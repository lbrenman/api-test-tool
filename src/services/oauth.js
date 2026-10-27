'use strict';
// Built-in OAuth 2.0 authorization server logic: clients, users, codes (PKCE), tokens, refresh, introspection, revocation.
// Clients authenticate with a secret (Basic or form), or with a signed JWT (RFC 7523): private_key_jwt against the
// client's public keys (jwks or jwks_uri), client_secret_jwt with an HMAC over its secret.
const crypto = require('node:crypto');
const { fetchJson, FetchRefused } = require('../util/safeFetch');

class OAuthError extends Error {
  constructor(error, description, status = 400, headers = undefined) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
    this.headers = headers;
  }
}

const GRANTS = ['authorization_code', 'refresh_token', 'client_credentials'];
const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'client_secret_jwt', 'private_key_jwt', 'none'];
const JWT_METHODS = ['client_secret_jwt', 'private_key_jwt'];
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const KEY_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const SECRET_ALGS = ['HS256', 'HS384', 'HS512'];
const MAX_ASSERTION_LIFETIME_S = 3600;
const JWKS_CACHE_MS = 300000;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The caller's IP for per-client limits. On Fly.io the edge sets Fly-Client-IP (a client cannot forge it there);
 * elsewhere req.ip, which with `trust proxy` is the left-most X-Forwarded-For entry.
 */
function clientIp(req) {
  if (process.env.FLY_APP_NAME && req.get('fly-client-ip')) return req.get('fly-client-ip');
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Claims set by the server itself; a user attribute may not use these names.
const RESERVED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti', 'scope', 'client_id', 'token_use', 'azp', 'preferred_username'];

function safeEq(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class OAuthService {
  constructor(ctx) {
    this.ctx = ctx;
    this.codes = new Map();
    this.revoked = new Set();
    this.registrations = new Map(); // client IP -> timestamps of its open registrations in the last hour
    this.assertionIds = new Map(); // "<client>:<jti>" of client assertions already used -> their exp (ms), against replay
    this.jwksCache = new Map(); // jwks_uri -> { at, jwks }
  }

  async init() {
    for (const d of await this.ctx.repo.list('oauth_revoked')) this.revoked.add(d.jti);
    // Clients registered before last-use tracking existed have no lastUsedAt: give them a fresh start rather than
    // pruning them by their creation date (they may be MCP clients in daily use).
    const now = new Date().toISOString();
    for (const c of await this.ctx.repo.list('oauth_clients')) {
      if (c.source === 'registered' && c.lastUsedAt === undefined) await this.ctx.repo.put('oauth_clients', c.clientId, { ...c, lastUsedAt: now });
    }
    await this.pruneRegisteredClients();
    this.pruneTimer = setInterval(() => {
      this.pruneRegisteredClients().catch(() => {});
      for (const [k, exp] of this.assertionIds) if (exp < Date.now()) this.assertionIds.delete(k);
      const cutoff = Date.now() - HOUR_MS;
      for (const [ip, times] of this.registrations) {
        const recent = times.filter((t) => t > cutoff);
        if (recent.length) this.registrations.set(ip, recent); else this.registrations.delete(ip);
      }
    }, HOUR_MS);
    this.pruneTimer.unref();
  }

  close() { clearInterval(this.pruneTimer); }

  issuer(req) { return this.ctx.settings.get('jwtIssuer') || this.ctx.baseUrl.root(req); } // one server for every profile

  audience() { return this.ctx.settings.get('jwtAudience'); }

  envClients() {
    return String(this.ctx.settings.get('oauthClients') || '').split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const [clientId, secret = '', ...rest] = entry.split(':');
      const scopes = rest.join(':').split(/[\s,]+/).filter(Boolean);
      return { clientId, secret, scopes: scopes.length ? scopes : ['read', 'write'], redirectUris: [], source: 'env' };
    });
  }

  async clients() {
    const envIds = new Set(this.envClients().map((c) => c.clientId));
    const extra = (await this.ctx.repo.list('oauth_clients')).map((c) => ({ ...c, source: c.source || 'dashboard', ...(envIds.has(c.clientId) ? { overridesEnv: true } : {}) }));
    const env = this.envClients().filter((c) => !extra.some((x) => x.clientId === c.clientId));
    return [...env, ...extra];
  }

  async client(id) { return (await this.clients()).find((c) => c.clientId === id) || null; }

  async addClient({ clientId, secret, scopes, redirectUris, jwks, jwksUri, tokenEndpointAuthMethod }) {
    if (!clientId || !/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) throw new OAuthError('invalid_request', 'clientId must be 3-64 chars [A-Za-z0-9._-]');
    const doc = await this.applyKeyPatch({
      clientId,
      secret: secret === undefined ? crypto.randomBytes(18).toString('base64url') : String(secret),
      scopes: (Array.isArray(scopes) ? scopes : String(scopes || 'read write').split(/[\s,]+/)).filter(Boolean),
      redirectUris: OAuthService.checkRedirectUris((Array.isArray(redirectUris) ? redirectUris : String(redirectUris || '').split(/[\s,]+/)).filter(Boolean)),
      createdAt: new Date().toISOString(),
    }, { jwks, jwksUri, tokenEndpointAuthMethod });
    await this.ctx.repo.put('oauth_clients', clientId, doc);
    return doc;
  }

  /**
   * How a client authenticates: tokenEndpointAuthMethod, jwks (JWKS, JWK or PEM), jwksUri, and the key pair the
   * dashboard generated (assertionKey; null removes it). Fields left out are kept. Mutates doc.
   */
  async applyKeyPatch(doc, patch) {
    if (patch.jwks !== undefined) {
      const jwks = await this.normalizeJwks(patch.jwks);
      if (jwks) doc.jwks = jwks; else delete doc.jwks;
      if (doc.assertionKey && !jwks?.keys.some((k) => k.kid === doc.assertionKey.kid)) delete doc.assertionKey;
    }
    if (patch.jwksUri !== undefined) {
      if (patch.jwksUri) {
        let url;
        try { url = new URL(String(patch.jwksUri)); } catch { throw new OAuthError('invalid_request', 'jwksUri must be an absolute URL'); }
        if (!/^https?:$/.test(url.protocol)) throw new OAuthError('invalid_request', 'jwksUri must be an https URL');
        doc.jwksUri = url.toString();
        this.jwksCache.delete(doc.jwksUri);
      } else delete doc.jwksUri;
    }
    if (patch.assertionKey !== undefined) {
      if (patch.assertionKey) doc.assertionKey = patch.assertionKey; else delete doc.assertionKey;
    }
    if (patch.tokenEndpointAuthMethod !== undefined) {
      const m = patch.tokenEndpointAuthMethod || undefined;
      if (m && !AUTH_METHODS.includes(m)) throw new OAuthError('invalid_request', `tokenEndpointAuthMethod must be one of ${AUTH_METHODS.join(', ')}`);
      if (m === 'none' && !doc.public) throw new OAuthError('invalid_request', 'Only a registered public client uses "none"');
      if (m) doc.tokenEndpointAuthMethod = m; else delete doc.tokenEndpointAuthMethod;
    }
    if (doc.tokenEndpointAuthMethod === 'private_key_jwt' && !doc.jwks?.keys?.length && !doc.jwksUri) {
      throw new OAuthError('invalid_request', 'private_key_jwt needs the client\'s public keys: set jwks (or generate a key pair) or jwksUri');
    }
    return doc;
  }

  async removeClient(clientId) { return this.ctx.repo.del('oauth_clients', clientId); }

  /** Check redirect URIs: absolute, no fragment, no script/data/file schemes. Throws OAuthError(code). */
  static checkRedirectUris(uris, code = 'invalid_request') {
    for (const u of uris) {
      let url;
      try { url = new URL(u); } catch { throw new OAuthError(code, `"${u}" is not an absolute URI`); }
      if (url.hash) throw new OAuthError(code, `"${u}" must not contain a fragment`);
      if (/^(javascript|data|vbscript|file):$/i.test(url.protocol)) throw new OAuthError(code, `The ${url.protocol} scheme is not allowed in a redirect URI`);
    }
    return uris;
  }

  /**
   * Edit a client from the dashboard: secret, scopes, redirect URIs, grant types, name. Fields left out are kept.
   * A dashboard or registered client is updated in place; an env client (OAUTH_CLIENTS) gets a stored copy that
   * takes precedence over the env entry (deleting the copy reverts to the env values).
   */
  async updateClient(clientId, patch = {}) {
    const current = await this.client(clientId);
    if (!current) return null;
    const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    const { source, ...base } = current;
    const doc = { ...base, source: source === 'env' ? 'dashboard' : source };
    if (source === 'env') { doc.overridesEnv = true; doc.createdAt = new Date().toISOString(); }
    if (patch.secret !== undefined) {
      if (doc.public) throw new OAuthError('invalid_request', 'A public client has no secret');
      doc.secret = patch.secret === '' || patch.secret === null ? crypto.randomBytes(18).toString('base64url') : String(patch.secret);
    }
    if (patch.scopes !== undefined) {
      const scopes = list(patch.scopes);
      if (!scopes.length) throw new OAuthError('invalid_request', 'A client needs at least one scope');
      doc.scopes = scopes;
    }
    if (patch.redirectUris !== undefined) doc.redirectUris = OAuthService.checkRedirectUris(list(patch.redirectUris));
    if (patch.grantTypes !== undefined) {
      const grants = list(patch.grantTypes);
      const bad = grants.find((g) => !['authorization_code', 'refresh_token', 'client_credentials'].includes(g));
      if (bad) throw new OAuthError('invalid_request', `Unsupported grant type "${bad}"`);
      if (doc.public && grants.includes('client_credentials')) throw new OAuthError('invalid_request', 'A public client cannot use client_credentials');
      doc.grantTypes = grants.length ? grants : undefined;
      if (!grants.length) delete doc.grantTypes;
    }
    if (patch.clientName !== undefined) {
      if (patch.clientName) doc.clientName = String(patch.clientName).slice(0, 200); else delete doc.clientName;
    }
    await this.applyKeyPatch(doc, patch);
    if (doc.grantTypes?.includes('authorization_code') && doc.source === 'registered' && !doc.redirectUris?.length) {
      throw new OAuthError('invalid_request', 'A registered client with the authorization_code grant needs at least one redirect URI');
    }
    doc.updatedAt = new Date().toISOString();
    await this.ctx.repo.put('oauth_clients', clientId, doc);
    return doc;
  }

  // ---- Dynamic client registration (RFC 7591) and its management endpoint (RFC 7592: read, delete) ----

  registrationScopes() { return String(this.ctx.settings.get('oauthRegistrationScopes') || '').split(/[\s,]+/).filter(Boolean); }

  /** Check the initial access token when registration needs one. Throws OAuthError. */
  checkRegistrationAccess(req) {
    const mode = this.ctx.settings.get('oauthRegistration');
    if (mode === 'off') throw new OAuthError('registration_not_supported', 'Dynamic client registration is turned off (OAUTH_REGISTRATION=off)', 404);
    if (mode !== 'token') return;
    const expected = this.ctx.settings.get('oauthRegistrationToken');
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!expected) throw new OAuthError('access_denied', 'Registration needs an initial access token, but OAUTH_REGISTRATION_TOKEN is not set', 403);
    if (!m || !safeEq(m[1].trim(), expected)) throw new OAuthError('invalid_token', 'A valid initial access token is required (Authorization: Bearer …)', 401);
  }

  /** Grant types an open registration may ask for (OAUTH_REGISTRATION_GRANTS, limited to the supported ones). */
  openRegistrationGrants() {
    return String(this.ctx.settings.get('oauthRegistrationGrants') || '').split(/[\s,]+/).filter((g) => GRANTS.includes(g));
  }

  /** Per-IP limit for open registration. Throws a 429 OAuthError with Retry-After. */
  checkRegistrationRate(ip) {
    const limit = this.ctx.settings.get('oauthRegistrationRate');
    if (!limit) return;
    const now = Date.now();
    const recent = (this.registrations.get(ip) || []).filter((t) => t > now - HOUR_MS);
    this.registrations.set(ip, recent);
    if (recent.length >= limit) {
      const retry = Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 1000));
      throw new OAuthError('rate_limited', `At most ${limit} registrations per hour from one address (OAUTH_REGISTRATION_RATE); retry in ${retry} s`, 429, { 'Retry-After': String(retry) });
    }
  }

  /** Delete registered clients that have not obtained a token for OAUTH_REGISTRATION_TTL_DAYS. Returns how many. */
  async pruneRegisteredClients() {
    const days = this.ctx.settings.get('oauthRegistrationTtlDays');
    if (!days) return 0;
    const cutoff = Date.now() - days * DAY_MS;
    let n = 0;
    for (const c of await this.ctx.repo.list('oauth_clients')) {
      if (c.source !== 'registered') continue;
      if (new Date(c.lastUsedAt || c.createdAt).getTime() < cutoff) { await this.ctx.repo.del('oauth_clients', c.clientId); n += 1; }
    }
    return n;
  }

  /** Delete registered clients (all of them, or only the never-used ones). Returns how many. */
  async removeRegisteredClients({ unusedOnly = false } = {}) {
    let n = 0;
    for (const c of await this.ctx.repo.list('oauth_clients')) {
      if (c.source !== 'registered' || (unusedOnly && c.lastUsedAt)) continue;
      await this.ctx.repo.del('oauth_clients', c.clientId);
      n += 1;
    }
    return n;
  }

  /** Record that a registered client obtained a token (at most one write per client per hour). */
  async markUsed(client) {
    if (client?.source !== 'registered') return;
    if (client.lastUsedAt && Date.now() - new Date(client.lastUsedAt).getTime() < HOUR_MS) return;
    const doc = await this.ctx.repo.get('oauth_clients', client.clientId);
    if (doc) await this.ctx.repo.put('oauth_clients', doc.clientId, { ...doc, lastUsedAt: new Date().toISOString() });
  }

  /**
   * Validate RFC 7591 client metadata and store the client. Returns the stored client.
   * Open registration (no initial access token) is restricted: only OAUTH_REGISTRATION_GRANTS, redirect URIs that
   * are https, loopback http or a custom scheme, and OAUTH_REGISTRATION_RATE per IP. Pass { trusted: true } when the
   * caller presented the initial access token.
   */
  async registerClient(meta, { trusted = false, ip = 'unknown' } = {}) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new OAuthError('invalid_client_metadata', 'The request body must be a JSON object of client metadata');
    const bad = (d) => new OAuthError('invalid_client_metadata', d);
    const list = (v, name, max = 20) => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${name} must be an array of strings`);
      if (v.length > max) throw bad(`${name} may have at most ${max} entries`);
      return v;
    };
    const authMethod = meta.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!AUTH_METHODS.includes(authMethod)) throw bad(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
    if (meta.jwks !== undefined && meta.jwks_uri !== undefined) throw bad('Use jwks or jwks_uri, not both');
    let jwks;
    if (meta.jwks !== undefined) {
      if (!meta.jwks || typeof meta.jwks !== 'object' || !Array.isArray(meta.jwks.keys)) throw bad('jwks must be a JWK Set object ({"keys": […]})');
      try { jwks = await this.normalizeJwks(meta.jwks); } catch (e) { throw bad(`jwks: ${e.message}`); }
    }
    let jwksUri;
    if (meta.jwks_uri !== undefined) {
      if (typeof meta.jwks_uri !== 'string' || meta.jwks_uri.length > 2000) throw bad('jwks_uri must be a URL string');
      let u;
      try { u = new URL(meta.jwks_uri); } catch { throw bad('jwks_uri must be an absolute URL'); }
      if (u.protocol !== 'https:' && !(trusted && u.protocol === 'http:')) throw bad('jwks_uri must use https');
      jwksUri = u.toString();
    }
    if (authMethod === 'private_key_jwt' && !jwks && !jwksUri) throw bad('private_key_jwt needs jwks or jwks_uri');
    const grantTypes = list(meta.grant_types, 'grant_types') || ['authorization_code'];
    const unknownGrant = grantTypes.find((g) => !GRANTS.includes(g));
    if (unknownGrant) throw bad(`Unsupported grant type "${unknownGrant}" (supported: ${GRANTS.join(', ')})`);
    if (!trusted) {
      const allowedGrants = this.openRegistrationGrants();
      const refused = grantTypes.filter((g) => !allowedGrants.includes(g));
      if (refused.length) {
        throw bad(`Grant type ${refused.join(', ')} is not allowed for open registration (allowed: ${allowedGrants.join(' ') || 'none'}). `
          + 'Ask the administrator for an initial access token (OAUTH_REGISTRATION=token) or a client added on the Auth page');
      }
    }
    const responseTypes = list(meta.response_types, 'response_types') || (grantTypes.includes('authorization_code') ? ['code'] : []);
    if (responseTypes.some((r) => r !== 'code')) throw bad('Only the "code" response type is supported');
    if (authMethod === 'none' && grantTypes.includes('client_credentials')) throw bad('A public client (token_endpoint_auth_method "none") cannot use client_credentials');
    const redirectUris = list(meta.redirect_uris, 'redirect_uris', 10) || [];
    if (grantTypes.includes('authorization_code') && !redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required for the authorization_code grant');
    const longUri = redirectUris.find((u) => u.length > 2000);
    if (longUri) throw new OAuthError('invalid_redirect_uri', 'A redirect URI may be at most 2000 characters');
    OAuthService.checkRedirectUris(redirectUris, 'invalid_redirect_uri');
    if (!trusted) {
      // Plain http only to loopback (RFC 8252 native apps); https and private-use schemes (myapp://) are fine.
      const insecure = redirectUris.find((u) => { const url = new URL(u); return url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname); });
      if (insecure) throw new OAuthError('invalid_redirect_uri', `"${insecure}" must use https; plain http is only allowed for loopback addresses (127.0.0.1, localhost, [::1])`);
    }
    const allowed = this.registrationScopes();
    let scopes = allowed;
    if (meta.scope !== undefined && meta.scope !== null && String(meta.scope).trim()) {
      scopes = String(meta.scope).split(/\s+/).filter(Boolean);
      const notAllowed = scopes.filter((x) => !allowed.includes(x));
      if (notAllowed.length) throw bad(`Scope not allowed for registered clients: ${notAllowed.join(' ')} (allowed: ${allowed.join(' ')})`);
    }
    const str = (k, max = 500) => {
      if (meta[k] === undefined || meta[k] === null) return undefined;
      if (typeof meta[k] !== 'string' || meta[k].length > max) throw bad(`${k} must be a string of at most ${max} characters`);
      return meta[k];
    };
    const contacts = list(meta.contacts, 'contacts', 10);
    if (!trusted) this.checkRegistrationRate(ip);
    await this.pruneRegisteredClients();
    const registered = (await this.ctx.repo.list('oauth_clients')).filter((c) => c.source === 'registered');
    const max = this.ctx.settings.get('oauthRegistrationMax');
    if (registered.length >= max) {
      // Make room by dropping the oldest registrations that never obtained a token, so a burst of junk
      // registrations cannot lock out real clients; clients that have been used are never evicted.
      const unused = registered.filter((c) => !c.lastUsedAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const excess = registered.length - max + 1;
      if (unused.length < excess) throw new OAuthError('access_denied', 'The registered-client limit is reached; delete registered clients on the Auth page or raise OAUTH_REGISTRATION_MAX', 403);
      for (const c of unused.slice(0, excess)) await this.ctx.repo.del('oauth_clients', c.clientId);
    }
    const regToken = crypto.randomBytes(32).toString('base64url');
    const doc = {
      clientId: `dcr-${crypto.randomBytes(12).toString('base64url')}`,
      secret: authMethod === 'none' || authMethod === 'private_key_jwt' ? '' : crypto.randomBytes(24).toString('base64url'),
      scopes,
      redirectUris,
      source: 'registered',
      public: authMethod === 'none',
      tokenEndpointAuthMethod: authMethod,
      ...(jwks ? { jwks } : {}),
      ...(jwksUri ? { jwksUri } : {}),
      grantTypes,
      responseTypes,
      clientName: str('client_name', 200),
      clientUri: str('client_uri'),
      logoUri: str('logo_uri'),
      softwareId: str('software_id', 200),
      softwareVersion: str('software_version', 100),
      contacts,
      registrationTokenHash: crypto.createHash('sha256').update(regToken).digest('hex'),
      registeredFrom: ip,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await this.ctx.repo.put('oauth_clients', doc.clientId, doc);
    if (!trusted) this.registrations.set(ip, [...(this.registrations.get(ip) || []), Date.now()]);
    return { client: doc, registrationAccessToken: regToken };
  }

  /** RFC 7591 response body for a registered client. */
  registrationResponse(client, base, registrationAccessToken) {
    const out = {
      client_id: client.clientId,
      ...(client.secret ? { client_secret: client.secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      redirect_uris: client.redirectUris,
      scope: client.scopes.join(' '),
      registration_client_uri: `${base}/oauth/register/${encodeURIComponent(client.clientId)}`,
    };
    if (registrationAccessToken) out.registration_access_token = registrationAccessToken;
    for (const [k, v] of [['client_name', client.clientName], ['client_uri', client.clientUri], ['logo_uri', client.logoUri], ['contacts', client.contacts], ['software_id', client.softwareId], ['software_version', client.softwareVersion], ['jwks', client.jwks], ['jwks_uri', client.jwksUri]]) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** The registered client a registration access token (Bearer) belongs to. Throws OAuthError. */
  async registeredClientFor(req, clientId) {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!m) throw new OAuthError('invalid_token', 'The registration access token is required (Authorization: Bearer …)', 401);
    const doc = await this.ctx.repo.get('oauth_clients', clientId);
    const hash = crypto.createHash('sha256').update(m[1].trim()).digest('hex');
    if (!doc || doc.source !== 'registered' || !safeEq(doc.registrationTokenHash, hash)) {
      throw new OAuthError('invalid_token', 'The registration access token is not valid for this client', 401);
    }
    return doc;
  }

  /** Redirect URI check: exact match, or a loopback http URI that differs only in its port (RFC 8252 7.3). */
  static redirectAllowed(client, uri) {
    if (!client.redirectUris?.length) return /^https?:\/\//i.test(uri || '');
    if (client.redirectUris.includes(uri)) return true;
    let given;
    try { given = new URL(uri); } catch { return false; }
    const loop = (u) => u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!loop(given)) return false;
    return client.redirectUris.some((r) => {
      try {
        const reg = new URL(r);
        return loop(reg) && reg.hostname === given.hostname && reg.pathname === given.pathname && reg.search === given.search;
      } catch { return false; }
    });
  }

  // ---- Users for the authorization_code login page, with roles and attributes that go into their tokens ----

  /**
   * Users from OAUTH_USERS: `user:password[:roles[:attributes]]` separated by `;`, roles comma separated,
   * attributes `key=value` comma separated (a value that parses as JSON is kept as JSON: numbers, booleans, arrays).
   */
  envUsers() {
    return String(this.ctx.settings.get('oauthUsers') || '').split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const [username, password = '', roles = '', ...rest] = entry.split(':');
      const attributes = {};
      for (const pair of OAuthService.splitTopLevel(rest.join(':')).map((s) => s.trim()).filter(Boolean)) {
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        attributes[pair.slice(0, i).trim()] = OAuthService.attributeValue(pair.slice(i + 1).trim());
      }
      return { username, password, roles: roles.split(',').map((r) => r.trim()).filter(Boolean), attributes, source: 'env' };
    }).filter((u) => u.username);
  }

  /** Split on commas that are not inside [], {} or double quotes, so `tags=["a","b"],tier=gold` is two attributes. */
  static splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let cur = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '\\') { cur += ch + (text[i + 1] ?? ''); i += 1; continue; }
        if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '[' || ch === '{') depth += 1;
      else if ((ch === ']' || ch === '}') && depth > 0) depth -= 1;
      else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  }

  static attributeValue(raw) {
    if (raw === '') return '';
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async users() {
    const envNames = new Set(this.envUsers().map((u) => u.username));
    const stored = (await this.ctx.repo.list('oauth_users')).map((u) => ({ ...u, source: 'dashboard', ...(envNames.has(u.username) ? { overridesEnv: true } : {}) }));
    const env = this.envUsers().filter((u) => !stored.some((s) => s.username === u.username));
    return [...env, ...stored];
  }

  async user(username) { return (await this.users()).find((u) => u.username === username) || null; }

  /** The user for a username and password, or null. */
  async checkUser(username, password) {
    const u = await this.user(String(username ?? ''));
    return u && safeEq(u.password, password) ? u : null;
  }

  /** Where roles go in a user's token: dotted claim paths from OAUTH_ROLES_CLAIM (default realm_access.roles). */
  rolesClaimPaths() {
    return String(this.ctx.settings.get('oauthRolesClaim') || '').split(/[\s,]+/).filter(Boolean).map((p) => p.split('.').filter(Boolean)).filter((p) => p.length);
  }

  /** Claim names an attribute may not use: the standard JWT claims, the server's own, and the roles claim's top level. */
  reservedClaims() {
    return new Set([...RESERVED_CLAIMS, ...this.rolesClaimPaths().map((p) => p[0])]);
  }

  static parseRoles(v) {
    const roles = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((r) => String(r).trim()).filter(Boolean);
    return [...new Set(roles)];
  }

  parseAttributes(v) {
    let attrs = v;
    if (typeof attrs === 'string') {
      if (!attrs.trim()) attrs = {};
      else {
        try { attrs = JSON.parse(attrs); } catch { throw new OAuthError('invalid_request', 'attributes must be a JSON object'); }
      }
    }
    if (attrs === null || attrs === undefined) attrs = {};
    if (typeof attrs !== 'object' || Array.isArray(attrs)) throw new OAuthError('invalid_request', 'attributes must be a JSON object of claim names and values');
    const reserved = this.reservedClaims();
    for (const k of Object.keys(attrs)) {
      if (!k.trim() || k.length > 200) throw new OAuthError('invalid_request', 'Attribute names must be 1-200 characters');
      if (reserved.has(k)) throw new OAuthError('invalid_request', `"${k}" is a reserved claim and cannot be an attribute (reserved: ${[...reserved].join(', ')})`);
    }
    return attrs;
  }

  async addUser({ username, password, roles, attributes }) {
    if (!username || !/^[A-Za-z0-9._@+-]{1,64}$/.test(username)) throw new OAuthError('invalid_request', 'username must be 1-64 chars [A-Za-z0-9._@+-]');
    if (await this.user(username)) throw new OAuthError('invalid_request', `User ${username} already exists (edit it instead)`, 409);
    const doc = {
      username,
      password: password === undefined || password === null || password === '' ? crypto.randomBytes(9).toString('base64url') : String(password),
      roles: OAuthService.parseRoles(roles),
      attributes: this.parseAttributes(attributes),
      createdAt: new Date().toISOString(),
    };
    await this.ctx.repo.put('oauth_users', username, doc);
    return { ...doc, source: 'dashboard' };
  }

  /**
   * Edit a user: password, roles, attributes. Fields left out are kept. An env user (OAUTH_USERS) gets a stored
   * copy that takes precedence over the env entry; deleting the copy reverts to the env values.
   */
  async updateUser(username, patch = {}) {
    const current = await this.user(username);
    if (!current) return null;
    const { source, overridesEnv, ...base } = current; // eslint-disable-line no-unused-vars
    const doc = { ...base };
    if (source === 'env') doc.createdAt = new Date().toISOString();
    if (patch.password !== undefined) {
      doc.password = patch.password === '' || patch.password === null ? crypto.randomBytes(9).toString('base64url') : String(patch.password);
    }
    if (patch.roles !== undefined) doc.roles = OAuthService.parseRoles(patch.roles);
    if (patch.attributes !== undefined) doc.attributes = this.parseAttributes(patch.attributes);
    doc.updatedAt = new Date().toISOString();
    await this.ctx.repo.put('oauth_users', username, doc);
    return { ...doc, source: 'dashboard', ...(source === 'env' || overridesEnv ? { overridesEnv: true } : {}) };
  }

  async removeUser(username) { return this.ctx.repo.del('oauth_users', username); }

  /**
   * The claims a user adds to a token: preferred_username, the roles at each OAUTH_ROLES_CLAIM path (left out when the
   * user has none, as Keycloak does), and each attribute as a top-level claim. Reserved names are skipped, so an
   * attribute stored before OAUTH_ROLES_CLAIM changed cannot overwrite the roles or a standard claim.
   */
  userClaims(user) {
    if (!user) return {};
    const reserved = this.reservedClaims();
    const out = {};
    for (const [k, v] of Object.entries(user.attributes || {})) if (!reserved.has(k)) out[k] = v;
    out.preferred_username = user.username;
    if (user.roles?.length) {
      for (const path of this.rolesClaimPaths()) {
        let node = out;
        for (const seg of path.slice(0, -1)) {
          if (!node[seg] || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
          node = node[seg];
        }
        node[path[path.length - 1]] = [...user.roles];
      }
    }
    return out;
  }

  // Client authentication from Basic header or form body.
  async authenticateClient(req, { allowPublic = false } = {}) {
    let id;
    let secret;
    const h = req.get('authorization') || '';
    if (req.body?.client_assertion !== undefined || req.body?.client_assertion_type !== undefined) {
      if (/^basic /i.test(h) || req.body?.client_secret) throw new OAuthError('invalid_request', 'Use one client authentication method per request (a client_assertion, or a secret)');
      return this.authenticateAssertion(req);
    }
    if (/^basic /i.test(h)) {
      const dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
      const i = dec.indexOf(':');
      const d = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
      if (i < 0) throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
      id = d(dec.slice(0, i));
      secret = d(dec.slice(i + 1));
    } else {
      id = req.body?.client_id;
      secret = req.body?.client_secret;
    }
    if (!id) throw new OAuthError('invalid_client', 'Client authentication required', 401);
    const client = await this.client(id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (JWT_METHODS.includes(client.tokenEndpointAuthMethod)) {
      throw new OAuthError('invalid_client', `This client authenticates with a signed JWT (${client.tokenEndpointAuthMethod}): send client_assertion_type=${JWT_BEARER} and client_assertion`, 401);
    }
    if (client.public) {
      // A registered public client (token_endpoint_auth_method "none") never authenticates with a secret.
      if (!allowPublic) throw new OAuthError('invalid_client', 'Public clients cannot use this endpoint or grant', 401);
      return { client, public: true };
    }
    if (secret === undefined || secret === null || secret === '') {
      if (allowPublic) return { client, public: true };
      throw new OAuthError('invalid_client', 'Client secret required', 401);
    }
    if (!safeEq(client.secret, secret)) throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
    return { client, public: false };
  }

  /**
   * RFC 7523 client authentication: client_assertion is a JWT whose iss and sub are the client_id, aud is this
   * server (issuer or token endpoint), exp is at most an hour away and jti is used once. Asymmetric algorithms are
   * checked against the client's jwks / jwks_uri (private_key_jwt), HS* against its secret (client_secret_jwt).
   */
  async authenticateAssertion(req) {
    const { jose } = this.ctx.keys;
    const b = req.body || {};
    const fail = (d) => new OAuthError('invalid_client', d, 401);
    if (b.client_assertion_type !== JWT_BEARER) throw fail(`client_assertion_type must be ${JWT_BEARER}`);
    const jwt = String(b.client_assertion || '');
    let claims;
    let header;
    try { claims = jose.decodeJwt(jwt); header = jose.decodeProtectedHeader(jwt); } catch { throw fail('client_assertion is not a JWT'); }
    const id = claims.sub;
    if (!id || claims.iss !== id) throw fail('The client_assertion\'s iss and sub must both be the client_id');
    if (b.client_id && b.client_id !== id) throw fail('client_id does not match the client_assertion\'s sub');
    const client = await this.client(id);
    if (!client) throw fail('Unknown client');
    if (client.public) throw fail('A public client cannot authenticate with a client_assertion');
    const symmetric = SECRET_ALGS.includes(header.alg);
    if (!symmetric && !KEY_ALGS.includes(header.alg)) throw fail(`Unsupported client_assertion alg "${header.alg}" (supported: ${[...KEY_ALGS, ...SECRET_ALGS].join(', ')})`);
    const method = symmetric ? 'client_secret_jwt' : 'private_key_jwt';
    if (client.tokenEndpointAuthMethod && client.tokenEndpointAuthMethod !== method && (JWT_METHODS.includes(client.tokenEndpointAuthMethod) || client.source === 'registered')) {
      throw fail(`This client is registered for ${client.tokenEndpointAuthMethod}, not ${method}`);
    }
    let key;
    if (symmetric) {
      if (!client.secret) throw fail('This client has no secret, so it cannot use client_secret_jwt');
      key = new TextEncoder().encode(client.secret);
    } else {
      const jwks = await this.clientJwks(client);
      if (!jwks) throw fail('This client has no public keys (jwks or jwks_uri), so it cannot use private_key_jwt');
      key = jose.createLocalJWKSet(jwks);
    }
    const root = this.ctx.baseUrl.root(req);
    const audiences = [...new Set([this.issuer(req), `${root}/oauth/token`, `${this.ctx.baseUrl(req)}/oauth/token`, `${root}${req.path}`])];
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(jwt, key, { algorithms: [header.alg], audience: audiences, clockTolerance: 30, requiredClaims: ['exp', 'jti'] }));
    } catch (e) {
      const why = e.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && e.claim === 'aud' ? `aud must be one of ${audiences.join(', ')}`
        : e.code === 'ERR_JWKS_NO_MATCHING_KEY' ? `no key in the client's JWKS matches kid "${header.kid ?? ''}" and alg ${header.alg}`
          : e.message;
      throw fail(`Invalid client_assertion: ${why}`);
    }
    if (payload.exp * 1000 - Date.now() > MAX_ASSERTION_LIFETIME_S * 1000) throw fail(`The client_assertion expires more than ${MAX_ASSERTION_LIFETIME_S} s from now`);
    const seen = `${id}:${payload.jti}`;
    if (this.assertionIds.has(seen)) throw fail('This client_assertion (jti) was already used');
    this.assertionIds.set(seen, payload.exp * 1000 + 60000);
    return { client, public: false, method };
  }

  /** The client's public keys: its jwks, or the document at its jwks_uri (cached 5 minutes). Null when it has none. */
  async clientJwks(client) {
    if (client.jwks?.keys?.length) return client.jwks;
    if (!client.jwksUri) return null;
    const hit = this.jwksCache.get(client.jwksUri);
    if (hit && Date.now() - hit.at < JWKS_CACHE_MS) return hit.jwks;
    try {
      const { json } = await fetchJson(client.jwksUri, { allowPrivate: this.ctx.settings.get('oauthFetchPrivate') });
      if (!Array.isArray(json?.keys)) throw new FetchRefused('the document has no "keys" array');
      this.jwksCache.set(client.jwksUri, { at: Date.now(), jwks: json });
      return json;
    } catch (e) {
      if (e instanceof FetchRefused) throw new OAuthError('invalid_client', `Cannot load the client's jwks_uri: ${e.message}`, 401);
      throw e;
    }
  }

  /**
   * Public keys as a JWK Set from a JWKS object or JSON, a single JWK, or a PEM public key or certificate.
   * Private key material is refused. Each key gets a kid (its RFC 7638 thumbprint) when it has none.
   */
  async normalizeJwks(input) {
    if (input === undefined || input === null || input === '') return undefined;
    const { jose } = this.ctx.keys;
    let keys;
    if (typeof input === 'string' && /-----BEGIN /.test(input)) {
      let pub;
      try { pub = crypto.createPublicKey(input); } catch (e) { throw new OAuthError('invalid_request', `Not a PEM public key or certificate: ${e.message}`); }
      keys = [pub.export({ format: 'jwk' })];
    } else {
      let v = input;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new OAuthError('invalid_request', 'jwks must be a JWK Set (JSON), a JWK or a PEM public key'); } }
      keys = Array.isArray(v?.keys) ? v.keys : v && typeof v === 'object' && v.kty ? [v] : null;
      if (!keys) throw new OAuthError('invalid_request', 'jwks must be a JWK Set ({"keys": […]}), a JWK or a PEM public key');
    }
    if (keys.length > 10) throw new OAuthError('invalid_request', 'At most 10 keys');
    const out = [];
    for (const k of keys) {
      if (!k || typeof k !== 'object' || !k.kty) throw new OAuthError('invalid_request', 'Every key needs a "kty"');
      if (k.d || k.p || k.q || k.k) throw new OAuthError('invalid_request', 'Only public keys belong in a client\'s jwks (this one has private or symmetric key material)');
      try { await jose.importJWK({ ...k, alg: k.alg || (k.kty === 'RSA' ? 'RS256' : k.kty === 'OKP' ? 'EdDSA' : k.crv === 'P-384' ? 'ES384' : k.crv === 'P-521' ? 'ES512' : 'ES256') }); } catch (e) { throw new OAuthError('invalid_request', `Unusable key: ${e.message}`); }
      out.push({ ...k, kid: k.kid || await jose.calculateJwkThumbprint(k), use: k.use || 'sig' });
    }
    return { keys: out };
  }

  /** A new key pair for a client (dashboard helper): the public key joins its jwks, the private key is kept for the assertion helper. */
  async generateClientKey(clientId, alg = 'RS256') {
    const { jose } = this.ctx.keys;
    if (!['RS256', 'ES256', 'PS256', 'EdDSA'].includes(alg)) throw new OAuthError('invalid_request', 'alg must be RS256, PS256, ES256 or EdDSA');
    const current = await this.client(clientId);
    if (!current) return null;
    if (current.public) throw new OAuthError('invalid_request', 'A public client cannot use private_key_jwt');
    const pair = alg === 'ES256' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : alg === 'EdDSA' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const kid = await jose.calculateJwkThumbprint(jwk);
    const publicJwk = { ...jwk, kid, alg, use: 'sig' };
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const jwks = { keys: [...(current.jwks?.keys || []).filter((k) => k.kid !== kid), publicJwk] };
    await this.updateClient(clientId, { jwks, assertionKey: { kid, alg, privateKeyPem, createdAt: new Date().toISOString() } });
    return { kid, alg, publicJwk, privateKeyPem };
  }

  /** A client assertion signed with the client's stored key (private_key_jwt) or its secret (client_secret_jwt). */
  async makeAssertion(req, clientId, { method, audience, lifetime = 300 } = {}) {
    const { jose } = this.ctx.keys;
    const client = await this.client(clientId);
    if (!client) return null;
    const m = method || (client.tokenEndpointAuthMethod === 'client_secret_jwt' ? 'client_secret_jwt' : client.assertionKey ? 'private_key_jwt' : 'client_secret_jwt');
    if (!JWT_METHODS.includes(m)) throw new OAuthError('invalid_request', `method must be ${JWT_METHODS.join(' or ')}`);
    let key;
    let header;
    if (m === 'private_key_jwt') {
      if (!client.assertionKey) throw new OAuthError('invalid_request', 'This client has no generated key pair; generate one first (or sign assertions with your own key)');
      key = crypto.createPrivateKey(client.assertionKey.privateKeyPem);
      header = { alg: client.assertionKey.alg, kid: client.assertionKey.kid, typ: 'JWT' };
    } else {
      if (!client.secret) throw new OAuthError('invalid_request', 'This client has no secret for client_secret_jwt');
      key = new TextEncoder().encode(client.secret);
      header = { alg: 'HS256', typ: 'JWT' };
    }
    const aud = audience || `${this.ctx.baseUrl.root(req)}/oauth/token`;
    const assertion = await new jose.SignJWT({}).setProtectedHeader(header).setIssuer(client.clientId).setSubject(client.clientId)
      .setAudience(aud).setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime(Math.floor(Date.now() / 1000) + Math.min(Math.max(30, Number(lifetime) || 300), MAX_ASSERTION_LIFETIME_S))
      .sign(key);
    return { method: m, assertion, clientAssertionType: JWT_BEARER, decoded: { header: jose.decodeProtectedHeader(assertion), payload: jose.decodeJwt(assertion) } };
  }

  resolveScopes(client, requested) {
    if (!requested) return client.scopes;
    const req = String(requested).split(/\s+/).filter(Boolean);
    const bad = req.filter((s) => !client.scopes.includes(s));
    if (bad.length) throw new OAuthError('invalid_scope', `Scope not allowed for this client: ${bad.join(' ')}`);
    return req;
  }

  // RFC 8707 resource indicator: a resource on this server (e.g. <base>/mcp) is added to the token's audience.
  checkResource(req, resource) {
    if (resource === undefined || resource === null || resource === '') return undefined;
    const r = Array.isArray(resource) ? resource[0] : String(resource);
    const base = this.ctx.baseUrl.root(req); // any resource on this server, including inside a profile (/p/<name>/mcp)
    let ok = false;
    try { const u = new URL(r); ok = !u.hash && (r === base || r.startsWith(`${base}/`)); } catch { ok = false; }
    if (!ok) throw new OAuthError('invalid_target', `resource must be an absolute URL on this server (${base}/…)`);
    return r;
  }

  async issueAccessToken(req, { client, scopes, subject, user, refresh, resource }) {
    const ttl = this.ctx.settings.get('oauthTokenTtl');
    const token = await this.ctx.keys.sign(
      { ...this.userClaims(user), client_id: client.clientId, scope: scopes.join(' '), token_use: 'access' },
      { ttl, issuer: this.issuer(req), audience: resource && resource !== this.audience() ? [this.audience(), resource] : this.audience(), subject: subject || client.clientId },
    );
    await this.markUsed(client).catch(() => {}); // keeps a registered client from expiring (OAUTH_REGISTRATION_TTL_DAYS)
    const out = { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') };
    if (refresh) {
      const rt = crypto.randomBytes(32).toString('base64url');
      await this.ctx.repo.put('oauth_refresh', rt, {
        token: rt, clientId: client.clientId, scopes, subject, resource,
        expiresAt: Date.now() + this.ctx.settings.get('oauthRefreshTtl') * 1000,
      });
      out.refresh_token = rt;
    }
    return out;
  }

  createCode({ clientId, redirectUri, scopes, subject, codeChallenge, codeChallengeMethod, state, resource }) {
    const code = crypto.randomBytes(24).toString('base64url');
    this.codes.set(code, { clientId, redirectUri, scopes, subject, codeChallenge, codeChallengeMethod, state, resource, expiresAt: Date.now() + 120000 });
    return code;
  }

  consumeCode(code) {
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    return c;
  }

  static verifyPkce(verifier, challenge, method) {
    if (!challenge) return true;
    if (!verifier) return false;
    if ((method || 'plain') === 'S256') {
      return crypto.createHash('sha256').update(verifier).digest('base64url') === challenge;
    }
    return verifier === challenge;
  }

  async verifyAccess(req, token) {
    const { payload, header } = await this.ctx.keys.verify(token, { issuer: this.issuer(req), audience: this.audience() });
    if (payload.jti && this.revoked.has(payload.jti)) throw new Error('Token has been revoked');
    return { payload, header };
  }

  async introspect(req, token) {
    if (!token) return { active: false };
    const rt = await this.ctx.repo.get('oauth_refresh', token);
    if (rt) {
      if (rt.expiresAt < Date.now()) return { active: false };
      return { active: true, token_type: 'refresh_token', client_id: rt.clientId, scope: rt.scopes.join(' '), sub: rt.subject || rt.clientId, ...(rt.subject ? { username: rt.subject } : {}), exp: Math.floor(rt.expiresAt / 1000) };
    }
    try {
      const { payload } = await this.verifyAccess(req, token);
      // A user's token: its roles and attributes come back too (RFC 7662 allows extra members).
      const { token_use: tokenUse, nbf, ...claims } = payload; // eslint-disable-line no-unused-vars
      return {
        ...claims,
        active: true, token_type: 'Bearer', scope: payload.scope, client_id: payload.client_id, sub: payload.sub,
        exp: payload.exp, iat: payload.iat, iss: payload.iss, aud: payload.aud, jti: payload.jti,
        ...(payload.preferred_username ? { username: payload.preferred_username } : {}),
      };
    } catch {
      return { active: false };
    }
  }

  async revoke(req, token) {
    if (!token) return;
    if (await this.ctx.repo.get('oauth_refresh', token)) {
      await this.ctx.repo.del('oauth_refresh', token);
      return;
    }
    const d = this.ctx.keys.decode(token);
    if (d?.payload?.jti) {
      this.revoked.add(d.payload.jti);
      await this.ctx.repo.put('oauth_revoked', d.payload.jti, { jti: d.payload.jti, exp: d.payload.exp, revokedAt: new Date().toISOString() });
    }
  }
}

module.exports = { OAuthService, OAuthError, safeEq, clientIp, RESERVED_CLAIMS, AUTH_METHODS, ASSERTION_ALGS: [...KEY_ALGS, ...SECRET_ALGS], JWT_BEARER };
