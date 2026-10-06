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

function makeBaseUrl(settings, env = process.env) {
  return function baseUrl(req) {
    const configured = settings.get('publicBaseUrl');
    const url = configured
      || hostBaseUrl(env, settings.get('port'))
      || requestBaseUrl(req)
      || `http://localhost:${settings.get('port')}`;
    return url.replace(/\/+$/, '');
  };
}

module.exports = { makeBaseUrl, hostBaseUrl, requestBaseUrl };
