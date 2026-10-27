'use strict';
// Public base URL detection.
// Order: PUBLIC_BASE_URL (setting/env) -> Codespaces -> Fly -> Render -> request (X-Forwarded-*) -> localhost.

function hostBaseUrl(env = process.env, port = 3000) {
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL;
  return null;
}

function requestBaseUrl(req) {
  if (!req) return null;
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : null;
}

// baseUrl(req) is where the request's APIs live: inside a settings profile it ends in /p/<name>, so links,
// specs and endpoints stay in the profile. baseUrl.root(req) is the server itself (OAuth server, dashboard).
// baseUrl.mtls(req) is the mutual-TLS listener.
function makeBaseUrl(settings, env = process.env) {
  function root(req) {
    const configured = settings.get('publicBaseUrl');
    const url = configured
      || hostBaseUrl(env, settings.get('port'))
      || requestBaseUrl(req)
      || `http://localhost:${settings.get('port')}`;
    return url.replace(/\/+$/, '');
  }
  // The mTLS listener (src/app.js listenTls): MTLS_PUBLIC_URL, else the host the client connected to (a request on that
  // listener comes straight from the client), else the public host name on MTLS_PORT.
  function mtls(req) {
    const configured = settings.get('mtlsPublicUrl');
    if (configured) return configured.replace(/\/+$/, '');
    if (req?.socket?.encrypted && req.get('host')) return `https://${req.get('host')}`;
    return `https://${new URL(root(req)).hostname}:${settings.get('mtlsPort')}`;
  }
  // A request on the mTLS listener gets links back to that listener, so a client authenticated by its certificate stays on it.
  function baseUrl(req) {
    const name = req ? req.profile?.name : settings.profile()?.name;
    const at = req?.socket?.encrypted ? mtls(req) : root(req);
    return name ? `${at}/p/${name}` : at;
  }
  baseUrl.root = root;
  baseUrl.mtls = mtls;
  return baseUrl;
}

module.exports = { makeBaseUrl, hostBaseUrl, requestBaseUrl };
