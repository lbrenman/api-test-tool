'use strict';
// Pass-through stream that hashes (sha256), counts bytes, and enforces a size limit.
// Once the limit is exceeded the rest of the body is drained and discarded, and the stream
// fails at the end with 413 — so clients receive a clean 413 response instead of a reset socket.
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { HttpError } = require('../../util/problem');

function meter(maxBytes) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  let over = false;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes !== undefined && maxBytes !== null && size > maxBytes) {
        over = true;
        cb();
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      if (over) {
        cb(new HttpError(413, `Upload exceeds the maximum size of ${maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${maxBytes} bytes`}`, { code: 'file-too-large' }));
        return;
      }
      cb();
    },
  });
  return { stream, result: () => ({ size, sha256: hash.digest('hex') }) };
}

module.exports = { meter };
