'use strict';
// Application factory: builds the context (settings, DB, stores, services) and the Express app.
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { AsyncResource } = require('node:async_hooks');
const express = require('express');
const { Settings } = require('./config/settings');
const { makeBaseUrl } = require('./config/baseUrl');
const { Repo } = require('./db/repo');
const { makeDateFormatter } = require('./services/dateFormat');
const { ResourceService } = require('./services/resources');
const { FileService, createStore } = require('./services/files');
const { KeyService } = require('./services/keys');
const { OAuthService } = require('./services/oauth');
const { ProfileService } = require('./services/profiles');
const { CaService } = require('./services/ca');
const { InspectorService } = require('./services/inspector');
const { TesterService } = require('./services/tester');
const { WebhookService } = require('./services/webhooks');
const { TelemetryService } = require('./services/telemetry');
const { seedAll } = require('./services/seed');
const { generateSamples } = require('./services/sampleFiles');
const { HttpError, sendProblem } = require('./util/problem');

const requestId = require('./middleware/requestId');
const telemetry = require('./middleware/telemetry');
const cors = require('./middleware/cors');
const idempotency = require('./middleware/idempotency');
const { responseHeaders } = require('./middleware/headers');
const { protocolStack } = require('./middleware/protocol');
const { v1Body } = require('./middleware/body');
const { makeAdminAuth } = require('./middleware/adminAuth');
const { catchAll, logAll, apiKind } = require('./middleware/inspector');
const { profileRouting } = require('./middleware/profile');

const platformRouter = require('./routes/platform');
const oauthRouter = require('./routes/oauth');
const resourcesRouter = require('./routes/resources');
const filesRouter = require('./routes/files');
const adminRouter = require('./routes/admin');
const soapRouter = require('./protocols/soap/router');
const wsRouter = require('./protocols/ws/router');
const sseRouter = require('./protocols/sse/router');
const graphqlRouter = require('./protocols/graphql/router');
const odataRouter = require('./protocols/odata/router');
const s3Router = require('./protocols/s3/router');
const llmRouter = require('./protocols/llm/router');
const mcpRouter = require('./protocols/mcp/router');
const a2aRouter = require('./protocols/a2a/router');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Listeners run in the async context they were added in: a change made inside one settings profile reaches a
// /sse/changes or /ws/changes subscriber with that subscriber's profile, and global listeners (webhooks) with none.
class ScopedEmitter extends EventEmitter {
  #bound = new WeakMap();
  on(event, fn) {
    const b = AsyncResource.bind(fn);
    this.#bound.set(fn, b);
    return super.on(event, b);
  }
  off(event, fn) { return super.off(event, this.#bound.get(fn) || fn); }
}
ScopedEmitter.prototype.addListener = ScopedEmitter.prototype.on;
ScopedEmitter.prototype.removeListener = ScopedEmitter.prototype.off;

async function createContext({ env = process.env, overrides = {} } = {}) {
  const settings = new Settings({ ...env, ...overrides });
  const log = (level, ...args) => {
    if (LEVELS[level] < LEVELS[settings.get('logLevel')]) return;
    (level === 'error' ? console.error : console.log)(`[${level}]`, ...args);
    log.sink?.(level, args); // OTLP log export (services/telemetry.js), once the context has it
  };
  const repo = await Repo.create({ driver: settings.get('dbDriver'), sqlitePath: settings.get('sqlitePath'), databaseUrl: settings.get('databaseUrl') });
  await settings.attach(repo);
  const ctx = { settings, repo, log, ready: false };
  ctx.baseUrl = makeBaseUrl(settings, env);
  ctx.dates = makeDateFormatter(settings);
  ctx.events = new ScopedEmitter(); // 'change' events from ResourceService feed /ws/changes (and /sse/changes)
  ctx.events.setMaxListeners(0);
  ctx.wsHub = new Set(); // open mock WebSocket connections
  ctx.resources = new ResourceService(repo, ctx.dates, ctx.events);
  ctx.files = new FileService(repo, await createStore(settings), settings);
  ctx.files.events = ctx.events; // 'file' events (uploaded/downloaded/deleted) for outgoing webhooks
  ctx.keys = new KeyService(repo, settings);
  await ctx.keys.init();
  ctx.oauth = new OAuthService(ctx);
  await ctx.oauth.init();
  ctx.profiles = new ProfileService(ctx);
  await ctx.profiles.init();
  ctx.ca = new CaService(ctx); // lab CA for mutual TLS: client certificates and the mTLS listener's certificate
  await ctx.ca.init();
  ctx.inspector = new InspectorService(ctx);
  ctx.tester = new TesterService(ctx);
  ctx.webhooks = new WebhookService(ctx); // outgoing webhooks on data changes (stored in the database)
  await ctx.webhooks.init();
  ctx.telemetry = new TelemetryService(ctx, { apiKind }); // /metrics and optional OTLP export of traces, metrics and logs
  log.sink = (level, args) => ctx.telemetry.log(level, args);
  return ctx;
}

async function seedOnStart(ctx) {
  const { settings, repo, log } = ctx;
  const mode = settings.get('seedOnStart');
  const empty = (await repo.count('employees')) === 0 && (await repo.count('departments')) === 0;
  let seeded = false;
  if (mode === 'always' || (mode === 'if-empty' && empty)) {
    const r = await seedAll(ctx);
    log('info', `seeded ${r.employees} employees, ${r.products} products (seed ${r.seed})`);
    seeded = true;
  }
  if (settings.get('seedSampleFiles')) {
    const hasSamples = (await repo.list('files')).some((f) => f.source === 'generated');
    if (seeded || !hasSamples) {
      const n = (await generateSamples(ctx)).length;
      log('info', `generated ${n} sample files`);
    }
  }
}

function errorHandler(ctx) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof HttpError) {
      return sendProblem(req, res, err.status, { detail: err.detail || err.message, errors: err.errors, headers: err.headers, code: err.code });
    }
    if (err.type === 'entity.parse.failed') {
      return sendProblem(req, res, 400, { detail: `Malformed request body: ${err.message}`, code: 'malformed-body' });
    }
    if (err.type === 'entity.too.large') return sendProblem(req, res, 413, { detail: 'Request body too large', code: 'body-too-large' });
    if (err.status && err.status >= 400 && err.status < 500) return sendProblem(req, res, err.status, { detail: err.message });
    ctx.log('error', req.method, req.originalUrl, err.stack || err);
    return sendProblem(req, res, 500, { detail: 'Unexpected server error', code: 'internal-error' });
  };
}

async function createApp(opts = {}) {
  const ctx = opts.ctx || await createContext(opts);
  const { settings } = ctx;
  if (opts.seed !== false) await seedOnStart(ctx);

  const app = express();
  app.locals.ctx = ctx;
  app.set('trust proxy', true);
  app.set('query parser', 'extended');
  app.set('x-powered-by', false);
  app.set('etag', 'weak');

  const adminAuth = makeAdminAuth(settings);

  app.use(requestId());
  app.use(telemetry(ctx)); // request duration metrics (/metrics) and, with OTLP export on, one span per API request
  app.use(profileRouting(ctx)); // /p/<profile>/… : the rest of the request runs with that settings profile
  app.use(responseHeaders(settings));
  app.use(cors(settings));
  app.use(s3Router.detect(ctx)); // marks S3 API requests (req.s3): /<bucket>/…, or signed with AWS SigV4
  app.use(logAll(ctx)); // records /v1, /oauth and the other protocols' traffic when INSPECTOR_LOG_ALL is on
  // S3-compatible API over the file pool. Mounted before everything else so a signed GET / is ListBuckets
  // (an unsigned GET / still redirects to the dashboard); requests that are not S3 pass straight through.
  app.use(s3Router(ctx));

  // Platform + OAuth (always open)
  app.use(platformRouter(ctx, { adminAuth }));
  app.use(oauthRouter(ctx));
  app.use(mcpRouter.wellKnown(ctx)); // RFC 9728 protected resource metadata for /mcp
  app.use(a2aRouter.wellKnown(ctx)); // A2A Agent Card at /.well-known/agent-card.json

  // Dashboard + admin API
  app.get('/', (req, res) => res.redirect(302, '/dashboard'));
  app.use('/dashboard', express.static(path.join(__dirname, 'public'), { index: 'index.html', fallthrough: true }));
  app.use('/dashboard', (req, res) => sendProblem(req, res, 404, { detail: 'Dashboard asset not found' }));
  // Business-style back-office app over the mock data (talks to /admin/api/app, same password as the dashboard).
  app.use('/app', express.static(path.join(__dirname, 'webapp'), { index: 'index.html', fallthrough: true }));
  app.use('/app', (req, res) => sendProblem(req, res, 404, { detail: 'App asset not found' }));
  const filesApi = filesRouter(ctx);
  app.use('/admin/api', adminRouter(ctx, { adminAuth, filesApi }));
  app.use('/admin', (req, res) => sendProblem(req, res, 404, { detail: `No admin route ${req.method} ${req.originalUrl}` }));

  // Presigned URLs carry their own signature: mounted before /v1 auth.
  app.use(filesRouter.presignedRouter(ctx, filesApi));

  // Mock REST API. protocolStack = error format -> body -> required headers -> rate limit -> auth -> chaos,
  // shared with every other mock protocol surface (see middleware/protocol.js).
  const v1 = express.Router();
  v1.use(...protocolStack(ctx, { format: 'problem', body: v1Body(settings) }));
  v1.use(idempotency(ctx));
  v1.use('/files', filesApi.router);
  v1.use(resourcesRouter(ctx));
  v1.use((req, res) => sendProblem(req, res, 404, { detail: `No route ${req.method} /v1${req.path}`, code: 'route-not-found' }));
  app.use('/v1', v1);

  // Mock SOAP 1.1/1.2 services over the same data (WSDL open; requests go through the same protocol stack).
  app.use('/soap', soapRouter(ctx));
  // Mock WebSocket channels; upgrades arrive through handleUpgrade() below.
  app.use('/ws', wsRouter(ctx));
  // Server-Sent Events streams (change feed with replay, ticks, request/stream).
  app.use('/sse', sseRouter(ctx));
  // GraphQL over HTTP and graphql-transport-ws (subscriptions) over the same data.
  app.use('/graphql', graphqlRouter(ctx));
  // OData v4 (JSON) over the same data.
  app.use('/odata', odataRouter(ctx));
  // OpenAI-compatible mock LLM (base URL /llm/v1): chat completions with random token usage, embeddings, models.
  app.use('/llm', llmRouter(ctx));
  // Mock MCP server (Streamable HTTP; 2026-07-28 stateless and 2025-xx session clients) over the same data.
  app.use('/mcp', mcpRouter(ctx));
  // Mock A2A agent (1.0 JSON-RPC and HTTP+JSON, and 0.3) answering questions about the same data.
  app.use('/a2a', a2aRouter(ctx));

  // Everything else: the inspector
  app.use(catchAll(ctx));
  app.use(errorHandler(ctx));

  // WebSocket upgrades are not seen by Express on their own. Every server created with app.listen()
  // (src/server.js, the tests) passes them through the normal middleware chain with a response object
  // bound to the raw socket, so a rejected upgrade gets an ordinary HTTP error (401, 429, 503, 404…).
  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const res = new http.ServerResponse(req);
    res.shouldKeepAlive = false;
    res.assignSocket(socket);
    res.on('finish', () => { if (!req.ws?.accepted) socket.end(); });
    req.ws = { socket, head, accepted: false };
    app.handle(req, res, () => sendProblem(req, res, 404, { detail: `No WebSocket endpoint at ${req.url}` }));
  }
  const listen = app.listen.bind(app);
  app.listen = (...args) => {
    const server = listen(...args);
    server.on('upgrade', handleUpgrade);
    const close = server.close.bind(server);
    // Open WebSockets would keep server.close() waiting forever.
    server.close = (cb) => { for (const c of ctx.wsHub) c.close(1001, 'Server shutting down'); setTimeout(() => { for (const c of ctx.wsHub) c.terminate(); }, 500).unref(); return close(cb); };
    return server;
  };
  app.handleUpgrade = handleUpgrade;

  // The mutual-TLS listener: the same app on a TLS port that asks for a client certificate but lets the handshake
  // finish without a valid one, so AUTH_MODE=mtls and RFC 8705 can answer with a readable 401 (util/clientCert.js).
  app.listenTls = async (port, host) => {
    let key;
    let cert;
    if (settings.get('mtlsCertFile')) {
      cert = fs.readFileSync(settings.get('mtlsCertFile'), 'utf8');
      key = fs.readFileSync(settings.get('mtlsKeyFile'), 'utf8');
    } else {
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, ''); } catch { return null; } };
      const issued = await ctx.ca.serverCert([hostOf(ctx.baseUrl.root()), hostOf(settings.get('mtlsPublicUrl')), 'localhost', '127.0.0.1', '::1']);
      cert = issued.certPem + ctx.ca.caPem;
      key = issued.keyPem;
    }
    const extra = String(settings.get('mtlsTrustedCas') || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const server = https.createServer({ key, cert, ca: [ctx.ca.caPem, ...extra], requestCert: true, rejectUnauthorized: false }, app);
    server.on('upgrade', handleUpgrade);
    server.keepAliveTimeout = 65000;
    server.requestTimeout = 0;
    const close = server.close.bind(server);
    server.close = (cb) => { for (const c of ctx.wsHub) c.close(1001, 'Server shutting down'); return close(cb); };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    ctx.mtlsServer = server;
    return server;
  };

  ctx.ready = true;
  return { app, ctx, close: async () => { ctx.oauth.close(); await ctx.webhooks.drain(); await ctx.telemetry.shutdown(); await ctx.repo.close(); } };
}

module.exports = { createApp, createContext, seedOnStart };
