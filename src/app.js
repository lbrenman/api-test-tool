'use strict';
// Application factory: builds the context (settings, DB, stores, services) and the Express app.
const path = require('node:path');
const express = require('express');
const { Settings } = require('./config/settings');
const { makeBaseUrl } = require('./config/baseUrl');
const { Repo } = require('./db/repo');
const { makeDateFormatter } = require('./services/dateFormat');
const { ResourceService } = require('./services/resources');
const { FileService, createStore } = require('./services/files');
const { KeyService } = require('./services/keys');
const { OAuthService } = require('./services/oauth');
const { InspectorService } = require('./services/inspector');
const { TesterService } = require('./services/tester');
const { seedAll } = require('./services/seed');
const { generateSamples } = require('./services/sampleFiles');
const { HttpError, sendProblem } = require('./util/problem');

const requestId = require('./middleware/requestId');
const cors = require('./middleware/cors');
const rateLimit = require('./middleware/ratelimit');
const idempotency = require('./middleware/idempotency');
const { responseHeaders, requiredHeaders } = require('./middleware/headers');
const { makeAuth } = require('./middleware/auth');
const { makeChaos } = require('./middleware/chaos');
const { v1Body } = require('./middleware/body');
const { makeAdminAuth } = require('./middleware/adminAuth');
const { catchAll, logAll } = require('./middleware/inspector');

const platformRouter = require('./routes/platform');
const oauthRouter = require('./routes/oauth');
const resourcesRouter = require('./routes/resources');
const filesRouter = require('./routes/files');
const adminRouter = require('./routes/admin');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

async function createContext({ env = process.env, overrides = {} } = {}) {
  const settings = new Settings({ ...env, ...overrides });
  const log = (level, ...args) => {
    if (LEVELS[level] >= LEVELS[settings.get('logLevel')]) (level === 'error' ? console.error : console.log)(`[${level}]`, ...args);
  };
  const repo = await Repo.create({ driver: settings.get('dbDriver'), sqlitePath: settings.get('sqlitePath'), databaseUrl: settings.get('databaseUrl') });
  await settings.attach(repo);
  const ctx = { settings, repo, log, ready: false };
  ctx.baseUrl = makeBaseUrl(settings, env);
  ctx.dates = makeDateFormatter(settings);
  ctx.resources = new ResourceService(repo, ctx.dates);
  ctx.files = new FileService(repo, await createStore(settings), settings);
  ctx.keys = new KeyService(repo, settings);
  await ctx.keys.init();
  ctx.oauth = new OAuthService(ctx);
  await ctx.oauth.init();
  ctx.inspector = new InspectorService(ctx);
  ctx.tester = new TesterService(ctx);
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
  app.use(responseHeaders(settings));
  app.use(cors(settings));
  app.use(logAll(ctx)); // records /v1 and /oauth traffic when INSPECTOR_LOG_ALL is on

  // Platform + OAuth (always open)
  app.use(platformRouter(ctx, { adminAuth }));
  app.use(oauthRouter(ctx));

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

  // Mock API
  const v1 = express.Router();
  v1.use(v1Body(settings));
  v1.use(requiredHeaders(settings));
  v1.use(rateLimit(settings));
  v1.use(makeAuth(ctx));
  v1.use(makeChaos(ctx));
  v1.use(idempotency(ctx));
  v1.use('/files', filesApi.router);
  v1.use(resourcesRouter(ctx));
  v1.use((req, res) => sendProblem(req, res, 404, { detail: `No route ${req.method} /v1${req.path}`, code: 'route-not-found' }));
  app.use('/v1', v1);

  // Everything else: the inspector
  app.use(catchAll(ctx));
  app.use(errorHandler(ctx));

  ctx.ready = true;
  return { app, ctx, close: () => ctx.repo.close() };
}

module.exports = { createApp, createContext, seedOnStart };
