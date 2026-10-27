'use strict';
// Settings registry.
// Effective value = dashboard override (persisted in DB) ?? environment variable ?? built-in default.
// "Reset to env defaults" deletes overrides (one key, one section, or all).
// Inside a settings profile (services/profiles.js) the profile's values come first, for that request only.
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');

// type: string | int | number | bool | enum | json | headerList | requiredHeaders
const DEFS = [
  // ---- server (restart required) ----
  { key: 'port', env: 'PORT', def: 3000, type: 'int', section: 'server', restart: true, desc: 'HTTP port' },
  { key: 'publicBaseUrl', env: 'PUBLIC_BASE_URL', def: '', type: 'string', section: 'server', desc: 'Public base URL (blank = auto-detect)' },
  { key: 'adminPassword', env: 'ADMIN_PASSWORD', def: '', type: 'string', section: 'server', restart: true, secret: true, desc: 'Dashboard password (env only)' },
  { key: 'logLevel', env: 'LOG_LEVEL', def: 'info', type: 'enum', options: ['debug', 'info', 'warn', 'error'], section: 'server' },
  { key: 'corsOrigins', env: 'CORS_ORIGINS', def: '*', type: 'string', section: 'server', desc: 'Comma list of allowed origins, or *' },

  // ---- storage (restart required) ----
  { key: 'dbDriver', env: 'DB_DRIVER', def: 'sqlite', type: 'enum', options: ['sqlite', 'postgres'], section: 'storage', restart: true },
  { key: 'sqlitePath', env: 'SQLITE_PATH', def: './data/app.db', type: 'string', section: 'storage', restart: true },
  { key: 'databaseUrl', env: 'DATABASE_URL', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 'fileStore', env: 'FILE_STORE', def: 'local', type: 'enum', options: ['local', 's3'], section: 'storage', restart: true },
  { key: 'fileDir', env: 'FILE_DIR', def: './data/files', type: 'string', section: 'storage', restart: true },
  { key: 's3Bucket', env: 'S3_BUCKET', def: '', type: 'string', section: 'storage', restart: true },
  { key: 's3Region', env: 'S3_REGION', def: 'us-east-1', type: 'string', section: 'storage', restart: true },
  { key: 's3Endpoint', env: 'S3_ENDPOINT', def: '', type: 'string', section: 'storage', restart: true },
  { key: 's3AccessKeyId', env: 'S3_ACCESS_KEY_ID', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 's3SecretAccessKey', env: 'S3_SECRET_ACCESS_KEY', def: '', type: 'string', section: 'storage', restart: true, secret: true },
  { key: 's3ForcePathStyle', env: 'S3_FORCE_PATH_STYLE', def: false, type: 'bool', section: 'storage', restart: true },
  { key: 's3Prefix', env: 'S3_PREFIX', def: 'files/', type: 'string', section: 'storage', restart: true, desc: 'Object key prefix (lets several instances share a bucket)' },
  { key: 'maxFileSizeMb', env: 'MAX_FILE_SIZE_MB', def: 100, type: 'int', section: 'storage', min: 1 },

  // ---- seed ----
  { key: 'seedOnStart', env: 'SEED_ON_START', def: 'if-empty', type: 'enum', options: ['always', 'if-empty', 'never'], section: 'seed' },
  { key: 'seedEmployees', env: 'SEED_EMPLOYEES', def: 250, type: 'int', section: 'seed', min: 0 },
  { key: 'seedProducts', env: 'SEED_PRODUCTS', def: 500, type: 'int', section: 'seed', min: 0 },
  { key: 'seedRandomSeed', env: 'SEED_RANDOM_SEED', def: 42, type: 'int', section: 'seed' },
  { key: 'seedSampleFiles', env: 'SEED_SAMPLE_FILES', def: true, type: 'bool', section: 'seed' },

  // ---- dates ----
  { key: 'dateFormat', env: 'DATE_FORMAT', def: 'iso', type: 'enum', options: ['iso', 'iso-offset', 'epoch-s', 'epoch-ms', 'rfc1123', 'custom'], section: 'dates' },
  { key: 'dateFormatPattern', env: 'DATE_FORMAT_PATTERN', def: 'YYYY-MM-DD HH:mm:ss', type: 'string', section: 'dates', desc: 'dayjs tokens (custom only)' },
  { key: 'dateTzOffset', env: 'DATE_TZ_OFFSET', def: '+00:00', type: 'string', section: 'dates', pattern: /^[+-]\d{2}:\d{2}$/ },

  // ---- auth ----
  { key: 'authMode', env: 'AUTH_MODE', def: 'none', type: 'enum', options: ['none', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2', 'hmac', 'mtls'], section: 'auth' },
  { key: 'mtlsAllowedSubjects', env: 'MTLS_ALLOWED_SUBJECTS', def: '', type: 'string', section: 'auth', desc: 'AUTH_MODE=mtls: client certificates accepted, as a comma-separated list of common names or SAN values (DNS name, URI such as spiffe://lab/agent, email). Blank = any certificate issued by a trusted CA' },
  { key: 'apiKey', env: 'API_KEY', def: 'demo-key', type: 'string', section: 'auth', secret: true },
  { key: 'apiKeyName', env: 'API_KEY_NAME', def: 'X-API-Key', type: 'string', section: 'auth' },
  { key: 'apiKeyIn', env: 'API_KEY_IN', def: 'header', type: 'enum', options: ['header', 'query'], section: 'auth' },
  { key: 'basicUser', env: 'BASIC_USER', def: 'demo', type: 'string', section: 'auth' },
  { key: 'basicPass', env: 'BASIC_PASS', def: 'demo', type: 'string', section: 'auth', secret: true },
  { key: 'bearerToken', env: 'BEARER_TOKEN', def: 'demo-token', type: 'string', section: 'auth', secret: true },
  { key: 'jwtAlg', env: 'JWT_ALG', def: 'RS256', type: 'enum', options: ['RS256', 'HS256'], section: 'auth' },
  { key: 'jwtSecret', env: 'JWT_SECRET', def: '', type: 'string', section: 'auth', secret: true, desc: 'HS256 secret (blank = auto-generate + persist)' },
  { key: 'jwtIssuer', env: 'JWT_ISSUER', def: '', type: 'string', section: 'auth', desc: 'blank = public base URL' },
  { key: 'jwtAudience', env: 'JWT_AUDIENCE', def: 'api-test-tool', type: 'string', section: 'auth' },
  { key: 'hmacKeyId', env: 'HMAC_KEY_ID', def: 'demo', type: 'string', section: 'auth' },
  { key: 'hmacSecret', env: 'HMAC_SECRET', def: 'demo-hmac', type: 'string', section: 'auth', secret: true },
  { key: 'hmacMaxSkewSeconds', env: 'HMAC_MAX_SKEW_SECONDS', def: 300, type: 'int', section: 'auth', min: 1 },

  // ---- oauth ----
  { key: 'oauthClients', env: 'OAUTH_CLIENTS', def: 'demo-client:demo-secret:read write', type: 'string', section: 'oauth', desc: 'id:secret:scopes;… (dashboard-added clients are stored separately)' },
  { key: 'oauthUsers', env: 'OAUTH_USERS', def: 'demo:demo', type: 'string', section: 'oauth', desc: 'user:password[:roles[:attributes]];… for the authorization_code login page. Roles comma separated, attributes key=value comma separated (e.g. alice:pw:admin,buyer:region=EMEA,tier=gold). Users added on the Auth page are stored separately' },
  { key: 'oauthRolesClaim', env: 'OAUTH_ROLES_CLAIM', def: 'realm_access.roles', type: 'string', section: 'oauth', desc: 'Where a user\'s roles go in the token: dotted claim paths, comma separated (realm_access.roles = Keycloak style; e.g. realm_access.roles,roles for both)' },
  { key: 'oauthTokenTtl', env: 'OAUTH_TOKEN_TTL', def: 3600, type: 'int', section: 'oauth', min: 1 },
  { key: 'oauthRefreshTtl', env: 'OAUTH_REFRESH_TTL', def: 86400, type: 'int', section: 'oauth', min: 1 },
  { key: 'oauthRegistration', env: 'OAUTH_REGISTRATION', def: 'open', type: 'enum', options: ['off', 'open', 'token'], section: 'oauth', desc: 'Dynamic client registration (RFC 7591) at /oauth/register: open = anyone may register (MCP clients expect this), token = needs the initial access token below, off = no registration endpoint' },
  { key: 'oauthRegistrationToken', env: 'OAUTH_REGISTRATION_TOKEN', def: '', type: 'string', section: 'oauth', secret: true, desc: 'Initial access token for registration when OAUTH_REGISTRATION=token (sent as Authorization: Bearer …)' },
  { key: 'oauthRegistrationScopes', env: 'OAUTH_REGISTRATION_SCOPES', def: 'read write', type: 'string', section: 'oauth', desc: 'Scopes a registered client may ask for (space separated); a client that asks for none gets all of them' },
  { key: 'oauthRegistrationMax', env: 'OAUTH_REGISTRATION_MAX', def: 500, type: 'int', section: 'oauth', min: 1, max: 100000, desc: 'Most registered clients kept. At the limit the oldest never-used registration makes room; if every one has been used, registration is refused (delete some on the Auth page)' },
  { key: 'oauthRegistrationGrants', env: 'OAUTH_REGISTRATION_GRANTS', def: 'authorization_code refresh_token client_credentials', type: 'string', section: 'oauth', desc: 'Grant types an open registration may ask for (space separated). The default includes client_credentials, so machine clients can register themselves; that also lets anyone who finds /oauth/register mint tokens without a user signing in. Use authorization_code refresh_token to lock that down. With OAUTH_REGISTRATION=token every grant is allowed' },
  { key: 'oauthRegistrationRate', env: 'OAUTH_REGISTRATION_RATE', def: 20, type: 'int', section: 'oauth', min: 0, max: 100000, desc: 'Open registrations allowed per client IP per hour (0 = no limit); beyond it 429 with Retry-After' },
  { key: 'oauthRegistrationTtlDays', env: 'OAUTH_REGISTRATION_TTL_DAYS', def: 30, type: 'int', section: 'oauth', min: 0, max: 3650, desc: 'Registered clients that have not obtained a token for this many days are deleted (0 = keep forever)' },
  { key: 'mtlsEnabled', env: 'MTLS_ENABLED', def: false, type: 'bool', section: 'mtls', restart: true, desc: 'Run a second, TLS listener that asks for client certificates (mutual TLS). Needed for AUTH_MODE=mtls and for OAuth client certificate authentication and certificate-bound tokens (RFC 8705)' },
  { key: 'mtlsPort', env: 'MTLS_PORT', def: 8443, type: 'int', section: 'mtls', restart: true, desc: 'Port of the mTLS listener' },
  { key: 'mtlsPublicUrl', env: 'MTLS_PUBLIC_URL', def: '', type: 'string', section: 'mtls', desc: 'Public URL of the mTLS listener, for links and the OAuth metadata (blank = https://<public host>:<MTLS_PORT>)' },
  { key: 'mtlsCertFile', env: 'MTLS_CERT_FILE', def: '', type: 'string', section: 'mtls', restart: true, desc: 'PEM certificate (chain) the mTLS listener presents. Blank = one issued by the lab CA for the public host name and localhost (clients then trust the lab CA, or skip verification)' },
  { key: 'mtlsKeyFile', env: 'MTLS_KEY_FILE', def: '', type: 'string', section: 'mtls', restart: true, desc: 'PEM private key for MTLS_CERT_FILE' },
  { key: 'mtlsTrustedCas', env: 'MTLS_TRUSTED_CAS', def: '', type: 'string', section: 'mtls', restart: true, desc: 'More CA certificates (PEM, concatenated) whose client certificates are trusted, besides the lab CA, e.g. your platform\'s own CA' },
  { key: 'oauthCimd', env: 'OAUTH_CIMD', def: true, type: 'bool', section: 'oauth', desc: 'Accept client ID metadata documents (CIMD): a client may use an https URL as its client_id, and the server fetches its metadata (name, redirect URIs, auth method) from that URL instead of a registration. MCP clients use this. Turn dynamic registration off (OAUTH_REGISTRATION=off) to make sure a client really uses CIMD' },
  { key: 'oauthFetchPrivate', env: 'OAUTH_FETCH_PRIVATE', def: false, type: 'bool', section: 'oauth', desc: 'Let the OAuth server fetch client documents (a client\'s jwks_uri, CIMD client metadata) from private, loopback and link-local addresses and over plain http. Off on a public server, so a client cannot make it call your internal network' },

  // ---- chaos ----
  { key: 'errorRate', env: 'ERROR_RATE', def: 0, type: 'number', section: 'chaos', min: 0, max: 100 },
  { key: 'errorTypes', env: 'ERROR_TYPES', def: '500,503', type: 'string', section: 'chaos', desc: 'Comma list of status codes and/or type names' },
  { key: 'latencyMinMs', env: 'LATENCY_MIN_MS', def: 0, type: 'int', section: 'chaos', min: 0 },
  { key: 'latencyMaxMs', env: 'LATENCY_MAX_MS', def: 0, type: 'int', section: 'chaos', min: 0 },
  { key: 'chaosTimeoutSeconds', env: 'CHAOS_TIMEOUT_SECONDS', def: 0, type: 'int', section: 'chaos', min: 0, desc: '"timeout" hangs this long then drops the socket (0 = until client gives up, max 600)' },
  { key: 'chaosSlowDripMs', env: 'CHAOS_SLOW_DRIP_MS', def: 250, type: 'int', section: 'chaos', min: 1, desc: 'Delay between chunks for slow-drip' },
  { key: 'chaosRouteOverrides', env: 'CHAOS_ROUTE_OVERRIDES', def: [], type: 'json', section: 'chaos', desc: '[{path, method?, errorRate?, errorTypes?, latencyMinMs?, latencyMaxMs?}]' },

  // ---- rate limit ----
  { key: 'rateLimitRpm', env: 'RATE_LIMIT_RPM', def: 0, type: 'int', section: 'ratelimit', min: 0, desc: '0 = off' },

  // ---- headers ----
  { key: 'responseHeaders', env: 'RESPONSE_HEADERS', def: [], type: 'headerList', section: 'headers', desc: 'Name:Value;Name2:Value2' },
  { key: 'requiredHeaders', env: 'REQUIRED_HEADERS', def: [], type: 'requiredHeaders', section: 'headers', desc: 'Name,Name2=expected' },

  // ---- soap ----
  { key: 'soapEnabled', env: 'SOAP_ENABLED', def: true, type: 'bool', section: 'soap', desc: 'serve the mock SOAP services under /soap' },
  { key: 'soapWsse', env: 'SOAP_WSSE', def: 'off', type: 'enum', options: ['off', 'optional', 'required'], section: 'soap', desc: 'WS-Security UsernameToken (BASIC_USER / BASIC_PASS; PasswordText or PasswordDigest). Independent of AUTH_MODE' },
  { key: 'soapActionCheck', env: 'SOAP_ACTION_CHECK', def: 'lenient', type: 'enum', options: ['lenient', 'strict', 'off'], section: 'soap', desc: 'lenient: a wrong SOAPAction is a fault, a missing one is accepted; strict: it must be present and right; off: not checked' },

  // ---- websocket ----
  { key: 'wsEnabled', env: 'WS_ENABLED', def: true, type: 'bool', section: 'websocket', desc: 'serve the mock WebSocket channels under /ws (echo, rpc, changes)' },
  { key: 'wsMaxMessageKb', env: 'WS_MAX_MESSAGE_KB', def: 1024, type: 'int', section: 'websocket', min: 1, desc: 'Larger messages close the connection with 1009' },
  { key: 'wsIdleTimeoutSeconds', env: 'WS_IDLE_TIMEOUT_SECONDS', def: 0, type: 'int', section: 'websocket', min: 0, desc: 'Close connections that send nothing for this long (1001); 0 = never' },
  { key: 'wsPingIntervalSeconds', env: 'WS_PING_INTERVAL_SECONDS', def: 30, type: 'int', section: 'websocket', min: 0, desc: 'Server ping interval; a connection that misses a pong is dropped. 0 = no pings' },

  // ---- graphql ----
  { key: 'graphqlEnabled', env: 'GRAPHQL_ENABLED', def: true, type: 'bool', section: 'graphql', desc: 'serve the GraphQL mock at /graphql (queries, mutations, subscriptions over graphql-transport-ws)' },
  { key: 'graphqlIntrospection', env: 'GRAPHQL_INTROSPECTION', def: true, type: 'bool', section: 'graphql', desc: 'allow __schema / __type introspection queries (the SDL at /graphql/schema.graphql stays available)' },
  { key: 'graphqlMaxDepth', env: 'GRAPHQL_MAX_DEPTH', def: 10, type: 'int', section: 'graphql', min: 0, max: 100, desc: 'Reject operations nested deeper than this (introspection fields not counted); 0 = no limit' },

  // ---- odata ----
  { key: 'odataEnabled', env: 'ODATA_ENABLED', def: true, type: 'bool', section: 'odata', desc: 'serve the OData v4 service at /odata/v4 (Employees, Products, Departments, Categories)' },
  { key: 'odataMaxPageSize', env: 'ODATA_MAX_PAGE_SIZE', def: 100, type: 'int', section: 'odata', min: 1, max: 1000, desc: 'Server-driven page size: longer results get @odata.nextLink (clients can ask for less with Prefer: odata.maxpagesize)' },

  // ---- s3 api (an S3-compatible endpoint over the file pool; not the S3_* storage backend above) ----
  { key: 's3ApiEnabled', env: 'S3_API_ENABLED', def: true, type: 'bool', section: 's3api', desc: 'serve the file pool as an S3-compatible API at the base URL (path-style: <base>/<bucket>/<key>), signed with AWS Signature V4' },
  { key: 's3ApiBucket', env: 'S3_API_BUCKET', def: 'files', type: 'string', section: 's3api', pattern: /^(?!(v1|admin|dashboard|docs|soap|ws|sse|graphql|odata|llm|mcp|a2a|oauth|app|health|ready|metrics|samples|mock|problems|openapi\.json|openapi\.yaml)$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, desc: 'Bucket name clients use (3-63 lowercase letters, digits, dots, hyphens; not a path the tool already uses)' },
  { key: 's3ApiRegion', env: 'S3_API_REGION', def: 'us-east-1', type: 'string', section: 's3api', pattern: /^[a-z0-9-]{1,40}$/, desc: 'Region clients must sign with (e.g. us-east-1, eu-west-1, auto)' },
  { key: 's3ApiAccessKeyId', env: 'S3_API_ACCESS_KEY_ID', def: 'demo-access-key', type: 'string', section: 's3api', pattern: /^[A-Za-z0-9._-]{3,128}$/, desc: 'Access key ID clients sign with' },
  { key: 's3ApiSecretAccessKey', env: 'S3_API_SECRET_ACCESS_KEY', def: 'demo-secret-key', type: 'string', section: 's3api', secret: true, pattern: /^.{1,256}$/, desc: 'Secret access key clients sign with' },

  // ---- sse ----
  { key: 'sseEnabled', env: 'SSE_ENABLED', def: true, type: 'bool', section: 'sse', desc: 'serve the Server-Sent Events streams under /sse (changes, ticks, stream)' },
  { key: 'sseHeartbeatSeconds', env: 'SSE_HEARTBEAT_SECONDS', def: 15, type: 'int', section: 'sse', min: 0, desc: 'Comment line sent this often to keep idle streams open; 0 = off' },
  { key: 'sseRetryMs', env: 'SSE_RETRY_MS', def: 3000, type: 'int', section: 'sse', min: 0, desc: 'retry: value sent at the start of every stream (client reconnect delay)' },
  { key: 'sseReplayBuffer', env: 'SSE_REPLAY_BUFFER', def: 500, type: 'int', section: 'sse', min: 1, max: 100000, desc: 'Change events kept for Last-Event-ID resume on /sse/changes' },
  { key: 'sseTickIntervalMs', env: 'SSE_TICK_INTERVAL_MS', def: 1000, type: 'int', section: 'sse', min: 50, max: 60000, desc: 'Default interval of /sse/ticks (override with ?interval=)' },

  // ---- llm (OpenAI-compatible mock) ----
  { key: 'llmEnabled', env: 'LLM_ENABLED', def: true, type: 'bool', section: 'llm', desc: 'serve the OpenAI-compatible mock LLM at /llm/v1 (chat/completions, embeddings, models)' },
  { key: 'llmModels', env: 'LLM_MODELS', def: 'mock-chat-large,mock-chat-small,mock-reasoning,mock-embed-small', type: 'string', section: 'llm', desc: 'Comma list of model ids returned by /llm/v1/models' },
  { key: 'llmRequireKnownModel', env: 'LLM_REQUIRE_KNOWN_MODEL', def: false, type: 'bool', section: 'llm', desc: 'reject models not in LLM_MODELS with 404 model_not_found (off = any model name is accepted and echoed back)' },
  { key: 'llmCompletionTokensMin', env: 'LLM_COMPLETION_TOKENS_MIN', def: 20, type: 'int', section: 'llm', min: 1, max: 16384, desc: 'Fewest completion tokens in a random answer' },
  { key: 'llmCompletionTokensMax', env: 'LLM_COMPLETION_TOKENS_MAX', def: 300, type: 'int', section: 'llm', min: 1, max: 16384, desc: 'Most completion tokens in a random answer (max_tokens / max_completion_tokens cap it, with finish_reason "length")' },
  { key: 'llmStreamDelayMs', env: 'LLM_STREAM_DELAY_MS', def: 25, type: 'int', section: 'llm', min: 0, max: 5000, desc: 'Delay between streamed chunks (stream: true)' },
  { key: 'llmToolCallRate', env: 'LLM_TOOL_CALL_RATE', def: 50, type: 'int', section: 'llm', min: 0, max: 100, desc: 'Percent of requests with tools (tool_choice auto) answered with a tool call; required or a named tool always calls, none never does, and a reply to a tool result is always text' },

  // ---- mcp (mock MCP server) ----
  { key: 'mcpEnabled', env: 'MCP_ENABLED', def: true, type: 'bool', section: 'mcp', desc: 'serve the mock MCP server at /mcp (Streamable HTTP: protocol 2026-07-28, and 2025-11-25 / 2025-06-18 / 2025-03-26 clients that initialize)' },
  { key: 'mcpAllowWrites', env: 'MCP_ALLOW_WRITES', def: true, type: 'bool', section: 'mcp', desc: 'offer the create/update/delete tools (off = read-only tools; connected clients get notifications/tools/list_changed)' },
  { key: 'mcpResponseMode', env: 'MCP_RESPONSE_MODE', def: 'auto', type: 'enum', options: ['auto', 'json', 'sse'], section: 'mcp', desc: 'How requests are answered: auto = JSON, or an SSE stream when a tools/call carries a progressToken; json = always JSON; sse = always an SSE stream (when the client accepts it)' },
  { key: 'mcpValidateHeaders', env: 'MCP_VALIDATE_HEADERS', def: true, type: 'bool', section: 'mcp', desc: 'Check 2026-07-28 requests: MCP-Protocol-Version, Mcp-Method, Mcp-Name and Mcp-Param-* must be present and match the body (400, -32020 HeaderMismatch), and Accept must list application/json and text/event-stream' },
  { key: 'mcpLegacy', env: 'MCP_LEGACY', def: true, type: 'bool', section: 'mcp', desc: 'also serve clients that start with initialize (sessions with Mcp-Session-Id, GET stream, DELETE); off = 2026-07-28 only' },
  { key: 'mcpSessionTtlMinutes', env: 'MCP_SESSION_TTL_MINUTES', def: 30, type: 'int', section: 'mcp', min: 1, max: 1440, desc: 'Idle legacy sessions are forgotten after this long (the client then gets 404 and must initialize again)' },
  { key: 'mcpKeepAliveSeconds', env: 'MCP_KEEPALIVE_SECONDS', def: 15, type: 'int', section: 'mcp', min: 0, max: 3600, desc: 'Comment line sent this often on open notification streams (subscriptions/listen, legacy GET); 0 = off' },

  // ---- a2a (mock A2A agent) ----
  { key: 'a2aEnabled', env: 'A2A_ENABLED', def: true, type: 'bool', section: 'a2a', desc: 'serve the mock A2A agent at /a2a (Agent Card at /.well-known/agent-card.json) that answers questions about the mock data' },
  { key: 'a2aAllowWrites', env: 'A2A_ALLOW_WRITES', def: true, type: 'bool', section: 'a2a', desc: 'let the agent change data ("set employee 12 title to …", "delete product 9"); off = such requests are REJECTED' },
  { key: 'a2aLegacy', env: 'A2A_LEGACY', def: true, type: 'bool', section: 'a2a', desc: 'also speak A2A 0.3 (requests without an A2A-Version header, and /a2a/v0.3 with its own Agent Card); off = 1.0 only' },
  { key: 'a2aWorkMs', env: 'A2A_WORK_MS', def: 1200, type: 'int', section: 'a2a', min: 0, max: 60000, desc: 'How long a task takes from WORKING to COMPLETED (gives time to poll, subscribe or cancel)' },
  { key: 'a2aTaskRetention', env: 'A2A_TASK_RETENTION', def: 500, type: 'int', section: 'a2a', min: 10, max: 100000, desc: 'Finished tasks kept in memory for GetTask and ListTasks (lost on restart)' },

  // ---- webhooks ----
  { key: 'webhooksEnabled', env: 'WEBHOOKS_ENABLED', def: true, type: 'bool', section: 'webhooks', desc: 'send the outgoing webhooks defined on the Webhooks page (off = pause all deliveries; the definitions are kept)' },
  { key: 'webhookTimeoutMs', env: 'WEBHOOK_TIMEOUT_MS', def: 10000, type: 'int', section: 'webhooks', min: 100, max: 60000, desc: 'How long a delivery waits for the receiver before it is logged as failed' },
  { key: 'webhookDeliveryRetention', env: 'WEBHOOK_DELIVERY_RETENTION', def: 200, type: 'int', section: 'webhooks', min: 10, max: 10000, desc: 'Webhook deliveries kept in the log (all webhooks together)' },

  // ---- telemetry (/metrics and OpenTelemetry export) ----
  { key: 'metricsEnabled', env: 'METRICS_ENABLED', def: true, type: 'bool', section: 'telemetry', desc: 'serve request and process metrics in Prometheus text format at /metrics (off = 404). Fly.io, Prometheus, Grafana Agent/Alloy and most collectors can scrape it' },
  { key: 'metricsToken', env: 'METRICS_TOKEN', def: '', type: 'string', section: 'telemetry', secret: true, desc: '/metrics then needs Authorization: Bearer <token> (blank = open, like /health). Fly.io\'s built-in scraper cannot send a token' },
  { key: 'otelEndpoint', env: 'OTEL_EXPORTER_OTLP_ENDPOINT', def: '', type: 'string', section: 'telemetry', pattern: /^https?:\/\/\S+$/, desc: 'OTLP/HTTP base URL of an OpenTelemetry backend or collector; traces go to <endpoint>/v1/traces and metrics to <endpoint>/v1/metrics (e.g. https://otlp-gateway-prod-us-east-0.grafana.net/otlp, https://api.honeycomb.io, http://localhost:4318). Blank = no export' },
  { key: 'otelHeaders', env: 'OTEL_EXPORTER_OTLP_HEADERS', def: '', type: 'string', section: 'telemetry', secret: true, desc: 'Headers sent with every export, as key=value,key2=value2 (values percent-encoded, e.g. Authorization=Basic%20abc… or x-honeycomb-team=…)' },
  { key: 'otelProtocol', env: 'OTEL_EXPORTER_OTLP_PROTOCOL', def: 'http/protobuf', type: 'enum', options: ['http/protobuf', 'http/json'], section: 'telemetry', desc: 'OTLP/HTTP encoding: http/protobuf (the OpenTelemetry default; what every backend accepts) or http/json (readable, for debugging with a request catcher). gRPC is not built in: send to an OpenTelemetry Collector if a backend needs it' },
  { key: 'otelServiceName', env: 'OTEL_SERVICE_NAME', def: '', type: 'string', section: 'telemetry', desc: 'service.name on everything exported (blank = service.name from OTEL_RESOURCE_ATTRIBUTES, else api-test-tool). Give each deployment its own name to tell them apart' },
  { key: 'otelResourceAttributes', env: 'OTEL_RESOURCE_ATTRIBUTES', def: '', type: 'string', section: 'telemetry', desc: 'Extra resource attributes, key=value,key2=value2 (e.g. deployment.environment.name=lab,team=integration)' },
  { key: 'otelTracesExporter', env: 'OTEL_TRACES_EXPORTER', def: 'otlp', type: 'enum', options: ['otlp', 'none'], section: 'telemetry', desc: 'otlp = one span per API request (REST, SOAP, WebSocket upgrade, SSE, GraphQL, OData, LLM, MCP, A2A, S3, OAuth, the inspector catch-all), none = no traces' },
  { key: 'otelMetricsExporter', env: 'OTEL_METRICS_EXPORTER', def: 'otlp', type: 'enum', options: ['otlp', 'none'], section: 'telemetry', desc: 'otlp = push the /metrics measurements every OTEL_METRIC_EXPORT_INTERVAL, none = no metric export (/metrics still works)' },
  { key: 'otelLogsExporter', env: 'OTEL_LOGS_EXPORTER', def: 'otlp', type: 'enum', options: ['otlp', 'none'], section: 'telemetry', desc: 'otlp = send log records to <endpoint>/v1/logs: access logs (TELEMETRY_ACCESS_LOGS) and the tool\'s own log lines at LOG_LEVEL and above; none = no logs (e.g. for Jaeger, which takes traces only)' },
  { key: 'otelAccessLogs', env: 'TELEMETRY_ACCESS_LOGS', def: 'all', type: 'enum', options: ['all', 'errors', 'none'], section: 'telemetry', desc: 'Access-log records for API requests, each linked to its trace span: all, errors (4xx, 5xx and dropped connections only, to keep log ingest down) or none' },
  { key: 'otelTracesSampleRatio', env: 'OTEL_TRACES_SAMPLER_ARG', def: 1, type: 'number', section: 'telemetry', min: 0, max: 1, desc: 'Share of requests traced, 0-1 (parent-based: a request with a W3C traceparent header follows the caller\'s sampled flag)' },
  { key: 'otelMetricsTemporality', env: 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE', def: 'cumulative', type: 'enum', options: ['cumulative', 'delta', 'lowmemory'], section: 'telemetry', desc: 'How exported counters and histograms count: cumulative (totals since start; Prometheus-style backends such as Grafana Cloud) or delta (the change since the last export; what New Relic and Datadog prefer). lowmemory = delta for request and event counters, cumulative for CPU time. Up-down counters stay cumulative; /metrics is always cumulative' },
  { key: 'otelMetricExportIntervalMs', env: 'OTEL_METRIC_EXPORT_INTERVAL', def: 60000, type: 'int', section: 'telemetry', min: 1000, max: 3600000, desc: 'Milliseconds between metric exports' },

  // ---- inspector ----
  { key: 'inspectorRetention', env: 'INSPECTOR_RETENTION', def: 500, type: 'int', section: 'inspector', min: 1 },
  { key: 'inspectorLogAll', env: 'INSPECTOR_LOG_ALL', def: true, type: 'bool', section: 'inspector', desc: 'also record /v1/*, /soap/*, /ws/* (upgrades), /sse/*, /graphql, /odata/*, /llm/*, /mcp, /a2a/*, S3 API and /oauth/* calls (the dashboard, docs and health probes are never recorded)' },
  { key: 'inspectorResponseStatus', env: 'INSPECTOR_RESPONSE_STATUS', def: 200, type: 'int', section: 'inspector', min: 100, max: 599 },
  { key: 'inspectorResponseContentType', env: 'INSPECTOR_RESPONSE_CONTENT_TYPE', def: 'application/json', type: 'string', section: 'inspector' },
  { key: 'inspectorResponseBody', env: 'INSPECTOR_RESPONSE_BODY', def: '', type: 'string', section: 'inspector', desc: 'blank = JSON receipt with the capture id' },
  { key: 'inspectorResponseHeaders', env: 'INSPECTOR_RESPONSE_HEADERS', def: [], type: 'headerList', section: 'inspector' },
  { key: 'inspectorResponseDelayMs', env: 'INSPECTOR_RESPONSE_DELAY_MS', def: 0, type: 'int', section: 'inspector', min: 0 },
  { key: 'inspectorRules', env: 'INSPECTOR_RULES', def: [], type: 'json', section: 'inspector', desc: '[{method?, path, status, contentType?, body?, headers?, delayMs?}] first match wins' },
  { key: 'inspectorForwardEnabled', env: 'INSPECTOR_FORWARD_ENABLED', def: false, type: 'bool', section: 'inspector' },
  { key: 'inspectorForwardUrl', env: 'INSPECTOR_FORWARD_URL', def: '', type: 'string', section: 'inspector' },
];

const BY_KEY = Object.fromEntries(DEFS.map((d) => [d.key, d]));

function parseHeaderList(v) {
  if (Array.isArray(v)) return v.filter((h) => h && h.name).map((h) => ({ name: String(h.name).trim(), value: String(h.value ?? '') }));
  if (!v) return [];
  return String(v).split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf(':');
    return i === -1 ? { name: pair, value: '' } : { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  }).filter((h) => h.name);
}

function parseRequiredHeaders(v) {
  if (Array.isArray(v)) return v.filter((h) => h && h.name).map((h) => ({ name: String(h.name).trim(), value: h.value ? String(h.value) : undefined }));
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf('=');
    return i === -1 ? { name: item } : { name: item.slice(0, i).trim(), value: item.slice(i + 1).trim() };
  });
}

function coerce(def, raw) {
  if (raw === undefined || raw === null) return raw;
  switch (def.type) {
    case 'int':
    case 'number': {
      const n = def.type === 'int' ? parseInt(raw, 10) : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${def.key}: expected a number`);
      if (def.min !== undefined && n < def.min) throw new Error(`${def.key}: must be >= ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${def.key}: must be <= ${def.max}`);
      return n;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'enum':
      if (!def.options.includes(String(raw))) throw new Error(`${def.key}: must be one of ${def.options.join(', ')}`);
      return String(raw);
    case 'json':
      if (typeof raw === 'string') {
        if (!raw.trim()) return def.def;
        try { return JSON.parse(raw); } catch { throw new Error(`${def.key}: invalid JSON`); }
      }
      return raw;
    case 'headerList':
      return parseHeaderList(raw);
    case 'requiredHeaders':
      return parseRequiredHeaders(raw);
    default: {
      const s = String(raw);
      if (def.pattern && s && !def.pattern.test(s)) throw new Error(`${def.key}: invalid format`);
      return s;
    }
  }
}

class Settings extends EventEmitter {
  constructor(env = process.env) {
    super();
    this.env = env;
    this.overrides = {};
    this.repo = null;
    this.envValues = {};
    this.scope = new AsyncLocalStorage(); // { name, settings } of the profile the current request runs in
    for (const d of DEFS) {
      if (env[d.env] !== undefined && env[d.env] !== '') {
        try { this.envValues[d.key] = coerce(d, env[d.env]); } catch (e) {
          console.warn(`[settings] ignoring ${d.env}: ${e.message}`);
        }
      }
    }
  }

  // Attach the repo and load persisted overrides.
  async attach(repo) {
    this.repo = repo;
    const docs = await repo.list('settings');
    for (const doc of docs) {
      const d = BY_KEY[doc.key];
      if (!d || d.restart) continue;
      try { this.overrides[doc.key] = coerce(d, doc.value); } catch { /* skip invalid */ }
    }
  }

  get(key) {
    const profile = this.scope.getStore()?.settings;
    if (profile && key in profile) return profile[key];
    if (key in this.overrides) return this.overrides[key];
    if (key in this.envValues) return this.envValues[key];
    const d = BY_KEY[key];
    if (!d) throw new Error(`Unknown setting ${key}`);
    return typeof d.def === 'object' ? JSON.parse(JSON.stringify(d.def)) : d.def;
  }

  // Runs fn (and everything it awaits) with a profile's values on top of the global ones.
  runIn(store, fn) { return this.scope.run(store, fn); }

  // The profile the current request runs in, or null.
  profile() { return this.scope.getStore() || null; }

  source(key) {
    if (key in this.overrides) return 'override';
    if (key in this.envValues) return 'env';
    return 'default';
  }

  describe({ revealSecrets = true } = {}) {
    return DEFS.map((d) => ({
      key: d.key,
      env: d.env,
      section: d.section,
      type: d.type,
      options: d.options,
      description: d.desc || '',
      restartRequired: !!d.restart,
      secret: !!d.secret,
      value: d.secret && !revealSecrets ? (this.get(d.key) ? '********' : '') : this.get(d.key),
      envValue: d.secret && !revealSecrets ? undefined : this.envValues[d.key],
      default: d.def,
      source: this.source(d.key),
    }));
  }

  async set(key, value) {
    const d = BY_KEY[key];
    if (!d) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
    if (d.restart) throw Object.assign(new Error(`${key} requires a restart and can only be set via ${d.env}`), { status: 400 });
    let v;
    try { v = coerce(d, value); } catch (e) { throw Object.assign(e, { status: 400 }); }
    this.overrides[key] = v;
    if (this.repo) await this.repo.put('settings', key, { key, value: v });
    this.emit('change', { key, value: v });
    return v;
  }

  async setMany(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = await this.set(k, v);
    return out;
  }

  async reset({ key, section } = {}) {
    const keys = Object.keys(this.overrides).filter((k) => (key ? k === key : section ? BY_KEY[k].section === section : true));
    for (const k of keys) {
      delete this.overrides[k];
      if (this.repo) await this.repo.del('settings', k);
      this.emit('change', { key: k, value: this.get(k) });
    }
    return keys;
  }

  sections() {
    return [...new Set(DEFS.map((d) => d.section))];
  }
}

module.exports = { Settings, DEFS, BY_KEY, coerce, parseHeaderList, parseRequiredHeaders };
