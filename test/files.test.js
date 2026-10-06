'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { listen } = require('./helpers');
const { SAMPLE_IDS } = require('../src/services/sampleIds');

let t;
before(async () => { t = await listen({ MAX_FILE_SIZE_MB: '12' }); });
after(async () => { await t.stop(); });

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const binParser = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

test('samples are generated with stable ids', async () => {
  const r = await request(t.app).get('/v1/files?limit=50').expect(200);
  const ids = r.body.data.map((f) => f.id);
  for (const id of Object.values(SAMPLE_IDS)) assert.ok(ids.includes(id), `missing ${id}`);
  const big = r.body.data.find((f) => f.id === SAMPLE_IDS.large);
  assert.equal(big.size, 10 * 1024 * 1024);
});

test('multipart upload (multiple files + fields) then download', async () => {
  const a = Buffer.from('hello multipart');
  const r = await request(t.app).post('/v1/files/multipart').field('description', 'two files').field('tag', 'x')
    .attach('file', a, { filename: 'a.txt', contentType: 'text/plain' }).attach('file', Buffer.from([1, 2, 3, 255]), 'b.bin').expect(201);
  assert.equal(r.body.files.length, 2);
  assert.equal(r.body.fields.description, 'two files');
  assert.equal(r.body.files[0].sha256, sha(a));
  const d = await request(t.app).get(`/v1/files/${r.body.files[0].id}/download`).buffer(true).parse(binParser).expect(200);
  assert.equal(d.body.toString(), 'hello multipart');
  assert.match(d.get('Content-Disposition'), /attachment; filename="a.txt"/);
  const inline = await request(t.app).get(`/v1/files/${r.body.files[0].id}/download?inline=true`);
  assert.match(inline.get('Content-Disposition'), /^inline/);
});

test('raw PUT and POST with Content-Disposition', async () => {
  const p = await request(t.app).put('/v1/files/raw/notes.txt').set('Content-Type', 'text/plain').send('raw body').expect(201);
  assert.equal(p.body.name, 'notes.txt');
  assert.equal(p.body.contentType, 'text/plain');
  const q = await request(t.app).post('/v1/files/raw').set('Content-Type', 'application/octet-stream').set('Content-Disposition', 'attachment; filename="data.bin"').send(Buffer.from('xyz')).expect(201);
  assert.equal(q.body.name, 'data.bin');
  assert.equal(q.body.size, 3);
});

test('base64 in and out', async () => {
  const data = Buffer.from('base64 payload ✓');
  const r = await request(t.app).post('/v1/files/base64').send({ name: 'b.txt', contentType: 'text/plain', data: data.toString('base64') }).expect(201);
  const g = await request(t.app).get(`/v1/files/${r.body.id}/base64`).expect(200);
  assert.equal(Buffer.from(g.body.data, 'base64').toString(), 'base64 payload ✓');
  await request(t.app).post('/v1/files/base64').send({ name: 'x', data: '***' }).expect(422);
  const du = await request(t.app).post('/v1/files/base64').send({ name: 'd.txt', data: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}` }).expect(201);
  assert.equal(du.body.contentType, 'text/plain');
});

test('tus resumable upload in two chunks', async () => {
  const payload = crypto.randomBytes(300000);
  const meta = `filename ${Buffer.from('tus.bin').toString('base64')},filetype ${Buffer.from('application/octet-stream').toString('base64')}`;
  const opts = await request(t.app).options('/v1/files/tus').expect(204);
  assert.match(opts.get('Tus-Extension'), /creation/);
  await request(t.app).post('/v1/files/tus').set('Upload-Length', String(payload.length)).expect(412);
  const c = await request(t.app).post('/v1/files/tus').set('Tus-Resumable', '1.0.0').set('Upload-Length', String(payload.length)).set('Upload-Metadata', meta).expect(201);
  const loc = new URL(c.get('Location')).pathname;
  const half = 120000;
  await request(t.app).patch(loc).set('Tus-Resumable', '1.0.0').set('Upload-Offset', '0').set('Content-Type', 'application/offset+octet-stream').send(payload.subarray(0, half)).expect(204);
  const head = await request(t.app).head(loc).set('Tus-Resumable', '1.0.0').expect(200);
  assert.equal(head.get('Upload-Offset'), String(half));
  await request(t.app).patch(loc).set('Tus-Resumable', '1.0.0').set('Upload-Offset', '5').set('Content-Type', 'application/offset+octet-stream').send(Buffer.from('x')).expect(409);
  const done = await request(t.app).patch(loc).set('Tus-Resumable', '1.0.0').set('Upload-Offset', String(half)).set('Content-Type', 'application/offset+octet-stream').send(payload.subarray(half)).expect(204);
  const fileId = done.get('X-File-Id');
  assert.ok(fileId);
  const meta2 = await request(t.app).get(`/v1/files/${fileId}`).expect(200);
  assert.equal(meta2.body.sha256, sha(payload));
  assert.equal(meta2.body.name, 'tus.bin');
});

test('range requests on the shared pool (tus upload downloaded by range)', async () => {
  const big = SAMPLE_IDS.large;
  const r = await request(t.app).get(`/v1/files/${big}/download`).set('Range', 'bytes=100-199').buffer(true).parse(binParser).expect(206);
  assert.equal(r.body.length, 100);
  assert.equal(r.get('Content-Range'), `bytes 100-199/${10 * 1024 * 1024}`);
  assert.equal(r.get('Accept-Ranges'), 'bytes');
  const suffix = await request(t.app).get(`/v1/files/${big}/download`).set('Range', 'bytes=-10').buffer(true).parse(binParser).expect(206);
  assert.equal(suffix.body.length, 10);
  await request(t.app).get(`/v1/files/${big}/download`).set('Range', 'bytes=999999999-').expect(416);
  const etag = r.get('ETag');
  await request(t.app).get(`/v1/files/${big}/download`).set('If-None-Match', etag).expect(304);
});

test('chunked download has no Content-Length', async () => {
  const r = await request(t.app).get(`/v1/files/${SAMPLE_IDS.employeesCsv}/chunked`).buffer(true).parse(binParser).expect(200);
  assert.equal(r.get('Content-Length'), undefined);
  assert.equal(r.get('Transfer-Encoding'), 'chunked');
  assert.match(r.body.toString('utf8', 0, 20), /^id,employeeNumber/);
});

test('presigned PUT then GET (local HMAC-signed URLs)', async () => {
  const p = await request(t.app).post('/v1/files/presign').send({ method: 'PUT', name: 'presigned.txt', contentType: 'text/plain', expiresIn: 60 }).expect(201);
  if (t.ctx.files.store.name === 'local') assert.match(p.body.url, /\/v1\/files\/presigned\//);
  else assert.match(p.body.url, /X-Amz-Signature=/);
  const put = await fetch(p.body.url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'via presigned url' });
  assert.equal(put.status, 200);
  const g = await request(t.app).post('/v1/files/presign').send({ method: 'GET', fileId: p.body.fileId }).expect(201);
  const dl = await fetch(g.body.url);
  assert.equal(await dl.text(), 'via presigned url');
  const tampered = `${g.body.url.slice(0, -3)}abc`;
  assert.equal((await fetch(tampered)).status, 403);
});

test('max size is enforced with 413', async () => {
  const tooBig = Buffer.alloc(13 * 1024 * 1024, 1);
  const r = await request(t.app).put('/v1/files/raw/huge.bin').set('Content-Type', 'application/octet-stream').send(tooBig);
  assert.equal(r.status, 413);
  await request(t.app).post('/v1/files/tus').set('Tus-Resumable', '1.0.0').set('Upload-Length', String(13 * 1024 * 1024)).expect(413);
});

test('delete', async () => {
  const p = await request(t.app).put('/v1/files/raw/del.txt').send('bye').expect(201);
  await request(t.app).delete(`/v1/files/${p.body.id}`).expect(204);
  await request(t.app).get(`/v1/files/${p.body.id}`).expect(404);
});
