'use strict';
// PKCS#12 (.p12 / .pfx) writer for the lab CA's client certificates (RFC 7292): the private key as a PBES2 /
// AES-256-CBC shrouded key bag (Node's encrypted PKCS#8), the certificate chain as cert bags, and an HMAC-SHA256 MAC.
// Java keystores, Postman, curl (--cert-type P12), browsers and OpenSSL 3 read it.
const crypto = require('node:crypto');
const d = require('./der');

const OID = {
  data: '1.2.840.113549.1.7.1',
  keyBag: '1.2.840.113549.1.12.10.1.2', // pkcs8ShroudedKeyBag
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  friendlyName: '1.2.840.113549.1.9.20',
  sha256: '2.16.840.1.101.3.4.2.1',
};
const ITERATIONS = 2048;

// RFC 7292 appendix B.2 key derivation (used for the MAC key, id 3), with SHA-256 (u = 32, v = 64).
function pkcs12Kdf(password, salt, id, iterations, n) {
  const u = 32;
  const v = 64;
  const pw = Buffer.concat([Buffer.from(password, 'utf16le').swap16(), Buffer.alloc(2)]);
  const fill = (b) => { if (!b.length) return Buffer.alloc(0); const out = Buffer.alloc(v * Math.ceil(b.length / v)); for (let i = 0; i < out.length; i += 1) out[i] = b[i % b.length]; return out; };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(pw)]);
  const out = [];
  for (let produced = 0; produced < n; produced += u) {
    let A = crypto.createHash('sha256').update(D).update(I).digest();
    for (let r = 1; r < iterations; r += 1) A = crypto.createHash('sha256').update(A).digest();
    out.push(A);
    const B = fill(A).subarray(0, v);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k -= 1) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

const attrs = (keyId, name) => d.set(
  keyId ? d.seq(d.oid(OID.localKeyId), d.set(d.octet(keyId))) : null,
  name ? d.seq(d.oid(OID.friendlyName), d.set(d.bmp(name))) : null,
);
const dataInfo = (der) => d.seq(d.oid(OID.data), d.explicit(0, d.octet(der)));

/**
 * A .p12 holding keyPem (any Node-readable private key), certPem and the chain (CA certificates), protected by password.
 * Returns a Buffer.
 */
function buildPkcs12({ keyPem, certPem, chainPems = [], password, name }) {
  if (!password) throw new Error('A PKCS#12 file needs a password');
  const certDer = new crypto.X509Certificate(certPem).raw;
  const keyId = crypto.createHash('sha1').update(certDer).digest();
  const certBag = (der, withId) => d.seq(d.oid(OID.certBag), d.explicit(0, d.seq(d.oid(OID.x509), d.explicit(0, d.octet(der)))), withId ? attrs(keyId, name) : null);
  const certs = d.seq(certBag(certDer, true), ...chainPems.map((p) => certBag(new crypto.X509Certificate(p).raw, false)));
  const shrouded = crypto.createPrivateKey(keyPem).export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase: password });
  const keys = d.seq(d.seq(d.oid(OID.keyBag), d.explicit(0, shrouded), attrs(keyId, name)));
  const authSafe = d.seq(dataInfo(certs), dataInfo(keys));
  const salt = crypto.randomBytes(16);
  const mac = crypto.createHmac('sha256', pkcs12Kdf(password, salt, 3, ITERATIONS, 32)).update(authSafe).digest();
  return d.seq(d.int(3), dataInfo(authSafe), d.seq(d.seq(d.seq(d.oid(OID.sha256), d.nul()), d.octet(mac)), d.octet(salt), d.int(ITERATIONS)));
}

module.exports = { buildPkcs12, pkcs12Kdf };
