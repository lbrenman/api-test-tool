'use strict';
// S3 error renderer (error format "s3"):
//   <?xml version="1.0" encoding="UTF-8"?>
//   <Error><Code>NoSuchKey</Code><Message>…</Message><Key>…</Key><RequestId>…</RequestId></Error>
// with the HTTP status as given. S3 error codes are passed as the problem code (S3Error below); errors
// raised by the shared stack (required headers, rate limit, chaos) get the S3 code for their status.
// HEAD responses carry no body (Express drops it), exactly like S3.
const { registerErrorRenderer, HttpError } = require('../../util/problem');
const { escapeXml } = require('../../util/xml');

const BY_STATUS = {
  400: 'InvalidRequest', 401: 'AccessDenied', 403: 'AccessDenied', 404: 'NotFound', 405: 'MethodNotAllowed',
  408: 'RequestTimeout', 409: 'OperationAborted', 411: 'MissingContentLength', 412: 'PreconditionFailed',
  413: 'EntityTooLarge', 416: 'InvalidRange', 429: 'SlowDown', 500: 'InternalError', 501: 'NotImplemented',
  503: 'ServiceUnavailable',
};

// Codes used elsewhere in the app that have an exact S3 equivalent.
const MAPPED = { 'file-too-large': 'EntityTooLarge', 'rate-limited': 'SlowDown' };

const isS3Code = (c) => typeof c === 'string' && /^[A-Z][A-Za-z0-9]+$/.test(c);

/** An S3 error: new S3Error(404, 'NoSuchKey', 'The specified key does not exist.', { Key: 'a.csv' }) */
class S3Error extends HttpError {
  constructor(status, s3Code, message, fields = {}, headers) {
    super(status, message, { code: s3Code, headers });
    this.fields = fields;
  }
}

function renderS3Error(p, req) {
  const code = isS3Code(p.code) ? p.code : (MAPPED[p.code] || BY_STATUS[p.status] || 'InternalError');
  const fields = { ...(req.s3ErrorFields || {}) };
  if (p.errors?.length && !fields.Detail) fields.Detail = p.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
  const extra = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
  const resource = req.s3?.bucket ? `/${req.s3.bucket}${req.s3.key ? `/${req.s3.key}` : ''}` : (req.originalUrl || '/').split('?')[0];
  return {
    status: p.status,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escapeXml(p.detail)}</Message>${extra}<Resource>${escapeXml(resource)}</Resource><RequestId>${escapeXml(p.requestId || '')}</RequestId></Error>`,
    headers: { 'x-amz-request-id': p.requestId || '' },
  };
}

registerErrorRenderer('s3', renderS3Error);

module.exports = { S3Error, renderS3Error };
