'use strict';
// S3-compatible API over the file pool, exercised with the real AWS SDK for JavaScript v3 (and curl-style
// requests signed by hand). Runs against local storage by default and against MinIO in CI (TEST_FILE_STORE=s3).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const {
  S3Client, ListBucketsCommand, HeadBucketCommand, GetBucketLocationCommand, ListObjectsV2Command, ListObjectsCommand,
  PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListPartsCommand,
  GetBucketVersioningCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { listen } = require('./helpers');
const { verifyRequest, S3BodyStream, presignUrl } = require('../src/protocols/s3/sigv4');

const BUCKET = 'files';
const CREDS = { accessKeyId: 'demo-access-key', secretAccessKey: 'demo-secret-key' };
let t;
let s3;
const events = [];

const client = (over = {}) => new S3Client({
  endpoint: t.url, region: 'us-east-1', forcePathStyle: true, credentials: CREDS, maxAttempts: 1, ...over,
});
const text = async (r) => r.Body.transformToString();
const fail = async (p) => { try { await p; } catch (e) { return e; } throw new Error('expected the call to fail'); };

before(async () => {
  t = await listen({ MAX_FILE_SIZE_MB: '20' });
  s3 = client();
  t.ctx.events.on('file', (e) => events.push(e));
});
after(async () => { await t.stop(); });

// ---- minimal header signer for hand-made requests (same algorithm as the SDK) ----
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
function sign({ method, path, query = '', headers = {}, payloadHash, secret = CREDS.secretAccessKey, region = 'us-east-1', date = new Date() }) {
  const amz = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const host = new URL(t.url).host;
  const h = { host, 'x-amz-date': amz, ...(payloadHash ? { 'x-amz-content-sha256': payloadHash } : {}), ...headers };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const canonical = [method, path, query, names.map((n) => `${n}:${String(h[Object.keys(h).find((k) => k.toLowerCase() === n)]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${amz.slice(0, 8)}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, amz.slice(0, 8)), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', key).update(sts).digest('hex');
  const out = { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${CREDS.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
  delete out.host;
  return out;
}

test('bucket operations: ListBuckets, HeadBucket, GetBucketLocation, GetBucketVersioning', async () => {
  const b = await s3.send(new ListBucketsCommand({}));
  assert.deepEqual(b.Buckets.map((x) => x.Name), [BUCKET]);
  assert.equal(b.Owner.ID, 'api-test-tool');
  assert.equal((await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))).$metadata.httpStatusCode, 200);
  assert.equal((await s3.send(new GetBucketLocationCommand({ Bucket: BUCKET }))).LocationConstraint, undefined); // us-east-1 = empty
  assert.equal((await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }))).Status, undefined);
  const e = await fail(s3.send(new HeadBucketCommand({ Bucket: 'other-bucket' })));
  assert.equal(e.$metadata.httpStatusCode, 404);
  const e2 = await fail(s3.send(new ListObjectsV2Command({ Bucket: 'other-bucket' })));
  assert.equal(e2.name, 'NoSuchBucket');
});

test('the pool is the bucket: sample files and /v1 uploads are listed by name', async () => {
  await fetch(`${t.url}/v1/files/raw/from-v1.txt`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'via v1' });
  const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const keys = l.Contents.map((c) => c.Key);
  assert.ok(keys.includes('employees.csv'));
  assert.ok(keys.includes('from-v1.txt'));
  assert.deepEqual(keys, [...keys].sort());
  const g = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'from-v1.txt' }));
  assert.equal(await text(g), 'via v1');
  assert.equal(g.ContentType, 'text/plain');
});

test('PutObject, GetObject, HeadObject with metadata; the file shows up in /v1/files with its key', async () => {
  events.length = 0;
  const put = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'in/2026/orders.csv', Body: 'id,total\n1,9.5\n', ContentType: 'text/csv', Metadata: { source: 'erp' }, CacheControl: 'no-cache' }));
  const md5 = crypto.createHash('md5').update('id,total\n1,9.5\n').digest('hex');
  assert.equal(put.ETag, `"${md5}"`);
  const g = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'in/2026/orders.csv' }));
  assert.equal(await text(g), 'id,total\n1,9.5\n');
  assert.equal(g.ContentType, 'text/csv');
  assert.equal(g.CacheControl, 'no-cache');
  assert.deepEqual(g.Metadata, { source: 'erp' });
  assert.equal(g.ETag, `"${md5}"`);
  const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'in/2026/orders.csv' }));
  assert.equal(h.ContentLength, 15);
  const v1 = await (await fetch(`${t.url}/v1/files?limit=200`)).json();
  const f = v1.data.find((x) => x.s3?.key === 'in/2026/orders.csv');
  assert.ok(f, 'listed in /v1/files');
  assert.equal(f.name, 'orders.csv');
  assert.equal(f.sha256, hex('id,total\n1,9.5\n'));
  const up = events.find((e) => e.type === 'uploaded');
  assert.equal(up.via, 's3');
  assert.ok(events.some((e) => e.type === 'downloaded' && e.via === 's3'));
});

test('overwriting a key replaces the object; a streamed body (aws-chunked with a trailing checksum) works', async () => {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'stream.bin', Body: 'v1' }));
  const data = crypto.randomBytes(300 * 1024);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'stream.bin', Body: Readable.from([data.subarray(0, 100000), data.subarray(100000)]), ContentLength: data.length }));
  const g = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'stream.bin' }));
  assert.ok(Buffer.from(await g.Body.transformToByteArray()).equals(data));
  const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'stream.bin' }));
  assert.equal(l.KeyCount, 1);
});

test('ListObjectsV2 with delimiter and paging; ListObjects (v1) with marker; encoding-type=url', async () => {
  for (const k of ['dir/a.txt', 'dir/b.txt', 'dir/sub/c.txt', 'dir/sub/d.txt', 'dir/e f+g.txt']) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: k }));
  }
  const d = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'dir/', Delimiter: '/' }));
  assert.deepEqual(d.Contents.map((c) => c.Key), ['dir/a.txt', 'dir/b.txt', 'dir/e f+g.txt']);
  assert.deepEqual(d.CommonPrefixes.map((c) => c.Prefix), ['dir/sub/']);
  const seen = [];
  let token;
  do {
    const p = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'dir/', MaxKeys: 2, ContinuationToken: token }));
    seen.push(...p.Contents.map((c) => c.Key));
    token = p.NextContinuationToken;
    if (token) assert.equal(p.IsTruncated, true);
  } while (token);
  assert.deepEqual(seen, ['dir/a.txt', 'dir/b.txt', 'dir/e f+g.txt', 'dir/sub/c.txt', 'dir/sub/d.txt']);
  const v1 = await s3.send(new ListObjectsCommand({ Bucket: BUCKET, Prefix: 'dir/', Marker: 'dir/b.txt' }));
  assert.deepEqual(v1.Contents.map((c) => c.Key), ['dir/e f+g.txt', 'dir/sub/c.txt', 'dir/sub/d.txt']);
  const raw = await fetch(`${t.url}/${BUCKET}?list-type=2&prefix=dir%2Fe&encoding-type=url`, { headers: sign({ method: 'GET', path: `/${BUCKET}`, query: 'encoding-type=url&list-type=2&prefix=dir%2Fe', payloadHash: hex('') }) });
  assert.match(await raw.text(), /<Key>dir\/e%20f%2Bg.txt<\/Key>/);
});

test('Range, conditional requests and response-* overrides', async () => {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Body: '0123456789' }));
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Range: 'bytes=2-5' }));
  assert.equal(await text(r), '2345');
  assert.equal(r.ContentRange, 'bytes 2-5/10');
  const tail = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Range: 'bytes=-3' }));
  assert.equal(await text(tail), '789');
  const bad = await fail(s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', Range: 'bytes=50-60' })));
  assert.equal(bad.name, 'InvalidRange');
  const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'range.txt' }));
  const nm = await fail(s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', IfNoneMatch: h.ETag })));
  assert.equal(nm.$metadata.httpStatusCode, 304);
  const pf = await fail(s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', IfMatch: '"nope"' })));
  assert.equal(pf.name, 'PreconditionFailed');
  const o = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'range.txt', ResponseContentType: 'application/x-test', ResponseContentDisposition: 'attachment; filename="r.txt"' }));
  assert.equal(o.ContentType, 'application/x-test');
  assert.equal(o.ContentDisposition, 'attachment; filename="r.txt"');
});

test('CopyObject, DeleteObject and DeleteObjects', async () => {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'copy/src.txt', Body: 'copy me', Metadata: { a: '1' } }));
  const c = await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'copy/dst.txt', CopySource: `${BUCKET}/copy/src.txt` }));
  assert.equal(c.CopyObjectResult.ETag, `"${crypto.createHash('md5').update('copy me').digest('hex')}"`);
  const g = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'copy/dst.txt' }));
  assert.equal(await text(g), 'copy me');
  assert.deepEqual(g.Metadata, { a: '1' });
  const r = await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'copy/dst.txt', CopySource: `${BUCKET}/copy/src.txt`, MetadataDirective: 'REPLACE', Metadata: { b: '2' } }));
  assert.ok(r.CopyObjectResult.ETag);
  assert.deepEqual((await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'copy/dst.txt' }))).Metadata, { b: '2' });
  const self = await fail(s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'copy/src.txt', CopySource: `${BUCKET}/copy/src.txt` })));
  assert.equal(self.name, 'InvalidRequest');
  const missing = await fail(s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'x', CopySource: `${BUCKET}/nope.txt` })));
  assert.equal(missing.name, 'NoSuchKey');

  assert.equal((await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'copy/src.txt' }))).$metadata.httpStatusCode, 204);
  assert.equal((await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'never-existed' }))).$metadata.httpStatusCode, 204);
  const nk = await fail(s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'copy/src.txt' })));
  assert.equal(nk.name, 'NoSuchKey');
  const d = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'copy/dst.txt' }, { Key: 'not-there' }] } }));
  assert.deepEqual(d.Deleted.map((x) => x.Key).sort(), ['copy/dst.txt', 'not-there']);
  const quiet = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'dir/a.txt' }], Quiet: true } }));
  assert.equal(quiet.Deleted, undefined);
});

test('multipart upload: create, parts, list, complete; abort; part rules', async () => {
  const p1 = crypto.randomBytes(5 * 1024 * 1024);
  const p2 = Buffer.from('the last part can be small');
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', ContentType: 'application/x-big', Metadata: { m: 'x' } }));
  const e1 = await s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId, PartNumber: 1, Body: p1 }));
  const e2 = await s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId, PartNumber: 2, Body: p2 }));
  const parts = await s3.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId }));
  assert.deepEqual(parts.Parts.map((p) => [p.PartNumber, p.Size]), [[1, p1.length], [2, p2.length]]);
  const order = await fail(s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 2, ETag: e2.ETag }, { PartNumber: 1, ETag: e1.ETag }] } })));
  assert.equal(order.name, 'InvalidPartOrder');
  const wrong = await fail(s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"0000"' }] } })));
  assert.equal(wrong.name, 'InvalidPart');
  const done = await s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: e1.ETag }, { PartNumber: 2, ETag: e2.ETag }] } }));
  assert.match(done.ETag, /^"[0-9a-f]{32}-2"$/);
  const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'mpu/big.bin' }));
  assert.equal(h.ContentLength, p1.length + p2.length);
  assert.equal(h.ContentType, 'application/x-big');
  assert.deepEqual(h.Metadata, { m: 'x' });
  const tail = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', Range: `bytes=${p1.length}-` }));
  assert.equal(await text(tail), 'the last part can be small');
  const gone = await fail(s3.send(new ListPartsCommand({ Bucket: BUCKET, Key: 'mpu/big.bin', UploadId })));
  assert.equal(gone.name, 'NoSuchUpload');

  const small = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/small.bin' }));
  const s1 = await s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'mpu/small.bin', UploadId: small.UploadId, PartNumber: 1, Body: 'tiny' }));
  const s2 = await s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'mpu/small.bin', UploadId: small.UploadId, PartNumber: 2, Body: 'tiny' }));
  const tooSmall = await fail(s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/small.bin', UploadId: small.UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: s1.ETag }, { PartNumber: 2, ETag: s2.ETag }] } })));
  assert.equal(tooSmall.name, 'EntityTooSmall');
  await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: 'mpu/small.bin', UploadId: small.UploadId }));
  const aborted = await fail(s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: 'mpu/small.bin', UploadId: small.UploadId, PartNumber: 3, Body: 'x' })));
  assert.equal(aborted.name, 'NoSuchUpload');
});

test('presigned URLs (SDK presigner and the built-in helper); expired URLs are refused', async () => {
  const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned/up.txt' }), { expiresIn: 60 });
  assert.equal((await fetch(putUrl, { method: 'PUT', body: 'presigned body' })).status, 200);
  const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned/up.txt' }), { expiresIn: 60 });
  const r = await fetch(getUrl);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'presigned body');
  const mine = presignUrl({ url: `${t.url}/${BUCKET}/presigned/up.txt`, ...CREDS, region: 'us-east-1', expiresIn: 60 });
  assert.equal(await (await fetch(mine)).text(), 'presigned body');
  const old = presignUrl({ url: `${t.url}/${BUCKET}/presigned/up.txt`, ...CREDS, region: 'us-east-1', expiresIn: 60, now: new Date(Date.now() - 3600 * 1000) });
  const e = await fetch(old);
  assert.equal(e.status, 403);
  assert.match(await e.text(), /<Code>AccessDenied<\/Code><Message>Request has expired<\/Message>/);
});

test('authentication errors come back as S3 XML errors', async () => {
  const wrongSecret = await fail(client({ credentials: { ...CREDS, secretAccessKey: 'wrong' } }).send(new ListBucketsCommand({})));
  assert.equal(wrongSecret.name, 'SignatureDoesNotMatch');
  assert.equal(wrongSecret.$metadata.httpStatusCode, 403);
  const wrongKey = await fail(client({ credentials: { ...CREDS, accessKeyId: 'someone-else' } }).send(new ListBucketsCommand({})));
  assert.equal(wrongKey.name, 'InvalidAccessKeyId');
  const wrongRegion = await fail(client({ region: 'eu-west-1' }).send(new ListBucketsCommand({})));
  assert.equal(wrongRegion.name, 'AuthorizationHeaderMalformed');
  assert.match(wrongRegion.message, /expecting 'us-east-1'/);
  const anon = await fetch(`${t.url}/${BUCKET}/employees.csv`);
  assert.equal(anon.status, 403);
  assert.equal(anon.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(await anon.text(), /<Code>AccessDenied<\/Code>/);
  const v2 = await fetch(`${t.url}/${BUCKET}`, { headers: { Authorization: 'AWS demo-access-key:abc' } });
  assert.equal(v2.status, 400);
  const skew = await fetch(`${t.url}/${BUCKET}`, { headers: sign({ method: 'GET', path: `/${BUCKET}`, payloadHash: hex(''), date: new Date(Date.now() - 3600 * 1000) }) });
  assert.match(await skew.text(), /RequestTimeTooSkewed/);
  // An unsigned GET / is still the dashboard.
  assert.equal((await fetch(`${t.url}/`, { redirect: 'manual' })).status, 302);
});

test('payload hashes: a wrong x-amz-content-sha256 is rejected; a request without one is hashed by the server', async () => {
  const body = 'hello hash';
  const bad = await fetch(`${t.url}/${BUCKET}/hash/bad.txt`, { method: 'PUT', body, headers: sign({ method: 'PUT', path: `/${BUCKET}/hash/bad.txt`, payloadHash: hex('something else') }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /XAmzContentSHA256Mismatch/);
  const nf = await fail(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'hash/bad.txt' })));
  assert.equal(nf.$metadata.httpStatusCode, 404);
  // Clients such as curl --aws-sigv4 may leave the header out: the signature covers the body hash anyway.
  const signedNoHeader = (() => {
    const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const host = new URL(t.url).host;
    const canonical = ['PUT', `/${BUCKET}/hash/ok.txt`, '', `host:${host}\nx-amz-date:${amz}\n`, 'host;x-amz-date', hex(body)].join('\n');
    const scope = `${amz.slice(0, 8)}/us-east-1/s3/aws4_request`;
    const key = hmac(hmac(hmac(hmac(`AWS4${CREDS.secretAccessKey}`, amz.slice(0, 8)), 'us-east-1'), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n')).digest('hex');
    return { 'x-amz-date': amz, authorization: `AWS4-HMAC-SHA256 Credential=${CREDS.accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${sig}` };
  })();
  const ok = await fetch(`${t.url}/${BUCKET}/hash/ok.txt`, { method: 'PUT', body, headers: signedNoHeader });
  assert.equal(ok.status, 200);
  assert.equal(await text(await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'hash/ok.txt' }))), body);
});

test('signed aws-chunked bodies: the AWS documentation example verifies chunk by chunk', async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html (example values)
  const headers = {
    host: 's3.amazonaws.com', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=content-encoding;content-length;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-storage-class,Signature=4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9',
    'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', 'content-encoding': 'aws-chunked', 'x-amz-decoded-content-length': '66560', 'content-length': '66824',
  };
  const req = { method: 'PUT', headers, rawHeaders: Object.entries(headers).flat(), get: (n) => headers[n.toLowerCase()] };
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  const auth = await verifyRequest(req, { rawPath: '/examplebucket/chunkObject.txt', rawQuery: '', creds, now: Date.UTC(2013, 4, 24) });
  const chunks = (finalSig) => Buffer.concat([
    Buffer.from('10000;chunk-signature=ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648\r\n'), Buffer.alloc(65536, 'a'), Buffer.from('\r\n'),
    Buffer.from('400;chunk-signature=0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497\r\n'), Buffer.alloc(1024, 'a'), Buffer.from('\r\n'),
    Buffer.from(`0;chunk-signature=${finalSig}\r\n\r\n`)]);
  const decode = (buf) => new Promise((resolve, reject) => {
    const s = new S3BodyStream(auth, headers);
    let n = 0;
    s.on('data', (c) => { n += c.length; }).on('end', () => resolve(n)).on('error', reject);
    Readable.from([buf.subarray(0, 777), buf.subarray(777)]).pipe(s);
  });
  const good = chunks('b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9');
  assert.equal(good.length, 66824);
  assert.equal(await decode(good), 66560);
  await assert.rejects(decode(chunks('0'.repeat(64))), /chunk signature/);
});

test('shared stack: chaos and required headers answer in S3 XML; the inspector tags S3 calls', async () => {
  const forced = await fetch(`${t.url}/${BUCKET}`, { headers: { ...sign({ method: 'GET', path: `/${BUCKET}`, payloadHash: hex('') }), 'X-Force-Error': '503' } });
  assert.equal(forced.status, 503);
  assert.match(await forced.text(), /<Code>ServiceUnavailable<\/Code>/);
  await t.ctx.settings.set('requiredHeaders', [{ name: 'X-Tenant' }]);
  try {
    const e = await fail(s3.send(new ListBucketsCommand({})));
    assert.equal(e.$metadata.httpStatusCode, 400);
    assert.equal(e.name, 'InvalidRequest');
  } finally {
    await t.ctx.settings.set('requiredHeaders', []);
  }
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  await new Promise((r) => setTimeout(r, 50));
  const recent = await t.ctx.inspector.list(20);
  assert.ok(recent.some((e) => e.kind === 's3'), 'an inspector entry tagged s3');
});

test('the API can be renamed, re-keyed and switched off from the settings', async () => {
  await t.ctx.settings.set('s3ApiBucket', 'pool');
  await t.ctx.settings.set('s3ApiRegion', 'eu-central-1');
  await t.ctx.settings.set('s3ApiAccessKeyId', 'AKIATESTTESTTEST');
  try {
    const c = client({ region: 'eu-central-1', credentials: { accessKeyId: 'AKIATESTTESTTEST', secretAccessKey: CREDS.secretAccessKey } });
    assert.deepEqual((await c.send(new ListBucketsCommand({}))).Buckets.map((b) => b.Name), ['pool']);
    assert.equal((await c.send(new GetBucketLocationCommand({ Bucket: 'pool' }))).LocationConstraint, 'eu-central-1');
    assert.ok((await c.send(new ListObjectsV2Command({ Bucket: 'pool' }))).KeyCount > 0);
    await assert.rejects(t.ctx.settings.set('s3ApiBucket', 'v1'), /invalid format/);
    await assert.rejects(t.ctx.settings.set('s3ApiBucket', 'Bad_Name'), /invalid format/);
  } finally {
    await t.ctx.settings.set('s3ApiBucket', BUCKET);
    await t.ctx.settings.set('s3ApiRegion', 'us-east-1');
    await t.ctx.settings.set('s3ApiAccessKeyId', CREDS.accessKeyId);
  }
  await t.ctx.settings.set('s3ApiEnabled', false);
  try {
    const r = await fetch(`${t.url}/${BUCKET}/employees.csv`);
    assert.equal(r.status, 200); // the inspector's catch-all answers instead
    assert.ok(r.headers.get('x-inspector-id'));
  } finally {
    await t.ctx.settings.set('s3ApiEnabled', true);
  }
});
