'use strict';
// Minimal DER (ASN.1) encoder, enough to build X.509 certificates and PKCS#12 files for the lab CA (services/ca.js).
// Node can parse certificates (crypto.X509Certificate) but not create them; this keeps the CA free of dependencies.

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map((p) => Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };

const seq = (...items) => tlv(0x30, ...items.filter(Boolean));
const set = (...items) => tlv(0x31, ...items.filter(Boolean));
const nul = () => Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, [v ? 0xff : 0x00]);
const octet = (b) => tlv(0x04, b);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const ia5 = (s) => tlv(0x16, Buffer.from(String(s), 'ascii'));
const bmp = (s) => tlv(0x1e, Buffer.from(String(s), 'utf16le').swap16());

/** INTEGER from a number, bigint or unsigned big-endian Buffer (a leading 0 keeps it positive). */
function int(v) {
  let b;
  if (Buffer.isBuffer(v)) b = v;
  else {
    let x = BigInt(v);
    const bytes = [];
    do { bytes.unshift(Number(x & 0xffn)); x >>= 8n; } while (x > 0n);
    b = Buffer.from(bytes);
  }
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && b[i + 1] < 0x80) i += 1;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, out);
}

/** BIT STRING with no unused bits (key material, signatures). */
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), Buffer.from(b)]));

/** BIT STRING for named-bit flags (KeyUsage): DER drops trailing zero bits. */
function flags(byte0, byte1) {
  const bytes = byte1 ? [byte0, byte1] : [byte0];
  const last = bytes[bytes.length - 1];
  let unused = 0;
  while (unused < 8 && !(last & (1 << unused))) unused += 1;
  return tlv(0x03, [unused, ...bytes]);
}

/** UTCTime before 2050, GeneralizedTime after (RFC 5280 4.1.2.5). */
function time(d) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const explicit = (n, ...items) => tlv(0xa0 + n, ...items);
const implicit = (n, b) => tlv(0x80 + n, b); // primitive context tag, e.g. GeneralName dNSName [2]

module.exports = { tlv, seq, set, nul, bool, octet, utf8, ia5, bmp, int, oid, bits, flags, time, explicit, implicit };
