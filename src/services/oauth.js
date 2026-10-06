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
    const extra = (await this.ctx.repo.list('oauth_clients')).map((c) => ({ ...c, source: 'dashboard' }));
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
      redirectUris: (Array.isArray(redirectUris) ? redirectUris : String(redirectUris || '').split(/[\s,]+/)).filter(Boolean),
      createdAt: new Date().toISOString(),
    };
    await this.ctx.repo.put('oauth_clients', clientId, doc);
    return doc;
  }

  async removeClient(clientId) { return this.ctx.repo.del('oauth_clients', clientId); }

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
