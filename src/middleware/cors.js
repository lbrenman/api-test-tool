'use strict';
// CORS. Preflights (OPTIONS + Access-Control-Request-Method) are answered here;
// plain OPTIONS requests fall through (tus uses them for capability discovery).

const EXPOSE = [
  'Location', 'ETag', 'Last-Modified', 'Link', 'X-Total-Count', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset',
  'RateLimit-Policy', 'Retry-After', 'X-Request-Id', 'X-Correlation-Id', 'X-Chaos-Injected', 'Idempotent-Replayed',
  'Content-Disposition', 'Content-Range', 'Accept-Ranges', 'Upload-Offset', 'Upload-Length', 'Upload-Metadata',
  'Tus-Resumable', 'Tus-Version', 'Tus-Extension', 'Tus-Max-Size', 'WWW-Authenticate',
].join(', ');

module.exports = function cors(settings) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const conf = String(settings.get('corsOrigins') || '*').split(',').map((s) => s.trim()).filter(Boolean);
    if (origin) {
      if (conf.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (conf.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.append('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Expose-Headers', EXPOSE);
    }
    if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.get('access-control-request-headers') || '*');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
};
