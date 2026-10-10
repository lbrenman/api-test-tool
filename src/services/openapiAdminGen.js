'use strict';
// OpenAPI 3.1 document for the ADMIN / control-plane API: /admin/api/* (dashboard backend) plus /health and /ready.
// Served at /admin/api/openapi.json|yaml behind the dashboard password. The mock data API that integrations call
// is described separately by openapiGen.js (/openapi.json).
const pkg = require('../../package.json');

const ref = (kind, name) => ({ $ref: `#/components/${kind}/${name}` });
const S = (name) => ref('schemas', name);
const R = (name) => ref('responses', name);

const obj = (properties = {}, required, extra = {}) => ({ type: 'object', ...(required ? { required } : {}), properties, ...extra });
const anyObj = (description) => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });
const json = (schema, example) => ({ 'application/json': { schema, ...(example !== undefined ? { example } : {}) } });
const body = (schema, example, required = true) => ({ required, content: json(schema, example) });
const ok = (description, schema, example) => ({ 200: { description, content: json(schema, example) } });
const created = (description, schema) => ({ 201: { description, content: json(schema) } });
const noContent = (description = 'Done') => ({ 204: { description } });
const pathParam = (name, description, example) => ({ name, in: 'path', required: true, description, schema: { type: 'string' }, ...(example ? { example } : {}) });

const AUTHED = { 401: R('Unauthorized') };
const NF = { 404: R('NotFound') };
const BAD = { 400: R('BadRequest') };

async function generateAdminOpenApi(ctx, req) {
  const { settings } = ctx;
  const base = ctx.baseUrl(req);
  const passwordSet = !!settings.get('adminPassword');
  const A = '/admin/api';

  const op = (tag, operationId, summary, extra = {}) => ({ tags: [tag], operationId, summary, ...extra });
  const paths = {};
  const add = (p, method, def) => { paths[p] = { ...(paths[p] || {}), [method]: def }; };

  // ---- Platform (open)
  add('/health', 'get', op('Platform', 'health', 'Liveness, version, dependency checks and an active-settings summary (no secrets)', {
    security: [],
    responses: { ...ok('Healthy', S('Health')), 503: { description: 'Degraded (database or file store check failed)', content: json(S('Health')) } },
  }));
  add('/ready', 'get', op('Platform', 'ready', 'Readiness probe', {
    security: [],
    responses: { ...ok('Ready', obj({ ready: { type: 'boolean' } }, ['ready'])), 503: { description: 'Not ready', content: json(obj({ ready: { type: 'boolean' } })) } },
  }));

  // ---- Session (open)
  add(`${A}/session`, 'get', op('Session', 'getSession', 'Whether this caller is signed in and whether a password is required', {
    security: [],
    responses: ok('Session state', obj({ authenticated: { type: 'boolean' }, passwordRequired: { type: 'boolean' } }, ['authenticated', 'passwordRequired'])),
  }));
  add(`${A}/login`, 'post', op('Session', 'login', 'Sign in with ADMIN_PASSWORD; sets the att_admin session cookie', {
    security: [],
    requestBody: { required: true, content: { ...json(obj({ password: { type: 'string', format: 'password' } }, ['password']), { password: 'change-me' }), 'application/x-www-form-urlencoded': { schema: obj({ password: { type: 'string' } }, ['password']) } } },
    responses: {
      200: { description: 'Signed in', headers: { 'Set-Cookie': { description: 'att_admin session cookie (HttpOnly, 7 days)', schema: { type: 'string' } } }, content: json(obj({ ok: { const: true } })) },
      401: { description: 'Wrong password', content: json(obj({ ok: { const: false }, error: { type: 'string' } })) },
    },
  }));
  add(`${A}/logout`, 'post', op('Session', 'logout', 'Clear the session cookie', { security: [], responses: ok('Signed out', obj({ ok: { type: 'boolean' } })) }));

  // ---- Overview
  add(`${A}/overview`, 'get', op('Overview', 'getOverview', 'URLs, auth mode, storage, counts and ready-made curl commands', {
    responses: { ...ok('Overview', S('Overview')), ...AUTHED },
  }));

  // ---- Settings
  add(`${A}/settings`, 'get', op('Settings', 'listSettings', 'Every setting with its value, default and source (env / default / override)', {
    responses: { ...ok('Settings', S('SettingsResponse')), ...AUTHED },
  }));
  add(`${A}/settings`, 'put', op('Settings', 'updateSettings', 'Override one or more settings (persisted; most take effect immediately)', {
    description: 'Body is a map of setting key to value. Settings marked restartRequired (port, DB driver, file store) are read-only.',
    requestBody: body({ type: 'object', additionalProperties: true }, { authMode: 'oauth2', errorRate: 10, dateFormat: 'epoch-ms' }),
    responses: { ...ok('Updated', obj({ updated: { type: 'array', items: { type: 'string' } }, settings: { type: 'array', items: S('Setting') } })), ...BAD, ...AUTHED },
  }));
  add(`${A}/settings/reset`, 'post', op('Settings', 'resetSettings', 'Drop overrides: one key, one section, or everything (empty body)', {
    requestBody: body(obj({ key: { type: 'string' }, section: { type: 'string' } }), { section: 'chaos' }, false),
    responses: { ...ok('Reset', obj({ reset: { type: 'array', items: { type: 'string' } }, settings: { type: 'array', items: S('Setting') } })), ...AUTHED },
  }));

  // ---- Data
  const resourceParam = { name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['employees', 'products', 'departments', 'categories'] } };
  add(`${A}/data/counts`, 'get', op('Data', 'getDataCounts', 'Record counts per mock resource', { responses: { ...ok('Counts', S('Counts')), ...AUTHED } }));
  add(`${A}/data/seed`, 'post', op('Data', 'seedData', 'Clear and re-seed the mock data (deterministic for a given seed)', {
    requestBody: body(obj({ employees: { type: 'integer', minimum: 0 }, products: { type: 'integer', minimum: 0 }, seed: { type: 'integer' }, sampleFiles: { type: 'boolean' } }), { employees: 250, products: 500, seed: 42, sampleFiles: true }, false),
    responses: { ...ok('Seeded', anyObj('Counts seeded, the seed used and the number of sample files generated')), ...AUTHED },
  }));
  add(`${A}/data/clear`, 'post', op('Data', 'clearData', 'Delete all mock data', { responses: { ...ok('Cleared', obj({ cleared: { type: 'boolean' }, counts: S('Counts') })), ...AUTHED } }));
  add(`${A}/data/preview/{resource}`, 'get', op('Data', 'previewData', 'First few records of a resource, rendered as the API returns them', {
    parameters: [resourceParam, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 5 } }],
    responses: { ...ok('Records', { type: 'array', items: anyObj() }), ...AUTHED, ...NF },
  }));

  // ---- Files
  const fileIdParam = pathParam('id', 'File id', 'sample-employees-csv');
  add(`${A}/files`, 'get', op('Files', 'adminListFiles', 'All files in the shared pool', { responses: { ...ok('Files', { type: 'array', items: S('File') }), ...AUTHED } }));
  add(`${A}/files/regenerate`, 'post', op('Files', 'regenerateSampleFiles', 'Regenerate the sample files (CSV, XLSX, JSON, images, PDF, ZIP, large binary)', {
    responses: { ...ok('Regenerated', obj({ generated: { type: 'integer' } })), ...AUTHED },
  }));
  add(`${A}/files/upload`, 'post', op('Files', 'adminUploadFile', 'Upload a file into the pool (raw body)', {
    parameters: [
      { name: 'X-Filename', in: 'header', description: 'URI-encoded file name', schema: { type: 'string' }, example: 'report.pdf' },
      { name: 'X-Content-Type', in: 'header', description: 'Real content type (the body is sent as application/octet-stream)', schema: { type: 'string' } },
    ],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    responses: { ...created('Uploaded', S('File')), 413: R('Problem'), ...AUTHED },
  }));
  add(`${A}/files/{id}`, 'delete', op('Files', 'adminDeleteFile', 'Delete a file', { parameters: [fileIdParam], responses: { ...noContent('Deleted'), ...AUTHED, ...NF } }));
  add(`${A}/files/{id}/download`, 'get', op('Files', 'adminDownloadFile', 'Download a file', {
    parameters: [fileIdParam, { name: 'inline', in: 'query', schema: { type: 'boolean' } }],
    responses: { 200: { description: 'File content', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }, ...AUTHED, ...NF },
  }));

  // ---- Auth
  add(`${A}/auth`, 'get', op('Auth', 'getAuthConfig', 'Active /v1 auth mode, every mode\'s credentials, the S3 API keys, OAuth endpoints and clients', {
    responses: { ...ok('Auth configuration', anyObj('mode, apiKey, basic, bearer, jwt, hmac, s3 (S3 API endpoint, bucket, region and keys), oauth, clients')), ...AUTHED },
  }));
  add(`${A}/oauth/clients`, 'post', op('Auth', 'createOAuthClient', 'Add an OAuth client (stored in the DB)', {
    requestBody: body(obj({ clientId: { type: 'string' }, secret: { type: 'string' }, scopes: { description: 'Space/comma-separated string or array', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, redirectUris: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }), { clientId: 'fusion', secret: 's3cret', scopes: 'read write' }),
    responses: { ...created('Client created', S('OAuthClient')), ...BAD, ...AUTHED },
  }));
  add(`${A}/oauth/clients/{id}`, 'delete', op('Auth', 'deleteOAuthClient', 'Delete a dashboard-added OAuth client (env clients cannot be deleted)', {
    parameters: [pathParam('id', 'Client id')],
    responses: { ...noContent('Deleted'), ...AUTHED, ...NF },
  }));
  add(`${A}/auth/test-token`, 'post', op('Auth', 'issueTestToken', 'Issue an access token for a client without a token request; returns it decoded', {
    requestBody: body(obj({ clientId: { type: 'string' }, scope: { type: 'string' } }), { clientId: 'demo-client', scope: 'read write' }, false),
    responses: { ...ok('Token', anyObj('access_token, token_type, expires_in, scope, clientId, decoded {header, payload}')), ...BAD, ...AUTHED },
  }));
  add(`${A}/auth/hmac-sign`, 'post', op('Auth', 'hmacSign', 'Compute the HMAC canonical string and headers for a request', {
    requestBody: body(obj({ method: { type: 'string' }, path: { type: 'string' }, body: { type: 'string' } }), { method: 'GET', path: '/v1/employees?limit=1' }),
    responses: { ...ok('Signature', obj({ canonical: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } } })), ...AUTHED },
  }));

  // ---- Inspector
  const capId = pathParam('id', 'Capture id');
  add(`${A}/inspector`, 'get', op('Inspector', 'listCaptures', 'Most recent captured requests', {
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, default: 200 } }],
    responses: { ...ok('Captures', { type: 'array', items: S('Capture') }), ...AUTHED },
  }));
  add(`${A}/inspector`, 'delete', op('Inspector', 'clearCaptures', 'Delete every capture', { responses: { ...noContent('Cleared'), ...AUTHED } }));
  add(`${A}/inspector/stream`, 'get', op('Inspector', 'streamCaptures', 'Live captures (Server-Sent Events: request, update, delete, clear)', {
    responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, ...AUTHED },
  }));
  add(`${A}/inspector/export`, 'get', op('Inspector', 'exportCaptures', 'Export every capture as a JSON download', { responses: { ...ok('Captures', { type: 'array', items: S('Capture') }), ...AUTHED } }));
  add(`${A}/inspector/{id}`, 'get', op('Inspector', 'getCapture', 'One capture, with a curl reproduction', {
    parameters: [capId], responses: { ...ok('Capture', S('Capture')), ...AUTHED, ...NF },
  }));
  add(`${A}/inspector/{id}`, 'delete', op('Inspector', 'deleteCapture', 'Delete one capture', {
    parameters: [capId], responses: { ...noContent('Deleted'), ...AUTHED, ...NF },
  }));
  add(`${A}/inspector/{id}/body`, 'get', op('Inspector', 'getCaptureBody', 'Raw captured request body', {
    parameters: [capId], responses: { 200: { description: 'Body bytes', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }, ...AUTHED, ...NF },
  }));
  add(`${A}/inspector/{id}/parts/{n}`, 'get', op('Inspector', 'getCapturePart', 'One file part of a captured multipart body', {
    parameters: [capId, { name: 'n', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
    responses: { 200: { description: 'Part bytes', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }, ...AUTHED, ...NF },
  }));
  add(`${A}/inspector/{id}/replay`, 'post', op('Inspector', 'replayCapture', 'Replay a capture to this server or another URL', {
    parameters: [capId],
    requestBody: body(obj({ targetUrl: { type: 'string', format: 'uri' } }), { targetUrl: 'https://example.com/hook' }, false),
    responses: { ...ok('Replay result', anyObj('status, headers, body and timing of the replayed call')), ...AUTHED, ...NF },
  }));
  // ---- Webhooks (outgoing)
  const whId = pathParam('id', 'Webhook id', 'wh_0123456789abcdef');
  const dlvId = pathParam('id', 'Delivery id', 'dlv_0123456789abcdef');
  const hookExample = { name: 'New employees to my integration', url: 'https://example.com/hooks/employees', resources: ['employees'], events: ['created', 'updated'], includeData: false, secret: 'shared-secret', headers: { 'X-API-Key': 'integration-key' } };
  add(`${A}/webhooks`, 'get', op('Webhooks', 'listWebhooks', 'Every webhook (secrets are not returned)', {
    responses: { ...ok('Webhooks', obj({ enabled: { type: 'boolean', description: 'WEBHOOKS_ENABLED' }, items: { type: 'array', items: S('Webhook') } }, ['enabled', 'items'])), ...AUTHED },
  }));
  add(`${A}/webhooks`, 'post', op('Webhooks', 'createWebhook', 'Add a webhook (stored in the database; survives restarts)', {
    requestBody: body(S('WebhookInput'), hookExample),
    responses: { ...created('Webhook created (Location header points at it)', S('Webhook')), ...BAD, ...AUTHED },
  }));
  add(`${A}/webhooks/{id}`, 'get', op('Webhooks', 'getWebhook', 'One webhook', { parameters: [whId], responses: { ...ok('Webhook', S('Webhook')), ...AUTHED, ...NF } }));
  add(`${A}/webhooks/{id}`, 'patch', op('Webhooks', 'updateWebhook', 'Change a webhook (only the fields sent; "secret": null removes the secret)', {
    parameters: [whId], requestBody: body(S('WebhookInput'), { enabled: false }),
    responses: { ...ok('Webhook', S('Webhook')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/webhooks/{id}`, 'delete', op('Webhooks', 'deleteWebhook', 'Delete a webhook (its logged deliveries stay until trimmed)', { parameters: [whId], responses: { ...noContent('Deleted'), ...AUTHED, ...NF } }));
  add(`${A}/webhooks/{id}/test`, 'post', op('Webhooks', 'testWebhook', 'Send a test delivery now (the first record of the webhook\'s first resource, marked "test": true) and return the result', {
    parameters: [whId], requestBody: body(obj({ type: { type: 'string', enum: ['created', 'updated', 'deleted', 'uploaded', 'downloaded'] } }), { type: 'created' }, false),
    responses: { ...ok('Delivery', S('WebhookDelivery')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/webhooks/deliveries`, 'get', op('Webhooks', 'listWebhookDeliveries', 'Logged deliveries, newest first', {
    parameters: [{ name: 'webhookId', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } }],
    responses: { ...ok('Deliveries', obj({ items: { type: 'array', items: S('WebhookDelivery') } }, ['items'])), ...BAD, ...AUTHED },
  }));
  add(`${A}/webhooks/deliveries`, 'delete', op('Webhooks', 'clearWebhookDeliveries', 'Clear the delivery log', { responses: { ...noContent('Cleared'), ...AUTHED } }));
  add(`${A}/webhooks/deliveries/{id}`, 'get', op('Webhooks', 'getWebhookDelivery', 'One delivery: request headers and body, response status, headers and body', {
    parameters: [dlvId], responses: { ...ok('Delivery', S('WebhookDelivery')), ...AUTHED, ...NF },
  }));
  add(`${A}/webhooks/deliveries/{id}/redeliver`, 'post', op('Webhooks', 'redeliverWebhook', 'Send a logged delivery again (same payload, new delivery id, fresh timestamp and signature)', {
    parameters: [dlvId], responses: { ...ok('New delivery', S('WebhookDelivery')), ...AUTHED, ...NF },
  }));

  add(`${A}/inspector/{id}/curl`, 'get', op('Inspector', 'getCaptureCurl', 'The capture as a curl command', {
    parameters: [capId, { name: 'target', in: 'query', description: 'Base URL to send to instead', schema: { type: 'string' } }],
    responses: { 200: { description: 'curl command', content: { 'text/plain': { schema: { type: 'string' } } } }, ...AUTHED, ...NF },
  }));

  // ---- Tester
  const T = `${A}/tester`;
  const specId = pathParam('id', 'Spec id', 'spec_0123456789ab');
  const runId = pathParam('runId', 'Run id', 'run_0123456789ab');
  add(`${T}/samples`, 'get', op('Tester', 'listTesterSamples', 'Bundled specs that can be loaded by name', {
    responses: { ...ok('Samples', { type: 'array', items: obj({ id: { type: 'string' }, name: { type: 'string' }, file: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string', enum: ['openapi', 'wsdl', 'asyncapi'] } }) }), ...AUTHED },
  }));
  add(`${T}/specs`, 'get', op('Tester', 'listSpecs', 'Loaded specs', { responses: { ...ok('Specs', { type: 'array', items: S('SpecSummary') }), ...AUTHED } }));
  add(`${T}/specs`, 'post', op('Tester', 'loadSpec', 'Load a contract (OpenAPI 3.0/3.1, Swagger 2.0, WSDL 1.1 for SOAP, or AsyncAPI 2.x/3.0 for WebSocket) from pasted content, a URL, a bundled sample or a file upload; the kind is detected from the content. kind "websocket" with a ws:// url creates a WebSocket scenario with no contract.', {
    requestBody: {
      required: true,
      content: {
        ...json(obj({ name: { type: 'string' }, content: { type: 'string', description: 'OpenAPI or AsyncAPI YAML/JSON text, or WSDL XML' }, kind: { type: 'string', enum: ['websocket'], description: 'Only for a WebSocket scenario without a contract (with url = ws:// or wss://)' }, url: { type: 'string', format: 'uri' }, sample: { type: 'string', description: 'Sample id from /tester/samples' } }), { name: 'supplier', sample: 'Supplier_Order_Collaboration_OpenAPI_3_1.yaml' }),
        'multipart/form-data': { schema: obj({ name: { type: 'string' }, file: { type: 'string', format: 'binary' } }) },
      },
    },
    responses: { ...created('Loaded', anyObj('id, name, version, originalVersion, notes, lint counts')), ...BAD, ...AUTHED, 422: R('Problem') },
  }));
  add(`${T}/specs/{id}`, 'get', op('Tester', 'getSpec', 'A spec with its operations, auth profiles and lint counts', { parameters: [specId], responses: { ...ok('Spec', anyObj()), ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}`, 'put', op('Tester', 'updateSpec', 'Rename a spec or change its target (base URL, auth profile, default headers) and options', {
    parameters: [specId],
    requestBody: body(obj({ name: { type: 'string' }, target: S('Target'), options: obj({ lenientAllOf: { type: 'boolean' } }), scenario: { type: ['array', 'null'], items: { type: 'object' }, description: 'WebSocket contracts: run-all steps (connect, send, expect, listen, wait, ping, close, expectClose); null = automatic' } }), { target: { baseUrl: 'https://my-impl.example.com/v1', auth: { type: 'none' } } }),
    responses: { ...ok('Updated', anyObj()), ...AUTHED, ...NF },
  }));
  add(`${T}/specs/{id}`, 'delete', op('Tester', 'deleteSpec', 'Delete a spec', { parameters: [specId], responses: { ...noContent('Deleted'), ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}/document`, 'get', op('Tester', 'getSpecDocument', 'The contract: the bundled OpenAPI or AsyncAPI document (JSON), the original WSDL (XML), or a WebSocket scenario', { parameters: [specId], responses: { 200: { description: 'Document', content: { 'application/json': { schema: anyObj() }, 'text/xml': { schema: { type: 'string' } } } }, ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}/reload`, 'post', op('Tester', 'reloadSpec', 'Reload a spec from its original source (URL or sample)', { parameters: [specId], responses: { ...ok('Reloaded', anyObj()), ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}/lint`, 'get', op('Tester', 'lintSpec', 'Spec lint findings (e.g. allOf + additionalProperties:false)', { parameters: [specId], responses: { ...ok('Lint', anyObj('counts and findings with JSON pointers')), ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}/operations`, 'get', op('Tester', 'listSpecOperations', 'Operations in a spec', { parameters: [specId], responses: { ...ok('Operations', { type: 'array', items: anyObj() }), ...AUTHED, ...NF } }));
  add(`${T}/specs/{id}/request`, 'get', op('Tester', 'getSampleRequest', 'Generated sample request for one operation', {
    parameters: [specId, { name: 'op', in: 'query', required: true, schema: { type: 'string' } }, { name: 'example', in: 'query', description: 'Named example to use (OpenAPI)', schema: { type: 'string' } }, { name: 'version', in: 'query', description: 'SOAP version for WSDL contracts', schema: { type: 'string', enum: ['1.1', '1.2'] } }],
    responses: { ...ok('Request', anyObj('path, query, headers and body')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${T}/specs/{id}/send`, 'post', op('Tester', 'sendOperation', 'Call one operation on the target and validate the response ("try it")', {
    parameters: [specId],
    requestBody: body(obj({ opId: { type: 'string' }, request: anyObj('Overrides the generated request'), target: S('Target'), lenientAllOf: { type: 'boolean' } }, ['opId']), { opId: 'listPurchaseOrders' }),
    responses: { ...ok('Result', anyObj('request, response, checks, outcome, pass')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${T}/specs/{id}/runs`, 'post', op('Tester', 'runSpec', 'Run every operation (contract mode) with ID chaining and optional negative tests', {
    parameters: [specId],
    requestBody: body(obj({ negative: { type: 'boolean' }, variables: { type: 'object', additionalProperties: true }, operationIds: { type: 'array', items: { type: 'string' } }, target: S('Target'), lenientAllOf: { type: 'boolean' } }), { negative: true }, false),
    responses: { ...created('Run', S('Run')), ...AUTHED, ...NF },
  }));
  add(`${T}/specs/{id}/runs`, 'get', op('Tester', 'listSpecRuns', 'Run history for a spec', { parameters: [specId], responses: { ...ok('Runs', { type: 'array', items: S('RunSummary') }), ...AUTHED } }));
  add(`${T}/specs/{id}/mock`, 'post', op('Tester', 'mockSpec', 'Serve the spec\'s examples under /mock/<name> (optionally as the tester target)', {
    parameters: [specId],
    requestBody: body(obj({ useAsTarget: { type: 'boolean' } }), { useAsTarget: true }, false),
    responses: { ...created('Mock installed', anyObj('prefix, url, rules')), ...AUTHED, ...NF },
  }));
  add(`${T}/specs/{id}/mock`, 'delete', op('Tester', 'unmockSpec', 'Remove the mock for a spec', { parameters: [specId], responses: { ...ok('Removed', obj({ removed: { type: 'integer' } })), ...AUTHED, ...NF } }));
  add(`${T}/token`, 'post', op('Tester', 'testTargetToken', 'Fetch a token from a target\'s OAuth2 client-credentials endpoint and show the exchange', {
    requestBody: body(obj({ auth: obj({ type: { const: 'oauth2cc' }, tokenUrl: { type: 'string', format: 'uri' }, clientId: { type: 'string' }, clientSecret: { type: 'string' }, scopes: { type: 'string' } }, ['type']) }, ['auth'])),
    responses: { ...ok('Token fetched', anyObj()), ...BAD, ...AUTHED, 502: { description: 'Token endpoint failed', content: json(anyObj()) } },
  }));
  add(`${T}/token-cache/clear`, 'post', op('Tester', 'clearTokenCache', 'Forget cached target tokens', { responses: { ...ok('Cleared', obj({ cleared: { type: 'boolean' } })), ...AUTHED } }));
  add(`${T}/runs`, 'get', op('Tester', 'listRuns', 'Run history across all specs', { responses: { ...ok('Runs', { type: 'array', items: S('RunSummary') }), ...AUTHED } }));
  add(`${T}/runs/{runId}`, 'get', op('Tester', 'getRun', 'A run with every step', { parameters: [runId], responses: { ...ok('Run', S('Run')), ...AUTHED, ...NF } }));
  add(`${T}/runs/{runId}`, 'delete', op('Tester', 'deleteRun', 'Delete a run', { parameters: [runId], responses: { ...noContent('Deleted'), ...AUTHED } }));
  add(`${T}/runs/{runId}/report.html`, 'get', op('Tester', 'getRunReport', 'Standalone HTML report', {
    parameters: [runId, { name: 'download', in: 'query', schema: { type: 'boolean' } }],
    responses: { 200: { description: 'HTML report', content: { 'text/html': { schema: { type: 'string' } } } }, ...AUTHED, ...NF },
  }));
  add(`${T}/runs/{runId}/export.json`, 'get', op('Tester', 'exportRun', 'The run as a JSON download', { parameters: [runId], responses: { ...ok('Run', S('Run')), ...AUTHED, ...NF } }));

  // ---- Back-office app (/app)
  const P = `${A}/app`;
  const appResource = { name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['employees', 'products', 'departments', 'categories'] } };
  const recId = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, example: 1 };
  add(`${P}/summary`, 'get', op('App', 'getAppSummary', 'KPIs, chart series and recent changes for the back-office home page', {
    responses: { ...ok('Summary', S('AppSummary')), ...AUTHED },
  }));
  add(`${P}/lookups`, 'get', op('App', 'getAppLookups', 'Departments, categories and employees for form dropdowns', {
    responses: { ...ok('Lookups', obj({ departments: { type: 'array', items: anyObj() }, categories: { type: 'array', items: anyObj() }, employees: { type: 'array', items: anyObj() } })), ...AUTHED },
  }));
  add(`${P}/records/{resource}`, 'get', op('App', 'listAppRecords', 'Search, filter, sort and page records (rows include computed columns)', {
    description: 'Accepts the same filters as /v1 (?field=value, ?field[gte]=x, ?q=, ?sort=-a,b) plus ?page= and ?size= (max 100). Timestamps are always ISO 8601.',
    parameters: [appResource, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'sort', in: 'query', schema: { type: 'string' }, example: '-updatedAt' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }, { name: 'size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }],
    responses: { ...ok('Page of records', obj({ items: { type: 'array', items: anyObj() }, total: { type: 'integer' }, page: { type: 'integer' }, size: { type: 'integer' }, pages: { type: 'integer' } }, ['items', 'total', 'page', 'size', 'pages'])), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${P}/records/{resource}`, 'post', op('App', 'createAppRecord', 'Create a record (same validation as POST /v1/{resource})', {
    parameters: [appResource], requestBody: body(anyObj(), { name: 'Logistics', code: 'LOG' }),
    responses: { ...created('Created', anyObj()), ...BAD, ...AUTHED, ...NF, 422: R('Problem') },
  }));
  add(`${P}/records/{resource}/{id}`, 'get', op('App', 'getAppRecord', 'A record with related records (direct reports, department staff, category products)', {
    parameters: [appResource, recId], responses: { ...ok('Record', obj({ record: anyObj(), related: anyObj() }, ['record', 'related'])), ...AUTHED, ...NF },
  }));
  add(`${P}/records/{resource}/{id}`, 'patch', op('App', 'updateAppRecord', 'Update a record (JSON Merge Patch, same validation as /v1)', {
    parameters: [appResource, recId], requestBody: body(anyObj(), { title: 'Senior Engineer', isActive: true }),
    responses: { ...ok('Updated', anyObj()), ...BAD, ...AUTHED, ...NF, 422: R('Problem') },
  }));
  add(`${P}/records/{resource}/{id}`, 'delete', op('App', 'deleteAppRecord', 'Delete a record (409 when a department or category is still in use)', {
    parameters: [appResource, recId], responses: { ...noContent('Deleted'), ...AUTHED, ...NF, 409: R('Problem') },
  }));

  // ---- the admin spec itself
  add(`${A}/openapi.json`, 'get', op('Platform', 'getAdminOpenApiJson', 'This document (JSON)', { responses: { ...ok('OpenAPI document', anyObj()), ...AUTHED } }));
  add(`${A}/openapi.yaml`, 'get', op('Platform', 'getAdminOpenApiYaml', 'This document (YAML)', { responses: { 200: { description: 'OpenAPI document', content: { 'application/yaml': { schema: { type: 'string' } } } }, ...AUTHED } }));

  const doc = {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: {
      title: 'API Test Tool — Admin API',
      version: pkg.version,
      summary: 'Control plane for the tool: settings, data, files, auth, inspector and the contract tester.',
      description: [
        '**For operators and automation, not for integrations.** This is the API the dashboard uses. Use it to script the tool',
        '(change settings, re-seed data, manage OAuth clients, read the inspector, drive the contract tester), to back the /app back-office UI,',
        'or to check its health.',
        '',
        `The mock data API that integrations call (\`/v1/*\` and \`/oauth/token\`) is described separately at [\`${base}/openapi.json\`](${base}/openapi.json).`,
        '',
        '**Auth.** Every `/admin/api/*` operation except session, login and logout requires the dashboard password: either the',
        '`att_admin` session cookie from `POST /admin/api/login`, or HTTP Basic with any username and `ADMIN_PASSWORD` as the password.',
        `\`/health\` and \`/ready\` are always open.${passwordSet ? '' : ' **ADMIN_PASSWORD is not set on this instance, so the admin API is currently open.**'}`,
        '',
        'Admin endpoints are never recorded by the inspector and are not affected by the /v1 auth mode, chaos or rate limits.',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: base, description: 'This instance' }],
    security: [{ AdminBasic: [] }, { AdminSession: [] }],
    tags: [
      { name: 'Platform', description: 'Health, readiness and this document' },
      { name: 'Session', description: 'Dashboard sign-in' },
      { name: 'Overview' },
      { name: 'Settings', description: 'Env defaults, persisted overrides and resets' },
      { name: 'Data', description: 'Seed, clear and preview the mock data' },
      { name: 'Files', description: 'Manage the shared file pool' },
      { name: 'Auth', description: '/v1 auth configuration and OAuth clients' },
      { name: 'Inspector', description: 'Captured requests (webhook-style catch-all)' },
      { name: 'Webhooks', description: 'Outgoing webhooks: POST to your URL when mock data is created, updated or deleted, or a file is uploaded, downloaded or deleted, through any protocol' },
      { name: 'Tester', description: 'Contract tester for APIs you implemented (OpenAPI, WSDL/SOAP, AsyncAPI/WebSocket)' },
      { name: 'App', description: 'Backend for the back-office app at /app (bypasses /v1 auth, chaos and rate limits)' },
    ],
    paths,
    components: {
      securitySchemes: {
        AdminBasic: { type: 'http', scheme: 'basic', description: 'Any username; the password is ADMIN_PASSWORD.' },
        AdminSession: { type: 'apiKey', in: 'cookie', name: 'att_admin', description: 'Session cookie set by POST /admin/api/login.' },
      },
      schemas: {
        Problem: obj({ type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' }, requestId: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' }, code: { type: 'string' } }, ['title', 'status'], { additionalProperties: true }),
        Health: obj({
          status: { type: 'string', enum: ['ok', 'degraded'] }, version: { type: 'string' }, uptimeSeconds: { type: 'integer' }, time: { type: 'string', format: 'date-time' },
          baseUrl: { type: 'string' }, checks: anyObj('database and fileStore: driver, ok, latencyMs, error'), settings: anyObj('Active settings summary (no secrets)'), data: S('Counts'),
        }, ['status', 'version', 'checks']),
        Counts: obj({ employees: { type: 'integer' }, products: { type: 'integer' }, departments: { type: 'integer' }, categories: { type: 'integer' } }, undefined, { additionalProperties: { type: 'integer' } }),
        Overview: obj({
          version: { type: 'string' }, baseUrl: { type: 'string' }, urls: { type: 'object', additionalProperties: { type: 'string' } }, authMode: { type: 'string' }, dateFormat: { type: 'string' },
          chaos: anyObj(), storage: obj({ db: { type: 'string' }, files: { type: 'string' } }), counts: S('Counts'), files: { type: 'integer' }, inspector: { type: 'integer' },
          lastSeed: { type: ['object', 'null'] }, curls: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } },
        }),
        Setting: obj({
          key: { type: 'string' }, env: { type: 'string' }, section: { type: 'string' }, type: { type: 'string' }, options: { type: ['array', 'null'] }, description: { type: 'string' },
          restartRequired: { type: 'boolean' }, secret: { type: 'boolean' }, value: {}, envValue: {}, default: {}, source: { type: 'string', enum: ['env', 'default', 'override'] },
        }, ['key', 'value', 'source']),
        SettingsResponse: obj({ sections: { type: 'array', items: { type: 'string' } }, settings: { type: 'array', items: S('Setting') } }, ['sections', 'settings']),
        File: obj({
          id: { type: 'string' }, name: { type: 'string' }, contentType: { type: 'string' }, size: { type: ['integer', 'null'] }, sha256: { type: ['string', 'null'] },
          source: { type: 'string', enum: ['generated', 'uploaded'] }, createdAt: {}, updatedAt: {}, links: { type: 'object', additionalProperties: { type: 'string' } },
        }, ['id', 'name']),
        OAuthClient: obj({ clientId: { type: 'string' }, secret: { type: 'string' }, scopes: {}, redirectUris: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, ['clientId'], { additionalProperties: true }),
        WebhookInput: obj({
          name: { type: 'string', maxLength: 120 },
          url: { type: 'string', format: 'uri', description: 'http(s) URL that receives the POST' },
          resources: { type: 'array', items: { type: 'string', enum: ['*', 'employees', 'products', 'departments', 'categories', 'files'] }, default: ['*'], description: '"*" = every data resource; add "files" for the file pool' },
          events: { type: 'array', items: { type: 'string', enum: ['created', 'updated', 'deleted', 'uploaded', 'downloaded'] }, description: 'created/updated apply to data, uploaded/downloaded to files, deleted to both. Default: created + updated for data, uploaded for files' },
          enabled: { type: 'boolean', default: true },
          includeData: { type: 'boolean', default: false, description: 'Add the record as "data" (never for deletes)' },
          secret: { type: ['string', 'null'], maxLength: 256, description: 'Signs each delivery: X-Webhook-Signature: sha256=hex(HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<raw body>"))' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers, e.g. credentials for the receiver (X-Webhook-*, Content-Type and Host are reserved)' },
        }, undefined, { description: 'url is required on create; on PATCH send only what changes' }),
        Webhook: obj({
          id: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, resources: { type: 'array', items: { type: 'string' } },
          events: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, includeData: { type: 'boolean' },
          headers: { type: 'object', additionalProperties: { type: 'string' } }, hasSecret: { type: 'boolean' }, secretHint: { type: ['string', 'null'] },
          baseUrl: { type: 'string', description: 'Used for "href" when no public URL is configured' },
          createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
          lastDelivery: { type: ['object', 'null'], properties: { at: { type: 'string' }, status: { type: ['integer', 'null'] }, ok: { type: 'boolean' }, error: { type: ['string', 'null'] }, durationMs: { type: 'integer' }, event: { type: 'string' } } },
        }, ['id', 'url', 'resources', 'events', 'enabled']),
        WebhookPayload: obj({
          id: { type: 'string', description: 'Delivery id (also X-Webhook-Delivery)' }, event: { type: 'string', examples: ['employees.created'] },
          type: { type: 'string', enum: ['created', 'updated', 'deleted', 'uploaded', 'downloaded'] }, resource: { type: 'string' }, resourceId: { type: ['integer', 'string'], description: 'Integer for data, "f_…" for files' },
          href: { type: 'string', format: 'uri', description: 'GET it from /v1 for the full record' }, occurredAt: { type: 'string', format: 'date-time' },
          webhookId: { type: 'string' }, test: { type: 'boolean' }, data: anyObj('The record (includeData only)'),
          via: { type: 'string', description: 'Files: multipart, raw, base64, tus, presigned, download, chunked, api or dashboard' },
          file: anyObj('Files: id, name, contentType, size, sha256, source, createdAt, updatedAt'),
          status: { type: 'integer', description: 'Downloads: 200 or 206' }, range: { type: ['string', 'null'], description: 'Downloads: Content-Range of a 206' },
          bytes: { type: 'integer', description: 'Downloads: bytes of the file sent' },
        }, ['id', 'event', 'type', 'resource', 'resourceId', 'href', 'occurredAt', 'webhookId'], { description: 'The JSON body POSTed to the webhook URL' }),
        WebhookDelivery: obj({
          id: { type: 'string' }, webhookId: { type: 'string' }, webhookName: { type: 'string' }, event: { type: 'string' }, resource: { type: 'string' }, resourceId: { type: 'integer' },
          url: { type: 'string' }, at: { type: 'string', format: 'date-time' }, test: { type: 'boolean' }, redeliveryOf: { type: ['string', 'null'] },
          request: obj({ headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Custom header values are shown as "(set)"' }, body: S('WebhookPayload') }),
          status: { type: ['integer', 'null'] }, ok: { type: 'boolean' }, error: { type: 'string' }, durationMs: { type: 'integer' },
          response: obj({ headers: { type: 'object' }, body: { type: 'string' } }),
        }, ['id', 'webhookId', 'event', 'at', 'ok']),
        Capture: anyObj('Captured request: id, timestamp, method, url, path, query, headers, detected auth, client IP, body, size, duration and the response returned'),
        Target: obj({
          baseUrl: { type: 'string', description: 'Base URL (OpenAPI) or endpoint URL (WSDL)' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, timeoutMs: { type: 'integer' },
          soapVersion: { type: 'string', enum: ['auto', '1.1', '1.2'], description: 'WSDL contracts only' },
          subprotocols: { type: 'array', items: { type: 'string' }, description: 'WebSocket contracts: Sec-WebSocket-Protocol values to offer' },
          oversizeKb: { type: 'integer', description: 'WebSocket negative test: size of the oversized message (default 2048)' },
          auth: obj({ type: { type: 'string', enum: ['none', 'apikey', 'basic', 'bearer', 'oauth2cc', 'wsse'] } }, ['type'], { additionalProperties: true }),
        }),
        SpecSummary: obj({
          id: { type: 'string' }, kind: { type: 'string', enum: ['openapi', 'wsdl', 'asyncapi', 'websocket'] }, name: { type: 'string' }, title: { type: 'string' }, apiVersion: { type: 'string' }, version: { type: 'string' }, originalVersion: { type: 'string' },
          converted: { type: 'boolean' }, source: anyObj(), operations: { type: 'integer' }, baseUrl: { type: 'string' }, updatedAt: { type: 'string' }, lastRun: { type: ['object', 'null'] },
        }, ['id', 'name']),
        RunSummary: obj({ id: { type: 'string' }, specId: { type: 'string' }, specName: { type: 'string' }, startedAt: { type: 'string' }, durationMs: { type: 'integer' }, summary: anyObj(), options: anyObj(), baseUrl: { type: 'string' } }, ['id', 'specId']),
        AppSummary: obj({
          generatedAt: { type: 'string', format: 'date-time' }, currency: { type: 'string' }, fxNote: { type: 'string' },
          people: anyObj('headcount, active, activePct, avgSalary, annualPayroll, avgRating, hiresLast12Months, departments'),
          catalog: anyObj('products, live, inStockPct, lowStock, outOfStock, discontinued, inventoryValueUsd, avgRating, categories'),
          charts: anyObj('headcountByDepartment, avgSalaryByLevel, hiresByYear, productsByCategory, stockStatus: arrays of {label, value}'),
          recent: { type: 'array', items: anyObj() },
        }, ['people', 'catalog', 'charts']),
        Run: obj({
          id: { type: 'string' }, specId: { type: 'string' }, specName: { type: 'string' }, startedAt: { type: 'string' }, finishedAt: { type: 'string' }, durationMs: { type: 'integer' },
          target: anyObj(), options: anyObj(), summary: anyObj('pass / fail / warn / skip counts'), variables: anyObj(), steps: { type: 'array', items: anyObj() },
        }, ['id', 'specId', 'summary', 'steps']),
      },
      responses: {
        Unauthorized: { description: 'Admin login required', content: { 'application/problem+json': { schema: S('Problem') } } },
        NotFound: { description: 'Not found', content: { 'application/problem+json': { schema: S('Problem') } } },
        BadRequest: { description: 'Bad request', content: { 'application/problem+json': { schema: S('Problem') } } },
        Problem: { description: 'Error', content: { 'application/problem+json': { schema: S('Problem') } } },
      },
    },
  };
  return doc;
}

module.exports = { generateAdminOpenApi };
