'use strict';
// S3-compatible API over the shared file pool (local directory or S3 bucket behind the tool).
//
// A client configures: endpoint = the tool's base URL, the access key id / secret / region from the
// dashboard, and path-style addressing. One bucket (S3_API_BUCKET, default "files") holds every file in
// the pool. Objects are keyed by file name; uploads through this API may use any key, including
// folder-style keys like "in/2026/orders.csv" (stored with the file as s3.key).
//
//   GET    /                                   ListBuckets (signed requests only; unsigned GET / is the dashboard)
//   HEAD   /files                              HeadBucket
//   GET    /files?location | ?versioning | ?acl GetBucketLocation, GetBucketVersioning, GetBucketAcl
//   GET    /files?list-type=2 | /files         ListObjectsV2 | ListObjects (prefix, delimiter, paging, encoding-type=url)
//   GET    /files?uploads                      ListMultipartUploads
//   POST   /files?delete                       DeleteObjects
//   PUT    /files                              CreateBucket (the configured bucket only; idempotent)
//   GET    /files/<key>                        GetObject (Range, If-Match/None-Match/(Un)Modified-Since, response-* overrides)
//   HEAD   /files/<key>                        HeadObject
//   PUT    /files/<key>                        PutObject, or CopyObject with x-amz-copy-source
//   DELETE /files/<key>                        DeleteObject (204 even when missing)
//   POST   /files/<key>?uploads                CreateMultipartUpload
//   PUT    /files/<key>?partNumber=N&uploadId= UploadPart (UploadPartCopy is not supported)
//   GET    /files/<key>?uploadId=              ListParts
//   POST   /files/<key>?uploadId=              CompleteMultipartUpload
//   DELETE /files/<key>?uploadId=              AbortMultipartUpload
// Virtual-hosted-style requests (Host: files.<host>) work too when DNS allows it.
//
// Requests are authenticated with AWS Signature V4 (header or presigned URL) against the S3_API_*
// settings instead of AUTH_MODE; required headers, the rate limit and chaos apply as on every protocol.
// Errors use the S3 XML error format. Uploads, downloads and deletes fire the file webhooks (via "s3").
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const { protocolStack } = require('../../middleware/protocol');
const { sendProblem, HttpError } = require('../../util/problem');
const { escapeXml, parseXml, elements, child, textOf } = require('../../util/xml');
const { guessType } = require('../../services/files');
const { S3Error } = require('./errors');
const { verifyRequest, S3BodyStream, uriEncode, queryPairs, EMPTY_SHA256, sha256hex } = require('./sigv4');

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const MIN_PART = 5 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;
const OWNER = { id: 'api-test-tool', name: 'api-test-tool' };
const KEPT_HEADERS = ['content-encoding', 'content-disposition', 'content-language', 'cache-control', 'expires'];

// ---- XML helpers -----------------------------------------------------------------------------------

function el(name, value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => el(name, v)).join('');
  if (typeof value === 'object') return `<${name}>${Object.entries(value).map(([k, v]) => el(k, v)).join('')}</${name}>`;
  return `<${name}>${escapeXml(value)}</${name}>`;
}
const xmlDoc = (root, inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${XMLNS}">${inner}</${root}>`;
function sendXml(res, status, root, obj) {
  res.status(status).type('application/xml').send(xmlDoc(root, Object.entries(obj).map(([k, v]) => el(k, v)).join('')));
}
const iso = (d) => new Date(d).toISOString();

// ---- request detection --------------------------------------------------------------------------------

function isSigned(req, rawQuery) {
  const auth = req.headers.authorization || '';
  if (/^AWS4-HMAC-SHA256\s/i.test(auth) || /^AWS\s/.test(auth)) return true;
  return /(^|&)X-Amz-Algorithm=/.test(rawQuery) || (/(^|&)AWSAccessKeyId=/.test(rawQuery) && /(^|&)Signature=/.test(rawQuery));
}

function splitUrl(req) {
  const url = req.originalUrl || req.url;
  const i = url.indexOf('?');
  return { rawPath: i < 0 ? url : url.slice(0, i), rawQuery: i < 0 ? '' : url.slice(i + 1) };
}

function decodePath(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

// Marks S3 requests (req.s3) so the inspector can tag them and the S3 router can claim them.
// An S3 request is: under /<bucket>, on the virtual host <bucket>.<host>, or signed with AWS SigV4/SigV2.
function detect(ctx) {
  const { settings } = ctx;
  return function s3Detect(req, res, next) {
    if (!settings.get('s3ApiEnabled')) return next();
    const bucketName = settings.get('s3ApiBucket');
    const { rawPath, rawQuery } = splitUrl(req);
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const vhost = !!bucketName && host.startsWith(`${bucketName.toLowerCase()}.`);
    const segs = rawPath.split('/');
    const first = decodePath(segs[1] || '');
    const signed = isSigned(req, rawQuery);
    if (!vhost && !signed && first !== bucketName) return next();
    let bucket = null;
    let key = null;
    if (vhost) {
      bucket = bucketName;
      const rest = rawPath.slice(1);
      key = rest ? decodePath(rest) : null;
    } else {
      bucket = first || null;
      const rest = segs.slice(2).join('/');
      key = segs.length > 2 && rest !== '' ? decodePath(rest) : null;
    }
    req.s3 = { bucket, key, rawPath, rawQuery, vhost, query: Object.fromEntries(queryPairs(rawQuery)) };
    return next();
  };
}

// ---- body helpers ------------------------------------------------------------------------------------

function hasBody(req) {
  return Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
}

function readAll(stream, limit, tooLarge) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    stream.on('end', () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    stream.on('error', reject);
  });
}

// The request body after SigV4 decoding and checks (see S3BodyStream).
function bodyStream(req) {
  const t = new S3BodyStream(req.s3.auth, req.headers);
  // A failed check (bad hash, checksum, chunk signature) can surface before the consumer's pipeline is
  // attached, e.g. while a slow database lookup is awaited. The stream keeps the error (stream.errored) and
  // the pipeline that reads it later still rejects with it; this listener only keeps it from being uncaught.
  t.on('error', () => {});
  if (req.s3.bodyBuffer) {
    Readable.from([req.s3.bodyBuffer]).pipe(t);
  } else {
    req.on('error', (e) => t.destroy(e));
    req.on('aborted', () => t.destroy(new HttpError(400, 'The client closed the connection before the body was complete', { code: 'IncompleteBody' })));
    req.pipe(t);
  }
  return t;
}

async function bodyBuffer(req, limit = 1024 * 1024) {
  const t = bodyStream(req);
  return readAll(t, limit, () => new S3Error(400, 'MaxMessageLengthExceeded', `The request body is larger than ${limit} bytes.`));
}

function userMetadata(req) {
  const meta = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = String(v);
  return meta;
}

function keptHeaders(req) {
  const out = {};
  for (const h of KEPT_HEADERS) if (req.headers[h] !== undefined) out[h] = String(req.headers[h]);
  return out;
}

const keyOf = (doc) => doc.s3?.key || doc.name;
const etagOf = (doc) => `"${doc.s3?.etag || doc.s3?.md5 || doc.sha256 || `${doc.id}-${doc.size}`}"`;

function checkKey(key) {
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) throw new S3Error(400, 'KeyTooLongError', 'Your key is too long.', { MaxSizeAllowed: MAX_KEY_BYTES });
}

// ---- router ----------------------------------------------------------------------------------------------

function s3Router(ctx) {
  const { settings, files, repo } = ctx;
  const mpuDir = path.resolve(path.dirname(path.resolve(settings.get('fileDir'))), 's3-multipart');
  const creds = () => ({ accessKeyId: settings.get('s3ApiAccessKeyId'), secretAccessKey: settings.get('s3ApiSecretAccessKey'), region: settings.get('s3ApiRegion') });
  const bucketName = () => settings.get('s3ApiBucket');

  // Every object, newest first per key (a key used by more than one pool file resolves to the newest).
  async function objects() {
    const byKey = new Map();
    for (const doc of await files.list()) {
      if (doc.size === null || doc.size === undefined) continue;
      const k = keyOf(doc);
      const prev = byKey.get(k);
      if (!prev || prev.updatedAt < doc.updatedAt) byKey.set(k, doc);
    }
    return byKey;
  }
  async function find(key) { return (await objects()).get(key) || null; }
  async function mustFind(key) {
    const doc = await find(key);
    if (!doc) throw new S3Error(404, 'NoSuchKey', 'The specified key does not exist.', { Key: key });
    return doc;
  }

  async function bucketCreated() {
    let at = await repo.kvGet('s3api:bucketCreated');
    if (!at) { at = new Date().toISOString(); await repo.kvSet('s3api:bucketCreated', at); }
    return at;
  }

  // SigV4 in place of AUTH_MODE (runs where the shared auth would run in protocolStack).
  async function sigv4(req, res, next) {
    try {
      const { rawPath, rawQuery } = req.s3;
      req.s3.auth = await verifyRequest(req, {
        rawPath, rawQuery, creds: creds(),
        payloadHash: async () => {
          if (!hasBody(req)) return EMPTY_SHA256;
          req.s3.bodyBuffer = await readAll(req, files.maxBytes(), () => new S3Error(400, 'EntityTooLarge', `Your proposed upload exceeds the maximum allowed size of ${settings.get('maxFileSizeMb')} MB.`));
          return sha256hex(req.s3.bodyBuffer);
        },
      });
      next();
    } catch (e) {
      next(e);
    }
  }

  // Store a decoded body as a pool file under `key`; replaces the newest file with that key.
  async function storeObject(key, stream, { contentType, meta, headers, etag }) {
    const previous = await find(key);
    const name = path.posix.basename(key.replace(/\/+$/, '')) || 'object';
    const ct = contentType || guessType(name);
    const saved = await files.saveStream({ name, contentType: ct, source: 'uploaded', stream });
    const r = stream.result ? stream.result() : {};
    const s3 = { key, md5: r.md5, etag: etag || r.md5, crc32: r.crc32, meta: meta || {}, headers: headers || {} };
    const doc = { ...saved, contentType: ct, s3 };
    await repo.put('files', doc.id, doc);
    if (previous && previous.id !== doc.id) await files.remove(previous.id);
    files.emit('uploaded', doc, 's3', previous ? { replaced: previous.id } : {});
    return doc;
  }

  function objectHeaders(res, doc, req) {
    res.setHeader('ETag', etagOf(doc));
    res.setHeader('Last-Modified', new Date(doc.updatedAt).toUTCString());
    res.setHeader('Content-Type', doc.contentType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    for (const [k, v] of Object.entries(doc.s3?.headers || {})) res.setHeader(k, v);
    for (const [k, v] of Object.entries(doc.s3?.meta || {})) {
      try { res.setHeader(`x-amz-meta-${k}`, v); } catch { /* invalid header value */ }
    }
    if (doc.s3?.parts) res.setHeader('x-amz-mp-parts-count', String(doc.s3.parts));
    if (String(req.headers['x-amz-checksum-mode'] || '').toUpperCase() === 'ENABLED' && doc.s3?.crc32 && !doc.s3?.parts) res.setHeader('x-amz-checksum-crc32', doc.s3.crc32);
    const q = req.s3.query;
    const overrides = { 'response-content-type': 'Content-Type', 'response-content-disposition': 'Content-Disposition', 'response-content-encoding': 'Content-Encoding', 'response-content-language': 'Content-Language', 'response-cache-control': 'Cache-Control', 'response-expires': 'Expires' };
    for (const [p, h] of Object.entries(overrides)) if (q[p] !== undefined) res.setHeader(h, q[p]);
  }

  // Conditional request headers, evaluated as S3 does. Returns a status to send (304/412) or null.
  function conditional(req, doc) {
    const etag = etagOf(doc);
    const modified = new Date(doc.updatedAt).getTime();
    const list = (h) => String(h).split(',').map((s) => s.trim().replace(/^W\//, ''));
    const im = req.get('if-match');
    const inm = req.get('if-none-match');
    const ims = req.get('if-modified-since');
    const ius = req.get('if-unmodified-since');
    if (im && !list(im).includes(etag) && !list(im).includes('*')) return 412;
    if (!im && ius && !Number.isNaN(Date.parse(ius)) && Math.floor(modified / 1000) > Math.floor(Date.parse(ius) / 1000)) return 412;
    if (inm && (list(inm).includes(etag) || list(inm).includes('*'))) return 304;
    if (!inm && ims && !Number.isNaN(Date.parse(ims)) && Math.floor(modified / 1000) <= Math.floor(Date.parse(ims) / 1000)) return 304;
    return null;
  }

  // ---- bucket operations ----

  async function listBuckets(req, res) {
    sendXml(res, 200, 'ListAllMyBucketsResult', {
      Owner: { ID: OWNER.id, DisplayName: OWNER.name },
      Buckets: { Bucket: [{ Name: bucketName(), CreationDate: await bucketCreated(), BucketRegion: settings.get('s3ApiRegion') }] },
    });
  }

  async function listObjects(req, res, v2) {
    const q = req.s3.query;
    const prefix = q.prefix || '';
    const delimiter = q.delimiter || '';
    const urlEncode = q['encoding-type'] === 'url';
    if (q['encoding-type'] !== undefined && !urlEncode) throw new S3Error(400, 'InvalidArgument', 'Invalid Encoding Method specified in Request', { ArgumentName: 'encoding-type', ArgumentValue: q['encoding-type'] });
    let maxKeys = q['max-keys'] === undefined ? 1000 : Number(q['max-keys']);
    if (!Number.isInteger(maxKeys) || maxKeys < 0) throw new S3Error(400, 'InvalidArgument', 'max-keys must be a non-negative integer.', { ArgumentName: 'max-keys', ArgumentValue: q['max-keys'] });
    maxKeys = Math.min(maxKeys, 1000);
    let start = '';
    if (v2) {
      if (q['continuation-token'] !== undefined) {
        start = Buffer.from(q['continuation-token'], 'base64url').toString('utf8');
        if (!q['continuation-token']) throw new S3Error(400, 'InvalidArgument', 'The continuation token provided is incorrect', { ArgumentName: 'continuation-token' });
      } else if (q['start-after'] !== undefined) start = q['start-after'];
    } else if (q.marker !== undefined) start = q.marker;

    const all = await objects();
    const keys = [...all.keys()].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
    const contents = [];
    const prefixes = [];
    let truncated = false;
    let last = null;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      if (start && Buffer.compare(Buffer.from(k), Buffer.from(start)) <= 0) continue;
      if (start && delimiter && start.endsWith(delimiter) && k.startsWith(start)) continue; // inside the prefix the last page ended on
      let cp = null;
      if (delimiter) {
        const i = k.indexOf(delimiter, prefix.length);
        if (i >= 0) cp = k.slice(0, i + delimiter.length);
      }
      if (cp && prefixes.length && prefixes[prefixes.length - 1] === cp) continue;
      if (contents.length + prefixes.length >= maxKeys) { truncated = true; break; }
      if (cp) { prefixes.push(cp); last = cp; } else { contents.push(all.get(k)); last = k; }
    }
    const enc = (s) => (urlEncode ? uriEncode(s, true) : s);
    const body = {
      Name: bucketName(),
      Prefix: enc(prefix),
      ...(v2 ? { KeyCount: contents.length + prefixes.length } : { Marker: enc(q.marker || '') }),
      MaxKeys: maxKeys,
      ...(delimiter ? { Delimiter: enc(delimiter) } : {}),
      ...(urlEncode ? { EncodingType: 'url' } : {}),
      IsTruncated: truncated,
      ...(v2 && q['continuation-token'] !== undefined ? { ContinuationToken: q['continuation-token'] } : {}),
      ...(v2 && truncated ? { NextContinuationToken: Buffer.from(last).toString('base64url') } : {}),
      ...(v2 && q['start-after'] !== undefined ? { StartAfter: enc(q['start-after']) } : {}),
      ...(!v2 && truncated && delimiter ? { NextMarker: enc(last) } : {}),
      Contents: contents.map((d) => ({
        Key: enc(keyOf(d)), LastModified: iso(d.updatedAt), ETag: etagOf(d), Size: d.size,
        ...(q['fetch-owner'] === 'true' || !v2 ? { Owner: { ID: OWNER.id, DisplayName: OWNER.name } } : {}), StorageClass: 'STANDARD',
      })),
      CommonPrefixes: prefixes.map((p) => ({ Prefix: enc(p) })),
    };
    sendXml(res, 200, 'ListBucketResult', body);
  }

  async function deleteObjects(req, res) {
    const raw = await bodyBuffer(req);
    let root;
    try { root = parseXml(raw.toString('utf8')); } catch (e) { throw new S3Error(400, 'MalformedXML', `The XML you provided was not well-formed: ${e.message}`); }
    if (root.local !== 'Delete') throw new S3Error(400, 'MalformedXML', 'The XML root element must be <Delete>.');
    const quiet = textOf(child(root, 'Quiet')) === 'true';
    const items = elements(root, 'Object').map((o) => textOf(child(o, 'Key')));
    if (items.length > 1000) throw new S3Error(400, 'MalformedXML', 'A Delete request can contain at most 1000 keys.');
    const deleted = [];
    for (const key of items) {
      const doc = await find(key);
      if (doc) {
        await files.remove(doc.id);
        files.emit('deleted', doc, 's3');
      }
      deleted.push({ Key: key });
    }
    sendXml(res, 200, 'DeleteResult', { Deleted: quiet ? [] : deleted });
  }

  // ---- object operations ----

  async function getObject(req, res, head) {
    const q = req.s3.query;
    if (q.partNumber !== undefined) throw new S3Error(501, 'NotImplemented', 'GetObject with partNumber is not supported by this endpoint.');
    const doc = await mustFind(req.s3.key);
    const cond = conditional(req, doc);
    if (cond === 412) throw new S3Error(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold', { Condition: req.get('if-match') ? 'If-Match' : 'If-Unmodified-Since' });
    if (cond === 304) {
      res.setHeader('ETag', etagOf(doc));
      res.setHeader('Last-Modified', new Date(doc.updatedAt).toUTCString());
      return res.status(304).end();
    }
    const size = doc.size;
    let start;
    let end;
    const range = req.get('range');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && !(m[1] === '' && m[2] === '')) {
        if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
          start = Number(m[1]);
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
        }
        if (start >= size || start > end) {
          if (size === 0) { start = undefined; end = undefined; } else {
            throw new S3Error(416, 'InvalidRange', 'The requested range is not satisfiable', { RangeRequested: range, ActualObjectSize: size });
          }
        }
      }
    }
    objectHeaders(res, doc, req); // only once the request is known to succeed (an error must not carry object headers)
    if (start !== undefined) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.removeHeader('x-amz-checksum-crc32');
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(size));
    }
    if (head) return res.end();
    files.trackDownload(req, res, doc, 's3');
    if (size === 0) return res.end();
    const stream = await files.read(doc, start !== undefined ? { start, end } : undefined);
    await pipeline(stream, res);
  }

  async function putObject(req, res) {
    const key = req.s3.key;
    checkKey(key);
    if (req.headers['x-amz-copy-source'] !== undefined) return copyObject(req, res);
    if (!hasBody(req) && req.headers['content-length'] === undefined && !req.s3.bodyBuffer) {
      throw new S3Error(411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
    }
    const stream = bodyStream(req);
    const ct = req.headers['content-type'];
    const doc = await storeObject(key, stream, { contentType: ct && ct !== 'binary/octet-stream' ? ct : undefined, meta: userMetadata(req), headers: keptHeaders(req) });
    res.setHeader('ETag', etagOf(doc));
    if (doc.s3.crc32 && stream.checksumAlgo === 'crc32') res.setHeader('x-amz-checksum-crc32', doc.s3.crc32);
    res.status(200).end();
  }

  async function copyObject(req, res) {
    const raw = String(req.headers['x-amz-copy-source']);
    const src = decodePath(raw.split('?')[0].replace(/^\//, ''));
    if (!src) throw new S3Error(400, 'InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey', { ArgumentName: 'x-amz-copy-source', ArgumentValue: raw });
    const i = src.indexOf('/');
    if (i < 1) throw new S3Error(400, 'InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey', { ArgumentName: 'x-amz-copy-source', ArgumentValue: raw });
    const srcBucket = src.slice(0, i);
    const srcKey = src.slice(i + 1);
    if (srcBucket !== bucketName()) throw new S3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', { BucketName: srcBucket });
    const source = await mustFind(srcKey);
    const cond = {
      'x-amz-copy-source-if-match': (v) => String(v).split(',').map((s) => s.trim()).includes(etagOf(source)),
      'x-amz-copy-source-if-none-match': (v) => !String(v).split(',').map((s) => s.trim()).includes(etagOf(source)),
      'x-amz-copy-source-if-modified-since': (v) => new Date(source.updatedAt).getTime() > Date.parse(v),
      'x-amz-copy-source-if-unmodified-since': (v) => new Date(source.updatedAt).getTime() <= Date.parse(v),
    };
    for (const [h, ok] of Object.entries(cond)) {
      if (req.headers[h] !== undefined && !ok(req.headers[h])) throw new S3Error(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold', { Condition: h });
    }
    const replace = String(req.headers['x-amz-metadata-directive'] || 'COPY').toUpperCase() === 'REPLACE';
    if (srcKey === req.s3.key && !replace) {
      throw new S3Error(400, 'InvalidRequest', 'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata, storage class, website redirect location or encryption attributes.');
    }
    // Drain any (empty) request body, then copy the bytes through the S3 body checks for a fresh MD5.
    if (!req.s3.bodyBuffer) req.resume();
    const t = new S3BodyStream({ payload: { mode: 'unsigned' }, seedSignature: '' }, {});
    (await files.read(source)).pipe(t);
    const doc = await storeObject(req.s3.key, t, {
      contentType: replace ? req.headers['content-type'] : source.contentType,
      meta: replace ? userMetadata(req) : source.s3?.meta,
      headers: replace ? keptHeaders(req) : source.s3?.headers,
    });
    sendXml(res, 200, 'CopyObjectResult', { LastModified: iso(doc.updatedAt), ETag: etagOf(doc) });
  }

  async function deleteObject(req, res) {
    const doc = await find(req.s3.key);
    if (doc) {
      await files.remove(doc.id);
      files.emit('deleted', doc, 's3');
    }
    res.status(204).end();
  }

  // ---- multipart uploads (parts are kept on local disk until completed) ----

  const uploadDir = (id) => {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || '')) throw new S3Error(404, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.', { UploadId: id });
    return path.join(mpuDir, id);
  };
  async function loadUpload(id, key) {
    let info;
    try { info = JSON.parse(await fsp.readFile(path.join(uploadDir(id), 'upload.json'), 'utf8')); } catch (e) {
      if (e instanceof S3Error) throw e;
      throw new S3Error(404, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.', { UploadId: id });
    }
    if (key !== undefined && info.key !== key) throw new S3Error(404, 'NoSuchUpload', 'The specified upload does not exist for this key.', { UploadId: id });
    return info;
  }
  async function listPartFiles(id) {
    const names = await fsp.readdir(uploadDir(id)).catch(() => []);
    const parts = [];
    for (const n of names.filter((x) => /^\d+\.json$/.test(x))) {
      try { parts.push(JSON.parse(await fsp.readFile(path.join(uploadDir(id), n), 'utf8'))); } catch { /* being written */ }
    }
    return parts.sort((a, b) => a.number - b.number);
  }

  async function createUpload(req, res) {
    checkKey(req.s3.key);
    const id = crypto.randomBytes(24).toString('base64url');
    await fsp.mkdir(uploadDir(id), { recursive: true });
    const ct = req.headers['content-type'];
    const info = { id, key: req.s3.key, initiated: new Date().toISOString(), contentType: ct && ct !== 'binary/octet-stream' ? ct : null, meta: userMetadata(req), headers: keptHeaders(req) };
    await fsp.writeFile(path.join(uploadDir(id), 'upload.json'), JSON.stringify(info));
    if (!req.s3.bodyBuffer) req.resume();
    sendXml(res, 200, 'InitiateMultipartUploadResult', { Bucket: bucketName(), Key: req.s3.key, UploadId: id });
  }

  async function uploadPart(req, res) {
    const q = req.s3.query;
    const n = Number(q.partNumber);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new S3Error(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000, inclusive', { ArgumentName: 'partNumber', ArgumentValue: q.partNumber });
    await loadUpload(q.uploadId, req.s3.key);
    if (req.headers['x-amz-copy-source'] !== undefined) throw new S3Error(501, 'NotImplemented', 'UploadPartCopy is not supported by this endpoint.');
    const dir = uploadDir(q.uploadId);
    const tmp = path.join(dir, `${n}.${crypto.randomUUID()}.tmp`);
    const t = bodyStream(req);
    let total = 0;
    const max = files.maxBytes();
    const limiter = new Transform({
      transform(chunk, _e, cb) { total += chunk.length; if (total > max) return cb(new S3Error(400, 'EntityTooLarge', `Your proposed upload exceeds the maximum allowed size of ${settings.get('maxFileSizeMb')} MB.`)); return cb(null, chunk); },
    });
    try {
      await pipeline(t, limiter, fs.createWriteStream(tmp));
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const r = t.result();
    await fsp.rename(tmp, path.join(dir, `${n}.part`));
    await fsp.writeFile(path.join(dir, `${n}.json`), JSON.stringify({ number: n, etag: r.md5, size: r.size, lastModified: new Date().toISOString() }));
    res.setHeader('ETag', `"${r.md5}"`);
    res.status(200).end();
  }

  async function completeUpload(req, res) {
    const id = req.s3.query.uploadId;
    const info = await loadUpload(id, req.s3.key);
    const raw = await bodyBuffer(req);
    let root;
    try { root = parseXml(raw.toString('utf8')); } catch (e) { throw new S3Error(400, 'MalformedXML', `The XML you provided was not well-formed: ${e.message}`); }
    const wanted = elements(root, 'Part').map((p) => ({ number: Number(textOf(child(p, 'PartNumber'))), etag: textOf(child(p, 'ETag')).replace(/"/g, '') }));
    if (!wanted.length) throw new S3Error(400, 'MalformedXML', 'You must specify at least one part');
    for (let i = 1; i < wanted.length; i++) {
      if (!(wanted[i].number > wanted[i - 1].number)) throw new S3Error(400, 'InvalidPartOrder', 'The list of parts was not in ascending order. Parts must be ordered by part number.', { UploadId: id });
    }
    const have = new Map((await listPartFiles(id)).map((p) => [p.number, p]));
    const parts = wanted.map((w) => {
      const p = have.get(w.number);
      if (!p || p.etag !== w.etag) throw new S3Error(400, 'InvalidPart', 'One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part\'s entity tag.', { UploadId: id, PartNumber: w.number, ETag: w.etag });
      return p;
    });
    parts.forEach((p, i) => {
      if (i < parts.length - 1 && p.size < MIN_PART) throw new S3Error(400, 'EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed object size (each part except the last must be at least 5 MiB).', { ProposedSize: p.size, MinSizeAllowed: MIN_PART, PartNumber: p.number, ETag: p.etag });
    });
    const total = parts.reduce((s, p) => s + p.size, 0);
    if (total > files.maxBytes()) throw new S3Error(400, 'EntityTooLarge', `Your proposed upload exceeds the maximum allowed size of ${settings.get('maxFileSizeMb')} MB.`);
    const dir = uploadDir(id);
    async function* concat() {
      for (const p of parts) yield* fs.createReadStream(path.join(dir, `${p.number}.part`));
    }
    const t = new S3BodyStream({ payload: { mode: 'unsigned' }, seedSignature: '' }, {});
    Readable.from(concat()).pipe(t);
    const etag = `${crypto.createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p.etag, 'hex')))).digest('hex')}-${parts.length}`;
    const doc = await storeObject(info.key, t, { contentType: info.contentType || undefined, meta: info.meta, headers: info.headers, etag });
    doc.s3.parts = parts.length;
    await repo.put('files', doc.id, doc);
    await fsp.rm(dir, { recursive: true, force: true });
    const base = ctx.baseUrl(req);
    sendXml(res, 200, 'CompleteMultipartUploadResult', { Location: `${base}/${bucketName()}/${uriEncode(info.key, true)}`, Bucket: bucketName(), Key: info.key, ETag: etagOf(doc) });
  }

  async function abortUpload(req, res) {
    await loadUpload(req.s3.query.uploadId, req.s3.key);
    await fsp.rm(uploadDir(req.s3.query.uploadId), { recursive: true, force: true });
    res.status(204).end();
  }

  async function listParts(req, res) {
    const q = req.s3.query;
    const info = await loadUpload(q.uploadId, req.s3.key);
    const marker = Number(q['part-number-marker'] || 0);
    const max = Math.min(Number(q['max-parts'] || 1000) || 1000, 1000);
    const all = (await listPartFiles(q.uploadId)).filter((p) => p.number > marker);
    const page = all.slice(0, max);
    sendXml(res, 200, 'ListPartsResult', {
      Bucket: bucketName(), Key: info.key, UploadId: info.id, PartNumberMarker: marker,
      ...(all.length > max ? { NextPartNumberMarker: page[page.length - 1].number } : {}), MaxParts: max, IsTruncated: all.length > max,
      Initiator: { ID: OWNER.id, DisplayName: OWNER.name }, Owner: { ID: OWNER.id, DisplayName: OWNER.name }, StorageClass: 'STANDARD',
      Part: page.map((p) => ({ PartNumber: p.number, LastModified: p.lastModified, ETag: `"${p.etag}"`, Size: p.size })),
    });
  }

  async function listUploads(req, res) {
    const ids = await fsp.readdir(mpuDir).catch(() => []);
    const uploads = [];
    for (const id of ids) {
      try { uploads.push(JSON.parse(await fsp.readFile(path.join(mpuDir, id, 'upload.json'), 'utf8'))); } catch { /* gone */ }
    }
    const prefix = req.s3.query.prefix || '';
    sendXml(res, 200, 'ListMultipartUploadsResult', {
      Bucket: bucketName(), KeyMarker: '', UploadIdMarker: '', MaxUploads: 1000, IsTruncated: false,
      Upload: uploads.filter((u) => u.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1)).map((u) => ({
        Key: u.key, UploadId: u.id, Initiator: { ID: OWNER.id, DisplayName: OWNER.name }, Owner: { ID: OWNER.id, DisplayName: OWNER.name }, StorageClass: 'STANDARD', Initiated: u.initiated,
      })),
    });
  }

  // ---- dispatch ----

  async function handle(req, res) {
    const { bucket, key, query: q } = req.s3;
    const m = req.method;
    res.setHeader('x-amz-request-id', req.id || '');
    res.setHeader('x-amz-id-2', req.id || '');
    if (!bucket) {
      if (m === 'GET') return listBuckets(req, res);
      throw new S3Error(405, 'MethodNotAllowed', `The specified method ${m} is not allowed against this resource.`, { Method: m, ResourceType: 'SERVICE' });
    }
    if (bucket !== bucketName()) {
      if (m === 'PUT' && key === null) throw new S3Error(403, 'AccessDenied', `This endpoint has a single bucket, "${bucketName()}"; creating other buckets is not supported.`);
      throw new S3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', { BucketName: bucket });
    }
    res.setHeader('x-amz-bucket-region', settings.get('s3ApiRegion'));
    if (key === null) {
      if (m === 'HEAD') return res.status(200).end();
      if (m === 'GET') {
        if (q.location !== undefined) {
          const region = settings.get('s3ApiRegion');
          return res.status(200).type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="${XMLNS}">${region === 'us-east-1' ? '' : escapeXml(region)}</LocationConstraint>`);
        }
        if (q.versioning !== undefined) return res.status(200).type('application/xml').send(xmlDoc('VersioningConfiguration', ''));
        if (q.acl !== undefined) {
          return sendXml(res, 200, 'AccessControlPolicy', { Owner: { ID: OWNER.id, DisplayName: OWNER.name }, AccessControlList: '' });
        }
        if (q.uploads !== undefined) return listUploads(req, res);
        const unsupported = ['cors', 'policy', 'lifecycle', 'tagging', 'encryption', 'website', 'logging', 'notification', 'replication', 'object-lock', 'ownershipControls', 'publicAccessBlock', 'accelerate', 'requestPayment', 'inventory', 'metrics', 'analytics', 'intelligent-tiering', 'policyStatus', 'versions'].find((s) => q[s] !== undefined);
        if (unsupported) throw new S3Error(501, 'NotImplemented', `The bucket subresource "${unsupported}" is not supported by this endpoint.`);
        return listObjects(req, res, q['list-type'] === '2');
      }
      if (m === 'POST' && q.delete !== undefined) return deleteObjects(req, res);
      if (m === 'PUT' && Object.keys(q).filter((k) => !k.startsWith('X-Amz-')).length === 0) {
        if (!req.s3.bodyBuffer) req.resume();
        res.setHeader('Location', `/${bucketName()}`);
        return res.status(200).end();
      }
      if (m === 'DELETE') throw new S3Error(409, 'BucketNotEmpty', 'This endpoint\'s bucket is the tool\'s file pool and cannot be deleted.', { BucketName: bucket });
      throw new S3Error(501, 'NotImplemented', `${m} on the bucket with these parameters is not supported by this endpoint.`);
    }
    if (q.uploadId !== undefined) {
      if (m === 'PUT' && q.partNumber !== undefined) return uploadPart(req, res);
      if (m === 'POST') return completeUpload(req, res);
      if (m === 'DELETE') return abortUpload(req, res);
      if (m === 'GET') return listParts(req, res);
    }
    if (m === 'POST' && q.uploads !== undefined) return createUpload(req, res);
    const unsupported = ['tagging', 'acl', 'retention', 'legal-hold', 'torrent', 'restore', 'select', 'attributes'].find((s) => q[s] !== undefined);
    if (unsupported) throw new S3Error(501, 'NotImplemented', `The object subresource "${unsupported}" is not supported by this endpoint.`);
    if (m === 'GET') return getObject(req, res, false);
    if (m === 'HEAD') return getObject(req, res, true);
    if (m === 'PUT') return putObject(req, res);
    if (m === 'DELETE') return deleteObject(req, res);
    throw new S3Error(405, 'MethodNotAllowed', `The specified method ${m} is not allowed against this resource.`, { Method: m, ResourceType: 'OBJECT' });
  }

  const r = express.Router();
  r.use((req, res, next) => (req.s3 ? next() : next('router')));
  r.use(...protocolStack(ctx, { format: 's3', auth: sigv4 }));
  r.use(async (req, res, next) => {
    try { await handle(req, res); } catch (e) { next(e); }
  });
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    // An error body must not carry object headers set before the failure (an SDK would check its checksum).
    for (const h of Object.keys(res.getHeaders())) {
      if (/^(x-amz-meta-|x-amz-checksum-|content-(disposition|encoding|language|range)$|etag$|last-modified$|cache-control$|expires$|accept-ranges$)/.test(h)) res.removeHeader(h);
    }
    if (err instanceof S3Error) {
      req.s3ErrorFields = err.fields;
      return sendProblem(req, res, err.status, { detail: err.detail || err.message, code: err.code, headers: err.headers });
    }
    if (err instanceof HttpError) {
      if (err.code === 'IncompleteBody') return sendProblem(req, res, 400, { detail: err.detail, code: 'IncompleteBody' });
      return sendProblem(req, res, err.status, { detail: err.detail || err.message, code: err.code, headers: err.headers });
    }
    ctx.log('error', req.method, req.originalUrl, err.stack || err);
    return sendProblem(req, res, 500, { detail: 'We encountered an internal error. Please try again.', code: 'InternalError' });
  });
  return r;
}

module.exports = s3Router;
module.exports.detect = detect;
