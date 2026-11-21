'use strict';
// Login page labels: the page always shows where the sign-in returns to, and OAUTH_LOGIN_LABELS names the page and
// prefills the username by redirect URI (several look-alike sign-ins open at once, one per callback port).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

async function withSettings(values, fn) {
  await t.ctx.settings.setMany(values);
  try { return await fn(); } finally { for (const key of Object.keys(values)) await t.ctx.settings.reset({ key }); }
}
const params = (redirect) => ({
  response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 's',
  code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
});
const page = async (redirect) => (await request(t.app).get('/oauth/authorize').query(params(redirect)).expect(200)).text;
const LABELS = 'http://localhost:3341=Alice (admin)|alice; http://localhost:3342/oauth/callback=Bob <dev>|bob\nhttp://localhost:3343=Carol';

test('without labels: plain heading, empty username, and where the sign-in returns to (no query)', async () => {
  const html = await page('http://localhost:3342/oauth/callback?x=1');
  assert.match(html, /<title>Sign in · API Test Tool<\/title>/);
  assert.match(html, /<h1>Sign in<\/h1>/);
  assert.match(html, /Returning to <code>http:\/\/localhost:3342\/oauth\/callback<\/code>/);
  assert.match(html, /name="username" autocomplete="username" required autofocus>/);
});

test('a matching label sets title and heading and prefills the username; others and near-misses stay plain', async () => {
  await withSettings({ oauthLoginLabels: LABELS }, async () => {
    const alice = await page('http://localhost:3341/oauth/callback');
    assert.match(alice, /<title>Sign in as Alice \(admin\) · API Test Tool<\/title>/);
    assert.match(alice, /<div class="persona">Alice \(admin\)<\/div>/);
    assert.match(alice, /name="username"[^>]*value="alice"/);
    assert.match(alice, /type="password"[^>]*autofocus/);
    const bob = await page('http://localhost:3342/oauth/callback');
    assert.match(bob, /Bob &lt;dev&gt;/, 'label is escaped');
    assert.doesNotMatch(bob, /Bob <dev>/);
    const carol = await page('http://localhost:3343/oauth/callback');
    assert.match(carol, /Sign in as Carol/);
    assert.match(carol, /name="username" autocomplete="username" required autofocus>/, 'no username given');
    for (const other of ['http://localhost:33410/oauth/callback', 'http://127.0.0.1:3341/oauth/callback', 'https://app.example.com/cb']) {
      assert.match(await page(other), /<h1>Sign in<\/h1>/, other);
    }
  });
});

test('a failed sign-in keeps the label and the username that was typed', async () => {
  await withSettings({ oauthLoginLabels: LABELS }, async () => {
    const r = await request(t.app).post('/oauth/authorize').type('form')
      .send({ ...params('http://localhost:3341/oauth/callback'), username: 'demo', password: 'wrong', decision: 'allow' }).expect(401);
    assert.match(r.text, /Sign in as Alice \(admin\)/);
    assert.match(r.text, /name="username"[^>]*value="demo"/);
    assert.match(r.text, /Invalid username or password/);
  });
});
