'use strict';
// Resource indicators (RFC 8707): a resource on this server always works; one on another host (an MCP gateway in
// front of an MCP server that signs in here) only when it is listed in OAUTH_EXTERNAL_RESOURCES.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const GATEWAY = 'https://gateway.example.com:4443/tool-access';
const redirect = 'https://app.example.com/callback';
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function withSettings(values, fn) {
  await t.ctx.settings.setMany(values);
  try { return await fn(); } finally { for (const key of Object.keys(values)) await t.ctx.settings.reset({ key }); }
}
const clientToken = (resource) => request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form')
  .send({ grant_type: 'client_credentials', resource });
const authorizePage = (resource) => request(t.app).get('/oauth/authorize').query({
  response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 's',
  code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource,
});

test('a resource on another host is refused by default, and the error names the setting', async () => {
  const r = await clientToken(GATEWAY).expect(400);
  assert.equal(r.body.error, 'invalid_target');
  assert.match(r.body.error_description, /OAUTH_EXTERNAL_RESOURCES/);
  await authorizePage(GATEWAY).expect(400);
});

test('a listed external resource: client_credentials and the login page accept it, and it joins the audience', async () => {
  await withSettings({ oauthExternalResources: `https://other.example.com, ${GATEWAY}/` }, async () => {
    const tok = (await clientToken(GATEWAY).expect(200)).body.access_token;
    const aud = decode(tok).aud;
    assert.ok(Array.isArray(aud) && aud.includes(GATEWAY) && aud.includes(t.ctx.settings.get('jwtAudience')), 'both audiences');
    await clientToken(`${GATEWAY}/mcp`).expect(200); // paths below a listed URL
    await clientToken(`${GATEWAY}?tenant=a`).expect(200);
    await clientToken('https://other.example.com/anything').expect(200);
    await authorizePage(GATEWAY).expect(200);
    for (const bad of [`${GATEWAY}-x`, 'https://gateway.example.com/tool-access', 'https://evil.example.com', `${GATEWAY}#frag`, 'not a url']) {
      assert.equal((await clientToken(bad).expect(400)).body.error, 'invalid_target', bad);
    }
  });
});

test('authorization_code + PKCE for an external resource, the way an MCP client signs in through a gateway', async () => {
  await withSettings({ oauthExternalResources: GATEWAY }, async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const login = await request(t.app).post('/oauth/authorize').type('form').send({
      response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 'st',
      code_challenge: challenge, code_challenge_method: 'S256', resource: GATEWAY, username: 'demo', password: 'demo', decision: 'allow',
    }).expect(302);
    const code = new URL(login.get('Location')).searchParams.get('code');
    const tok = await request(t.app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: 'demo-client', client_secret: 'demo-secret',
      code_verifier: verifier, resource: GATEWAY,
    }).expect(200);
    const claims = decode(tok.body.access_token);
    assert.equal(claims.sub, 'demo');
    assert.ok(claims.aud.includes(GATEWAY));
    // The refreshed token keeps the resource.
    const refreshed = await request(t.app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: 'demo-client', client_secret: 'demo-secret',
    }).expect(200);
    assert.ok(decode(refreshed.body.access_token).aud.includes(GATEWAY));
  });
});
