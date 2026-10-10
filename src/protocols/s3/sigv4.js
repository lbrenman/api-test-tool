'use strict';
// AWS Signature Version 4 for the S3 API, as S3 checks it:
//   - Authorization header (AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…)
//   - presigned URLs (X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date, X-Amz-Expires, X-Amz-SignedHeaders,
//     X-Amz-Signature; the payload is always UNSIGNED-PAYLOAD)
//   - x-amz-content-sha256: a hex hash (checked against the body), UNSIGNED-PAYLOAD, or one of the
//     aws-chunked streaming modes (decoded by ChunkedDecoder, with every chunk signature checked)
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { S3Error } = require('./errors');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED = 'UNSIGNED-PAYLOAD';
const STREAMING = {
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD': { signed: true, trailer: false },
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER': { signed: true, trailer: true },
  'STREAMING-UNSIGNED-PAYLOAD-TRAILER': { signed: false, trailer: true },
};
const MAX_SKEW_MS = 15 * 60 * 1000;

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS does it: everything but A-Z a-z 0-9 - _ . ~ ('/' kept when keepSlash). */
function uriEncode(str, keepSlash = false) {
  let out = '';
  for (const b of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Raw query string -> [[name, value]] (decoded, '+' kept literally as S3 does). */
function queryPairs(rawQuery) {
  if (!rawQuery) return [];
  return rawQuery.split('&').filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? [safeDecode(part), ''] : [safeDecode(part.slice(0, i)), safeDecode(part.slice(i + 1))];
  });
}

function canonicalQuery(pairs) {
  return pairs.map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
}

/** The path as S3 signs it: each segment decoded once and re-encoded (no dot-segment normalisation). */
function canonicalPath(rawPath) {
  return rawPath.split('/').map((seg) => uriEncode(safeDecode(seg))).join('/') || '/';
}

/** Header values from rawHeaders (so repeated headers are joined with ',' like AWS clients do). */
function headerValues(req) {
  const out = {};
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    const value = String(raw[i + 1]).trim().replace(/\s+/g, ' ');
    out[name] = out[name] === undefined ? value : `${out[name]},${value}`;
  }
  return out;
}

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

function parseAmzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function denied(code, message, fields, status = 403) {
  return new S3Error(status, code, message, fields);
}

/**
 * Read the signature parameters of a request (header or query). Returns null when the request is not
 * signed with SigV4 at all. Throws S3Error for malformed or SigV2 requests.
 */
function parseAuth(req, rawQuery) {
  const pairs = queryPairs(rawQuery);
  const q = Object.fromEntries(pairs);
  const auth = req.get('authorization');
  if (auth && /^AWS4-HMAC-SHA256\s/i.test(auth)) {
    const params = {};
    for (const part of auth.slice(ALGORITHM.length).split(',')) {
      const i = part.indexOf('=');
      if (i > 0) params[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!params.Credential || !params.SignedHeaders || !params.Signature) {
      throw denied('AuthorizationHeaderMalformed', 'The authorization header is malformed; it needs Credential, SignedHeaders and Signature.', {}, 400);
    }
    const amzDate = req.get('x-amz-date') || null;
    return { kind: 'header', credential: params.Credential, signedHeaders: params.SignedHeaders, signature: params.Signature, amzDate, pairs };
  }
  if (auth && /^AWS\s/.test(auth)) throw denied('InvalidRequest', 'Signature Version 2 is not supported. Use AWS Signature Version 4 (AWS4-HMAC-SHA256).', {}, 400);
  if (q['X-Amz-Algorithm'] !== undefined) {
    if (q['X-Amz-Algorithm'] !== ALGORITHM) throw denied('AuthorizationQueryParametersError', `X-Amz-Algorithm must be ${ALGORITHM}.`, {}, 400);
    for (const k of ['X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) {
      if (!q[k]) throw denied('AuthorizationQueryParametersError', `Query-string authentication requires ${k}.`, {}, 400);
    }
    return {
      kind: 'query', credential: q['X-Amz-Credential'], signedHeaders: q['X-Amz-SignedHeaders'], signature: q['X-Amz-Signature'],
      amzDate: q['X-Amz-Date'], expires: q['X-Amz-Expires'], pairs: pairs.filter(([k]) => k !== 'X-Amz-Signature'),
    };
  }
  if (q.AWSAccessKeyId !== undefined && q.Signature !== undefined) {
    throw denied('InvalidRequest', 'Signature Version 2 is not supported. Use AWS Signature Version 4 (AWS4-HMAC-SHA256).', {}, 400);
  }
  return null;
}

/**
 * Check a request's SigV4 signature. creds = { accessKeyId, secretAccessKey, region }.
 * payloadHash(): async () => the hash to use in the canonical request when the client did not send
 * x-amz-content-sha256 (the caller buffers the body and hashes it).
 * Returns { accessKeyId, region, scope, amzDate, signingKey, seedSignature, payload } where payload is
 * { mode: 'empty'|'hash'|'unsigned'|'streaming', hash?, signed?, trailer? }.
 */
async function verifyRequest(req, { rawPath, rawQuery, creds, payloadHash, now = Date.now() }) {
  const a = parseAuth(req, rawQuery);
  if (!a) throw denied('AccessDenied', 'Anonymous access is not allowed. Sign requests with AWS Signature Version 4 using the access key from the dashboard.');

  const parts = a.credential.split('/');
  if (parts.length !== 5) throw denied(a.kind === 'header' ? 'AuthorizationHeaderMalformed' : 'AuthorizationQueryParametersError', `Credential "${a.credential}" is malformed; expected <access-key-id>/<date>/<region>/s3/aws4_request.`, {}, 400);
  const [akid, date, region, service, terminator] = parts;
  if (akid !== creds.accessKeyId) throw denied('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', { AWSAccessKeyId: akid });
  if (region !== creds.region) {
    throw denied(a.kind === 'header' ? 'AuthorizationHeaderMalformed' : 'AuthorizationQueryParametersError',
      `The authorization header is malformed; the region '${region}' is wrong; expecting '${creds.region}'.`, { Region: creds.region }, 400);
  }
  if (service !== 's3' || terminator !== 'aws4_request') {
    throw denied(a.kind === 'header' ? 'AuthorizationHeaderMalformed' : 'AuthorizationQueryParametersError', `The credential scope must end with /s3/aws4_request (got /${service}/${terminator}).`, {}, 400);
  }

  const amzDateStr = a.amzDate || (req.get('date') ? new Date(req.get('date')).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') : null);
  const when = parseAmzDate(amzDateStr);
  if (!when) throw denied('AccessDenied', 'AWS authentication requires a valid X-Amz-Date or Date header.');
  if (amzDateStr.slice(0, 8) !== date) {
    throw denied('SignatureDoesNotMatch', `The date in the credential scope (${date}) does not match the request date (${amzDateStr.slice(0, 8)}).`);
  }
  if (a.kind === 'header') {
    if (Math.abs(now - when.getTime()) > MAX_SKEW_MS) {
      throw denied('RequestTimeTooSkewed', 'The difference between the request time and the server time is too large.', { RequestTime: amzDateStr, ServerTime: new Date(now).toISOString(), MaxAllowedSkewMilliseconds: MAX_SKEW_MS });
    }
  } else {
    const expires = Number(a.expires);
    if (!Number.isInteger(expires) || expires < 1 || expires > 604800) throw denied('AuthorizationQueryParametersError', 'X-Amz-Expires must be between 1 and 604800 seconds.', {}, 400);
    if (when.getTime() - now > MAX_SKEW_MS) throw denied('AccessDenied', 'Request is not valid yet.');
    if (now > when.getTime() + expires * 1000) throw denied('AccessDenied', 'Request has expired', { 'X-Amz-Expires': expires, Expires: new Date(when.getTime() + expires * 1000).toISOString(), ServerTime: new Date(now).toISOString() });
  }

  // Payload hash as the client declared it.
  const declared = a.kind === 'query' ? UNSIGNED : req.get('x-amz-content-sha256');
  let payload;
  let hashForSig;
  if (declared === UNSIGNED) { payload = { mode: 'unsigned' }; hashForSig = UNSIGNED; } else if (declared && STREAMING[declared]) {
    payload = { mode: 'streaming', ...STREAMING[declared] };
    hashForSig = declared;
  } else if (declared && /^[0-9a-f]{64}$/i.test(declared)) {
    payload = { mode: 'hash', hash: declared.toLowerCase() };
    hashForSig = declared;
  } else if (declared) {
    throw denied('InvalidArgument', `x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a streaming mode or a hex SHA-256 (got "${declared}").`, {}, 400);
  } else {
    hashForSig = await payloadHash();
    payload = { mode: 'hash', hash: hashForSig, verified: true };
  }

  const signed = a.signedHeaders.toLowerCase().split(';').filter(Boolean).sort();
  if (!signed.includes('host')) throw denied('AccessDenied', 'The host header must be signed.');
  const values = headerValues(req);
  const missing = signed.filter((h) => values[h] === undefined);
  if (missing.length) throw denied('AccessDenied', `Signed header${missing.length > 1 ? 's' : ''} missing from the request: ${missing.join(', ')}.`);
  const canonicalHeaders = signed.map((h) => `${h}:${values[h]}\n`).join('');
  const canonicalRequest = [req.method, canonicalPath(rawPath), canonicalQuery(a.pairs), canonicalHeaders, signed.join(';'), hashForSig].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDateStr, scope, sha256hex(canonicalRequest)].join('\n');
  const key = signingKey(creds.secretAccessKey, date, region, 's3');
  const expected = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  const given = String(a.signature).toLowerCase();
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw denied('SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.', {
      AWSAccessKeyId: akid, StringToSign: stringToSign, CanonicalRequest: canonicalRequest,
    });
  }
  return { accessKeyId: akid, region, scope, amzDate: amzDateStr, signingKey: key, seedSignature: expected, payload, kind: a.kind };
}

// ---- checksums ------------------------------------------------------------------------------------

const CHECKSUMS = {
  crc32: () => {
    let crc = 0;
    return { update: (b) => { crc = zlib.crc32(b, crc); }, digest: () => { const o = Buffer.alloc(4); o.writeUInt32BE(crc >>> 0); return o.toString('base64'); } };
  },
  sha1: () => { const h = crypto.createHash('sha1'); return { update: (b) => h.update(b), digest: () => h.digest('base64') }; },
  sha256: () => { const h = crypto.createHash('sha256'); return { update: (b) => h.update(b), digest: () => h.digest('base64') }; },
};

/**
 * Pass-through for an S3 request body: decodes aws-chunked framing (checking chunk and trailer
 * signatures), and checks x-amz-content-sha256, Content-MD5 and x-amz-checksum-* values (header or
 * trailer). Always computes the MD5 (the S3 ETag) and the CRC32. Errors surface as S3Error from flush,
 * before the store commits the object.
 *   auth     - result of verifyRequest
 *   headers  - lowercase request headers
 *   result() - { md5, crc32, size, trailers }
 */
class S3BodyStream extends Transform {
  constructor(auth, headers) {
    super();
    this.auth = auth;
    this.payload = auth.payload;
    this.md5 = crypto.createHash('md5');
    this.sha = this.payload.mode === 'hash' && !this.payload.verified ? crypto.createHash('sha256') : null;
    this.crc = CHECKSUMS.crc32();
    this.size = 0;
    this.headers = headers;
    this.trailers = {};
    // Additional checksum named by a header (x-amz-checksum-sha256: …) or announced as a trailer.
    const algo = ['crc32', 'sha1', 'sha256'].find((a) => headers[`x-amz-checksum-${a}`] !== undefined)
      || /^x-amz-checksum-(crc32|sha1|sha256)$/i.exec(String(headers['x-amz-trailer'] || '').trim())?.[1]?.toLowerCase();
    this.checksumAlgo = algo || null;
    this.extra = algo && algo !== 'crc32' ? CHECKSUMS[algo]() : null;
    // aws-chunked parser state
    this.chunked = this.payload.mode === 'streaming';
    this.buf = Buffer.alloc(0);
    this.state = 'header'; // header | data | data-crlf | trailer | done
    this.remaining = 0;
    this.chunkSig = null;
    this.chunkHash = null;
    this.prevSig = auth.seedSignature;
    this.trailerLines = [];
    this.declaredLength = headers['x-amz-decoded-content-length'] !== undefined ? Number(headers['x-amz-decoded-content-length']) : null;
  }

  data(b) {
    if (!b.length) return;
    this.size += b.length;
    this.md5.update(b);
    this.crc.update(b);
    if (this.sha) this.sha.update(b);
    if (this.extra) this.extra.update(b);
    this.push(b);
  }

  fail(err) { this.failed = err; }

  _transform(chunk, _enc, cb) {
    if (this.failed) return cb();
    if (!this.chunked) { this.data(chunk); return cb(); }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.parse();
    } catch (e) {
      this.fail(e);
    }
    return cb();
  }

  chunkStringToSign(hashHex) {
    return ['AWS4-HMAC-SHA256-PAYLOAD', this.auth.amzDate, this.auth.scope, this.prevSig, EMPTY_SHA256, hashHex].join('\n');
  }

  endChunk(isFinal) {
    if (this.payload.signed) {
      const hash = this.chunkHash.digest('hex');
      const expect = crypto.createHmac('sha256', this.auth.signingKey).update(this.chunkStringToSign(hash)).digest('hex');
      if (!this.chunkSig || this.chunkSig !== expect) {
        throw denied('SignatureDoesNotMatch', `The chunk signature${isFinal ? ' of the final chunk' : ''} does not match.`);
      }
      this.prevSig = expect;
    }
  }

  parse() {
    for (;;) {
      if (this.state === 'header' || this.state === 'trailer') {
        const i = this.buf.indexOf('\r\n');
        if (i < 0) {
          if (this.buf.length > 8192) throw denied('IncompleteBody', 'Malformed aws-chunked body (header line too long).', {}, 400);
          return;
        }
        const line = this.buf.subarray(0, i).toString('latin1');
        this.buf = this.buf.subarray(i + 2);
        if (this.state === 'trailer') {
          if (line === '') { this.state = 'done'; continue; }
          this.trailerLines.push(line);
          const j = line.indexOf(':');
          if (j > 0) this.trailers[line.slice(0, j).trim().toLowerCase()] = line.slice(j + 1).trim();
          continue;
        }
        const [sizeHex, ...ext] = line.split(';');
        const size = parseInt(sizeHex, 16);
        if (!/^[0-9a-fA-F]+$/.test(sizeHex) || !Number.isFinite(size)) throw denied('IncompleteBody', `Malformed aws-chunked body (bad chunk size "${sizeHex}").`, {}, 400);
        const sig = ext.map((e) => e.split('=')).find(([k]) => k.trim() === 'chunk-signature');
        this.chunkSig = sig ? sig[1].trim() : null;
        this.chunkHash = crypto.createHash('sha256');
        if (size === 0) {
          this.endChunk(true);
          this.state = this.payload.trailer ? 'trailer' : 'done';
          continue;
        }
        this.remaining = size;
        this.state = 'data';
      } else if (this.state === 'data') {
        if (!this.buf.length) return;
        const take = this.buf.subarray(0, Math.min(this.remaining, this.buf.length));
        this.buf = this.buf.subarray(take.length);
        this.remaining -= take.length;
        this.chunkHash.update(take);
        this.data(take);
        if (this.remaining === 0) this.state = 'data-crlf';
      } else if (this.state === 'data-crlf') {
        if (this.buf.length < 2) return;
        if (this.buf[0] !== 13 || this.buf[1] !== 10) throw denied('IncompleteBody', 'Malformed aws-chunked body (missing CRLF after chunk data).', {}, 400);
        this.buf = this.buf.subarray(2);
        this.endChunk(false);
        this.state = 'header';
      } else {
        // done: ignore anything after the terminating chunk / trailer
        this.buf = Buffer.alloc(0);
        return;
      }
    }
  }

  _flush(cb) {
    if (this.failed) return cb(this.failed);
    try {
      if (this.chunked && this.state === 'trailer' && this.buf.length === 0) this.state = 'done'; // trailer ended without blank line
      if (this.chunked && this.state !== 'done') throw denied('IncompleteBody', 'The request body ended before the final aws-chunked chunk.', {}, 400);
      if (this.chunked && this.declaredLength !== null && this.declaredLength !== this.size) {
        throw denied('IncompleteBody', `x-amz-decoded-content-length is ${this.declaredLength} but ${this.size} bytes were sent.`, {}, 400);
      }
      if (this.chunked && this.payload.signed && this.payload.trailer && this.trailers['x-amz-trailer-signature']) {
        const body = `${this.trailerLines.filter((l) => !/^x-amz-trailer-signature:/i.test(l)).map((l) => l.replace(/\s*:\s*/, ':')).join('\n')}\n`;
        const sts = ['AWS4-HMAC-SHA256-TRAILER', this.auth.amzDate, this.auth.scope, this.prevSig, sha256hex(body)].join('\n');
        const expect = crypto.createHmac('sha256', this.auth.signingKey).update(sts).digest('hex');
        if (expect !== this.trailers['x-amz-trailer-signature']) throw denied('SignatureDoesNotMatch', 'The trailer signature does not match.');
      }
      if (this.sha) {
        const actual = this.sha.digest('hex');
        if (actual !== this.payload.hash) {
          throw denied('XAmzContentSHA256Mismatch', "The provided 'x-amz-content-sha256' header does not match what was computed.", { ClientComputedContentSHA256: this.payload.hash, S3ComputedContentSHA256: actual }, 400);
        }
      }
      this.md5Hex = this.md5.digest('hex');
      if (this.headers['content-md5'] !== undefined) {
        const got = Buffer.from(this.md5Hex, 'hex').toString('base64');
        if (got !== String(this.headers['content-md5']).trim()) throw denied('BadDigest', 'The Content-MD5 you specified did not match what we received.', {}, 400);
      }
      this.crc32 = this.crc.digest();
      if (this.checksumAlgo) {
        const name = `x-amz-checksum-${this.checksumAlgo}`;
        const declared = this.headers[name] ?? this.trailers[name];
        const actual = this.checksumAlgo === 'crc32' ? this.crc32 : this.extra.digest();
        if (declared !== undefined && String(declared).trim() !== actual) {
          throw denied('BadDigest', `The ${this.checksumAlgo.toUpperCase()} you specified did not match the calculated checksum.`, {}, 400);
        }
      }
      return cb();
    } catch (e) {
      return cb(e);
    }
  }

  result() { return { md5: this.md5Hex, crc32: this.crc32, size: this.size, trailers: this.trailers }; }
}

/** Build a presigned GET/PUT URL (used by the dashboard guide and tests). */
function presignUrl({ method = 'GET', url, accessKeyId, secretAccessKey, region, expiresIn = 900, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const pairs = [...queryPairs(u.search.slice(1)),
    ['X-Amz-Algorithm', ALGORITHM], ['X-Amz-Credential', `${accessKeyId}/${scope}`], ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)], ['X-Amz-SignedHeaders', 'host']];
  const canonical = [method, canonicalPath(u.pathname), canonicalQuery(pairs), `host:${u.host}\n`, 'host', UNSIGNED].join('\n');
  const sts = [ALGORITHM, amzDate, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(secretAccessKey, date, region, 's3')).update(sts).digest('hex');
  return `${u.origin}${u.pathname}?${canonicalQuery([...pairs, ['X-Amz-Signature', sig]])}`;
}

module.exports = {
  verifyRequest, parseAuth, S3BodyStream, uriEncode, queryPairs, canonicalQuery, canonicalPath, presignUrl, EMPTY_SHA256, sha256hex,
};
