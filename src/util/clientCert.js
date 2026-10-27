'use strict';
// The client certificate of a request that came in on the mTLS listener (src/app.js listenTls), parsed once per request.
// The listener asks for a certificate but accepts the handshake without one (rejectUnauthorized: false), so a missing or
// untrusted certificate becomes an ordinary 401 with a reason instead of a TLS error the client cannot read.
const crypto = require('node:crypto');

function sans(text) {
  const out = { dns: [], uri: [], email: [], ip: [] };
  for (const part of String(text || '').split(/,\s*/)) {
    const i = part.indexOf(':');
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === 'DNS') out.dns.push(v); else if (k === 'URI') out.uri.push(v); else if (k === 'email') out.email.push(v); else if (k === 'IP Address') out.ip.push(v);
  }
  return out;
}

/** null when the request did not come over TLS or sent no certificate. */
function clientCert(req) {
  if (req._clientCert !== undefined) return req._clientCert;
  const sock = req.socket;
  let out = null;
  if (sock?.encrypted && typeof sock.getPeerX509Certificate === 'function') {
    const x = sock.getPeerX509Certificate();
    if (x) {
      const cn = /(?:^|\n)CN=([^\n]*)/.exec(x.subject)?.[1] || '';
      out = {
        authorized: sock.authorized === true,
        error: sock.authorized ? null : String(sock.authorizationError || 'not trusted'),
        subject: x.subject.replace(/\n/g, ', '),
        issuer: x.issuer.replace(/\n/g, ', '),
        cn,
        sans: sans(x.subjectAltName),
        serialNumber: x.serialNumber,
        validTo: new Date(x.validTo).toISOString(),
        fingerprint256: x.fingerprint256,
        x5tS256: crypto.createHash('sha256').update(x.raw).digest('base64url'),
        raw: x.raw,
        selfSigned: x.subject === x.issuer && x.checkIssued(x),
      };
    }
  }
  req._clientCert = out;
  return out;
}

/** The names a certificate can be matched by: its CN and every SAN value. */
const certNames = (c) => (c ? [c.cn, ...c.sans.dns, ...c.sans.uri, ...c.sans.email, ...c.sans.ip].filter(Boolean) : []);

module.exports = { clientCert, certNames };
