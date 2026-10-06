'use strict';
// Auth profiles for the incoming tester: none, apikey, basic, bearer, oauth2 client credentials (cached tokens).
const tokenCache = new Map();

function mask(s) {
  if (!s) return s;
  const str = String(s);
  return str.length <= 6 ? '***' : `${str.slice(0, 3)}…${str.slice(-2)}`;
}

// Suggest auth profiles from the spec's securitySchemes.
function profilesFromSpec(doc) {
  const out = [{ type: 'none', label: 'None' }];
  for (const [name, s] of Object.entries(doc.components?.securitySchemes || {})) {
    if (s.type === 'apiKey') out.push({ type: 'apikey', label: `${name} (API key, ${s.in} "${s.name}")`, scheme: name, in: s.in, name: s.name, value: '' });
    else if (s.type === 'http' && /^basic$/i.test(s.scheme)) out.push({ type: 'basic', label: `${name} (HTTP Basic)`, scheme: name, username: '', password: '' });
    else if (s.type === 'http' && /^bearer$/i.test(s.scheme)) out.push({ type: 'bearer', label: `${name} (Bearer)`, scheme: name, token: '' });
    else if (s.type === 'oauth2' && s.flows?.clientCredentials) {
      out.push({
        type: 'oauth2cc', label: `${name} (OAuth2 client credentials)`, scheme: name,
        tokenUrl: s.flows.clientCredentials.tokenUrl, clientId: '', clientSecret: '',
        scopes: Object.keys(s.flows.clientCredentials.scopes || {}).join(' '), clientAuth: 'basic',
      });
    }
  }
  return out;
}

async function fetchToken(profile, { force = false } = {}) {
  const key = `${profile.tokenUrl}|${profile.clientId}|${profile.scopes || ''}|${profile.clientAuth || 'basic'}`;
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now() + 10000) return { token: cached.token, cached: true, exchange: cached.exchange };

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (profile.scopes) form.set('scope', profile.scopes);
  if (profile.audience) form.set('audience', profile.audience);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if ((profile.clientAuth || 'basic') === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(profile.clientId)}:${encodeURIComponent(profile.clientSecret || '')}`).toString('base64')}`;
  } else {
    form.set('client_id', profile.clientId);
    if (profile.clientSecret) form.set('client_secret', profile.clientSecret);
  }
  const started = Date.now();
  const exchange = {
    request: {
      method: 'POST', url: profile.tokenUrl,
      headers: { ...headers, ...(headers.Authorization ? { Authorization: `Basic ${mask(headers.Authorization.slice(6))}` } : {}) },
      body: form.toString().replace(/client_secret=[^&]*/, `client_secret=${mask(profile.clientSecret)}`),
    },
  };
  let res;
  try {
    res = await fetch(profile.tokenUrl, { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(20000) });
  } catch (e) {
    exchange.error = e.cause?.message || e.message;
    const err = new Error(`Token request to ${profile.tokenUrl} failed: ${exchange.error}`);
    err.exchange = exchange;
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  exchange.response = {
    status: res.status, durationMs: Date.now() - started, headers: Object.fromEntries(res.headers.entries()),
    body: json ? { ...json, access_token: json.access_token ? mask(json.access_token) : undefined, refresh_token: json.refresh_token ? mask(json.refresh_token) : undefined } : text.slice(0, 2000),
  };
  if (!res.ok || !json?.access_token) {
    const err = new Error(`Token request failed with HTTP ${res.status}${json?.error ? ` (${json.error}${json.error_description ? `: ${json.error_description}` : ''})` : ''}`);
    err.exchange = exchange;
    throw err;
  }
  const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 300;
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + ttl * 1000, exchange });
  return { token: json.access_token, cached: false, exchange };
}

// Mutates { headers, query } to carry credentials. Returns token exchange info when a token was fetched.
async function applyAuth(profile, req) {
  if (!profile || profile.type === 'none') return null;
  switch (profile.type) {
    case 'apikey':
      if (profile.in === 'query') req.query[profile.name] = profile.value;
      else if (profile.in === 'cookie') req.headers.Cookie = `${profile.name}=${profile.value}`;
      else req.headers[profile.name || 'X-API-Key'] = profile.value;
      return null;
    case 'basic':
      req.headers.Authorization = `Basic ${Buffer.from(`${profile.username || ''}:${profile.password || ''}`).toString('base64')}`;
      return null;
    case 'bearer':
      req.headers.Authorization = `Bearer ${profile.token || ''}`;
      return null;
    case 'oauth2cc': {
      const t = await fetchToken(profile);
      req.headers.Authorization = `Bearer ${t.token}`;
      return { cached: t.cached, ...t.exchange };
    }
    default:
      return null;
  }
}

function clearTokenCache() { tokenCache.clear(); }

module.exports = { applyAuth, fetchToken, profilesFromSpec, clearTokenCache, mask };
