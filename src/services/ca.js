'use strict';
// The lab CA for mutual TLS (docs/security-roadmap.md, step 3): generated on first start and kept in the database like
// the JWT keys. It issues client certificates (PEM and PKCS#12) from the Auth page and the server certificate for the
// mTLS listener, so a demo needs neither openssl nor a third-party CA. Certificates are built with util/der.js.
const crypto = require('node:crypto');
const net = require('node:net');
const d = require('../util/der');
const { buildPkcs12 } = require('../util/pkcs12');
const { HttpError } = require('../util/problem');

const OID = {
  cn: '2.5.4.3', o: '2.5.4.10', ou: '2.5.4.11',
  ecdsaSha256: '1.2.840.10045.4.3.2', rsaSha256: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', san: '2.5.29.17', ski: '2.5.29.14', aki: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1', clientAuth: '1.3.6.1.5.5.7.3.2',
};
const DAY = 86400000;

/** Subject or issuer Name: CN, O and OU, as UTF8Strings. */
const name = ({ cn, o, ou }) => d.seq(...[[OID.cn, cn], [OID.o, o], [OID.ou, ou]].filter(([, v]) => v).map(([k, v]) => d.set(d.seq(d.oid(k), d.utf8(v)))));
const ext = (id, critical, value) => d.seq(d.oid(id), critical ? d.bool(true) : null, d.octet(value));

function sanValue({ dns = [], uri = [], email = [], ip = [] }) {
  const ipBytes = (s) => (net.isIPv6(s) ? Buffer.from(expandV6(s), 'hex') : Buffer.from(s.split('.').map(Number)));
  return d.seq(...email.map((e) => d.implicit(1, Buffer.from(e))), ...dns.map((n) => d.implicit(2, Buffer.from(n))), ...uri.map((u) => d.implicit(6, Buffer.from(u))), ...ip.map((a) => d.implicit(7, ipBytes(a))));
}
function expandV6(s) {
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((x) => x.padStart(4, '0')).join('');
}

/** Sign a TBSCertificate and wrap it into a PEM certificate. */
function makeCert({ subject, issuer, publicKey, signKey, serial, notBefore, notAfter, extensions }) {
  const ec = signKey.asymmetricKeyType === 'ec';
  const alg = d.seq(d.oid(ec ? OID.ecdsaSha256 : OID.rsaSha256), ec ? null : d.nul());
  const tbs = d.seq(d.explicit(0, d.int(2)), d.int(serial), alg, name(issuer), d.seq(d.time(notBefore), d.time(notAfter)), name(subject),
    publicKey.export({ type: 'spki', format: 'der' }), d.explicit(3, d.seq(...extensions)));
  const sig = crypto.sign('sha256', tbs, signKey);
  const der = d.seq(tbs, alg, d.bits(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

const keyId = (publicKey) => crypto.createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();

/** RFC 8705 thumbprint: base64url SHA-256 of the certificate's DER. */
const x5tS256 = (der) => crypto.createHash('sha256').update(der).digest('base64url');

function describe(pem) {
  const x = new crypto.X509Certificate(pem);
  return {
    subject: x.subject, issuer: x.issuer, serialNumber: x.serialNumber, validFrom: new Date(x.validFrom).toISOString(), validTo: new Date(x.validTo).toISOString(),
    subjectAltName: x.subjectAltName || '', fingerprint256: x.fingerprint256, 'x5t#S256': x5tS256(x.raw),
  };
}

class CaService {
  constructor(ctx) { this.ctx = ctx; }

  async init() {
    let doc = await this.ctx.repo.get('mtls', 'ca');
    if (!doc) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const now = Date.now();
      const subject = { cn: 'API Test Tool lab CA', o: 'API Test Tool', ou: 'lab' };
      const ski = keyId(publicKey);
      const certPem = makeCert({
        subject, issuer: subject, publicKey, signKey: privateKey, serial: crypto.randomBytes(16), notBefore: new Date(now - 300000), notAfter: new Date(now + 3650 * DAY),
        extensions: [ext(OID.basicConstraints, true, d.seq(d.bool(true), d.int(0))), ext(OID.keyUsage, true, d.flags(0x86)), ext(OID.ski, false, d.octet(ski))],
      });
      doc = { id: 'ca', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem, createdAt: new Date(now).toISOString() };
      await this.ctx.repo.put('mtls', 'ca', doc);
    }
    this.caKey = crypto.createPrivateKey(doc.keyPem);
    this.caPem = doc.certPem;
    this.caCert = new crypto.X509Certificate(doc.certPem);
    this.caSubject = { cn: 'API Test Tool lab CA', o: 'API Test Tool', ou: 'lab' };
  }

  caInfo() { return { pem: this.caPem, ...describe(this.caPem) }; }

  /**
   * Issue a certificate signed by the lab CA. usage 'client' (clientAuth) or 'server' (serverAuth). san: {dns, uri,
   * email, ip} arrays. Returns { certPem, keyPem, ...describe }.
   */
  issue({ cn, o, ou, san = {}, days = 365, keyType = 'ec', usage = 'client' } = {}) {
    if (!cn || typeof cn !== 'string' || cn.length > 64) throw new HttpError(400, 'cn (common name) is required, at most 64 characters', { code: 'invalid-certificate-request' });
    const lists = {};
    for (const k of ['dns', 'uri', 'email', 'ip']) {
      const v = san[k] === undefined ? [] : Array.isArray(san[k]) ? san[k] : String(san[k]).split(/[\s,]+/);
      lists[k] = v.map((x) => String(x).trim()).filter(Boolean);
      if (lists[k].length > 10) throw new HttpError(400, `At most 10 ${k} names`, { code: 'invalid-certificate-request' });
    }
    for (const u of lists.uri) { try { new URL(u); } catch { throw new HttpError(400, `"${u}" is not a URI (e.g. spiffe://lab/agent)`, { code: 'invalid-certificate-request' }); } } // eslint-disable-line no-new
    for (const a of lists.ip) if (!net.isIP(a)) throw new HttpError(400, `"${a}" is not an IP address`, { code: 'invalid-certificate-request' });
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 825) throw new HttpError(400, 'days must be 1-825', { code: 'invalid-certificate-request' });
    const pair = keyType === 'rsa' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rsa = keyType === 'rsa';
    const now = Date.now();
    const extensions = [
      ext(OID.basicConstraints, true, d.seq()),
      ext(OID.keyUsage, true, d.flags(rsa ? 0xa0 : 0x80)),
      ext(OID.extKeyUsage, false, d.seq(d.oid(usage === 'server' ? OID.serverAuth : OID.clientAuth))),
      ext(OID.ski, false, d.octet(keyId(pair.publicKey))),
      ext(OID.aki, false, d.seq(d.implicit(0, keyId(this.caCert.publicKey)))),
    ];
    if (Object.values(lists).some((l) => l.length)) extensions.push(ext(OID.san, false, sanValue(lists)));
    const certPem = makeCert({
      subject: { cn, o, ou }, issuer: this.caSubject, publicKey: pair.publicKey, signKey: this.caKey, serial: crypto.randomBytes(16),
      notBefore: new Date(now - 300000), notAfter: new Date(now + n * DAY), extensions,
    });
    return { certPem, keyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyType: rsa ? 'rsa' : 'ec', usage, ...describe(certPem) };
  }

  pkcs12(cert, password, friendly) { return buildPkcs12({ keyPem: cert.keyPem, certPem: cert.certPem, chainPems: [this.caPem], password, name: friendly }); }

  // ---- client certificates issued from the dashboard (kept, private key included, so they can be downloaded again)
  async list() { return (await this.ctx.repo.list('mtls_certs')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }

  async get(id) { return this.ctx.repo.get('mtls_certs', id); }

  async create(req) {
    const c = this.issue({ ...req, usage: 'client' });
    const doc = { id: c.serialNumber.toLowerCase(), cn: req.cn, label: String(req.label || '').slice(0, 100) || undefined, ...c, createdAt: new Date().toISOString() };
    await this.ctx.repo.put('mtls_certs', doc.id, doc);
    return doc;
  }

  async remove(id) { return this.ctx.repo.del('mtls_certs', id); }

  /** The mTLS listener's certificate: issued by the lab CA for the hostnames given (kept until the names change). */
  async serverCert(hostnames) {
    const names = [...new Set(hostnames.filter(Boolean))].sort();
    const doc = await this.ctx.repo.get('mtls', 'server');
    if (doc && doc.names?.join(',') === names.join(',') && new Date(doc.validTo).getTime() - Date.now() > 30 * DAY) return doc;
    const c = this.issue({ cn: names.find((h) => !net.isIP(h)) || names[0] || 'localhost', san: { dns: names.filter((h) => !net.isIP(h)), ip: names.filter((h) => net.isIP(h)) }, days: 397, usage: 'server' });
    const out = { id: 'server', names, ...c };
    await this.ctx.repo.put('mtls', 'server', out);
    return out;
  }
}

module.exports = { CaService, x5tS256, describe };
