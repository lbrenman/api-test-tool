'use strict';
// Observability: /metrics (Prometheus text: request histogram by protocol/route/status/profile, chaos, data changes,
// OAuth tokens, process metrics; METRICS_ENABLED and METRICS_TOKEN), and OTLP export of traces and metrics to a
// local collector in both encodings (W3C traceparent honoured, headers and resource attributes sent, failures
// reported in /health), OTLP logs (access logs linked to spans, the tool's own log lines), plus the route templates
// that keep metric cardinality low.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, listen, waitFor } = require('./helpers');
const { routeOf, parseTraceparent, parseKeyValues } = require('../src/services/telemetry');
const otlpProto = require('../src/util/otlpProto');

// A tiny OTLP/HTTP collector: records every export.
let collector;
let otlp;
const got = [];
before(async () => {
  collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
      if (req.url.startsWith('/broken/')) { res.writeHead(503); res.end('collector down'); return; }
      res.writeHead(200, { 'Content-Type': req.headers['content-type'] });
      res.end(req.headers['content-type'] === 'application/json' ? '{}' : '');
    });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  otlp = `http://127.0.0.1:${collector.address().port}`;
});
after(async () => { collector.closeAllConnections?.(); await new Promise((r) => collector.close(r)); });

const json = (x) => JSON.parse(x.raw.toString('utf8'));
const attr = (attrs, key) => { const a = attrs.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
const sample = (text, name, labels) => {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line ? Number(line.split(' ').pop()) : undefined;
};

test('/metrics: request histogram by protocol, route, status and profile; chaos, data, tokens, process', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const api = () => request(t.app);
    await api().get('/v1/employees/1').expect(200);
    await api().get('/v1/employees/2').expect(200);
    await api().get('/v1/employees/3').set('X-Force-Error', '503').expect(503);
    await api().post('/v1/departments').send({ name: 'Telemetry', code: 'TEL' }).expect(201);
    await api().get('/odata/v4/Employees(4)').expect(200);
    await api().post('/hooks/some/random/path').send({ a: 1 }).expect(200);
    await api().get('/p/basic/v1/employees/5').auth('demo', 'demo').expect(200);
    await api().post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials' }).expect(200);

    const res = await api().get('/metrics').expect(200);
    assert.match(res.headers['content-type'], /^text\/plain; version=0\.0\.4/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const m = res.text;
    assert.match(m, /^# TYPE http_server_request_duration_seconds histogram$/m);
    const count = (labels) => sample(m, 'http_server_request_duration_seconds_count', labels);
    assert.equal(count({ att_protocol: 'v1', http_route: '/v1/employees/{id}', http_response_status_code: '200', http_request_method: 'GET' }), 2);
    assert.equal(count({ att_protocol: 'v1', http_route: '/v1/employees/{id}', http_response_status_code: '503', error_type: '503' }), 1);
    assert.equal(count({ att_protocol: 'v1', http_route: '/v1/departments', http_request_method: 'POST', http_response_status_code: '201' }), 1);
    assert.equal(count({ att_protocol: 'odata', http_route: '/odata/v4/Employees({key})' }), 1);
    assert.equal(count({ att_protocol: 'inspector', http_route: '/*', http_request_method: 'POST' }), 1, 'catch-all paths collapse to /*');
    assert.equal(count({ att_protocol: 'v1', att_profile: 'basic', http_route: '/v1/employees/{id}' }), 1, 'a profile request carries its profile and the route without /p/<name>');
    assert.equal(count({ att_protocol: 'oauth', http_route: '/oauth/token' }), 1);
    assert.ok(!/http_route="[^"]*\b\d+\b[^"]*"/.test(m.replace(/Employees\(\{key\}\)/g, '')), 'no raw ids in route labels');
    assert.match(m, /http_server_request_duration_seconds_bucket\{[^}]*le="\+Inf"\}/);
    assert.equal(sample(m, 'att_chaos_injections_total', { att_protocol: 'v1', att_chaos_type: '503' }), 1);
    assert.equal(sample(m, 'att_data_changes_total', { att_resource: 'departments', att_change_type: 'created' }), 1);
    assert.equal(sample(m, 'att_oauth_tokens_total', { oauth_grant_type: 'client_credentials' }), 1);
    for (const name of ['process_cpu_time_seconds_total', 'process_memory_usage_bytes', 'v8js_memory_heap_used_bytes', 'nodejs_eventloop_delay_p99_seconds', 'att_websocket_connections', 'http_server_active_requests']) {
      assert.match(m, new RegExp(`^# TYPE ${name} `, 'm'), name);
    }
    assert.match(m, /^target_info\{[^}]*service_name="api-test-tool"[^}]*\} 1$/m);

    // /metrics, /health and the dashboard count as the tool's own traffic, not as an API under test.
    await api().get('/health').expect(200);
    const again = (await api().get('/metrics').expect(200)).text;
    assert.equal(sample(again, 'http_server_request_duration_seconds_count', { att_protocol: 'platform', http_route: '/metrics' }), 1);
    assert.equal(sample(again, 'http_server_request_duration_seconds_count', { att_protocol: 'platform', http_route: '/health' }), 1);

    // /health reports what telemetry is doing.
    const h = (await api().get('/health').expect(200)).body;
    assert.deepEqual(h.settings.telemetry, { metrics: { enabled: true, path: '/metrics', tokenRequired: false }, otlp: false });

    // /metrics is reserved: the inspector does not capture it, and it is no S3 bucket name.
    await assert.rejects(t.ctx.settings.set('s3ApiBucket', 'metrics'), /invalid format/);
  } finally {
    await t.close();
  }
});

test('/metrics: METRICS_TOKEN requires a Bearer token; METRICS_ENABLED=false answers 404', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', METRICS_TOKEN: 's3cret-token' });
  try {
    const r = await request(t.app).get('/metrics').expect(401);
    assert.match(r.headers['content-type'], /problem\+json/);
    assert.equal(r.headers['www-authenticate'], 'Bearer realm="metrics"');
    await request(t.app).get('/metrics').set('Authorization', 'Bearer wrong-token!').expect(401);
    await request(t.app).get('/metrics').set('Authorization', 'Bearer s3cret-token').expect(200);
    assert.equal((await request(t.app).get('/health').expect(200)).body.settings.telemetry.metrics.tokenRequired, true);
    await t.ctx.settings.set('metricsEnabled', false);
    const off = await request(t.app).get('/metrics').set('Authorization', 'Bearer s3cret-token').expect(404);
    assert.equal(off.body.code, 'metrics-disabled');
  } finally {
    await t.close();
  }
});

test('OTLP http/json: spans follow traceparent and carry request ids; metrics are pushed with headers and resource', async () => {
  got.length = 0;
  const t = await makeApp({
    SEED_SAMPLE_FILES: 'false',
    OTEL_EXPORTER_OTLP_ENDPOINT: `${otlp}/json/`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc123,Authorization=Basic%20dXNlcjpwdw==',
    OTEL_SERVICE_NAME: 'att-under-test',
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=ci,service.name=ignored',
  });
  try {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parent = 'b7ad6b7169203331';
    const r = await request(t.app).get('/v1/employees/7').set('traceparent', `00-${traceId}-${parent}-01`).set('X-Correlation-Id', 'corr-otlp-1').expect(200);
    await request(t.app).get('/v1/employees/8').set('traceparent', `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`).expect(200); // caller did not sample
    await request(t.app).get('/v1/employees/9').set('X-Force-Error', '500').expect(500);
    await request(t.app).get('/health').expect(200); // probes are not traced
    await t.ctx.telemetry.flush();

    const traces = got.filter((x) => x.path === '/json/v1/traces');
    assert.ok(traces.length >= 1, 'traces exported');
    assert.equal(traces[0].headers['content-type'], 'application/json');
    assert.equal(traces[0].headers['x-honeycomb-team'], 'abc123');
    assert.equal(traces[0].headers.authorization, 'Basic dXNlcjpwdw==', 'header values are percent-decoded');
    const batch = traces.map(json).flatMap((b) => b.resourceSpans);
    const resAttrs = batch[0].resource.attributes;
    assert.equal(attr(resAttrs, 'service.name'), 'att-under-test', 'OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES');
    assert.equal(attr(resAttrs, 'deployment.environment.name'), 'ci');
    const spans = batch.flatMap((b) => b.scopeSpans.flatMap((s) => s.spans));
    assert.equal(spans.filter((s) => s.traceId === '1'.repeat(32)).length, 0, 'unsampled parent: no span');
    assert.ok(!spans.some((s) => attr(s.attributes, 'url.path') === '/health'), '/health is not traced');
    const span = spans.find((s) => s.traceId === traceId);
    assert.ok(span, 'span joins the caller\'s trace');
    assert.equal(span.parentSpanId, parent);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    assert.equal(span.name, 'GET /v1/employees/{id}');
    assert.equal(span.kind, 2);
    assert.equal(attr(span.attributes, 'http.response.status_code'), '200');
    assert.equal(attr(span.attributes, 'url.path'), '/v1/employees/7');
    assert.equal(attr(span.attributes, 'att.request_id'), r.headers['x-request-id']);
    assert.equal(attr(span.attributes, 'att.correlation_id'), 'corr-otlp-1');
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    const failed = spans.find((s) => attr(s.attributes, 'url.path') === '/v1/employees/9');
    assert.equal(failed.status.code, 2);
    assert.equal(attr(failed.attributes, 'att.chaos.type'), '500');

    const metrics = got.filter((x) => x.path === '/json/v1/metrics').map(json);
    assert.ok(metrics.length >= 1, 'metrics exported');
    const all = metrics.at(-1).resourceMetrics[0].scopeMetrics[0].metrics;
    const hist = all.find((x) => x.name === 'http.server.request.duration');
    assert.equal(hist.unit, 's');
    assert.equal(hist.histogram.aggregationTemporality, 2);
    const pt = hist.histogram.dataPoints.find((p) => attr(p.attributes, 'http.route') === '/v1/employees/{id}' && attr(p.attributes, 'http.response.status_code') === '200');
    assert.equal(pt.count, '2');
    assert.equal(pt.bucketCounts.length, pt.explicitBounds.length + 1);
    assert.equal(all.find((x) => x.name === 'att.websocket.connections').gauge.dataPoints.length, 1);

    const h = (await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp;
    assert.equal(h.endpoint, otlp);
    assert.equal(h.protocol, 'http/json');
    assert.equal(h.serviceName, 'att-under-test');
    assert.equal(h.traces.last.ok, true);
    assert.ok(h.traces.sent >= 2);
    assert.equal(h.metrics.last.ok, true);
    assert.ok(!JSON.stringify(h).includes('abc123'), 'no export headers in /health');
  } finally {
    await t.close();
  }
});

test('OTLP http/protobuf (the default) and failing exports reported in /health', async () => {
  got.length = 0;
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: `${otlp}/proto`, OTEL_METRICS_EXPORTER: 'none' });
  try {
    await request(t.app).get('/v1/products/1').set('traceparent', `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`).expect(200);
    await t.ctx.telemetry.flush();
    const sent = await waitFor(() => got.find((x) => x.path === '/proto/v1/traces'));
    assert.ok(sent, 'traces exported');
    assert.equal(sent.headers['content-type'], 'application/x-protobuf');
    // The trace id is sent as 16 raw bytes (field 1 of the Span), not as hex text.
    assert.ok(sent.raw.includes(Buffer.from(`0a10${'a'.repeat(32)}`, 'hex')), 'span trace_id bytes');
    assert.ok(sent.raw.includes(Buffer.from('GET /v1/products/{id}')), 'span name');
    assert.ok(!got.some((x) => x.path.endsWith('/v1/metrics')), 'OTEL_METRICS_EXPORTER=none');

    await t.ctx.settings.set('otelEndpoint', `${otlp}/broken`);
    await request(t.app).get('/v1/products/2').expect(200);
    await t.ctx.telemetry.flush();
    const h = (await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp;
    assert.equal(h.traces.last.ok, false);
    assert.match(h.traces.last.error, /HTTP 503/);
    assert.ok(h.traces.failed >= 1);
    assert.equal(h.metrics, false);

    await t.ctx.settings.set('otelEndpoint', ''); // export off again: nothing queued, nothing sent
    await request(t.app).get('/v1/products/3').expect(200);
    assert.equal((await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp, false);
    assert.equal(t.ctx.telemetry.spans.length, 0);
  } finally {
    await t.close();
  }
});

test('delta temporality (New Relic, Datadog) and large exports split under the size limit', async () => {
  got.length = 0;
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: `${otlp}/delta`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta', OTEL_TRACES_EXPORTER: 'none' });
  try {
    const metric = (body, name) => body.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
    const route = (m, r) => m?.histogram.dataPoints.find((p) => attr(p.attributes, 'http.route') === r);
    for (let i = 0; i < 3; i += 1) await request(t.app).get('/v1/employees/1').expect(200);
    await t.ctx.telemetry.flushMetrics();
    for (let i = 0; i < 2; i += 1) await request(t.app).get('/v1/employees/1').expect(200);
    await t.ctx.telemetry.flushMetrics();
    const [first, second] = got.filter((x) => x.path === '/delta/v1/metrics').map(json);
    const h1 = metric(first, 'http.server.request.duration');
    const h2 = metric(second, 'http.server.request.duration');
    assert.equal(h1.histogram.aggregationTemporality, 1, 'AGGREGATION_TEMPORALITY_DELTA');
    assert.equal(route(h1, '/v1/employees/{id}').count, '3');
    assert.equal(route(h2, '/v1/employees/{id}').count, '2', 'the second export carries only the new requests');
    assert.equal(route(h2, '/v1/employees/{id}').startTimeUnixNano, route(h1, '/v1/employees/{id}').timeUnixNano, 'each delta starts where the last one ended');
    assert.equal(metric(second, 'http.server.active_requests').sum.aggregationTemporality, 2, 'up-down counters stay cumulative');
    assert.equal(metric(second, 'process.cpu.time').sum.aggregationTemporality, 1);
    assert.equal((await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp.metrics.temporality, 'delta');
    assert.match((await request(t.app).get('/metrics').expect(200)).text, /http_server_request_duration_seconds_count\{[^}]*http_route="\/v1\/employees\/\{id\}"[^}]*\} [5-9]/, '/metrics stays cumulative');

    // A failed export keeps its increments for the next one.
    await t.ctx.settings.set('otelEndpoint', `${otlp}/broken`);
    await request(t.app).get('/v1/employees/1').expect(200);
    assert.equal(await t.ctx.telemetry.flushMetrics(), false);
    await t.ctx.settings.set('otelEndpoint', `${otlp}/delta`);
    await request(t.app).get('/v1/employees/1').expect(200);
    await t.ctx.telemetry.flushMetrics();
    assert.equal(route(metric(got.filter((x) => x.path === '/delta/v1/metrics').map(json).at(-1), 'http.server.request.duration'), '/v1/employees/{id}').count, '2');

    // Exports larger than the limit are split; every span still arrives.
    got.length = 0;
    await t.ctx.settings.set('otelTracesExporter', 'otlp');
    t.ctx.telemetry.maxExportBytes = 4000;
    for (let i = 0; i < 20; i += 1) await request(t.app).get(`/v1/products/${i + 1}`).expect(200);
    await t.ctx.telemetry.flush();
    const posts = got.filter((x) => x.path === '/delta/v1/traces');
    assert.ok(posts.length > 1, `split into ${posts.length} requests`);
    assert.ok(posts.every((x) => x.raw.length <= 4000), 'each request under the limit');
    assert.equal(posts.map(json).reduce((n, b) => n + b.resourceSpans[0].scopeSpans[0].spans.length, 0), 20);
  } finally {
    await t.close();
  }
});

test('OTLP logs: an access log per API request linked to its span, the tool\'s own log lines, errors-only mode', async () => {
  got.length = 0;
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: `${otlp}/logs`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_METRICS_EXPORTER: 'none' });
  try {
    const records = () => got.filter((x) => x.path === '/logs/v1/logs').map(json).flatMap((b) => b.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((sl) => sl.logRecords)));
    const ok = await request(t.app).get('/v1/employees/1').set('traceparent', `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`).expect(200);
    await request(t.app).get('/v1/employees/999999').expect(404);
    await request(t.app).get('/v1/employees/2').set('X-Force-Error', '503').expect(503);
    await request(t.app).get('/health').expect(200); // not an API under test: no access log
    t.ctx.log('error', 'something broke:', 42);
    await t.ctx.telemetry.flush();

    const recs = records();
    const access = recs.filter((r) => attr(r.attributes, 'att.log.kind') === 'access');
    assert.equal(access.length, 3);
    assert.ok(!access.some((r) => attr(r.attributes, 'url.path') === '/health'));
    const first = access.find((r) => attr(r.attributes, 'url.path') === '/v1/employees/1');
    assert.match(first.body.stringValue, /^GET \/v1\/employees\/1 200 \d+ ms$/);
    assert.equal(first.severityNumber, 9);
    assert.equal(first.severityText, 'INFO');
    assert.equal(first.traceId, 'c'.repeat(32), 'the access log carries the caller\'s trace id');
    assert.equal(first.flags, 1);
    assert.equal(attr(first.attributes, 'att.request_id'), ok.headers['x-request-id']);
    const spans = got.filter((x) => x.path === '/logs/v1/traces').map(json).flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
    assert.equal(first.spanId, spans.find((sp) => sp.traceId === 'c'.repeat(32)).spanId, 'and its span id: logs in context');
    assert.equal(access.find((r) => attr(r.attributes, 'url.path') === '/v1/employees/999999').severityText, 'WARN');
    const failed = access.find((r) => attr(r.attributes, 'url.path') === '/v1/employees/2');
    assert.equal(failed.severityNumber, 17);
    assert.equal(attr(failed.attributes, 'att.chaos.type'), '503');
    const tool = recs.find((r) => attr(r.attributes, 'att.log.kind') === 'tool');
    assert.equal(tool.body.stringValue, 'something broke: 42');
    assert.equal(tool.severityText, 'ERROR');
    assert.equal(tool.traceId, undefined);

    // errors: only 4xx, 5xx and dropped connections get an access log.
    got.length = 0;
    await t.ctx.settings.set('otelAccessLogs', 'errors');
    await request(t.app).get('/v1/employees/3').expect(200);
    await request(t.app).get('/v1/employees/4').set('X-Force-Error', '500').expect(500);
    await t.ctx.telemetry.flush();
    assert.deepEqual(records().map((r) => attr(r.attributes, 'url.path')), ['/v1/employees/4']);
    const h = (await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp.logs;
    assert.equal(h.accessLogs, 'errors');
    assert.equal(h.last.ok, true);

    // The exporter's own failure warnings are printed but never exported (they would fail too, and feed themselves).
    await t.ctx.settings.set('logLevel', 'warn');
    await t.ctx.settings.set('otelEndpoint', `${otlp}/broken`);
    await request(t.app).get('/v1/employees/5').set('X-Force-Error', '500').expect(500);
    await t.ctx.telemetry.flush();
    assert.ok(!t.ctx.telemetry.logs.some((r) => /OTLP .* export/.test(r.body.stringValue)));
    assert.equal((await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp.logs.last.ok, false);

    // OTEL_LOGS_EXPORTER=none: nothing queued or sent.
    await t.ctx.settings.set('otelEndpoint', `${otlp}/logs`);
    await t.ctx.settings.set('otelLogsExporter', 'none');
    got.length = 0;
    await request(t.app).get('/v1/employees/6').set('X-Force-Error', '500').expect(500);
    t.ctx.log('error', 'not exported');
    await t.ctx.telemetry.flush();
    assert.equal(records().length, 0);
    assert.equal((await request(t.app).get('/health').expect(200)).body.settings.telemetry.otlp.logs, false);
  } finally {
    await t.close();
  }
});

test('an export pointed at the tool\'s own Inspector is captured there, and the export itself is not traced', async () => {
  const t = await listen({ SEED_SAMPLE_FILES: 'false', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_METRICS_EXPORTER: 'none' });
  try {
    await t.ctx.settings.set('otelEndpoint', `${t.url}/otel-debug`);
    await request(t.url).get('/v1/employees/1').expect(200);
    assert.ok(await waitFor(() => t.ctx.telemetry.spans.length === 1), 'one span queued');
    assert.equal(await t.ctx.telemetry.flushTraces(), true);
    const cap = await waitFor(async () => (await t.ctx.inspector.list()).find((e) => e.path === '/otel-debug/v1/traces' && e.status === 200));
    assert.ok(cap, 'export captured by the Inspector');
    assert.equal(cap.contentType, 'application/json');
    const body = JSON.parse((await t.ctx.inspector.get(cap.id)).body.text);
    assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].name, 'GET /v1/employees/{id}');
    // The export request has finished on the server by the time the export resolved: it queued no span of its own.
    assert.equal(t.ctx.telemetry.spans.length, 0);
  } finally {
    await t.stop();
  }
});

test('route templates, traceparent and key=value parsing', () => {
  assert.equal(routeOf('/v1/employees/12', 'v1'), '/v1/employees/{id}');
  assert.equal(routeOf('/v1/departments/3/employees', 'v1'), '/v1/departments/{id}/employees');
  assert.equal(routeOf('/v1/files/f_AbC123xyz/download', 'v1'), '/v1/files/{id}/download');
  assert.equal(routeOf('/v1/files/raw/report.pdf', 'v1'), '/v1/files/raw/{name}');
  assert.equal(routeOf('/a2a/rest/tasks/1b4e28ba-2fa1-11d2-883f-0016d3cca427', 'a2a'), '/a2a/rest/tasks/{id}');
  assert.equal(routeOf("/odata/v4/Products('x')/Category", 'odata'), '/odata/v4/Products({key})/Category');
  assert.equal(routeOf('/v1/p/cursor/products', 'v1'), '/v1/p/cursor/products');
  assert.equal(routeOf('/a/b/c/d/e/f/g', 'inspector'), '/*');
  assert.equal(routeOf('/files/some/key.txt', 's3'), '/{bucket}/*');
  assert.equal(routeOf('/x1/x2/x3/x4/x5/x6/x7', 'v1'), '/x1/x2/x3/x4/x5/*');
  assert.deepEqual(parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'), { traceId: '0af7651916cd43dd8448eb211c80319c', parentSpanId: 'b7ad6b7169203331', sampled: true });
  for (const bad of ['', 'nonsense', `00-${'0'.repeat(32)}-b7ad6b7169203331-01`, `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`, 'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01']) {
    assert.equal(parseTraceparent(bad), null, bad);
  }
  assert.deepEqual(parseKeyValues('a=1, b = x%20y ,bad,=nokey,c=='), { a: '1', b: 'x y', c: '=' });
});

test('otlpProto: varints, packed repeated numbers and nested messages', () => {
  // KeyValue{key:"k", value:{intValue:-1}}: int64 -1 is a 10-byte varint.
  const kv = otlpProto.encode({ key: 'k', value: { intValue: '-1' } }, 'KeyValue');
  assert.equal(kv.toString('hex'), `0a016b120b18${'ff'.repeat(9)}01`);
  // Histogram data point: count (fixed64 4), packed bucket_counts (6) and explicit_bounds (7).
  const hp = otlpProto.encode({ count: '3', bucketCounts: ['1', '2'], explicitBounds: [0.5] }, 'HistogramDataPoint');
  assert.equal(hp.toString('hex'), `21${'0300000000000000'}3210${'0100000000000000'}${'0200000000000000'}3a08${'000000000000e03f'}`);
  // LogRecord flags (fixed32, field 8) and severity_number (enum, field 2).
  assert.equal(otlpProto.encode({ severityNumber: 17, flags: 1 }, 'LogRecord').toString('hex'), '10114501000000');
  assert.throws(() => otlpProto.encode({}, 'Nope'), /unknown message/);
});
