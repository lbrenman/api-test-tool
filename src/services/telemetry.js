'use strict';
// Observability for the tool itself: a small in-process metrics registry, served as Prometheus text at /metrics,
// plus an optional OTLP/HTTP exporter (protobuf or JSON) that pushes traces (one server span per API request) and the same
// metrics to any OpenTelemetry backend (Grafana Cloud, Honeycomb, New Relic, Datadog, SigNoz, a collector…).
// In-house on purpose, like the other wire formats here: no OpenTelemetry SDK, no new dependency.
//
// Metric names follow the OpenTelemetry semantic conventions (http.server.request.duration, …). /metrics renders
// them the way an OTLP-to-Prometheus bridge would (dots -> underscores, unit and _total suffixes), so a dashboard
// built on scraped metrics also works on pushed ones, and the other way round.
//
// Settings (section "telemetry"): METRICS_ENABLED, METRICS_TOKEN and the standard OTEL_* variables. Export is off
// until OTEL_EXPORTER_OTLP_ENDPOINT is set; every setting is read when used, so dashboard changes apply live.
const os = require('node:os');
const crypto = require('node:crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const pkg = require('../../package.json');
const { commit } = require('../util/build');
const otlpProto = require('../util/otlpProto');

// http.server.request.duration buckets from the semantic conventions, extended for chaos latency and long streams.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 120];
const MAX_SERIES = 2000; // per metric; beyond it new attribute sets go to one otel.metric.overflow series
const MAX_QUEUED_SPANS = 2048;
const SPAN_BATCH = 512;
const SPAN_FLUSH_MS = 5000;
const EXPORT_TIMEOUT_MS = 10000;
const WARN_EVERY_MS = 5 * 60 * 1000;
const PROCESS_START_NS = BigInt(Date.now() - Math.round(process.uptime() * 1000)) * 1000000n;

const nowNs = () => BigInt(Date.now()) * 1000000n;

// ---------------------------------------------------------------- metrics registry

// Attributes are kept as sorted [key, value] pairs; empty values are dropped (Prometheus treats "" as absent).
function normAttrs(attrs) {
  return Object.entries(attrs || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

class Metric {
  // type: counter | updown | histogram | gauge (observed) | ocounter (observed monotonic, e.g. CPU time)
  constructor({ name, type, unit = '', description = '', buckets, observe }) {
    Object.assign(this, { name, type, unit, description, buckets, observe });
    this.series = new Map(); // key -> { attrs, value } or { attrs, count, sum, buckets[] }
  }

  slot(attrs) {
    let pairs = normAttrs(attrs);
    let key = JSON.stringify(pairs);
    let s = this.series.get(key);
    if (s) return s;
    if (this.series.size >= MAX_SERIES) {
      pairs = [['otel.metric.overflow', true]];
      key = JSON.stringify(pairs);
      s = this.series.get(key);
      if (s) return s;
    }
    s = this.type === 'histogram' ? { attrs: pairs, count: 0, sum: 0, buckets: new Array(this.buckets.length + 1).fill(0) } : { attrs: pairs, value: 0 };
    this.series.set(key, s);
    return s;
  }

  add(attrs, n = 1) { this.slot(attrs).value += n; }

  record(attrs, v) {
    const s = this.slot(attrs);
    s.count += 1;
    s.sum += v;
    let i = 0;
    while (i < this.buckets.length && v > this.buckets[i]) i += 1;
    s.buckets[i] += 1;
  }

  // Current points: stored series, or the observe() callback's [{attrs, value}] for observed instruments.
  points() {
    if (!this.observe) return [...this.series.values()];
    let out;
    try { out = this.observe(); } catch { return []; }
    if (typeof out === 'number') out = [{ attrs: {}, value: out }];
    return (out || []).filter((p) => Number.isFinite(p.value)).map((p) => ({ attrs: normAttrs(p.attrs), value: p.value }));
  }

  // Prometheus name, the way OTLP-to-Prometheus translation spells it.
  promName() {
    let n = this.name.replace(/[^A-Za-z0-9_]/g, '_');
    const suffix = { s: 'seconds', By: 'bytes', ms: 'milliseconds' }[this.unit];
    if (suffix && !n.endsWith(`_${suffix}`)) n += `_${suffix}`;
    if ((this.type === 'counter' || this.type === 'ocounter') && !n.endsWith('_total')) n += '_total';
    return n;
  }
}

const promLabel = (k) => k.replace(/[^A-Za-z0-9_]/g, '_');
const promValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const promNum = (n) => (n === Infinity ? '+Inf' : n === -Infinity ? '-Inf' : Number.isNaN(n) ? 'NaN' : String(n));
const labels = (pairs, extra = []) => {
  const all = [...pairs, ...extra];
  return all.length ? `{${all.map(([k, v]) => `${promLabel(k)}="${promValue(v)}"`).join(',')}}` : '';
};

// OTLP JSON attribute values (int64 as strings, as the JSON mapping allows).
function anyValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
const otlpAttrs = (pairs) => pairs.map(([key, v]) => ({ key, value: anyValue(v) }));

// ---------------------------------------------------------------- request classification

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[a-z]{1,5}_[A-Za-z0-9_-]{6,}$/, // f_…, dlv_… and the other prefixed ids
  /^[0-9a-f]{16,}$/i,
  /^(?=.*\d)[A-Za-z0-9_-]{20,}$/, // long random tokens
];

// Which surface a request belongs to (protocol names match the Inspector's apiKind, plus the tool's own areas).
function surface(path, req, apiKind) {
  const kind = apiKind(path, req);
  if (kind) return kind;
  if (/^\/(health|ready|metrics|openapi\.(json|yaml)|docs|samples)(\/|$)/.test(path)) return 'platform';
  if (/^\/admin(\/|$)/.test(path)) return 'admin';
  if (path === '/' || /^\/(dashboard|app)(\/|$)/.test(path)) return 'ui';
  return 'inspector';
}

// A low-cardinality route template: ids become {id}; open-ended paths end in /*.
function routeOf(path, protocol) {
  if (protocol === 'inspector') return '/*';
  if (protocol === 's3') return '/{bucket}/*';
  if (protocol === 'ui') return path === '/' ? '/' : `/${path.split('/')[1]}/*`;
  const segs = path.split('/').filter(Boolean);
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (i >= 5) { out.push('*'); break; }
    let s = segs[i];
    try { s = decodeURIComponent(s); } catch { /* keep it */ }
    if (ID_SEGMENT.some((re) => re.test(s)) || s.length > 40) s = '{id}';
    else if (out[0] === 'v1' && out[1] === 'files' && s.includes('.')) s = '{name}';
    else s = s.replace(/\((?!\))[^)]*\)/g, '({key})'); // OData keys: Employees(12) -> Employees({key})
    out.push(s);
  }
  return `/${out.join('/')}`;
}

// W3C Trace Context: 00-<trace id>-<parent span id>-<flags>
function parseTraceparent(h) {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(h || '').trim().toLowerCase());
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return { traceId: m[2], parentSpanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// OTEL_EXPORTER_OTLP_HEADERS / OTEL_RESOURCE_ATTRIBUTES: key=value,key2=value2 with percent-encoded values.
function parseKeyValues(s) {
  const out = {};
  for (const part of String(s || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep it */ }
    if (k) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- service

class TelemetryService {
  constructor(ctx, { apiKind }) {
    this.ctx = ctx;
    this.settings = ctx.settings;
    this.apiKind = apiKind;
    this.metrics = [];
    this.spans = [];
    this.timers = [];
    this.status = { traces: { sent: 0, failed: 0, dropped: 0, last: null }, metrics: { sent: 0, failed: 0, last: null } };
    this.warnedAt = {};
    this.flushing = { traces: null, metrics: null };
    this.closed = false;

    const m = (def) => { const x = new Metric(def); this.metrics.push(x); return x; };
    this.duration = m({ name: 'http.server.request.duration', type: 'histogram', unit: 's', description: 'Duration of HTTP requests served, by protocol, route, method, status and settings profile', buckets: DURATION_BUCKETS });
    this.active = m({ name: 'http.server.active_requests', type: 'updown', description: 'Requests in progress, including open streams and WebSocket upgrades still being handled' });
    this.chaos = m({ name: 'att.chaos.injections', type: 'counter', description: 'Errors and failures injected by chaos (random rate, route overrides or X-Force-* headers)' });
    this.changes = m({ name: 'att.data.changes', type: 'counter', description: 'Mock data records created, updated or deleted, over any protocol' });
    this.fileEvents = m({ name: 'att.file.events', type: 'counter', description: 'File pool uploads, downloads and deletes, by protocol (via)' });
    this.webhooks = m({ name: 'att.webhook.deliveries', type: 'counter', description: 'Outgoing webhook deliveries, by outcome' });
    this.webhookDuration = m({ name: 'att.webhook.delivery.duration', type: 'histogram', unit: 's', description: 'Time an outgoing webhook delivery took', buckets: DURATION_BUCKETS });
    this.tokens = m({ name: 'att.oauth.tokens', type: 'counter', description: 'Access tokens issued by the built-in OAuth server, by grant type' });
    m({ name: 'att.websocket.connections', type: 'gauge', description: 'Open mock WebSocket connections', observe: () => ctx.wsHub?.size ?? 0 });
    m({ name: 'att.mcp.sessions', type: 'gauge', description: 'Open MCP sessions (2025-xx clients)', observe: () => ctx.mcpSessions?.size ?? 0 });
    m({ name: 'att.a2a.tasks', type: 'gauge', description: 'A2A tasks held in memory', observe: () => ctx.a2a?.tasks?.size ?? 0 });

    // Process metrics (same names as the OpenTelemetry Node.js runtime instrumentation).
    m({ name: 'process.cpu.time', type: 'ocounter', unit: 's', description: 'CPU time used by this process', observe: () => { const u = process.cpuUsage(); return [{ attrs: { 'cpu.mode': 'user' }, value: u.user / 1e6 }, { attrs: { 'cpu.mode': 'system' }, value: u.system / 1e6 }]; } });
    m({ name: 'process.memory.usage', type: 'gauge', unit: 'By', description: 'Resident set size of this process', observe: () => process.memoryUsage.rss() });
    m({ name: 'v8js.memory.heap.used', type: 'gauge', unit: 'By', description: 'V8 heap in use', observe: () => process.memoryUsage().heapUsed });
    m({ name: 'process.uptime', type: 'gauge', unit: 's', description: 'Seconds since this process started', observe: () => process.uptime() });
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.loopP99 = 0;
    this.every(15000, () => { this.loopP99 = this.loop.percentile(99) / 1e9; this.loop.reset(); });
    m({ name: 'nodejs.eventloop.delay.p99', type: 'gauge', unit: 's', description: 'Event loop delay, 99th percentile over the last 15 seconds', observe: () => this.loopP99 });

    // Activity reported by the services through ctx.events.
    if (ctx.events) {
      ctx.events.on('change', (e) => this.changes.add({ 'att.resource': e.resource, 'att.change.type': e.type }));
      ctx.events.on('file', (e) => this.fileEvents.add({ 'att.file.event': e.type, 'att.file.via': e.via }));
    }

    this.every(SPAN_FLUSH_MS, () => this.flushTraces());
    this.scheduleMetrics();
  }

  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  // The metrics export interval is a live setting, so each run schedules the next.
  scheduleMetrics() {
    if (this.closed) return;
    const t = setTimeout(async () => { await this.flushMetrics(); this.scheduleMetrics(); }, this.settings.get('otelMetricExportIntervalMs'));
    t.unref();
    this.metricsTimer = t;
  }

  // ------------------------------------------------------------ configuration (read live)

  endpoint() { return String(this.settings.get('otelEndpoint') || '').trim().replace(/\/+$/, ''); }
  tracesOn() { return !!this.endpoint() && this.settings.get('otelTracesExporter') === 'otlp'; }
  metricsExportOn() { return !!this.endpoint() && this.settings.get('otelMetricsExporter') === 'otlp'; }

  serviceName() {
    return this.settings.get('otelServiceName') || parseKeyValues(this.settings.get('otelResourceAttributes'))['service.name'] || 'api-test-tool';
  }

  resource() {
    const fromEnv = parseKeyValues(this.settings.get('otelResourceAttributes'));
    const attrs = {
      'service.version': pkg.version,
      'service.instance.id': process.env.FLY_MACHINE_ID || os.hostname(),
      'host.name': os.hostname(),
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.versions.node,
      'telemetry.sdk.name': 'api-test-tool',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': pkg.version,
      ...(commit ? { 'vcs.ref.head.revision': commit } : {}),
      ...fromEnv,
    };
    // OTEL_SERVICE_NAME wins over a service.name in OTEL_RESOURCE_ATTRIBUTES, as in the OpenTelemetry SDKs.
    attrs['service.name'] = this.serviceName();
    return { attributes: otlpAttrs(normAttrs(attrs)) };
  }

  scope() { return { name: 'api-test-tool', version: pkg.version }; }

  // ------------------------------------------------------------ requests

  // Called by middleware/telemetry.js when a request arrives; returns the per-request state.
  begin(req) {
    this.active.add({}, 1);
    const st = { startNs: nowNs(), hr: process.hrtime.bigint(), span: null };
    if (this.tracesOn()) {
      const parent = parseTraceparent(req.get('traceparent'));
      const ratio = this.settings.get('otelTracesSampleRatio');
      const sampled = parent ? parent.sampled : Math.random() < ratio;
      if (sampled) {
        st.span = {
          traceId: parent ? parent.traceId : crypto.randomBytes(16).toString('hex'),
          spanId: crypto.randomBytes(8).toString('hex'),
          parentSpanId: parent ? parent.parentSpanId : undefined,
        };
        req.traceContext = { traceId: st.span.traceId, spanId: st.span.spanId };
      }
    }
    return st;
  }

  // Called once, when the response has finished or the connection closed early.
  end(req, res, st) {
    this.active.add({}, -1);
    const durNs = process.hrtime.bigint() - st.hr;
    const seconds = Number(durNs) / 1e9;
    const prefix = req.profile?.prefix || '';
    const path = (req.originalUrl || req.url || '/').split('?')[0].slice(prefix.length) || '/';
    const protocol = surface(path, req, this.apiKind);
    const route = routeOf(path, protocol);
    const upgraded = !!req.ws?.accepted;
    const aborted = !upgraded && !res.writableFinished;
    const status = upgraded ? 101 : res.headersSent || !aborted ? res.statusCode : undefined;
    const chaos = res.getHeader('X-Chaos-Injected');
    const attrs = {
      'http.request.method': req.method,
      'http.route': route,
      'http.response.status_code': status,
      'att.protocol': protocol,
      'att.profile': req.profile?.name,
      'error.type': aborted ? 'aborted' : status >= 500 ? String(status) : undefined,
    };
    this.duration.record(attrs, seconds);
    if (chaos) this.chaos.add({ 'att.protocol': protocol, 'att.chaos.type': String(chaos) });

    // Spans for the APIs under test and the inspector catch-all; not for the dashboard, admin API or probes, and not
    // for this tool's own exports (an endpoint pointed at its own inspector would otherwise trace itself forever).
    const ownExport = String(req.get('user-agent') || '').startsWith('api-test-tool-otlp/');
    if (st.span && !ownExport && !['platform', 'admin', 'ui'].includes(protocol)) {
      const spanAttrs = {
        ...attrs,
        'url.path': path,
        'url.scheme': req.protocol,
        'server.address': req.hostname,
        'client.address': req.ip,
        'user_agent.original': req.get('user-agent'),
        'att.request_id': req.id,
        'att.correlation_id': req.correlationId !== req.id ? req.correlationId : undefined,
        'att.chaos.type': chaos ? String(chaos) : undefined,
      };
      this.queueSpan({
        traceId: st.span.traceId,
        spanId: st.span.spanId,
        ...(st.span.parentSpanId ? { parentSpanId: st.span.parentSpanId } : {}),
        name: `${req.method} ${route}`,
        kind: 2, // SPAN_KIND_SERVER
        startTimeUnixNano: String(st.startNs),
        endTimeUnixNano: String(st.startNs + durNs),
        attributes: otlpAttrs(normAttrs(spanAttrs)),
        status: aborted || status >= 500 ? { code: 2, message: aborted ? 'connection closed before the response finished' : `HTTP ${status}` } : { code: 0 },
      });
    }
  }

  webhookDelivery(rec) {
    const outcome = rec.ok ? 'success' : rec.status ? 'http-error' : 'no-response';
    this.webhooks.add({ 'att.webhook.outcome': outcome, 'att.webhook.test': rec.test || undefined });
    if (Number.isFinite(rec.durationMs)) this.webhookDuration.record({ 'att.webhook.outcome': outcome }, rec.durationMs / 1000);
  }

  tokenIssued(grant) {
    const g = ['client_credentials', 'authorization_code', 'refresh_token'].includes(grant) ? grant : 'other';
    this.tokens.add({ 'oauth.grant_type': g });
  }

  // ------------------------------------------------------------ Prometheus

  prometheus() {
    const lines = [];
    for (const m of this.metrics) {
      const name = m.promName();
      const type = { counter: 'counter', ocounter: 'counter', updown: 'gauge', gauge: 'gauge', histogram: 'histogram' }[m.type];
      lines.push(`# HELP ${name} ${m.description.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${type}`);
      if (m.type === 'histogram') {
        const base = name;
        for (const s of m.points()) {
          let cum = 0;
          m.buckets.forEach((b, i) => { cum += s.buckets[i]; lines.push(`${base}_bucket${labels(s.attrs, [['le', promNum(b)]])} ${cum}`); });
          lines.push(`${base}_bucket${labels(s.attrs, [['le', '+Inf']])} ${s.count}`);
          lines.push(`${base}_sum${labels(s.attrs)} ${promNum(s.sum)}`, `${base}_count${labels(s.attrs)} ${s.count}`);
        }
      } else {
        for (const s of m.points()) lines.push(`${name}${labels(s.attrs)} ${promNum(s.value)}`);
      }
    }
    lines.push('# HELP target_info Target metadata', '# TYPE target_info gauge');
    const res = Object.fromEntries(this.resource().attributes.map((a) => [a.key, Object.values(a.value)[0]]));
    lines.push(`target_info${labels(normAttrs(res))} 1`);
    return `${lines.join('\n')}\n`;
  }

  // ------------------------------------------------------------ OTLP export

  queueSpan(span) {
    if (this.spans.length >= MAX_QUEUED_SPANS) { this.status.traces.dropped += 1; return; }
    this.spans.push(span);
    if (this.spans.length >= SPAN_BATCH) this.flushTraces();
  }

  // body is in OTLP JSON shape; http/protobuf encodes it with util/otlpProto.js.
  async post(signal, body) {
    const url = `${this.endpoint()}/v1/${signal}`;
    const proto = this.settings.get('otelProtocol') === 'http/protobuf';
    const payload = proto ? otlpProto.encode(body, signal === 'traces' ? 'ExportTraceServiceRequest' : 'ExportMetricsServiceRequest') : JSON.stringify(body);
    const headers = { 'Content-Type': proto ? 'application/x-protobuf' : 'application/json', 'User-Agent': `api-test-tool-otlp/${pkg.version}`, ...parseKeyValues(this.settings.get('otelHeaders')) };
    const st = this.status[signal];
    const at = new Date().toISOString();
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      st.last = { at, ok: true, status: res.status };
      return true;
    } catch (e) {
      const error = e.name === 'TimeoutError' ? `no response within ${EXPORT_TIMEOUT_MS} ms` : (e.cause?.message || e.message);
      st.last = { at, ok: false, error };
      if (!this.warnedAt[signal] || Date.now() - this.warnedAt[signal] > WARN_EVERY_MS) {
        this.warnedAt[signal] = Date.now();
        this.ctx.log('warn', `OTLP ${signal} export to ${url} failed: ${error}`);
      }
      return false;
    }
  }

  // Sends queued spans now. Resolves when the batch has been sent (or failed); one export at a time.
  async flushTraces() {
    if (this.flushing.traces) return this.flushing.traces;
    if (!this.tracesOn()) { this.spans.length = 0; return false; }
    if (!this.spans.length) return true;
    const batch = this.spans.splice(0, SPAN_BATCH);
    this.flushing.traces = (async () => {
      const ok = await this.post('traces', { resourceSpans: [{ resource: this.resource(), scopeSpans: [{ scope: this.scope(), spans: batch }] }] });
      if (ok) this.status.traces.sent += batch.length; else this.status.traces.failed += batch.length;
      return ok;
    })();
    try { return await this.flushing.traces; } finally { this.flushing.traces = null; }
  }

  otlpMetrics() {
    const t = String(nowNs());
    const start = String(PROCESS_START_NS);
    const point = (s, extra) => ({ attributes: otlpAttrs(s.attrs), startTimeUnixNano: start, timeUnixNano: t, ...extra });
    const num = (v) => (Number.isInteger(v) ? { asInt: String(v) } : { asDouble: v });
    const out = [];
    for (const m of this.metrics) {
      const pts = m.points();
      if (!pts.length) continue;
      const base = { name: m.name, description: m.description, unit: m.unit };
      if (m.type === 'histogram') {
        out.push({ ...base, histogram: { aggregationTemporality: 2, dataPoints: pts.map((s) => point(s, { count: String(s.count), sum: s.sum, bucketCounts: s.buckets.map(String), explicitBounds: m.buckets })) } });
      } else if (m.type === 'gauge') {
        out.push({ ...base, gauge: { dataPoints: pts.map((s) => ({ attributes: otlpAttrs(s.attrs), timeUnixNano: t, ...num(s.value) })) } });
      } else {
        out.push({ ...base, sum: { aggregationTemporality: 2, isMonotonic: m.type !== 'updown', dataPoints: pts.map((s) => point(s, num(s.value))) } });
      }
    }
    return { resourceMetrics: [{ resource: this.resource(), scopeMetrics: [{ scope: this.scope(), metrics: out }] }] };
  }

  async flushMetrics() {
    if (this.flushing.metrics) return this.flushing.metrics;
    if (!this.metricsExportOn()) return false;
    this.flushing.metrics = (async () => {
      const ok = await this.post('metrics', this.otlpMetrics());
      if (ok) this.status.metrics.sent += 1; else this.status.metrics.failed += 1;
      return ok;
    })();
    try { return await this.flushing.metrics; } finally { this.flushing.metrics = null; }
  }

  // Both signals now (tests, shutdown). Waits for an export already in flight, then sends whatever is still queued.
  async flush() {
    const traces = (async () => {
      let ok = await this.flushTraces();
      while (ok && this.spans.length) ok = await this.flushTraces();
    })();
    await Promise.all([traces, this.flushMetrics()]);
  }

  // For /health and the admin overview: what is configured and how the last exports went. No secrets.
  summary() {
    let endpoint = null;
    try { endpoint = this.endpoint() ? new URL(this.endpoint()).origin : null; } catch { endpoint = 'invalid URL'; }
    return {
      metrics: { enabled: !!this.settings.get('metricsEnabled'), path: '/metrics', tokenRequired: !!this.settings.get('metricsToken') },
      otlp: endpoint ? {
        endpoint,
        protocol: this.settings.get('otelProtocol'),
        serviceName: this.serviceName(),
        traces: this.tracesOn() ? { sampleRatio: this.settings.get('otelTracesSampleRatio'), ...this.status.traces, queued: this.spans.length } : false,
        metrics: this.metricsExportOn() ? { intervalMs: this.settings.get('otelMetricExportIntervalMs'), ...this.status.metrics } : false,
      } : false,
    };
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.metricsTimer);
    this.loop.disable();
    await Promise.race([this.flush().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
  }
}

module.exports = { TelemetryService, routeOf, surface, parseTraceparent, parseKeyValues, DURATION_BUCKETS };
