'use strict';
// S3-compatible file store (AWS S3, Cloudflare R2, Tigris, MinIO, ...).
// Uploads are spooled to a local temp file first so size/sha256/limits are known before PutObject.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { meter } = require('./meter');

class S3FileStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 's3';
    this.bucket = cfg.bucket;
    this.prefix = 'files/';
  }

  async init() {
    if (!this.bucket) throw new Error('FILE_STORE=s3 requires S3_BUCKET');
    const { S3Client } = require('@aws-sdk/client-s3');
    this.s3 = require('@aws-sdk/client-s3');
    this.presigner = require('@aws-sdk/s3-request-presigner');
    this.client = new S3Client({
      region: this.cfg.region || 'us-east-1',
      endpoint: this.cfg.endpoint || undefined,
      forcePathStyle: !!this.cfg.forcePathStyle,
      credentials: this.cfg.accessKeyId ? { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } : undefined,
    });
    this.tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'api-test-tool-s3-'));
  }

  key(id) { return this.prefix + id; }

  async writeStream(id, readable, { maxBytes, contentType } = {}) {
    const tmp = path.join(this.tmpDir, crypto.randomUUID());
    const m = meter(maxBytes);
    try {
      await pipeline(readable, m.stream, fs.createWriteStream(tmp));
      const r = m.result();
      await this.client.send(new this.s3.PutObjectCommand({
        Bucket: this.bucket, Key: this.key(id), Body: fs.createReadStream(tmp), ContentLength: r.size,
        ContentType: contentType || 'application/octet-stream',
      }));
      return r;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async writeBuffer(id, buf, { contentType } = {}) {
    await this.client.send(new this.s3.PutObjectCommand({
      Bucket: this.bucket, Key: this.key(id), Body: buf, ContentLength: buf.length, ContentType: contentType || 'application/octet-stream',
    }));
    return { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }

  async read(id, { start, end } = {}) {
    const r = await this.client.send(new this.s3.GetObjectCommand({
      Bucket: this.bucket, Key: this.key(id), Range: start !== undefined ? `bytes=${start}-${end}` : undefined,
    }));
    return r.Body;
  }

  async readBuffer(id) {
    const stream = await this.read(id);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async stat(id) {
    try {
      const r = await this.client.send(new this.s3.HeadObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
      return { size: Number(r.ContentLength), mtime: r.LastModified, contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  async delete(id) {
    await this.client.send(new this.s3.DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
  }

  async presign(id, { method, contentType, expiresIn, filename }) {
    const cmd = method === 'PUT'
      ? new this.s3.PutObjectCommand({ Bucket: this.bucket, Key: this.key(id), ContentType: contentType })
      : new this.s3.GetObjectCommand({
        Bucket: this.bucket, Key: this.key(id),
        ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/"/g, '')}"` : undefined,
      });
    return this.presigner.getSignedUrl(this.client, cmd, { expiresIn });
  }

  async ping() {
    await this.client.send(new this.s3.HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }
}

module.exports = { S3FileStore };
