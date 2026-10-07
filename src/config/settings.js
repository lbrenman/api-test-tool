'use strict';
// Settings registry.
// Effective value = dashboard override (persisted in DB) ?? environment variable ?? built-in default.
// "Reset to env defaults" deletes overrides (one key, one section, or all).
const { EventEmitter } = require('node:events');

// type: string | int | number | bool | enum | json | headerList | requiredHeaders
const DEFS = [
  // ---- server (restart required) ----
  { key: 'port', env: 'PORT', def: 3000, type: 'int', section: 'server', restart: true, desc: 'HTTP port' },
  { key: 'publicBaseUrl', env: 'PUBLIC_BASE_URL', def: '', type: 'string', section: 'server', desc: 'Public base URL (blank = auto-detect)' },
  { key: 'adminPassword', env: 'ADMIN_PASSWORD', def: '', type: 'string', section: 'server', restart: true, secret: true, desc: 'Dashboard password (env only)' },
  { key: 'logLevel', env: 'LOG_LEVEL', def: 'info', type: 'enum', options: ['debug', 'info', 'warn', 'error'], section: 'server' },
  { key: 'corsOrigins', env: 'CORS_ORIGINS', def: '*', type: 'string', section: 'server', desc: 'Comma list of allowed origins, or *' },

  // ---- storage (restart required) ----
  { key: 'dbDriver', env: 'DB_DRIVER', def: 'sqlite', type: 'enum', options: ['sqlite', 'postgres'], section: 'storage', restart: true },
  { key: 'sqlitePath', env: 'SQLITE_PATH', def: './data/app.db', type: 'string', section: 'storage', restart: true },
  { key: 'databaseUrl', env: 'DATABASE_URL', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 'fileStore', env: 'FILE_STORE', def: 'local', type: 'enum', options: ['local', 's3'], section: 'storage', restart: true },
  { key: 'fileDir', env: 'FILE_DIR', def: './data/files', type: 'string', section: 'storage', restart: true },
  { key: 's3Bucket', env: 'S3_BUCKET', def: '', type: 'string', section: 'storage', restart: true },
  { key: 's3Region', env: 'S3_REGION', def: 'us-east-1', type: 'string', section: 'storage', restart: true },
  { key: 's3Endpoint', env: 'S3_ENDPOINT', def: '', type: 'string', section: 'storage', restart: true },
  { key: 's3AccessKeyId', env: 'S3_ACCESS_KEY_ID', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 's3SecretAccessKey', env: 'S3_SECRET_ACCESS_KEY', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 's3ForcePathStyle', env: 'S3_FORCE_PATH_STYLE', def: false, type: 'bool', section: 'storage', restart: true },
  { key: 's3Prefix', env: 'S3_PREFIX', def: 'files/', type: 'string', section: 'storage', restart: true, desc: 'Object key prefix (lets several instances share a bucket)' },
  { key: 'maxFileSizeMb', env: 'MAX_FILE_SIZE_MB', def: 100, type: 'int', section: 'storage', min: 1 },

  // ---- seed ----
  { key: 'seedOnStart', env: 'SEED_ON_START', def: 'if-empty', type: 'enum', options: ['always', 'if-empty', 'never'], section: 'seed' },
  { key: 'seedEmployees', env: 'SEED_EMPLOYEES', def: 250, type: 'int', section: 'seed', min: 0 },
  { key: 'seedProducts', env: 'SEED_PRODUCTS', def: 500, type: 'int', section: 'seed', min: 0 },
  { key: 'seedRandomSeed', env: 'SEED_RANDOM_SEED', def: 42, type: 'int', section: 'seed' },
  { key: 'seedSampleFiles', env: 'SEED_SAMPLE_FILES', def: true, type: 'bool', section: 'seed' },

  // ---- dates ----
  { key: 'dateFormat', env: 'DATE_FORMAT', def: 'iso', type: 'enum', options: ['iso', 'iso-offset', 'epoch-s', 'epoch-ms', 'rfc1123', 'custom'], section: 'dates' },
  { key: 'dateFormatPattern', env: 'DATE_FORMAT_PATTERN', def: 'YYYY-MM-DD HH:mm:ss', type: 'string', section: 'dates', desc: 'dayjs tokens (custom only)' },
  { key: 'dateTzOffset', env: 'DATE_TZ_OFFSET', def: '+00:00', type: 'string', section: 'dates', pattern: /^[+-]\d{2}:\d{2}$/ },

  // ---- auth ----
  { key: 'authMode', env: 'AUTH_MODE', def: 'none', type: 'enum', options: ['none', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2', 'hmac'], section: 'auth' },
  { key: 'apiKey', env: 'API_KEY', def: 'demo-key', type: 'string', section: 'auth', secret: true },
  { key: 'apiKeyName', env: 'API_KEY_NAME', def: 'X-API-Key', type: 'string', section: 'auth' },
  { key: 'apiKeyIn', env: 'API_KEY_IN', def: 'header', type: 'enum', options: ['header', 'query'], section: 'auth' },
  { key: 'basicUser', env: 'BASIC_USER', def: 'demo', type: 'string', section: 'auth' },
  { key: 'basicPass', env: 'BASIC_PASS', def: 'demo', type: 'string', section: 'auth', secret: true },
  { key: 'bearerToken', env: 'BEARER_TOKEN', def: 'demo-token', type: 'string', section: 'auth', secret: true },
  { key: 'jwtAlg', env: 'JWT_ALG', def: 'RS256', type: 'enum', options: ['RS256', 'HS256'], section: 'auth' },
  { key: 'jwtSecret', env: 'JWT_SECRET', def: '', type: 'string', section: 'auth', secret: true, desc: 'HS256 secret (blank = auto-generate + persist)' },
  { key: 'jwtIssuer', env: 'JWT_ISSUER', def: '', type: 'string', section: 'auth', desc: 'blank = public base URL' },
  { key: 'jwtAudience', env: 'JWT_AUDIENCE', def: 'api-test-tool', type: 'string', section: 'auth' },
  { key: 'hmacKeyId', env: 'HMAC_KEY_ID', def: 'demo', type: 'string', section: 'auth' },
  { key: 'hmacSecret', env: 'HMAC_SECRET', def: 'demo-hmac', type: 'string', section: 'auth', secret: true },
  { key: 'hmacMaxSkewSeconds', env: 'HMAC_MAX_SKEW_SECONDS', def: 300, type: 'int', section: 'auth', min: 1 },

  // ---- oauth ----
  { key: 'oauthClients', env: 'OAUTH_CLIENTS', def: 'demo-client:demo-secret:read write', type: 'string', section: 'oauth', desc: 'id:secret:scopes;… (dashboard-added clients are stored separately)' },
  { key: 'oauthUsers', env: 'OAUTH_USERS', def: 'demo:demo', type: 'string', section: 'oauth', desc: 'user:password;… for the authorization_code login page' },
  { key: 'oauthTokenTtl', env: 'OAUTH_TOKEN_TTL', def: 3600, type: 'int', section: 'oauth', min: 1 },
  { key: 'oauthRefreshTtl', env: 'OAUTH_REFRESH_TTL', def: 86400, type: 'int', section: 'oauth', min: 1 },

  // ---- chaos ----
  { key: 'errorRate', env: 'ERROR_RATE', def: 0, type: 'number', section: 'chaos', min: 0, max: 100 },
  { key: 'errorTypes', env: 'ERROR_TYPES', def: '500,503', type: 'string', section: 'chaos', desc: 'Comma list of status codes and/or type names' },
  { key: 'latencyMinMs', env: 'LATENCY_MIN_MS', def: 0, type: 'int', section: 'chaos', min: 0 },
  { key: 'latencyMaxMs', env: 'LATENCY_MAX_MS', def: 0, type: 'int', section: 'chaos', min: 0 },
  { key: 'chaosTimeoutSeconds', env: 'CHAOS_TIMEOUT_SECONDS', def: 0, type: 'int', section: 'chaos', min: 0, desc: '"timeout" hangs this long then drops the socket (0 = until client gives up, max 600)' },
  { key: 'chaosSlowDripMs', env: 'CHAOS_SLOW_DRIP_MS', def: 250, type: 'int', section: 'chaos', min: 1, desc: 'Delay between chunks for slow-drip' },
  { key: 'chaosRouteOverrides', env: 'CHAOS_ROUTE_OVERRIDES', def: [], type: 'json', section: 'chaos', desc: '[{path, method?, errorRate?, errorTypes?, latencyMinMs?, latencyMaxMs?}]' },

  // ---- rate limit ----
  { key: 'rateLimitRpm', env: 'RATE_LIMIT_RPM', def: 0, type: 'int', section: 'ratelimit', min: 0, desc: '0 = off' },

  // ---- headers ----
  { key: 'responseHeaders', env: 'RESPONSE_HEADERS', def: [], type: 'headerList', section: 'headers', desc: 'Name:Value;Name2:Value2' },
  { key: 'requiredHeaders', env: 'REQUIRED_HEADERS', def: [], type: 'requiredHeaders', section: 'headers', desc: 'Name,Name2=expected' },

  // ---- soap ----
  { key: 'soapEnabled', env: 'SOAP_ENABLED', def: true, type: 'bool', section: 'soap', desc: 'serve the mock SOAP services under /soap' },
  { key: 'soapWsse', env: 'SOAP_WSSE', def: 'off', type: 'enum', options: ['off', 'optional', 'required'], section: 'soap', desc: 'WS-Security UsernameToken (BASIC_USER / BASIC_PASS; PasswordText or PasswordDigest). Independent of AUTH_MODE' },
  { key: 'soapActionCheck', env: 'SOAP_ACTION_CHECK', def: 'lenient', type: 'enum', options: ['lenient', 'strict', 'off'], section: 'soap', desc: 'lenient: a wrong SOAPAction is a fault, a missing one is accepted; strict: it must be present and right; off: not checked' },

  // ---- websocket ----
  { key: 'wsEnabled', env: 'WS_ENABLED', def: true, type: 'bool', section: 'websocket', desc: 'serve the mock WebSocket channels under /ws (echo, rpc, changes)' },
  { key: 'wsMaxMessageKb', env: 'WS_MAX_MESSAGE_KB', def: 1024, type: 'int', section: 'websocket', min: 1, desc: 'Larger messages close the connection with 1009' },
  { key: 'wsIdleTimeoutSeconds', env: 'WS_IDLE_TIMEOUT_SECONDS', def: 0, type: 'int', section: 'websocket', min: 0, desc: 'Close connections that send nothing for this long (1001); 0 = never' },
  { key: 'wsPingIntervalSeconds', env: 'WS_PING_INTERVAL_SECONDS', def: 30, type: 'int', section: 'websocket', min: 0, desc: 'Server ping interval; a connection that misses a pong is dropped. 0 = no pings' },

  // ---- inspector ----
  { key: 'inspectorRetention', env: 'INSPECTOR_RETENTION', def: 500, type: 'int', section: 'inspector', min: 1 },
  { key: 'inspectorLogAll', env: 'INSPECTOR_LOG_ALL', def: true, type: 'bool', section: 'inspector', desc: 'also record /v1/*, /soap/*, /ws/* (upgrades) and /oauth/* calls (the dashboard, docs and health probes are never recorded)' },
  { key: 'inspectorResponseStatus', env: 'INSPECTOR_RESPONSE_STATUS', def: 200, type: 'int', section: 'inspector', min: 100, max: 599 },
  { key: 'inspectorResponseContentType', env: 'INSPECTOR_RESPONSE_CONTENT_TYPE', def: 'application/json', type: 'string', section: 'inspector' },
  { key: 'inspectorResponseBody', env: 'INSPECTOR_RESPONSE_BODY', def: '', type: 'string', section: 'inspector', desc: 'blank = JSON receipt with the capture id' },
  { key: 'inspectorResponseHeaders', env: 'INSPECTOR_RESPONSE_HEADERS', def: [], type: 'headerList', section: 'inspector' },
  { key: 'inspectorResponseDelayMs', env: 'INSPECTOR_RESPONSE_DELAY_MS', def: 0, type: 'int', section: 'inspector', min: 0 },
  { key: 'inspectorRules', env: 'INSPECTOR_RULES', def: [], type: 'json', section: 'inspector', desc: '[{method?, path, status, contentType?, body?, headers?, delayMs?}] first match wins' },
  { key: 'inspectorForwardEnabled', env: 'INSPECTOR_FORWARD_ENABLED', def: false, type: 'bool', section: 'inspector' },
  { key: 'inspectorForwardUrl', env: 'INSPECTOR_FORWARD_URL', def: '', type: 'string', section: 'inspector' },
];

const BY_KEY = Object.fromEntries(DEFS.map((d) => [d.key, d]));

function parseHeaderList(v) {
  if (Array.isArray(v)) return v.filter((h) => h && h.name).map((h) => ({ name: String(h.name).trim(), value: String(h.value ?? '') }));
  if (!v) return [];
  return String(v).split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf(':');
    return i === -1 ? { name: pair, value: '' } : { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  }).filter((h) => h.name);
}

function parseRequiredHeaders(v) {
  if (Array.isArray(v)) return v.filter((h) => h && h.name).map((h) => ({ name: String(h.name).trim(), value: h.value ? String(h.value) : undefined }));
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf('=');
    return i === -1 ? { name: item } : { name: item.slice(0, i).trim(), value: item.slice(i + 1).trim() };
  });
}

function coerce(def, raw) {
  if (raw === undefined || raw === null) return raw;
  switch (def.type) {
    case 'int':
    case 'number': {
      const n = def.type === 'int' ? parseInt(raw, 10) : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${def.key}: expected a number`);
      if (def.min !== undefined && n < def.min) throw new Error(`${def.key}: must be >= ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${def.key}: must be <= ${def.max}`);
      return n;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'enum':
      if (!def.options.includes(String(raw))) throw new Error(`${def.key}: must be one of ${def.options.join(', ')}`);
      return String(raw);
    case 'json':
      if (typeof raw === 'string') {
        if (!raw.trim()) return def.def;
        try { return JSON.parse(raw); } catch { throw new Error(`${def.key}: invalid JSON`); }
      }
      return raw;
    case 'headerList':
      return parseHeaderList(raw);
    case 'requiredHeaders':
      return parseRequiredHeaders(raw);
    default: {
      const s = String(raw);
      if (def.pattern && s && !def.pattern.test(s)) throw new Error(`${def.key}: invalid format`);
      return s;
    }
  }
}

class Settings extends EventEmitter {
  constructor(env = process.env) {
    super();
    this.env = env;
    this.overrides = {};
    this.repo = null;
    this.envValues = {};
    for (const d of DEFS) {
      if (env[d.env] !== undefined && env[d.env] !== '') {
        try { this.envValues[d.key] = coerce(d, env[d.env]); } catch (e) {
          console.warn(`[settings] ignoring ${d.env}: ${e.message}`);
        }
      }
    }
  }

  // Attach the repo and load persisted overrides.
  async attach(repo) {
    this.repo = repo;
    const docs = await repo.list('settings');
    for (const doc of docs) {
      const d = BY_KEY[doc.key];
      if (!d || d.restart) continue;
      try { this.overrides[doc.key] = coerce(d, doc.value); } catch { /* skip invalid */ }
    }
  }

  get(key) {
    if (key in this.overrides) return this.overrides[key];
    if (key in this.envValues) return this.envValues[key];
    const d = BY_KEY[key];
    if (!d) throw new Error(`Unknown setting ${key}`);
    return typeof d.def === 'object' ? JSON.parse(JSON.stringify(d.def)) : d.def;
  }

  source(key) {
    if (key in this.overrides) return 'override';
    if (key in this.envValues) return 'env';
    return 'default';
  }

  describe({ revealSecrets = true } = {}) {
    return DEFS.map((d) => ({
      key: d.key,
      env: d.env,
      section: d.section,
      type: d.type,
      options: d.options,
      description: d.desc || '',
      restartRequired: !!d.restart,
      secret: !!d.secret,
      value: d.secret && !revealSecrets ? (this.get(d.key) ? '********' : '') : this.get(d.key),
      envValue: d.secret && !revealSecrets ? undefined : this.envValues[d.key],
      default: d.def,
      source: this.source(d.key),
    }));
  }

  async set(key, value) {
    const d = BY_KEY[key];
    if (!d) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
    if (d.restart) throw Object.assign(new Error(`${key} requires a restart and can only be set via ${d.env}`), { status: 400 });
    let v;
    try { v = coerce(d, value); } catch (e) { throw Object.assign(e, { status: 400 }); }
    this.overrides[key] = v;
    if (this.repo) await this.repo.put('settings', key, { key, value: v });
    this.emit('change', { key, value: v });
    return v;
  }

  async setMany(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = await this.set(k, v);
    return out;
  }

  async reset({ key, section } = {}) {
    const keys = Object.keys(this.overrides).filter((k) => (key ? k === key : section ? BY_KEY[k].section === section : true));
    for (const k of keys) {
      delete this.overrides[k];
      if (this.repo) await this.repo.del('settings', k);
      this.emit('change', { key: k, value: this.get(k) });
    }
    return keys;
  }

  sections() {
    return [...new Set(DEFS.map((d) => d.section))];
  }
}

module.exports = { Settings, DEFS, parseHeaderList, parseRequiredHeaders };
