'use strict';
// Built-in OAuth 2.0 authorization server logic: clients, users, codes (PKCE), tokens, refresh, introspection, revocation.
const crypto = require('node:crypto');

class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

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
  }

  async init() {
    for (const d of await this.ctx.repo.list('oauth_revoked')) this.revoked.add(d.jti);
  }

  issuer(req) { return this.ctx.settings.get('jwtIssuer') || this.ctx.baseUrl(req); }

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

  async addClient({ clientId, secret, scopes, redirectUris }) {
    if (!clientId || !/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) throw new OAuthError('invalid_request', 'clientId must be 3-64 chars [A-Za-z0-9._-]');
    const doc = {
      clientId,
      secret: secret === undefined ? crypto.randomBytes(18).toString('base64url') : String(secret),
      scopes: (Array.isArray(scopes) ? scopes : String(scopes || 'read write').split(/[\s,]+/)).filter(Boolean),
      redirectUris: OAuthService.checkRedirectUris((Array.isArray(redirectUris) ? redirectUris : String(redirectUris || '').split(/[\s,]+/)).filter(Boolean)),
      createdAt: new Date().toISOString(),
    };
    await this.ctx.repo.put('oauth_clients', clientId, doc);
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

  /** Validate RFC 7591 client metadata and store the client. Returns the stored client. */
  async registerClient(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new OAuthError('invalid_client_metadata', 'The request body must be a JSON object of client metadata');
    const bad = (d) => new OAuthError('invalid_client_metadata', d);
    const list = (v, name) => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${name} must be an array of strings`);
      return v;
    };
    const authMethod = meta.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!['client_secret_basic', 'client_secret_post', 'none'].includes(authMethod)) throw bad('token_endpoint_auth_method must be client_secret_basic, client_secret_post or none');
    const grantTypes = list(meta.grant_types, 'grant_types') || ['authorization_code'];
    const unknownGrant = grantTypes.find((g) => !['authorization_code', 'refresh_token', 'client_credentials'].includes(g));
    if (unknownGrant) throw bad(`Unsupported grant type "${unknownGrant}" (supported: authorization_code, refresh_token, client_credentials)`);
    const responseTypes = list(meta.response_types, 'response_types') || (grantTypes.includes('authorization_code') ? ['code'] : []);
    if (responseTypes.some((r) => r !== 'code')) throw bad('Only the "code" response type is supported');
    if (authMethod === 'none' && grantTypes.includes('client_credentials')) throw bad('A public client (token_endpoint_auth_method "none") cannot use client_credentials');
    const redirectUris = list(meta.redirect_uris, 'redirect_uris') || [];
    if (grantTypes.includes('authorization_code') && !redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required for the authorization_code grant');
    OAuthService.checkRedirectUris(redirectUris, 'invalid_redirect_uri');
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
    const count = (await this.ctx.repo.list('oauth_clients')).filter((c) => c.source === 'registered').length;
    if (count >= this.ctx.settings.get('oauthRegistrationMax')) throw new OAuthError('access_denied', 'The registered-client limit is reached; delete registered clients on the Auth page or raise OAUTH_REGISTRATION_MAX', 403);
    const regToken = crypto.randomBytes(32).toString('base64url');
    const doc = {
      clientId: `dcr-${crypto.randomBytes(12).toString('base64url')}`,
      secret: authMethod === 'none' ? '' : crypto.randomBytes(24).toString('base64url'),
      scopes,
      redirectUris,
      source: 'registered',
      public: authMethod === 'none',
      tokenEndpointAuthMethod: authMethod,
      grantTypes,
      responseTypes,
      clientName: str('client_name', 200),
      clientUri: str('client_uri'),
      logoUri: str('logo_uri'),
      softwareId: str('software_id', 200),
      softwareVersion: str('software_version', 100),
      contacts: list(meta.contacts, 'contacts'),
      registrationTokenHash: crypto.createHash('sha256').update(regToken).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    await this.ctx.repo.put('oauth_clients', doc.clientId, doc);
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
    for (const [k, v] of [['client_name', client.clientName], ['client_uri', client.clientUri], ['logo_uri', client.logoUri], ['contacts', client.contacts], ['software_id', client.softwareId], ['software_version', client.softwareVersion]]) {
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

  users() {
    return String(this.ctx.settings.get('oauthUsers') || '').split(';').map((s) => s.trim()).filter(Boolean).map((e) => {
      const i = e.indexOf(':');
      return { username: e.slice(0, i), password: e.slice(i + 1) };
    });
  }

  checkUser(username, password) {
    return this.users().some((u) => u.username === username && safeEq(u.password, password));
  }

  // Client authentication from Basic header or form body.
  async authenticateClient(req, { allowPublic = false } = {}) {
    let id;
    let secret;
    const h = req.get('authorization') || '';
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

  resolveScopes(client, requested) {
    if (!requested) return client.scopes;
    const req = String(requested).split(/\s+/).filter(Boolean);
    const bad = req.filter((s) => !client.scopes.includes(s));
    if (bad.length) throw new OAuthError('invalid_scope', `Scope not allowed for this client: ${bad.join(' ')}`);
    return req;
  }

  async issueAccessToken(req, { client, scopes, subject, refresh }) {
    const ttl = this.ctx.settings.get('oauthTokenTtl');
    const token = await this.ctx.keys.sign(
      { client_id: client.clientId, scope: scopes.join(' '), token_use: 'access' },
      { ttl, issuer: this.issuer(req), audience: this.audience(), subject: subject || client.clientId },
    );
    const out = { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') };
    if (refresh) {
      const rt = crypto.randomBytes(32).toString('base64url');
      await this.ctx.repo.put('oauth_refresh', rt, {
        token: rt, clientId: client.clientId, scopes, subject,
        expiresAt: Date.now() + this.ctx.settings.get('oauthRefreshTtl') * 1000,
      });
      out.refresh_token = rt;
    }
    return out;
  }

  createCode({ clientId, redirectUri, scopes, subject, codeChallenge, codeChallengeMethod, state }) {
    const code = crypto.randomBytes(24).toString('base64url');
    this.codes.set(code, { clientId, redirectUri, scopes, subject, codeChallenge, codeChallengeMethod, state, expiresAt: Date.now() + 120000 });
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
      return { active: true, token_type: 'refresh_token', client_id: rt.clientId, scope: rt.scopes.join(' '), sub: rt.subject || rt.clientId, exp: Math.floor(rt.expiresAt / 1000) };
    }
    try {
      const { payload } = await this.verifyAccess(req, token);
      return {
        active: true, token_type: 'Bearer', scope: payload.scope, client_id: payload.client_id, sub: payload.sub,
        exp: payload.exp, iat: payload.iat, iss: payload.iss, aud: payload.aud, jti: payload.jti,
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

module.exports = { OAuthService, OAuthError, safeEq };
