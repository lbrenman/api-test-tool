'use strict';
// Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document; MCP authorization 2025-11-25):
// a client uses an https URL as its client_id and the server fetches the JSON metadata at that URL instead of a
// registration step. Documents are fetched through util/safeFetch (no private hosts unless OAUTH_FETCH_PRIVATE) and
// cached under their Cache-Control max-age. The lab also hosts editable documents at /oauth/client-metadata/<name>.json
// (resolved locally, without an HTTP call), so a demo needs nothing hosted elsewhere.
const { fetchJson, FetchRefused } = require('../util/safeFetch');
const { OAuthError, OAuthService } = require('./oauth'); // oauth.js loads this file from its constructor, after its own exports exist

const PREFIX = '/oauth/client-metadata/';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_TTL_S = 300;
const MAX_TTL_S = 3600;
const MAX_CACHE = 200;
const MAX_SEEN = 50;
const GRANTS = ['authorization_code', 'refresh_token', 'client_credentials'];

class CimdService {
  constructor(ctx, oauth) {
    this.ctx = ctx;
    this.oauth = oauth;
    this.cache = new Map(); // url -> { at, ttl, client }
    this.seen = new Map(); // url -> what the Auth page shows: name, host, last fetch, last use, last error
  }

  enabled() { return this.ctx.settings.get('oauthCimd'); }

  static isUrlId(id) { return /^https?:\/\//i.test(String(id || '')); }

  // ---- documents the lab hosts itself
  builtIns(root) {
    return {
      demo: {
        client_name: 'CIMD demo client',
        client_uri: root,
        redirect_uris: ['https://oauth.pstmn.io/v1/callback', 'http://127.0.0.1:33418/callback', 'http://localhost:6274/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'read write',
      },
    };
  }

  docUrl(root, name) { return `${root}${PREFIX}${name}.json`; }

  async hostedDocs(root) {
    const stored = new Map((await this.ctx.repo.list('oauth_client_metadata')).map((d) => [d.name, d]));
    const out = [];
    for (const [name, metadata] of Object.entries(this.builtIns(root))) {
      if (!stored.has(name)) out.push({ name, builtIn: true, url: this.docUrl(root, name), document: { client_id: this.docUrl(root, name), ...metadata } });
    }
    for (const d of stored.values()) out.push({ name: d.name, builtIn: false, overridesBuiltIn: !!this.builtIns(root)[d.name], url: this.docUrl(root, d.name), document: { client_id: this.docUrl(root, d.name), ...d.metadata }, updatedAt: d.updatedAt });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async hostedDoc(root, name) { return (await this.hostedDocs(root)).find((d) => d.name === name) || null; }

  /** Store a hosted document. Its client_id is always its own URL; the rest is checked like a fetched document. */
  async saveDoc(root, name, metadata) {
    if (!NAME.test(String(name || ''))) throw new OAuthError('invalid_request', 'Names are 1-40 lowercase letters, digits and hyphens');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new OAuthError('invalid_request', 'The body must be a JSON object of client metadata');
    const { client_id: _ignored, ...rest } = metadata; // eslint-disable-line no-unused-vars
    const url = this.docUrl(root, name);
    await this.toClient(url, { client_id: url, ...rest }, { local: true }); // validate
    const doc = { name, metadata: rest, updatedAt: new Date().toISOString() };
    await this.ctx.repo.put('oauth_client_metadata', name, doc);
    this.cache.delete(url);
    return this.hostedDoc(root, name);
  }

  async removeDoc(root, name) {
    this.cache.delete(this.docUrl(root, name));
    return this.ctx.repo.del('oauth_client_metadata', name);
  }

  // ---- resolving a URL client_id
  /** The client for a URL client_id, or throws OAuthError(invalid_client). */
  async resolve(url, req) {
    const fail = (d) => new OAuthError('invalid_client', d, 401);
    if (!this.enabled()) throw fail('client_id is a URL (a client ID metadata document), but CIMD is turned off on this server (OAUTH_CIMD=false)');
    const root = this.ctx.baseUrl.root(req);
    const local = url.startsWith(`${root}${PREFIX}`);
    this.checkUrl(url, { local });
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < hit.ttl * 1000) { this.note(url, hit.client, { used: true }); return hit.client; }
    let document;
    let ttl = DEFAULT_TTL_S;
    try {
      if (local) {
        const name = url.slice(`${root}${PREFIX}`.length).replace(/\.json$/, '');
        const d = await this.hostedDoc(root, name);
        if (!d || d.url !== url) throw new FetchRefused(`${url} is not one of this server's hosted metadata documents`);
        document = d.document;
        ttl = 0; // always current, so edits on the Auth page apply at once
      } else {
        const r = await fetchJson(url, { allowPrivate: this.ctx.settings.get('oauthFetchPrivate'), maxBytes: 10240 });
        document = r.json;
        const cc = r.headers.get('cache-control') || '';
        const m = /max-age=(\d+)/i.exec(cc);
        if (/no-store|no-cache/i.test(cc)) ttl = 0; else if (m) ttl = Math.min(Number(m[1]), MAX_TTL_S);
      }
      const client = await this.toClient(url, document, { local });
      if (ttl > 0) {
        if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(url, { at: Date.now(), ttl, client });
      }
      this.note(url, client, { fetched: true, used: true, local });
      return client;
    } catch (e) {
      const msg = e instanceof FetchRefused || e instanceof OAuthError ? (e.description || e.message) : `could not be loaded: ${e.message}`;
      this.note(url, null, { error: msg, local });
      throw fail(`Client metadata document ${url}: ${msg}`);
    }
  }

  checkUrl(url, { local }) {
    const fail = (d) => new OAuthError('invalid_client', `Invalid CIMD client_id: ${d}`, 401);
    let u;
    try { u = new URL(url); } catch { throw fail('not an absolute URL'); }
    if (u.protocol !== 'https:' && !(local || (u.protocol === 'http:' && this.ctx.settings.get('oauthFetchPrivate')))) throw fail('it must use https');
    if (u.username || u.password) throw fail('it must not contain credentials');
    if (u.hash || url.includes('#')) throw fail('it must not contain a fragment');
    if (!u.pathname || u.pathname === '/') throw fail('it must have a path');
    if (/\/\.\.?(\/|$)/.test(url.replace(/[?#].*$/, ''))) throw fail('it must not contain . or .. path segments');
  }

  /** Validate a metadata document and turn it into a client. Throws OAuthError(invalid_client_metadata). */
  async toClient(url, doc, { local = false } = {}) {
    const bad = (d) => new OAuthError('invalid_client_metadata', d);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('the document is not a JSON object');
    if (doc.client_id !== url) throw bad(`its client_id must be exactly the document URL (${url}); it is ${JSON.stringify(doc.client_id)}`);
    if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) throw bad('a metadata document must not contain a client_secret');
    const strings = (v, name, max) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string') || v.length > max) throw bad(`${name} must be an array of at most ${max} strings`);
      return v;
    };
    const method = doc.token_endpoint_auth_method ?? 'none';
    if (!['none', 'private_key_jwt'].includes(method)) throw bad(`token_endpoint_auth_method must be "none" or "private_key_jwt" (a metadata document has no shared secret), not "${method}"`);
    const redirectUris = strings(doc.redirect_uris, 'redirect_uris', 10) || [];
    const grantTypes = strings(doc.grant_types, 'grant_types', 5) || ['authorization_code'];
    const unknown = grantTypes.find((g) => !GRANTS.includes(g));
    if (unknown) throw bad(`unsupported grant type "${unknown}"`);
    if (grantTypes.includes('client_credentials') && method !== 'private_key_jwt') throw bad('client_credentials needs token_endpoint_auth_method "private_key_jwt"');
    if (grantTypes.includes('authorization_code') && !redirectUris.length) throw bad('redirect_uris is required for the authorization_code grant');
    OAuthService.checkRedirectUris(redirectUris, 'invalid_client_metadata');
    const responseTypes = strings(doc.response_types, 'response_types', 3) || (grantTypes.includes('authorization_code') ? ['code'] : []);
    if (responseTypes.some((r) => r !== 'code')) throw bad('only the "code" response type is supported');
    const allowed = this.oauth.registrationScopes();
    let scopes = allowed;
    if (typeof doc.scope === 'string' && doc.scope.trim()) {
      scopes = doc.scope.split(/\s+/).filter(Boolean);
      const no = scopes.filter((x) => !allowed.includes(x));
      if (no.length) throw bad(`scope not allowed: ${no.join(' ')} (allowed: ${allowed.join(' ')})`);
    }
    let jwks;
    let jwksUri;
    if (method === 'private_key_jwt') {
      if (doc.jwks !== undefined && doc.jwks_uri !== undefined) throw bad('use jwks or jwks_uri, not both');
      if (doc.jwks !== undefined) {
        try { jwks = await this.oauth.normalizeJwks(doc.jwks); } catch (e) { throw bad(`jwks: ${e.description || e.message}`); }
      } else if (typeof doc.jwks_uri === 'string') jwksUri = doc.jwks_uri;
      else throw bad('private_key_jwt needs jwks or jwks_uri');
    }
    const str = (k, max = 500) => (typeof doc[k] === 'string' ? doc[k].slice(0, max) : undefined);
    return {
      clientId: url,
      secret: '',
      public: method === 'none',
      tokenEndpointAuthMethod: method,
      ...(jwks ? { jwks } : {}),
      ...(jwksUri ? { jwksUri } : {}),
      scopes,
      redirectUris,
      grantTypes,
      responseTypes,
      clientName: str('client_name', 200),
      clientUri: str('client_uri'),
      logoUri: str('logo_uri'),
      source: 'cimd',
      metadataHost: new URL(url).host,
      hostedHere: local,
    };
  }

  note(url, client, { fetched, used, error, local } = {}) {
    const now = new Date().toISOString();
    const cur = this.seen.get(url) || { url, host: (() => { try { return new URL(url).host; } catch { return ''; } })(), uses: 0 };
    if (client) { cur.clientName = client.clientName; cur.method = client.tokenEndpointAuthMethod; cur.error = undefined; }
    if (fetched) cur.fetchedAt = now;
    if (used) { cur.lastUsedAt = now; cur.uses += 1; }
    if (error) { cur.error = error; cur.errorAt = now; }
    if (local !== undefined) cur.hostedHere = local;
    this.seen.delete(url);
    this.seen.set(url, cur);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value);
  }

  seenList() { return [...this.seen.values()].reverse(); }

  clearCache() { this.cache.clear(); }
}

module.exports = { CimdService, CIMD_PREFIX: PREFIX };
