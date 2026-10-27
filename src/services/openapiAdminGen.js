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

  // ---- Settings profiles
  const profName = pathParam('name', 'Profile name (built-in: one per auth mode)', 'hmac');
  const profExample = { name: 'flaky-oauth', description: 'OAuth2 with 20% 503s', settings: { authMode: 'oauth2', errorRate: 20, errorTypes: '503' } };
  add(`${A}/profiles`, 'get', op('Profiles', 'listProfiles', 'Built-in and custom settings profiles, the settings a profile may set, and their current global values', {
    responses: { ...ok('Profiles', obj({ profiles: { type: 'array', items: S('Profile') }, keys: { type: 'array', items: { type: 'string' } }, settings: anyObj('Setting descriptions (as in GET /admin/api/settings) keyed by name') }, ['profiles', 'keys'])), ...AUTHED },
  }));
  add(`${A}/profiles`, 'post', op('Profiles', 'createProfile', 'Add a custom profile. Its settings apply to requests under /p/<name>/…; everything else stays global', {
    requestBody: body(S('ProfileInput'), profExample),
    responses: { ...created('Profile created', S('Profile')), ...BAD, ...AUTHED, 409: { description: 'The name is taken or built in', content: json(S('Problem')) } },
  }));
  add(`${A}/profiles/{name}`, 'get', op('Profiles', 'getProfile', 'One profile', { parameters: [profName], responses: { ...ok('Profile', S('Profile')), ...AUTHED, ...NF } }));
  add(`${A}/profiles/{name}`, 'patch', op('Profiles', 'updateProfile', 'Change a custom profile\'s description or settings (settings replace the profile\'s whole set)', {
    parameters: [profName], requestBody: body(S('ProfileInput'), { settings: { authMode: 'oauth2', errorRate: 0 } }),
    responses: { ...ok('Profile', S('Profile')), ...BAD, ...AUTHED, ...NF, 409: { description: 'Built-in profiles cannot be changed', content: json(S('Problem')) } },
  }));
  add(`${A}/profiles/{name}`, 'delete', op('Profiles', 'deleteProfile', 'Delete a custom profile', {
    parameters: [profName], responses: { ...noContent('Deleted'), ...AUTHED, ...NF, 409: { description: 'Built-in profiles cannot be deleted', content: json(S('Problem')) } },
  }));

  // ---- Auth
  add(`${A}/auth`, 'get', op('Auth', 'getAuthConfig', 'Active /v1 auth mode, every mode\'s credentials, the S3 API keys, OAuth endpoints and clients. With ?profile=<name>, the values inside that settings profile', {
    parameters: [{ name: 'profile', in: 'query', required: false, description: 'Describe the auth settings inside this profile (apiBase then ends in /p/<name>)', schema: { type: 'string' }, example: 'hmac' }],
    responses: { ...ok('Auth configuration', anyObj('profile, apiBase (where the mock APIs are), mode, apiKey, basic, bearer, jwt, hmac, s3 (S3 API endpoint, bucket, region and keys), oauth, clients, users')), ...AUTHED, ...NF },
  }));
  const keyFields = {
    tokenEndpointAuthMethod: { type: 'string', enum: ['client_secret_basic', 'client_secret_post', 'client_secret_jwt', 'private_key_jwt', 'tls_client_auth', 'self_signed_tls_client_auth'], description: 'Pin how the client authenticates. Unset = secret (Basic or form) or a signed assertion. private_key_jwt needs jwks or jwksUri; tls_client_auth needs tlsClientAuth; self_signed_tls_client_auth needs the certificate in jwks (both on the mTLS listener)' },
    tlsClientAuth: { type: ['object', 'null'], description: 'tls_client_auth (RFC 8705): the client certificate to expect. null removes it', properties: { type: { type: 'string', enum: ['subject_dn', 'san_dns', 'san_uri', 'san_ip', 'san_email'] }, value: { type: 'string' } } },
    jwks: { description: 'Public keys for private_key_jwt: a JWK Set, a JWK, or a PEM public key or certificate. Private key material is refused. "" removes them', anyOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
    jwksUri: { type: 'string', format: 'uri', description: 'Where to fetch the public keys instead (https; private addresses only with OAUTH_FETCH_PRIVATE). "" removes it' },
  };
  add(`${A}/oauth/clients`, 'post', op('Auth', 'createOAuthClient', 'Add an OAuth client (stored in the DB)', {
    requestBody: body(obj({ clientId: { type: 'string' }, secret: { type: 'string' }, scopes: { description: 'Space/comma-separated string or array', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, redirectUris: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, ...keyFields }), { clientId: 'fusion', secret: 's3cret', scopes: 'read write' }),
    responses: { ...created('Client created', S('OAuthClient')), ...BAD, ...AUTHED },
  }));
  add(`${A}/oauth/clients/{id}`, 'patch', op('Auth', 'updateOAuthClient', 'Edit a client: secret ("" = generate a new one), scopes, redirect URIs, grant types, name. Omitted fields are kept. Editing an env client stores a copy that overrides OAUTH_CLIENTS; deleting the copy reverts it.', {
    parameters: [pathParam('id', 'Client id')],
    requestBody: body(obj({ secret: { type: 'string' }, scopes: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, redirectUris: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, grantTypes: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string', enum: ['authorization_code', 'refresh_token', 'client_credentials'] } }] }, clientName: { type: 'string' }, ...keyFields }), { redirectUris: ['https://oauth.pstmn.io/v1/callback', 'http://localhost:8080/callback'] }),
    responses: { ...ok('Updated client', S('OAuthClient')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/clients/{id}`, 'delete', op('Auth', 'deleteOAuthClient', 'Delete a dashboard-added, edited or registered OAuth client (deleting an edited env client reverts it to OAUTH_CLIENTS)', {
    parameters: [pathParam('id', 'Client id')],
    responses: { ...noContent('Deleted'), ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/clients/{id}/keypair`, 'post', op('Auth', 'generateClientKeyPair', 'Generate a key pair for private_key_jwt. The public key joins the client\'s jwks and the client is pinned to private_key_jwt (use: false leaves the method alone). The private key is returned and kept, like a secret, so /auth/client-assertion can sign with it.', {
    parameters: [pathParam('id', 'Client id')],
    requestBody: body(obj({ alg: { type: 'string', enum: ['RS256', 'PS256', 'ES256', 'EdDSA'], default: 'RS256' }, use: { type: 'boolean', default: true } }), { alg: 'ES256' }, false),
    responses: { ...created('Key pair', obj({ kid: { type: 'string' }, alg: { type: 'string' }, publicJwk: { type: 'object', additionalProperties: true }, privateKeyPem: { type: 'string' } })), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/auth/client-assertion`, 'post', op('Auth', 'makeClientAssertion', 'A signed client_assertion (RFC 7523) for the token, introspection or revocation endpoint: private_key_jwt with the client\'s generated key, or client_secret_jwt (HS256 over its secret). Valid once, for lifetime seconds.', {
    requestBody: body(obj({ clientId: { type: 'string' }, method: { type: 'string', enum: ['private_key_jwt', 'client_secret_jwt'], description: 'Default: the client\'s pinned JWT method, else private_key_jwt when it has a generated key' }, audience: { type: 'string', description: 'Default <server>/oauth/token' }, lifetime: { type: 'integer', minimum: 30, maximum: 3600, default: 300 } }, ['clientId']), { clientId: 'demo-client', method: 'client_secret_jwt' }),
    responses: { ...ok('Assertion', anyObj('method, assertion, clientAssertionType, tokenEndpoint, decoded {header, payload}')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/client-metadata`, 'get', op('Auth', 'listClientMetadata', 'Client ID metadata documents (CIMD): whether URL client_ids are accepted (OAUTH_CIMD), the documents this server hosts at /oauth/client-metadata/<name>.json, and the URL client_ids seen recently (with the last fetch error)', {
    responses: { ...ok('CIMD state', obj({ enabled: { type: 'boolean' }, registration: { type: 'string' }, documents: { type: 'array', items: obj({ name: { type: 'string' }, builtIn: { type: 'boolean' }, url: { type: 'string', format: 'uri' }, document: { type: 'object', additionalProperties: true } }) }, seen: { type: 'array', items: { type: 'object', additionalProperties: true } } })), ...AUTHED },
  }));
  add(`${A}/oauth/client-metadata/{name}`, 'put', op('Auth', 'saveClientMetadata', 'Create or replace a hosted metadata document. Its client_id is always its own URL; token_endpoint_auth_method is none (default) or private_key_jwt (with jwks or jwks_uri). Saving the built-in "demo" stores an edited copy.', {
    parameters: [pathParam('name', 'Document name (lowercase letters, digits, hyphens); served as <name>.json')],
    requestBody: body({ type: 'object', additionalProperties: true, description: 'RFC 7591 client metadata: client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope, jwks / jwks_uri, client_uri, logo_uri' }, { client_name: 'My demo agent', redirect_uris: ['https://oauth.pstmn.io/v1/callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', scope: 'read' }),
    responses: { ...ok('Saved document', anyObj('name, builtIn, url, document')), ...BAD, ...AUTHED },
  }));
  add(`${A}/oauth/client-metadata/{name}`, 'delete', op('Auth', 'deleteClientMetadata', 'Delete a stored hosted document (an edited "demo" reverts to the built-in one)', {
    parameters: [pathParam('name', 'Document name')], responses: { ...noContent('Deleted'), ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/client-metadata-cache`, 'delete', op('Auth', 'clearClientMetadataCache', 'Forget the cached fetched metadata documents, so the next use of each URL client_id fetches it again', {
    responses: { ...noContent('Cleared'), ...AUTHED },
  }));
  // ---- mutual TLS
  const certId = pathParam('id', 'Certificate id (its serial number)');
  const certOut = anyObj('id, cn, subject, issuer, serialNumber, validFrom, validTo, subjectAltName, fingerprint256, x5t#S256, keyType, certPem (and keyPem when issued or fetched one by one)');
  add(`${A}/mtls`, 'get', op('mTLS', 'getMtls', 'The mTLS listener (enabled, listening, URL), the lab CA, the listener\'s certificate and the client certificates issued (without private keys)', {
    responses: { ...ok('mTLS state', anyObj('enabled, listening, port, url, customServerCert, trustedCas, allowedSubjects, ca {pem, subject, …}, server, certs')), ...AUTHED },
  }));
  add(`${A}/mtls/ca.pem`, 'get', op('mTLS', 'getLabCa', 'The lab CA certificate (PEM): trust it for the listener\'s certificate; it issues the client certificates', {
    responses: { 200: { description: 'PEM', content: { 'application/x-pem-file': { schema: { type: 'string' } } } }, ...AUTHED },
  }));
  add(`${A}/mtls/certs`, 'post', op('mTLS', 'issueClientCert', 'Issue a client certificate from the lab CA (key pair generated here). The reply includes certPem and keyPem.', {
    requestBody: body(obj({ cn: { type: 'string', maxLength: 64 }, o: { type: 'string' }, ou: { type: 'string' }, san: obj({ dns: { type: 'array', items: { type: 'string' } }, uri: { type: 'array', items: { type: 'string' } }, email: { type: 'array', items: { type: 'string' } }, ip: { type: 'array', items: { type: 'string' } } }), days: { type: 'integer', minimum: 1, maximum: 825, default: 365 }, keyType: { type: 'string', enum: ['ec', 'rsa'], default: 'ec' }, label: { type: 'string' } }, ['cn']), { cn: 'fusion-client', san: { uri: ['spiffe://lab/fusion'] } }),
    responses: { ...created('Issued certificate', certOut), ...BAD, ...AUTHED },
  }));
  add(`${A}/mtls/certs/{id}`, 'get', op('mTLS', 'getClientCert', 'One issued certificate, with its private key', { parameters: [certId], responses: { ...ok('Certificate', certOut), ...AUTHED, ...NF } }));
  add(`${A}/mtls/certs/{id}`, 'delete', op('mTLS', 'deleteClientCert', 'Forget an issued certificate (it stays valid until it expires: there is no revocation list)', { parameters: [certId], responses: { ...noContent('Deleted'), ...AUTHED, ...NF } }));
  add(`${A}/mtls/certs/{id}/cert.pem`, 'get', op('mTLS', 'downloadClientCert', 'The certificate (PEM)', { parameters: [certId], responses: { 200: { description: 'PEM', content: { 'application/x-pem-file': { schema: { type: 'string' } } } }, ...AUTHED, ...NF } }));
  add(`${A}/mtls/certs/{id}/key.pem`, 'get', op('mTLS', 'downloadClientKey', 'The private key (PKCS#8 PEM)', { parameters: [certId], responses: { 200: { description: 'PEM', content: { 'application/x-pem-file': { schema: { type: 'string' } } } }, ...AUTHED, ...NF } }));
  add(`${A}/mtls/certs/{id}/p12`, 'post', op('mTLS', 'downloadClientP12', 'Key, certificate and lab CA as a PKCS#12 (.p12) file protected by the password (AES-256, HMAC-SHA256)', {
    parameters: [certId], requestBody: body(obj({ password: { type: 'string', minLength: 4 } }, ['password']), { password: 'changeit' }),
    responses: { 200: { description: 'PKCS#12', content: { 'application/x-pkcs12': { schema: { type: 'string', format: 'binary' } } } }, ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/registered`, 'delete', op('Auth', 'deleteRegisteredClients', 'Delete the clients that registered themselves through /oauth/register (all of them, or with unused=true only those that never obtained a token)', {
    parameters: [{ name: 'unused', in: 'query', schema: { type: 'boolean' }, description: 'Only delete registrations that never obtained a token' }],
    responses: { ...ok('How many were deleted', obj({ deleted: { type: 'integer' } })), ...AUTHED },
  }));
  const userBody = { password: { type: 'string', description: 'Blank or omitted = generate one' }, roles: { description: 'Array, or a space/comma-separated string', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, attributes: { type: 'object', additionalProperties: true, description: 'Claim name → JSON value, added to the user\'s tokens. Reserved claims (iss, sub, aud, exp, scope, client_id, preferred_username, the roles claim\'s top level, …) are refused.' } };
  add(`${A}/oauth/users`, 'get', op('Auth', 'listOAuthUsers', 'Users for the authorization_code login page (OAUTH_USERS and dashboard-added), with roles and attributes', {
    responses: { ...ok('Users', obj({ items: { type: 'array', items: S('OAuthUser') }, rolesClaim: { type: 'string' } })), ...AUTHED },
  }));
  add(`${A}/oauth/users`, 'post', op('Auth', 'createOAuthUser', 'Add a user (stored in the DB). Its roles go to the OAUTH_ROLES_CLAIM paths and each attribute becomes a claim in its tokens.', {
    requestBody: body(obj({ username: { type: 'string', pattern: '^[A-Za-z0-9._@+-]{1,64}$' }, ...userBody }, ['username']), { username: 'alice', password: 'alice', roles: ['admin', 'buyer'], attributes: { region: 'EMEA', tier: 'gold', costCenters: [4100, 4200] } }),
    responses: { ...created('User created', S('OAuthUser')), ...BAD, ...AUTHED, 409: R('Problem') },
  }));
  add(`${A}/oauth/users/{username}`, 'patch', op('Auth', 'updateOAuthUser', 'Edit a user: password ("" = generate a new one), roles, attributes (replaced as a whole). Omitted fields are kept. Editing an env user stores a copy that overrides OAUTH_USERS; deleting the copy reverts it.', {
    parameters: [pathParam('username', 'Username')],
    requestBody: body(obj(userBody), { roles: ['viewer'], attributes: { region: 'APAC' } }),
    responses: { ...ok('Updated user', S('OAuthUser')), ...BAD, ...AUTHED, ...NF },
  }));
  add(`${A}/oauth/users/{username}`, 'delete', op('Auth', 'deleteOAuthUser', 'Delete a dashboard-added or edited user (deleting an edited env user reverts it to OAUTH_USERS)', {
    parameters: [pathParam('username', 'Username')],
    responses: { ...noContent('Deleted'), ...AUTHED, ...NF },
  }));
  add(`${A}/auth/test-token`, 'post', op('Auth', 'issueTestToken', 'Issue an access token for a client without a token request; returns it decoded. With username, the token carries that user\'s subject, roles and attributes, as the authorization_code flow would.', {
    requestBody: body(obj({ clientId: { type: 'string' }, scope: { type: 'string' }, username: { type: 'string' } }), { clientId: 'demo-client', scope: 'read write' }, false),
    responses: { ...ok('Token', anyObj('access_token, token_type, expires_in, scope, clientId, username, decoded {header, payload}')), ...BAD, ...AUTHED },
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
      { name: 'Profiles', description: 'Settings profiles: /p/<name>/… runs a request with the profile\'s auth mode, chaos, headers, rate limit and formats, so several setups can be used side by side' },
      { name: 'mTLS', description: 'Mutual TLS: the lab CA, client certificates (PEM and PKCS#12) and the mTLS listener (MTLS_ENABLED)' },
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
          status: { type: 'string', enum: ['ok', 'degraded'] }, version: { type: 'string' }, commit: { type: ['string', 'null'], description: 'Git commit the process runs (GIT_SHA build argument, else the checkout), or null' }, uptimeSeconds: { type: 'integer' }, time: { type: 'string', format: 'date-time' },
          baseUrl: { type: 'string' }, checks: anyObj('database and fileStore: driver, ok, latencyMs, error'), settings: anyObj('Active settings summary (no secrets)'), data: S('Counts'),
        }, ['status', 'version', 'checks']),
        Counts: obj({ employees: { type: 'integer' }, products: { type: 'integer' }, departments: { type: 'integer' }, categories: { type: 'integer' } }, undefined, { additionalProperties: { type: 'integer' } }),
        Overview: obj({
          version: { type: 'string' }, commit: { type: ['string', 'null'] }, baseUrl: { type: 'string' }, urls: { type: 'object', additionalProperties: { type: 'string' } }, authMode: { type: 'string' }, dateFormat: { type: 'string' },
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
        OAuthUser: obj({ username: { type: 'string' }, password: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, attributes: { type: 'object', additionalProperties: true }, source: { type: 'string', enum: ['env', 'dashboard'] }, overridesEnv: { type: 'boolean' } }, ['username'], { additionalProperties: true }),
        OAuthClient: obj({ clientId: { type: 'string' }, secret: { type: 'string' }, scopes: {}, redirectUris: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, ['clientId'], { additionalProperties: true }),
        ProfileInput: obj({
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Only when creating' }, description: { type: 'string', maxLength: 200 },
          settings: anyObj('Setting values by key (see GET /admin/api/profiles for the allowed keys); unset keys use the global value'),
        }),
        Profile: obj({
          name: { type: 'string' }, builtIn: { type: 'boolean' }, description: { type: 'string' }, settings: anyObj('The profile\'s values; every other setting is global'),
          url: { type: 'string', format: 'uri', description: 'Base URL of the mock APIs inside this profile' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        }, ['name', 'settings', 'url']),
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
