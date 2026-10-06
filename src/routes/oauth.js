'use strict';
// Built-in OAuth 2.0 server: token (client_credentials, authorization_code + PKCE, refresh_token),
// authorize (login/consent page), introspect (RFC 7662), revoke (RFC 7009), metadata (RFC 8414) and JWKS.
const express = require('express');
const { OAuthError, OAuthService } = require('../services/oauth');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function oauthError(res, e) {
  if (!(e instanceof OAuthError)) throw e;
  res.setHeader('Cache-Control', 'no-store');
  if (e.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
  return res.status(e.status).json({ error: e.error, error_description: e.description });
}

function loginPage({ client, params, error }) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · API Test Tool</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5b6475;--accent:#2f6fed;--border:#dde1e8;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b24;--fg:#e6e9ef;--muted:#9aa3b2;--accent:#6c9cff;--border:#2a3140;--err:#ff7b72}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:380px;width:100%}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px}label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit}
.scopes{font-family:ui-monospace,monospace;font-size:13px;background:var(--bg);padding:8px 10px;border-radius:6px;margin-top:6px}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);font:inherit;cursor:pointer;background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:var(--err);margin-top:10px}.hint{font-size:12px;color:var(--muted);margin-top:14px}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<h1>Sign in</h1><p><strong>${esc(client.clientId)}</strong> is requesting access.</p>
${hidden}
<label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<label>Requested scopes</label><div class="scopes">${esc(params.scope || client.scopes.join(' '))}</div>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
<div class="hint">Demo users come from OAUTH_USERS (default demo / demo).</div>
</form></body></html>`;
}

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

module.exports = function oauthRouter(ctx) {
  const { oauth, keys, baseUrl, settings } = ctx;
  const r = express.Router();
  const forms = [express.urlencoded({ extended: false }), express.json()];

  const AUTH_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];

  async function validateAuthorize(q) {
    if (q.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type must be "code"');
    const client = await oauth.client(q.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client_id');
    if (!q.redirect_uri || !/^https?:\/\//i.test(q.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri (http/https) is required');
    if (client.redirectUris?.length && !client.redirectUris.includes(q.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    if (q.code_challenge_method && !['S256', 'plain'].includes(q.code_challenge_method)) throw new OAuthError('invalid_request', 'code_challenge_method must be S256 or plain');
    const scopes = oauth.resolveScopes(client, q.scope);
    return { client, scopes };
  }

  r.get('/oauth/authorize', async (req, res) => {
    try {
      const { client } = await validateAuthorize(req.query);
      const params = Object.fromEntries(AUTH_PARAMS.filter((k) => req.query[k]).map((k) => [k, req.query[k]]));
      res.type('html').send(loginPage({ client, params }));
    } catch (e) {
      if (e instanceof OAuthError) return res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><title>OAuth error</title><body style="font-family:system-ui;padding:24px"><h1>Authorization error</h1><p><code>${esc(e.error)}</code>: ${esc(e.description)}</p></body>`);
      throw e;
    }
  });

  r.post('/oauth/authorize', ...forms, async (req, res) => {
    const b = req.body || {};
    let ctxv;
    try {
      ctxv = await validateAuthorize(b);
    } catch (e) {
      if (e instanceof OAuthError) return res.status(400).type('html').send(`<p>${esc(e.error)}: ${esc(e.description)}</p>`);
      throw e;
    }
    const params = Object.fromEntries(AUTH_PARAMS.filter((k) => b[k]).map((k) => [k, b[k]]));
    if (b.decision === 'deny') return redirectWith(res, b.redirect_uri, { error: 'access_denied', state: b.state });
    if (!oauth.checkUser(b.username, b.password)) {
      return res.status(401).type('html').send(loginPage({ client: ctxv.client, params, error: 'Invalid username or password' }));
    }
    const code = oauth.createCode({
      clientId: ctxv.client.clientId, redirectUri: b.redirect_uri, scopes: ctxv.scopes, subject: b.username,
      codeChallenge: b.code_challenge, codeChallengeMethod: b.code_challenge_method, state: b.state,
    });
    redirectWith(res, b.redirect_uri, { code, state: b.state });
  });

  r.post('/oauth/token', ...forms, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      const b = req.body || {};
      const grant = b.grant_type;
      if (grant === 'client_credentials') {
        const { client } = await oauth.authenticateClient(req);
        const scopes = oauth.resolveScopes(client, b.scope);
        return res.json(await oauth.issueAccessToken(req, { client, scopes }));
      }
      if (grant === 'authorization_code') {
        const { client, public: isPublic } = await oauth.authenticateClient(req, { allowPublic: true });
        const code = oauth.consumeCode(b.code);
        if (code.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Code was issued to another client');
        if (code.redirectUri !== b.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
        if (isPublic && !code.codeChallenge) throw new OAuthError('invalid_request', 'Public clients must use PKCE');
        if (!OAuthService.verifyPkce(b.code_verifier, code.codeChallenge, code.codeChallengeMethod)) throw new OAuthError('invalid_grant', 'PKCE code_verifier does not match code_challenge');
        return res.json(await oauth.issueAccessToken(req, { client, scopes: code.scopes, subject: code.subject, refresh: true }));
      }
      if (grant === 'refresh_token') {
        const { client } = await oauth.authenticateClient(req, { allowPublic: true });
        const rt = await ctx.repo.get('oauth_refresh', b.refresh_token || '');
        if (!rt || rt.expiresAt < Date.now() || rt.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Refresh token is invalid, expired or belongs to another client');
        await ctx.repo.del('oauth_refresh', rt.token); // rotation
        const scopes = b.scope ? b.scope.split(/\s+/).filter((s) => rt.scopes.includes(s)) : rt.scopes;
        return res.json(await oauth.issueAccessToken(req, { client, scopes, subject: rt.subject, refresh: true }));
      }
      throw new OAuthError('unsupported_grant_type', `Unsupported grant_type "${grant || ''}"`);
    } catch (e) {
      return oauthError(res, e);
    }
  });

  r.post('/oauth/introspect', ...forms, async (req, res) => {
    try {
      await oauth.authenticateClient(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await oauth.introspect(req, req.body?.token));
    } catch (e) {
      return oauthError(res, e);
    }
  });

  r.post('/oauth/revoke', ...forms, async (req, res) => {
    try {
      await oauth.authenticateClient(req, { allowPublic: true });
      await oauth.revoke(req, req.body?.token);
      res.status(200).json({ revoked: true });
    } catch (e) {
      return oauthError(res, e);
    }
  });

  function metadata(req) {
    const base = baseUrl(req);
    return {
      issuer: oauth.issuer(req),
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      introspection_endpoint: `${base}/oauth/introspect`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: [...new Set(['read', 'write', ...oauth.envClients().flatMap((c) => c.scopes)])],
      id_token_signing_alg_values_supported: [settings.get('jwtAlg')],
      subject_types_supported: ['public'],
    };
  }

  r.get('/.well-known/oauth-authorization-server', (req, res) => res.json(metadata(req)));
  r.get('/.well-known/openid-configuration', (req, res) => res.json(metadata(req)));
  r.get('/.well-known/jwks.json', (req, res) => res.json(keys.jwks()));

  return r;
};
