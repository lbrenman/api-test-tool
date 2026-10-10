'use strict';
// Live OpenAPI 3.1 document for the MOCK DATA API that integrations call (/v1/* and /oauth/token), reflecting the
// current settings (base URL, date format, auth, headers, chaos, pagination, files). Served at /openapi.json|yaml.
// The admin / control-plane API (/admin/api/*, /health, /ready) has its own document: openapiAdminGen.js.
const { outputSchemas } = require('./schemas');
const { SCHEMES } = require('./paginate');
const { TYPE_NAMES } = require('../middleware/chaos');
const pkg = require('../../package.json');

const RES = {
  employees: { schema: 'Employee', input: 'EmployeeInput', tag: 'Employees', one: 'employee' },
  products: { schema: 'Product', input: 'ProductInput', tag: 'Products', one: 'product' },
  departments: { schema: 'Department', input: 'DepartmentInput', tag: 'Departments', one: 'department' },
  categories: { schema: 'Category', input: 'CategoryInput', tag: 'Categories', one: 'category' },
};

const ref = (kind, name) => ({ $ref: `#/components/${kind}/${name}` });
const P = (name) => ref('parameters', name);
const R = (name) => ref('responses', name);
const S = (name) => ref('schemas', name);
const H = (name) => ref('headers', name);

function problemResponse(desc, example, extraHeaders) {
  return {
    description: desc,
    headers: { 'X-Request-Id': H('XRequestId'), ...(extraHeaders || {}) },
    content: { 'application/problem+json': { schema: S('Problem'), example } },
  };
}

function security(mode, apiKeyName, apiKeyIn, base) {
  switch (mode) {
    case 'apikey': return { ApiKeyAuth: { type: 'apiKey', in: apiKeyIn, name: apiKeyName } };
    case 'basic': return { BasicAuth: { type: 'http', scheme: 'basic' } };
    case 'bearer': return { BearerAuth: { type: 'http', scheme: 'bearer', description: 'Static bearer token (BEARER_TOKEN)' } };
    case 'jwt': return { JwtAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: `JWT validated for iss/aud/exp. Tokens from ${base}/oauth/token are accepted.` } };
    case 'oauth2': return {
      OAuth2: {
        type: 'oauth2',
        description: 'Built-in authorization server. GET requires scope "read"; mutations require "write".',
        flows: {
          clientCredentials: { tokenUrl: `${base}/oauth/token`, scopes: { read: 'Read access', write: 'Write access' } },
          authorizationCode: {
            authorizationUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`, refreshUrl: `${base}/oauth/token`,
            scopes: { read: 'Read access', write: 'Write access' },
          },
        },
      },
    };
    case 'hmac': return {
      HmacAuth: {
        type: 'apiKey', in: 'header', name: 'Authorization',
        description: 'Authorization: HMAC <keyId>:<base64(HMAC-SHA256(secret, METHOD\\nPATH+QUERY\\nX-Timestamp\\nhex(SHA-256(body))))>. Send X-Timestamp (epoch seconds or HTTP-date). Streamed /v1/files uploads use the literal UNSIGNED-PAYLOAD instead of the body hash.',
      },
    };
    default: return {};
  }
}

function opSecurity(mode, method) {
  const names = { apikey: 'ApiKeyAuth', basic: 'BasicAuth', bearer: 'BearerAuth', jwt: 'JwtAuth', oauth2: 'OAuth2', hmac: 'HmacAuth' };
  if (!names[mode]) return undefined;
  if (mode === 'oauth2') return [{ OAuth2: [method === 'get' ? 'read' : 'write'] }];
  return [{ [names[mode]]: [] }];
}

function pageSchema(scheme, itemSchema, name) {
  const items = { type: 'array', items: itemSchema };
  switch (scheme) {
    case 'offset': return { type: 'object', required: ['data', 'meta'], properties: { data: items, meta: { type: 'object', required: ['offset', 'limit', 'total'], properties: { offset: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } } } } };
    case 'page': return { type: 'object', required: ['data', 'meta'], properties: { data: items, meta: { type: 'object', required: ['page', 'size', 'totalPages', 'totalItems'], properties: { page: { type: 'integer' }, size: { type: 'integer' }, totalPages: { type: 'integer' }, totalItems: { type: 'integer' } } } } };
    case 'cursor': return { type: 'object', required: ['data', 'nextCursor', 'prevCursor'], properties: { data: items, nextCursor: { type: ['string', 'null'] }, prevCursor: { type: ['string', 'null'] } } };
    case 'keyset': return { type: 'object', required: ['data', 'hasMore', 'lastId'], properties: { data: items, hasMore: { type: 'boolean' }, firstId: { type: ['integer', 'null'] }, lastId: { type: ['integer', 'null'] } } };
    case 'link': return items;
    case 'hal': {
      const link = { type: 'object', required: ['href'], properties: { href: { type: 'string', format: 'uri' } } };
      return {
        type: 'object', required: ['_embedded', '_links', 'page'],
        properties: {
          _embedded: { type: 'object', required: [name], properties: { [name]: items } },
          _links: { type: 'object', required: ['self', 'first', 'last'], properties: { self: link, first: link, prev: link, next: link, last: link } },
          page: { type: 'object', properties: { size: { type: 'integer' }, totalElements: { type: 'integer' }, totalPages: { type: 'integer' }, number: { type: 'integer' } } },
        },
      };
    }
    case 'token': return { type: 'object', required: ['items', 'nextPageToken'], properties: { items, nextPageToken: { type: ['string', 'null'] } } };
    default: return items;
  }
}

function pageParams(scheme) {
  const int = (name, desc, min = 0, extra = {}) => ({ name, in: 'query', required: false, description: desc, schema: { type: 'integer', minimum: min, ...extra } });
  const lim = (name) => int(name, 'Page size (1-200, default 25)', 1, { maximum: 200, default: 25 });
  switch (scheme) {
    case 'offset': return [int('offset', 'Zero-based offset', 0, { default: 0 }), lim('limit')];
    case 'page': return [int('page', '1-based page number', 1, { default: 1 }), lim('size')];
    case 'cursor': return [{ name: 'cursor', in: 'query', description: 'Opaque cursor from nextCursor/prevCursor', schema: { type: 'string' } }, lim('limit')];
    case 'keyset': return [int('after_id', 'Return items with id greater than this'), int('before_id', 'Return items with id less than this'), lim('limit')];
    case 'link': return [int('page', '1-based page number', 1, { default: 1 }), lim('per_page')];
    case 'hal': return [int('page', '1-based page number', 1, { default: 1 }), lim('size')];
    case 'token': return [{ name: 'pageToken', in: 'query', description: 'Opaque token from nextPageToken', schema: { type: 'string' } }, lim('pageSize')];
    default: return [];
  }
}

async function generateOpenApi(ctx, req) {
  const { settings, dates, resources } = ctx;
  const base = ctx.baseUrl(req);
  const mode = settings.get('authMode');
  const schemas = outputSchemas(dates.schema);
  const examples = {};
  for (const [name, def] of Object.entries(RES)) {
    const first = (await resources.all(name))[0];
    if (first) examples[def.schema] = dates.formatDoc((await resources.render(name, [first]))[0]);
  }

  const requiredHeaderParams = settings.get('requiredHeaders').map((h, i) => ({
    name: h.name, in: 'header', required: true,
    description: h.value ? `Required header (must equal "${h.value}")` : 'Required header (REQUIRED_HEADERS)',
    schema: h.value ? { type: 'string', const: h.value } : { type: 'string' },
    'x-param-key': `Required${i}`,
  }));
  const reqParamRefs = requiredHeaderParams.map((p) => {
    const key = p['x-param-key'];
    delete p['x-param-key'];
    return { key, param: p };
  });
  const common = [P('XForceError'), P('XForceStatus'), P('XForceLatency'), P('XRequestIdHeader'), P('XCorrelationIdHeader'), ...reqParamRefs.map((r) => P(r.key))];
  const listQuery = [P('Fields'), P('Sort'), P('Q')];

  const errs = (kinds) => {
    const out = {};
    for (const k of kinds) {
      if (k === 401 && mode === 'none') continue;
      if (k === 403 && mode !== 'oauth2') continue;
      out[k] = R(`E${k}`);
    }
    return out;
  };

  const okHeaders = (extra = {}) => ({ 'X-Request-Id': H('XRequestId'), 'X-Correlation-Id': H('XCorrelationId'), ...(settings.get('rateLimitRpm') ? { 'RateLimit-Limit': H('RateLimitLimit'), 'RateLimit-Remaining': H('RateLimitRemaining'), 'RateLimit-Reset': H('RateLimitReset') } : {}), ...extra });
  const sec = (m) => opSecurity(mode, m);

  const paths = {};
  for (const [name, def] of Object.entries(RES)) {
    const item = S(def.schema);
    const ex = examples[def.schema];
    paths[`/v1/${name}`] = {
      get: {
        tags: [def.tag], operationId: `list${def.tag}`, summary: `List ${name} (offset pagination)`,
        description: 'Supports filtering (?field=value, ?field[gte]=x with eq/ne/gt/gte/lt/lte/in/nin/like/exists), ?q= text search, ?sort=-a,b and ?fields=a,b.c.',
        security: sec('get'),
        parameters: [...common, ...pageParams('offset'), ...listQuery],
        responses: { 200: { description: `A page of ${name}`, headers: okHeaders({ ETag: H('ETag') }), content: { 'application/json': { schema: pageSchema('offset', item, name) } } }, ...errs([400, 401, 403, 429, 500, 503]) },
      },
      post: {
        tags: [def.tag], operationId: `create${def.tag.replace(/s$/, '').replace(/ie$/, 'y')}`, summary: `Create a ${def.one}`,
        security: sec('post'),
        parameters: [...common, P('IdempotencyKey')],
        requestBody: { required: true, content: { 'application/json': { schema: S(def.input), ...(ex ? { example: stripReadOnly(ex) } : {}) } } },
        responses: {
          201: { description: 'Created', headers: okHeaders({ Location: H('Location'), ETag: H('ETag'), 'Idempotent-Replayed': H('IdempotentReplayed') }), content: { 'application/json': { schema: item, ...(ex ? { example: ex } : {}) } } },
          ...errs([400, 401, 403, 409, 415, 422, 429, 500, 503]),
        },
      },
    };
    const idParam = { name: 'id', in: 'path', required: true, description: `${def.one} id`, schema: { type: 'integer', minimum: 1 }, example: 1 };
    paths[`/v1/${name}/{id}`] = {
      parameters: [idParam],
      get: {
        tags: [def.tag], operationId: `get${def.tag.replace(/s$/, '').replace(/ie$/, 'y')}`, summary: `Get a ${def.one}`,
        security: sec('get'),
        parameters: [...common, P('Fields'), P('IfNoneMatch')],
        responses: {
          200: { description: 'OK', headers: okHeaders({ ETag: H('ETag'), 'Last-Modified': H('LastModified') }), content: { 'application/json': { schema: item, ...(ex ? { example: ex } : {}) } } },
          304: { description: 'Not Modified (If-None-Match matched)' },
          ...errs([401, 403, 404, 429, 500, 503]),
        },
      },
      put: {
        tags: [def.tag], operationId: `replace${def.tag.replace(/s$/, '').replace(/ie$/, 'y')}`, summary: `Replace a ${def.one}`,
        security: sec('put'),
        parameters: [...common, P('IfMatch')],
        requestBody: { required: true, content: { 'application/json': { schema: S(def.input) } } },
        responses: { 200: { description: 'Replaced', headers: okHeaders({ ETag: H('ETag') }), content: { 'application/json': { schema: item } } }, ...errs([400, 401, 403, 404, 412, 415, 422, 429, 500, 503]) },
      },
      patch: {
        tags: [def.tag], operationId: `update${def.tag.replace(/s$/, '').replace(/ie$/, 'y')}`, summary: `Update a ${def.one} (JSON Merge Patch, RFC 7396)`,
        security: sec('patch'),
        parameters: [...common, P('IfMatch')],
        requestBody: { required: true, content: { 'application/merge-patch+json': { schema: { type: 'object' } }, 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated', headers: okHeaders({ ETag: H('ETag') }), content: { 'application/json': { schema: item } } }, ...errs([400, 401, 403, 404, 412, 415, 422, 429, 500, 503]) },
      },
      delete: {
        tags: [def.tag], operationId: `delete${def.tag.replace(/s$/, '').replace(/ie$/, 'y')}`, summary: `Delete a ${def.one}`,
        security: sec('delete'),
        parameters: [...common, P('IfMatch')],
        responses: { 204: { description: 'Deleted', headers: okHeaders() }, ...errs([401, 403, 404, 409, 412, 429, 500, 503]) },
      },
    };
    for (const scheme of SCHEMES) {
      const isHal = scheme === 'hal';
      const isLink = scheme === 'link';
      paths[`/v1/p/${scheme}/${name}`] = {
        get: {
          tags: ['Pagination'], operationId: `list${def.tag}${scheme[0].toUpperCase()}${scheme.slice(1)}`,
          summary: `List ${name} with ${scheme} pagination`,
          security: sec('get'),
          parameters: [...common, ...pageParams(scheme), ...listQuery],
          responses: {
            200: {
              description: `A page of ${name}`,
              headers: okHeaders(isLink ? { Link: H('Link'), 'X-Total-Count': H('XTotalCount') } : {}),
              content: { [isHal ? 'application/hal+json' : 'application/json']: { schema: pageSchema(scheme, item, name) } },
            },
            ...errs([400, 401, 403, 429, 500, 503]),
          },
        },
      };
    }
  }
  const nest = (parent, child) => {
    const def = RES[child];
    paths[`/v1/${parent}/{id}/${child}`] = {
      get: {
        tags: [RES[parent].tag], operationId: `list${RES[parent].tag.replace(/s$/, '').replace(/ie$/, 'y')}${def.tag}`,
        summary: `List ${child} of a ${RES[parent].one}`,
        security: sec('get'),
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }, ...common, ...pageParams('offset'), ...listQuery],
        responses: { 200: { description: 'OK', headers: okHeaders(), content: { 'application/json': { schema: pageSchema('offset', S(def.schema), child) } } }, ...errs([400, 401, 403, 404, 429, 500, 503]) },
      },
    };
  };
  nest('departments', 'employees');
  nest('categories', 'products');

  // ---- files
  const fileResp = (desc, status = 201) => ({ [status]: { description: desc, headers: okHeaders(status === 201 ? { Location: H('Location') } : {}), content: { 'application/json': { schema: S('File') } } } });
  const binary = { type: 'string', format: 'binary', contentMediaType: 'application/octet-stream' };
  const fileId = { name: 'fileId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9._-]+$' }, example: 'sample-employees-csv' };
  paths['/v1/files'] = {
    get: {
      tags: ['Files'], operationId: 'listFiles', summary: 'List files in the shared pool', security: sec('get'),
      parameters: [...common, ...pageParams('offset'), ...listQuery],
      responses: { 200: { description: 'OK', headers: okHeaders(), content: { 'application/json': { schema: pageSchema('offset', S('File'), 'files') } } }, ...errs([400, 401, 403, 429, 500]) },
    },
  };
  paths['/v1/files/multipart'] = {
    post: {
      tags: ['Files'], operationId: 'uploadMultipart', summary: 'Upload one or more files (multipart/form-data)', security: sec('post'),
      parameters: [...common, P('IdempotencyKey')],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: binary, files: { type: 'array', items: binary }, description: { type: 'string' } }, additionalProperties: true } } } },
      responses: {
        201: { description: 'Uploaded', headers: okHeaders({ Location: H('Location') }), content: { 'application/json': { schema: { type: 'object', required: ['files', 'fields'], properties: { files: { type: 'array', items: S('File') }, fields: { type: 'object', additionalProperties: true } } } } } },
        ...errs([400, 401, 403, 413, 415, 429, 500]),
      },
    },
  };
  paths['/v1/files/raw/{name}'] = {
    put: {
      tags: ['Files'], operationId: 'uploadRawNamed', summary: 'Upload a raw body; file name from the path', security: sec('put'),
      parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' }, example: 'hello.txt' }, ...common],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: binary }, '*/*': { schema: binary } } },
      responses: { ...fileResp('Uploaded'), ...errs([400, 401, 403, 413, 429, 500]) },
    },
  };
  paths['/v1/files/raw'] = {
    post: {
      tags: ['Files'], operationId: 'uploadRaw', summary: 'Upload a raw body; name from Content-Disposition, X-Filename or ?name=', security: sec('post'),
      parameters: [...common, { name: 'Content-Disposition', in: 'header', schema: { type: 'string' }, example: 'attachment; filename="report.pdf"' }, { name: 'name', in: 'query', schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: binary }, '*/*': { schema: binary } } },
      responses: { ...fileResp('Uploaded'), ...errs([400, 401, 403, 413, 429, 500]) },
    },
  };
  paths['/v1/files/base64'] = {
    post: {
      tags: ['Files'], operationId: 'uploadBase64', summary: 'Upload a base64-encoded file in JSON', security: sec('post'),
      parameters: [...common, P('IdempotencyKey')],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['name', 'data'], properties: { name: { type: 'string' }, contentType: { type: 'string' }, data: { type: 'string', contentEncoding: 'base64', description: 'Base64 or data: URL' } } }, example: { name: 'hello.txt', contentType: 'text/plain', data: 'SGVsbG8sIHdvcmxkIQ==' } } },
      },
      responses: { ...fileResp('Uploaded'), ...errs([400, 401, 403, 413, 422, 429, 500]) },
    },
  };
  paths['/v1/files/presign'] = {
    post: {
      tags: ['Files'], operationId: 'presignFile', summary: 'Create a presigned PUT (upload) or GET (download) URL', security: sec('post'),
      description: 'With FILE_STORE=s3 this returns real S3 presigned URLs; with the local store, HMAC-signed expiring URLs of the same shape.',
      parameters: common,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { method: { type: 'string', enum: ['PUT', 'GET'] }, name: { type: 'string' }, contentType: { type: 'string' }, fileId: { type: 'string' }, expiresIn: { type: 'integer', minimum: 1, maximum: 604800 } } }, example: { method: 'PUT', name: 'upload.txt', contentType: 'text/plain', expiresIn: 900 } } } },
      responses: {
        201: { description: 'Presigned URL', headers: okHeaders(), content: { 'application/json': { schema: { type: 'object', required: ['method', 'url', 'fileId', 'expiresAt'], properties: { method: { type: 'string' }, url: { type: 'string', format: 'uri' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, fileId: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, store: { type: 'string' }, file: { type: 'string' } } } } } },
        ...errs([400, 401, 403, 404, 422, 429, 500]),
      },
    },
  };
  paths['/v1/files/tus'] = {
    options: { tags: ['Files'], operationId: 'tusOptions', summary: 'tus capability discovery', security: sec('get'), responses: { 204: { description: 'Tus-Version, Tus-Extension, Tus-Max-Size headers' } } },
    post: {
      tags: ['Files'], operationId: 'tusCreate', summary: 'tus: create an upload (creation, creation-with-upload)', security: sec('post'),
      parameters: [
        { name: 'Tus-Resumable', in: 'header', required: true, schema: { type: 'string', const: '1.0.0' } },
        { name: 'Upload-Length', in: 'header', required: true, schema: { type: 'integer', minimum: 0 } },
        { name: 'Upload-Metadata', in: 'header', schema: { type: 'string' }, description: 'filename <base64>,filetype <base64>' },
      ],
      responses: { 201: { description: 'Upload created', headers: { Location: H('Location'), 'Upload-Offset': H('UploadOffset') } }, ...errs([400, 401, 403, 413, 415, 429]) },
    },
  };
  paths['/v1/files/tus/{uploadId}'] = {
    parameters: [{ name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } }],
    head: { tags: ['Files'], operationId: 'tusHead', summary: 'tus: current offset', security: sec('get'), responses: { 200: { description: 'Upload-Offset / Upload-Length (X-File-Id once complete)' }, 404: R('E404') } },
    patch: {
      tags: ['Files'], operationId: 'tusPatch', summary: 'tus: append bytes', security: sec('patch'),
      parameters: [{ name: 'Tus-Resumable', in: 'header', required: true, schema: { type: 'string', const: '1.0.0' } }, { name: 'Upload-Offset', in: 'header', required: true, schema: { type: 'integer' } }],
      requestBody: { required: true, content: { 'application/offset+octet-stream': { schema: binary } } },
      responses: { 204: { description: 'Appended; Upload-Offset header (X-File-Id once complete)' }, ...errs([400, 401, 403, 404, 409, 413, 415]) },
    },
    delete: { tags: ['Files'], operationId: 'tusDelete', summary: 'tus: terminate an upload', security: sec('delete'), responses: { 204: { description: 'Terminated' }, 404: R('E404') } },
  };
  paths['/v1/files/{fileId}'] = {
    parameters: [fileId],
    get: { tags: ['Files'], operationId: 'getFile', summary: 'File metadata', security: sec('get'), parameters: common, responses: { ...fileResp('OK', 200), ...errs([401, 403, 404, 429, 500]) } },
    delete: { tags: ['Files'], operationId: 'deleteFile', summary: 'Delete a file', security: sec('delete'), parameters: common, responses: { 204: { description: 'Deleted' }, ...errs([401, 403, 404, 429, 500]) } },
  };
  paths['/v1/files/{fileId}/download'] = {
    parameters: [fileId],
    get: {
      tags: ['Files'], operationId: 'downloadFile', summary: 'Stream a file (Range / 206, ETag, Last-Modified)', security: sec('get'),
      parameters: [...common, { name: 'Range', in: 'header', schema: { type: 'string' }, example: 'bytes=0-1023' }, { name: 'inline', in: 'query', schema: { type: 'boolean' } }, P('IfNoneMatch')],
      responses: {
        200: { description: 'Whole file', headers: { ETag: H('ETag'), 'Accept-Ranges': H('AcceptRanges'), 'Content-Disposition': H('ContentDisposition') }, content: { '*/*': { schema: binary } } },
        206: { description: 'Partial content', headers: { 'Content-Range': H('ContentRange') }, content: { '*/*': { schema: binary } } },
        304: { description: 'Not Modified' },
        ...errs([401, 403, 404, 416, 429, 500]),
      },
    },
  };
  paths['/v1/files/{fileId}/chunked'] = {
    parameters: [fileId],
    get: { tags: ['Files'], operationId: 'downloadChunked', summary: 'Download with Transfer-Encoding: chunked (no Content-Length)', security: sec('get'), parameters: common, responses: { 200: { description: 'Chunked body', content: { '*/*': { schema: binary } } }, ...errs([401, 403, 404, 429, 500]) } },
  };
  paths['/v1/files/{fileId}/base64'] = {
    parameters: [fileId],
    get: {
      tags: ['Files'], operationId: 'getFileBase64', summary: 'File content as base64 in JSON', security: sec('get'), parameters: common,
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { allOf: [S('File'), { type: 'object', required: ['data', 'encoding'], properties: { encoding: { const: 'base64' }, data: { type: 'string', contentEncoding: 'base64' } } }] } } } }, ...errs([401, 403, 404, 429, 500]) },
    },
  };

  // ---- OAuth (token endpoint used by oauth2 / jwt clients)
  // ---- Server-Sent Events (only while SSE is enabled)
  if (settings.get('sseEnabled')) {
    const sseText = { 'text/event-stream': { schema: { type: 'string', description: 'A stream of Server-Sent Events (id, event, data lines). data is JSON unless noted.' } } };
    const sseChaos = [
      { name: 'dropAfter', in: 'query', required: false, description: 'Cut the connection after this many events (test reconnect + Last-Event-ID)', schema: { type: 'integer', minimum: 1 } },
      { name: 'malformedAt', in: 'query', required: false, description: 'Send event N as a broken frame', schema: { type: 'integer', minimum: 1 } },
      { name: 'skipIds', in: 'query', required: false, description: 'Make event ids jump (test gap handling)', schema: { type: 'boolean' } },
    ];
    const lastId = [
      { name: 'Last-Event-ID', in: 'header', required: false, description: 'Resume after this id (EventSource sends it on reconnect)', schema: { type: 'string' } },
      { name: 'lastEventId', in: 'query', required: false, description: 'Same as the Last-Event-ID header', schema: { type: 'integer', minimum: 0 } },
    ];
    const tokenQ = ['bearer', 'jwt', 'oauth2'].includes(mode) ? [{ name: 'access_token', in: 'query', required: false, description: 'Token in the query string, for EventSource clients that cannot set headers', schema: { type: 'string' } }] : [];
    paths['/sse/changes'] = {
      get: {
        tags: ['Streaming'], operationId: 'streamChanges', summary: 'Live change feed (created / updated / deleted) for the mock data',
        description: 'Starts with `event: subscribed`, then one event per change made through any protocol (/v1, /soap, the back office). `event` is the change type, `id` increases; reconnecting with Last-Event-ID replays missed events from a buffer (`event: reset` when the id is too old). Comment heartbeats keep the stream open.',
        security: sec('get'),
        parameters: [{ name: 'resource', in: 'query', required: false, description: 'Comma list: employees, products, departments, categories', schema: { type: 'string' } }, ...lastId, ...sseChaos, ...tokenQ, ...common],
        responses: { 200: { description: 'Event stream', content: sseText }, ...errs([400, 401, 403, 429, 500]) },
      },
    };
    paths['/sse/ticks'] = {
      get: {
        tags: ['Streaming'], operationId: 'streamTicks', summary: 'Numbered synthetic events',
        description: 'Sends `{"n": 1, "time": "…"}`, `{"n": 2, …}` every `interval` ms; with `count` it ends with `event: end`. Resumes after Last-Event-ID.',
        security: sec('get'),
        parameters: [
          { name: 'interval', in: 'query', required: false, schema: { type: 'integer', minimum: 50, maximum: 60000, default: settings.get('sseTickIntervalMs') } },
          { name: 'count', in: 'query', required: false, description: '0 = until the client disconnects', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'event', in: 'query', required: false, schema: { type: 'string', default: 'tick' } },
          ...lastId, ...sseChaos, ...tokenQ, ...common,
        ],
        responses: { 200: { description: 'Event stream', content: sseText }, ...errs([400, 401, 403, 429, 500]) },
      },
    };
    paths['/sse/stream'] = {
      post: {
        tags: ['Streaming'], operationId: 'streamCompletion', summary: 'Request with a streamed answer (LLM-style token streaming)',
        description: 'Answers with one event per word. `format: "events"` sends `event: message` `{"index", "delta"}` and a final `event: done`; `format: "openai"` sends chat.completion.chunk objects and `data: [DONE]`.',
        security: sec('post'),
        parameters: [...sseChaos, ...common],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string' }, words: { type: 'integer', minimum: 1, maximum: 5000, default: 40 }, delayMs: { type: 'integer', minimum: 0, maximum: 5000, default: 40 }, format: { type: 'string', enum: ['events', 'openai'], default: 'events' } } }, example: { prompt: 'Who works in R&D?', words: 30, delayMs: 20 } } } },
        responses: { 200: { description: 'Event stream', content: sseText }, ...errs([400, 401, 403, 422, 429, 500]) },
      },
    };
  }

  paths['/oauth/token'] = {
    post: {
      tags: ['OAuth'], operationId: 'oauthToken', summary: 'Token endpoint (client_credentials, authorization_code + PKCE, refresh_token)', security: [],
      requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type'], properties: { grant_type: { type: 'string', enum: ['client_credentials', 'authorization_code', 'refresh_token'] }, client_id: { type: 'string' }, client_secret: { type: 'string' }, scope: { type: 'string' }, code: { type: 'string' }, redirect_uri: { type: 'string' }, code_verifier: { type: 'string' }, refresh_token: { type: 'string' } } } } } },
      responses: {
        200: { description: 'Token', content: { 'application/json': { schema: { type: 'object', required: ['access_token', 'token_type', 'expires_in'], properties: { access_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' }, scope: { type: 'string' }, refresh_token: { type: 'string' } } } } } },
        400: { description: 'OAuth error', content: { 'application/json': { schema: S('OAuthError') } } },
        401: { description: 'Invalid client', content: { 'application/json': { schema: S('OAuthError') } } },
      },
    },
  };

  const problemExample = (status, title, detail) => ({ type: `${base}/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title, status, detail, instance: '/v1/employees', requestId: '5f754b61-2038-4978-a7cb-6d6a97afd501', timestamp: '2026-01-15T14:30:00.000Z' });
  const retry = { 'Retry-After': H('RetryAfter') };

  const doc = {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: {
      title: 'API Test Tool — Mock Data API',
      version: pkg.version,
      summary: 'Realistic mock target for integration testing (pagination, errors, files, auth, headers).',
      description: [
        '**For integrations and API clients.** Import this into your integration platform, Postman or a code generator to call the mock',
        'data API: employees, products, departments, categories, the seven pagination schemes, the file pool, the Server-Sent Events streams and the OAuth token endpoint.',
        `SOAP is described by WSDLs (\`${base}/soap/EmployeeService?wsdl\`), WebSockets by AsyncAPI (\`${base}/ws/asyncapi.json\`) GraphQL by its SDL (\`${base}/graphql/schema.graphql\`) and OData by its CSDL (\`${base}/odata/v4/$metadata\`). The file pool is also an S3-compatible bucket at \`${base}\` (path-style, AWS Signature V4).`,
        '',
        'Tool administration (settings, seeding, the inspector, the contract tester) and the health probes are not part of this document.',
        `They are described by the admin spec at \`${base}/admin/api/openapi.json\` (requires the dashboard password).`,
        '',
        'Generated live from the current settings:',
        `- **Auth mode:** \`${mode}\``,
        `- **Timestamp format:** \`${settings.get('dateFormat')}\`${settings.get('dateFormat') === 'custom' ? ` (\`${settings.get('dateFormatPattern')}\`)` : ''}`,
        `- **Chaos:** error rate ${settings.get('errorRate')}%, types \`${settings.get('errorTypes')}\`, latency ${settings.get('latencyMinMs')}-${settings.get('latencyMaxMs')} ms`,
        `- **Rate limit:** ${settings.get('rateLimitRpm') || 'off'}${settings.get('rateLimitRpm') ? ' req/min' : ''}`,
        '',
        'Every /v1 operation accepts the optional chaos forcing headers `X-Force-Error`, `X-Force-Status` and `X-Force-Latency`. Errors are RFC 9457 `application/problem+json`.',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: base, description: 'This instance' }],
    tags: [
      { name: 'Employees' }, { name: 'Products' }, { name: 'Departments' }, { name: 'Categories' },
      { name: 'Pagination', description: 'Seven pagination schemes, each on its own path' },
      { name: 'Files', description: 'Shared file pool with multiple transfer protocols' },
      { name: 'Streaming', description: 'Server-Sent Events: change feed, ticks and request/stream' },
      { name: 'OAuth', description: 'Token endpoint for the oauth2 and jwt auth modes' },
    ],
    paths,
    components: {
      schemas: {
        ...schemas,
        Problem: {
          type: 'object', required: ['type', 'title', 'status', 'detail', 'instance', 'requestId', 'timestamp'],
          properties: {
            type: { type: 'string', format: 'uri-reference' }, title: { type: 'string' }, status: { type: 'integer', minimum: 100, maximum: 599 },
            detail: { type: 'string' }, instance: { type: 'string' }, requestId: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' },
            code: { type: 'string' },
            errors: { type: 'array', items: { type: 'object', required: ['field', 'message'], properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
        File: {
          type: 'object', required: ['id', 'name', 'contentType', 'size', 'source', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, contentType: { type: 'string' }, size: { type: ['integer', 'null'] },
            sha256: { type: ['string', 'null'] }, source: { type: 'string', enum: ['generated', 'uploaded'] },
            createdAt: dates.schema(), updatedAt: dates.schema(),
            links: { type: 'object', properties: { self: { type: 'string' }, download: { type: 'string' }, chunked: { type: 'string' }, base64: { type: 'string' } } },
            s3: {
              type: 'object', description: 'Present on files written through the S3-compatible API: the object key, its ETag (MD5, or MD5-of-parts for multipart), user metadata and stored headers.',
              properties: { key: { type: 'string' }, md5: { type: 'string' }, etag: { type: 'string' }, crc32: { type: 'string' }, parts: { type: 'integer' }, meta: { type: 'object', additionalProperties: { type: 'string' } }, headers: { type: 'object', additionalProperties: { type: 'string' } } },
            },
          },
        },
        OAuthError: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, error_description: { type: 'string' } } },
      },
      parameters: {
        XForceError: { name: 'X-Force-Error', in: 'header', required: false, description: `Force an error: a 4xx/5xx status or one of ${TYPE_NAMES.join(', ')}`, schema: { type: 'string' }, example: '503' },
        XForceStatus: { name: 'X-Force-Status', in: 'header', required: false, description: 'Override the response status (>= 400 returns a problem+json)', schema: { type: 'integer', minimum: 100, maximum: 599 } },
        XForceLatency: { name: 'X-Force-Latency', in: 'header', required: false, description: 'Add this many milliseconds of latency (max 120000)', schema: { type: 'integer', minimum: 0, maximum: 120000 } },
        XRequestIdHeader: { name: 'X-Request-Id', in: 'header', required: false, description: 'Echoed back; generated when absent', schema: { type: 'string', maxLength: 200 } },
        XCorrelationIdHeader: { name: 'X-Correlation-Id', in: 'header', required: false, description: 'Echoed back; defaults to the request id', schema: { type: 'string', maxLength: 200 } },
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, description: 'Replays return the original response; reuse with a different body returns 409', schema: { type: 'string', minLength: 1, maxLength: 255 } },
        IfMatch: { name: 'If-Match', in: 'header', required: false, description: 'ETag from a previous GET; 412 on mismatch', schema: { type: 'string' } },
        IfNoneMatch: { name: 'If-None-Match', in: 'header', required: false, description: 'Returns 304 when the ETag matches', schema: { type: 'string' } },
        Fields: { name: 'fields', in: 'query', required: false, description: 'Sparse fieldset, e.g. id,firstName,department.name', schema: { type: 'string' } },
        Sort: { name: 'sort', in: 'query', required: false, description: 'Comma list; prefix with - for descending, e.g. -createdAt,lastName', schema: { type: 'string' } },
        Q: { name: 'q', in: 'query', required: false, description: 'Case-insensitive text search across all fields', schema: { type: 'string' } },
        ...Object.fromEntries(reqParamRefs.map((r) => [r.key, r.param])),
      },
      headers: {
        XRequestId: { description: 'Request id', schema: { type: 'string' } },
        XCorrelationId: { description: 'Correlation id', schema: { type: 'string' } },
        Location: { description: 'URL of the created resource', schema: { type: 'string', format: 'uri' } },
        ETag: { description: 'Entity tag', schema: { type: 'string' } },
        LastModified: { description: 'Last modification time', schema: { type: 'string' } },
        IdempotentReplayed: { description: '"true" when the response is a replay', schema: { type: 'string' } },
        Link: { description: 'RFC 8288 pagination links (first, prev, next, last)', schema: { type: 'string' } },
        XTotalCount: { description: 'Total matching items', schema: { type: 'integer' } },
        RetryAfter: { description: 'Seconds to wait before retrying', schema: { type: 'integer', minimum: 1 } },
        RateLimitLimit: { description: 'Requests allowed per window', schema: { type: 'integer' } },
        RateLimitRemaining: { description: 'Requests remaining in the window', schema: { type: 'integer' } },
        RateLimitReset: { description: 'Seconds until the window resets', schema: { type: 'integer' } },
        AcceptRanges: { description: 'bytes', schema: { type: 'string' } },
        ContentRange: { description: 'Byte range returned', schema: { type: 'string' } },
        ContentDisposition: { description: 'attachment or inline with filename', schema: { type: 'string' } },
        UploadOffset: { description: 'tus upload offset', schema: { type: 'integer' } },
      },
      responses: {
        E400: problemResponse('Bad request', problemExample(400, 'Bad Request', 'Unknown filter field "colour"')),
        E401: problemResponse('Authentication required or failed', problemExample(401, 'Unauthorized', 'Bearer token required'), { 'WWW-Authenticate': { schema: { type: 'string' } } }),
        E403: problemResponse('Insufficient scope', problemExample(403, 'Forbidden', 'Token lacks required scope "write"')),
        E404: problemResponse('Not found', problemExample(404, 'Not Found', 'employee 999999 not found')),
        E409: problemResponse('Conflict (idempotency key reuse or resource in use)', problemExample(409, 'Conflict', 'Idempotency-Key was already used with a different request')),
        E412: problemResponse('If-Match did not match', problemExample(412, 'Precondition Failed', 'If-Match does not match the current ETag')),
        E413: problemResponse('Too large', problemExample(413, 'Content Too Large', `File exceeds the maximum size of ${settings.get('maxFileSizeMb')} MB`)),
        E415: problemResponse('Unsupported media type', problemExample(415, 'Unsupported Media Type', 'Content-Type must be application/json')),
        E416: problemResponse('Range not satisfiable', problemExample(416, 'Range Not Satisfiable', 'Range is not satisfiable')),
        E422: problemResponse('Validation failed', { ...problemExample(422, 'Unprocessable Content', 'employee failed validation'), errors: [{ field: 'email', message: 'must match format "email"' }] }),
        E429: problemResponse('Rate limited', problemExample(429, 'Too Many Requests', 'Rate limit exceeded'), retry),
        E500: problemResponse('Server error', problemExample(500, 'Internal Server Error', 'Injected 500 error (chaos)')),
        E503: problemResponse('Unavailable', problemExample(503, 'Service Unavailable', 'Injected 503 error (chaos)'), retry),
      },
      securitySchemes: security(mode, settings.get('apiKeyName'), settings.get('apiKeyIn'), base),
    },
  };
  if (mode !== 'none') doc.security = opSecurity(mode, 'get');
  return doc;
}

function stripReadOnly(ex) {
  const out = { ...ex };
  for (const k of ['id', 'uuid', 'createdAt', 'updatedAt', 'department', 'category', 'employeeNumber']) delete out[k];
  return out;
}

module.exports = { generateOpenApi };
