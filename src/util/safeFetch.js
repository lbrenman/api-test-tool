'use strict';
// Fetches a small JSON document from a URL that a client chose (a client's jwks_uri, a CIMD client_id URL) without
// turning the server into a proxy for the private network: https only (http for loopback when private targets are
// allowed), no redirects, private, loopback and link-local addresses refused unless allowPrivate, a timeout and a size cap.
const dns = require('node:dns').promises;
const net = require('node:net');

class FetchRefused extends Error {}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

async function checkUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchRefused(`"${raw}" is not an absolute URL`); }
  if (url.username || url.password) throw new FetchRefused('URLs with credentials are not fetched');
  if (url.hash) throw new FetchRefused('URLs with a fragment are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowPrivate)) throw new FetchRefused(`${url.protocol} URLs are not fetched; use https`);
  if (!allowPrivate) {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new FetchRefused(`Cannot resolve ${host}`); });
    const bad = addrs.find((a) => privateAddress(a.address));
    if (bad) throw new FetchRefused(`${host} resolves to a private or local address (${bad.address}); set OAUTH_FETCH_PRIVATE=true to allow it`);
  }
  return url;
}

async function fetchJson(raw, { allowPrivate = false, timeoutMs = 5000, maxBytes = 65536, accept = 'application/json' } = {}) {
  const url = await checkUrl(raw, { allowPrivate });
  let res;
  try {
    res = await fetch(url, { headers: { Accept: accept }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new FetchRefused(`Fetching ${url} failed: ${e.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : e.message}`);
  }
  if (res.status >= 300 && res.status < 400) throw new FetchRefused(`${url} answered with a redirect (${res.status}); redirects are not followed`);
  if (!res.ok) throw new FetchRefused(`${url} answered ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new FetchRefused(`${url} is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try { return { url: url.toString(), headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { throw new FetchRefused(`${url} did not return JSON`); }
}

module.exports = { fetchJson, checkUrl, privateAddress, FetchRefused };
