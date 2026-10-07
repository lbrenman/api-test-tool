# API Test Tool

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/api-test-tool)
[![tests](https://github.com/lbrenman/api-test-tool/actions/workflows/newman.yml/badge.svg)](https://github.com/lbrenman/api-test-tool/actions/workflows/newman.yml)

One deployable app for testing an API platform or integration in both directions:

1. **Outgoing testing — a realistic mock target.** Your integration calls this tool. It serves seeded employees and products with every JSON type you need to parse, seven pagination styles side by side, error and latency injection, a shared file pool exposed over every common HTTP file protocol, seven auth modes with a built-in OAuth 2.0 server, custom and required headers, and a **webhook.site-style inspector** that captures anything sent to any other path.
2. **Incoming testing — a contract tester.** Load the OpenAPI spec you implemented (3.0, 3.1 or Swagger 2.0). The tool generates sample requests, calls your implementation through a server-side proxy, validates every response against the spec, and runs the whole contract with ID chaining and negative tests.

Contains:

* Admin web dashboard for configuring the server, re-seeding data, managing files, retrieving OpenAPI specs, inspecting incoming API calls and getting help with the system
* Operation web console to emulate a back office app for the business represted by the data, including full CRUD support of data via web forms
* OpenAPI Spec for use in your client application
* Postman collection for making calls to the server

Everything runs in one Node.js process on one port, with a vanilla-JS dashboard (no build step). It is host-agnostic: Codespaces, Docker, Fly.io, Render and Northflank are configured with environment variables.

Ues Cases:

* You need a reliable, free data source for an api demo
* You are trying to learn how to implement some API feature such as pagination or header introspection
* You need a free http file upload/download endpoint for a file based flow
* You need to experiment with advanced orchestration/aggregation functions such as data aggregation/join/deduplication and you need a data source
* You are debugging an http client call and need a web catcher to see what your platform is actually sending

---

## Contents

- [API Test Tool](#api-test-tool)
  - [Contents](#contents)
  - [Quick start](#quick-start)
    - [GitHub Codespaces (fastest)](#github-codespaces-fastest)
    - [Local](#local)
    - [Docker](#docker)
  - [Features](#features)
  - [Configuration](#configuration)
  - [Route map](#route-map)
  - [Authentication](#authentication)
  - [Mock API conventions](#mock-api-conventions)
  - [Pagination](#pagination)
  - [Chaos: errors and latency](#chaos-errors-and-latency)
  - [Files](#files)
  - [Inspector](#inspector)
  - [API tester walkthrough](#api-tester-walkthrough)
  - [Postman and Newman](#postman-and-newman)
  - [Deployment](#deployment)
    - [Fly.io](#flyio)
    - [Render](#render)
    - [Northflank](#northflank)
    - [Docker / any container host](#docker--any-container-host)
    - [Codespaces](#codespaces)
  - [Development](#development)
  - [Troubleshooting](#troubleshooting)
  - [License](#license)

---

## Quick start

### GitHub Codespaces (fastest)

Click the badge above. The devcontainer installs dependencies, starts the server, and makes port 3000 **public** so external systems (your API platform, webhooks, Postman) can reach it. The dashboard URL is printed in the terminal:

```
https://<codespace-name>-3000.app.github.dev/dashboard
```

Set an admin password before sharing the URL: put `ADMIN_PASSWORD=...` in `.env` (created from `.env.example` on first start) and restart with `pkill -f src/server.js; bash .devcontainer/start.sh`. Server logs are in `/tmp/api-test-tool.log`.

### Local

```bash
git clone https://github.com/lbrenman/api-test-tool && cd api-test-tool
npm install
cp .env.example .env      # optional
npm start                 # http://localhost:3000/dashboard
```

Requires Node.js 22+.

### Docker

```bash
docker build -t api-test-tool .
docker run -p 3000:3000 -v att-data:/data -e ADMIN_PASSWORD=change-me api-test-tool
```

Fly.io, Render and Northflank are covered in [Deployment](#deployment).

---

## Features

| Area | What you get |
|---|---|
| **Data** | 250 employees and 500 products (configurable) with int, float, decimal-as-string, boolean, null, enum, UUID, date-only, timestamps, string arrays, object arrays, nested and free-form objects, and unicode text (accents, emoji, quotes, CJK). Deterministic Faker seed; departments and categories keep relational integrity. |
| **CRUD conventions** | 201 + `Location`, PUT full replace, PATCH as JSON Merge Patch, 204 on delete, `ETag` / `If-Match` (412) / `If-None-Match` (304), `Idempotency-Key` replay and 409 on reuse, `X-Request-Id` / `X-Correlation-Id`, RFC 9457 `problem+json` errors, 400/422 validation with field errors. |
| **Query** | `?fields=a,b.c`, `?field=value`, `?field[gte]=…` (eq, ne, gt, gte, lt, lte, in, nin, like, exists), `?q=` text search, `?sort=-a,b`. |
| **Pagination** | offset, page, cursor, keyset, RFC 8288 `Link`, HAL, and Google-style `pageToken`, each on its own path and all available at once. |
| **Dates** | One global format for every timestamp: ISO UTC, ISO with offset, epoch seconds, epoch ms, RFC 1123, or a custom dayjs pattern. Any of them is accepted on input. |
| **Chaos** | Error rate %, error types (any 4xx/5xx, `timeout`, `reset`, `malformed-json`, `truncated-body`, `empty-body`, `wrong-content-type`, `slow-drip`), latency range, per-route overrides, and deterministic forcing headers. |
| **Rate limiting** | A real per-client limiter with `RateLimit-*` headers and 429 + `Retry-After`. |
| **Headers** | Custom headers added to every response, and required request headers (with optional expected values) enforced on `/v1/*`. |
| **Auth** | `none`, `apikey` (header or query), `basic`, `bearer`, `jwt` (HS256/RS256, JWKS), `oauth2` (scopes), `hmac` (signed requests). |
| **OAuth 2.0 server** | client_credentials, authorization_code + PKCE (login/consent page), refresh_token (rotating), introspection (RFC 7662), revocation (RFC 7009), RFC 8414 metadata, JWKS. |
| **Files** | One shared pool (local disk or S3-compatible) behind multipart, raw, base64-in-JSON, tus resumable, presigned URLs, range downloads (206) and chunked downloads. Sample CSV, XLSX, JSON, PNG, JPG, PDF, TXT, ZIP and a 10 MB binary are generated on seed. |
| **Inspector** | Catch-all capture with the actual path, live stream (SSE), detected auth (Basic user, decoded JWT, API keys), pretty bodies and multipart parts, copy as curl, replay, auto-forward, configurable responses and path rules. |
| **Generated OpenAPI** | Two OAS 3.1 specs, regenerated from the live settings. **Mock Data API** (`/openapi.json`, `/openapi.yaml`) is for integrations: `/v1` resources, every pagination path, the file endpoints and the OAuth token endpoint, reflecting the server URL, date format, auth scheme, required headers and chaos headers. **Admin API** (`/admin/api/openapi.json`, `.yaml`, password protected) is for operators and scripts: settings, seeding, files, OAuth clients, inspector, tester, `/health` and `/ready`. Swagger UI at `/docs` shows both (`/docs?spec=admin` for the admin spec). |
| **API tester** | Upload, paste or URL load for OAS 3.0, 3.1 and Swagger 2.0. Spec lint, per-operation "try it" with generated samples that honour `pattern`/`format`/`enum`/limits, auth profiles (none, API key, Basic, Bearer, OAuth2 client credentials), response validation, run-all contract mode with ID chaining and negative tests, run history, and JSON and HTML reports. "Mock from spec" serves a spec's examples from this tool. |
| **Back office app** | `/app` is a business-style app over the mock data, for demos and non-technical viewers: KPIs (headcount, payroll, stock value, stock health), charts, searchable and sortable lists, record pages with related records, and forms to create, edit and delete employees, products, departments and categories. It reads and writes the same data as `/v1` but through its own backend (`/admin/api/app/*`), so the `/v1` auth mode, chaos, rate limits and required headers never break it. Uses the dashboard password. |
| **Dashboard** | Overview, Settings (with source badges and resets), Data, Inspector, Files, Auth, Chaos, Headers, OpenAPI, API Tester, and About & Help (what each page does, quick starts, reserved paths, handy headers). Every page has a "? Help" link, and every main component has a **"?" guide** (hover, focus or tap) with numbered steps for using it in your integration or tests and copy-ready curl commands. The curls use the resolved base URL, the auth mode that is active right now (from `AUTH_MODE` or a dashboard override — the guides never change it), and any required request headers; in `jwt`/`oauth2` mode they fetch a token first, and in `hmac` mode they sign the request with `openssl`. The tester's **Try it → Request** tab adds "Copy as curl" for the exact call it sent. Responsive, with light and dark themes. |

---

## Configuration

Environment variables set the **defaults**. Changes made in the dashboard are saved in the database as **overrides** and take effect immediately, without a restart. **Reset to env defaults** removes overrides for one setting, one section, or everything. Every setting shows a source badge: `default`, `env` or `override`.

Settings marked **restart** can only be set through the environment.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | restart |
| `PUBLIC_BASE_URL` | auto | Auto-detect order: this value, then Codespaces (`CODESPACE_NAME` + `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`), then Fly (`FLY_APP_NAME`.fly.dev), then Render (`RENDER_EXTERNAL_URL`), then `X-Forwarded-*` headers. Used in `Location`, links, OpenAPI `servers` and presigned URLs. |
| `ADMIN_PASSWORD` | — | restart. Protects `/dashboard` and `/admin/api/*` with a session cookie, plus HTTP Basic (any username) for scripts. **Set it on any public deployment.** A warning is logged when it is empty. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CORS_ORIGINS` | `*` | Comma list of origins, or `*` |
| `DB_DRIVER` | `sqlite` | restart. `sqlite` or `postgres` |
| `SQLITE_PATH` | `./data/app.db` | restart |
| `DATABASE_URL` | — | restart. Postgres or Neon (SSL is enabled automatically for Neon and `sslmode=require`) |
| `FILE_STORE` | `local` | restart. `local` or `s3` |
| `FILE_DIR` | `./data/files` | restart |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | — | restart. Any S3-compatible service (AWS, R2, Tigris, MinIO) |
| `S3_PREFIX` | `files/` | restart. Object key prefix, so several instances can share a bucket |
| `MAX_FILE_SIZE_MB` | `100` | Enforced on every upload path (413 `problem+json`) |
| `SEED_ON_START` | `if-empty` | `always`, `if-empty`, `never` |
| `SEED_EMPLOYEES` / `SEED_PRODUCTS` | `250` / `500` | |
| `SEED_RANDOM_SEED` | `42` | The same seed always produces the same data |
| `SEED_SAMPLE_FILES` | `true` | Generate sample files on seed |
| `DATE_FORMAT` | `iso` | `iso`, `iso-offset`, `epoch-s`, `epoch-ms`, `rfc1123`, `custom` |
| `DATE_FORMAT_PATTERN` | `YYYY-MM-DD HH:mm:ss` | dayjs tokens, used by `custom` |
| `DATE_TZ_OFFSET` | `+00:00` | Used by `iso-offset` and `custom` |
| `AUTH_MODE` | `none` | `none`, `apikey`, `basic`, `bearer`, `jwt`, `oauth2`, `hmac` |
| `API_KEY`, `API_KEY_NAME`, `API_KEY_IN` | `demo-key`, `X-API-Key`, `header` | `API_KEY_IN` is `header` or `query` |
| `BASIC_USER` / `BASIC_PASS` | `demo` / `demo` | |
| `BEARER_TOKEN` | `demo-token` | |
| `JWT_ALG` | `RS256` | `RS256` or `HS256` |
| `JWT_SECRET` | generated | HS256 secret; generated once and stored if empty |
| `JWT_PRIVATE_KEY` | generated | RS256 PEM (`\n` escapes accepted); generated once and stored if empty. The public key is served at `/.well-known/jwks.json`. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | base URL / `api-test-tool` | |
| `HMAC_KEY_ID` / `HMAC_SECRET` | `demo` / `demo-hmac` | |
| `HMAC_MAX_SKEW_SECONDS` | `300` | |
| `OAUTH_CLIENTS` | `demo-client:demo-secret:read write` | `id:secret:scopes;…`. More clients can be added in the dashboard. |
| `OAUTH_USERS` | `demo:demo` | `user:password;…` for the authorization_code login page |
| `OAUTH_TOKEN_TTL` / `OAUTH_REFRESH_TTL` | `3600` / `86400` | seconds |
| `ERROR_RATE` | `0` | 0–100 % |
| `ERROR_TYPES` | `500,503` | See [Chaos](#chaos-errors-and-latency) |
| `LATENCY_MIN_MS` / `LATENCY_MAX_MS` | `0` / `0` | |
| `CHAOS_TIMEOUT_SECONDS` | `0` | How long `timeout` hangs before dropping the socket (0 = until the client gives up, max 600) |
| `CHAOS_SLOW_DRIP_MS` | `250` | Delay between `slow-drip` chunks |
| `CHAOS_ROUTE_OVERRIDES` | — | JSON, e.g. `[{"path":"/v1/products","errorRate":50,"errorTypes":"503,timeout"}]` |
| `RATE_LIMIT_RPM` | `0` (off) | Per client IP + credential |
| `RESPONSE_HEADERS` | — | `Name:Value;Name2:Value2`, added to every response |
| `REQUIRED_HEADERS` | — | `Name,Name2=expected`. 400 on `/v1/*` when missing or wrong |
| `INSPECTOR_RETENTION` | `500` | Captures kept |
| `INSPECTOR_LOG_ALL` | `true` | Also record `/v1/*` and `/oauth/*` calls (with their real responses). Toggle on the Inspector page. |
| `INSPECTOR_RESPONSE_STATUS`, `…_CONTENT_TYPE`, `…_BODY`, `…_HEADERS`, `…_DELAY_MS` | `200`, `application/json`, receipt, —, `0` | Default catch-all response |
| `INSPECTOR_RULES` | — | JSON path rules (first match wins) |
| `INSPECTOR_FORWARD_ENABLED` / `INSPECTOR_FORWARD_URL` | `false` / — | Auto-forward captures |

`.env.example` documents every variable. `src/server.js` loads `.env` when present, and real environment variables win.

---

## Route map

These prefixes are reserved: `/v1`, `/oauth`, `/.well-known`, `/admin`, `/dashboard`, `/app`, `/docs`, `/openapi.json`, `/openapi.yaml`, `/samples`, `/health`, `/ready`, and `GET /` (which redirects to the dashboard). **Every other path, and every method, is captured by the inspector.** Calls to `/v1` and `/oauth` are recorded there too (unless `INSPECTOR_LOG_ALL=false`); the dashboard, admin API, docs and health probes never are.

| Path | Purpose |
|---|---|
| `GET /health` | Liveness, version, uptime, DB and file-store checks, settings summary (no secrets), data counts |
| `GET /ready` | Readiness |
| `GET /openapi.json`, `GET /openapi.yaml` | Live OpenAPI 3.1 for the **mock data API** (`/v1`, `/oauth/token`). Import this into integrations. |
| `GET /admin/api/openapi.json`, `GET /admin/api/openapi.yaml` | Live OpenAPI 3.1 for the **admin API** (`/admin/api/*`, `/health`, `/ready`). Password protected. |
| `GET /docs` | Swagger UI with a tab per spec: mock data API (OAuth2 + PKCE pre-configured for `demo-client`) and admin API (`?spec=admin`, needs dashboard sign-in) |
| `/v1/employees`, `/v1/products`, `/v1/departments`, `/v1/categories` | Full CRUD (`/{id}` for items); lists use offset pagination |
| `GET /v1/departments/{id}/employees`, `GET /v1/categories/{id}/products` | Nested collections |
| `GET /v1/p/{scheme}/{resource}` | Pagination variants: `offset`, `page`, `cursor`, `keyset`, `link`, `hal`, `token` |
| `/v1/files/…` | File protocols (see [Files](#files)) |
| `/oauth/token`, `/oauth/authorize`, `/oauth/introspect`, `/oauth/revoke` | OAuth 2.0 server |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Discovery and JWKS |
| `/samples/*` | Bundled specs (handy for the tester's URL loader) |
| `/dashboard`, `/admin/api/*` | Dashboard and its API (password protected; described by `/admin/api/openapi.json`) |
| `/admin/api/tester/*` | API tester backend |
| `/app/` | Back office app (business view of the mock data; dashboard password) |
| `/admin/api/app/*` | Back office app backend: KPIs, lookups, record search and CRUD |
| anything else | Inspector catch-all |

---

## Authentication

Auth is global and applies to `/v1/*`. Health, docs, the mock data API spec (`/openapi.json`), OAuth and well-known endpoints are always open; the admin API and its spec use the dashboard password instead. Change the mode with `AUTH_MODE` or on the dashboard's **Auth** page. The change takes effect immediately, and `/openapi.json` updates its `securitySchemes` to match.

Below, `B` is your base URL, for example `B=http://localhost:3000`.

**none**

```bash
curl -s "$B/v1/employees?limit=2"
```

**apikey** (`API_KEY_IN=header` or `query`)

```bash
curl -s "$B/v1/employees?limit=2" -H 'X-API-Key: demo-key'
curl -s "$B/v1/employees?limit=2&api_key=demo-key"     # with API_KEY_IN=query, API_KEY_NAME=api_key
```

**basic**

```bash
curl -s -u demo:demo "$B/v1/employees?limit=2"
```

**bearer** (static token)

```bash
curl -s "$B/v1/employees?limit=2" -H 'Authorization: Bearer demo-token'
```

**jwt** and **oauth2**: get a token from the built-in server. Under `jwt`, any valid token from the server is accepted (iss/aud/exp are checked). Under `oauth2`, scopes are also enforced: `read` for GET, and `write` for POST, PUT, PATCH and DELETE (403 `insufficient_scope` otherwise).

```bash
TOKEN=$(curl -s -u demo-client:demo-secret -d grant_type=client_credentials -d 'scope=read write' \
  "$B/oauth/token" | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -s "$B/v1/employees?limit=2" -H "Authorization: Bearer $TOKEN"
```

Other OAuth calls:

```bash
# client auth in the body instead of Basic
curl -s -d grant_type=client_credentials -d client_id=demo-client -d client_secret=demo-secret "$B/oauth/token"
# introspection (RFC 7662) and revocation (RFC 7009)
curl -s -u demo-client:demo-secret -d "token=$TOKEN" "$B/oauth/introspect"
curl -s -u demo-client:demo-secret -d "token=$TOKEN" "$B/oauth/revoke"
```

**authorization_code + PKCE**: open `$B/oauth/authorize?response_type=code&client_id=demo-client&redirect_uri=https://oauth.pstmn.io/v1/callback&scope=read&state=xyz&code_challenge=<S256>&code_challenge_method=S256`, sign in as `demo` / `demo`, then exchange the code at `/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri` and `code_verifier`. The response includes a `refresh_token`, which rotates on every use. Swagger UI at `/docs` runs this whole flow for you.

**hmac**

```
Authorization: HMAC <keyId>:<base64(HMAC-SHA256(secret, canonical))>
X-Timestamp: <epoch seconds or an HTTP-date>      (a Date header also works)

canonical = METHOD + "\n" + PATH_WITH_QUERY + "\n" + X-Timestamp + "\n" + hex(SHA-256(body))
```

- `PATH_WITH_QUERY` is exactly what goes on the request line, for example `/v1/employees?limit=2`.
- For a request without a body, hash the empty string (`e3b0c442…b855`).
- For the streamed upload endpoints (`/v1/files/*` other than `base64` and `presign`), use the literal `UNSIGNED-PAYLOAD` instead of the hash.
- The timestamp must be within `HMAC_MAX_SKEW_SECONDS`.
- On a mismatch, the 401 `problem+json` includes the server's canonical string so you can diff it.

Node example:

```js
const crypto = require('node:crypto');
const B = 'http://localhost:3000';
const body = JSON.stringify({ name: 'Signed', code: 'SGN' });
const path = '/v1/departments';
const ts = String(Math.floor(Date.now() / 1000));
const hash = crypto.createHash('sha256').update(body).digest('hex');
const sig = crypto.createHmac('sha256', 'demo-hmac').update(['POST', path, ts, hash].join('\n')).digest('base64');
const res = await fetch(B + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `HMAC demo:${sig}`, 'X-Timestamp': ts },
  body,
});
console.log(res.status, await res.json());
```

Postman pre-request script:

```js
const sdk = require('postman-collection');
const url = new sdk.Url(pm.variables.replaceIn(pm.request.url.toString()));
const ts = String(Math.floor(Date.now() / 1000));
const raw = pm.request.body && pm.request.body.raw ? pm.variables.replaceIn(pm.request.body.raw) : '';
const hash = CryptoJS.SHA256(CryptoJS.enc.Utf8.parse(raw)).toString(CryptoJS.enc.Hex);
const canonical = [pm.request.method, url.getPathWithQuery(), ts, hash].join('\n');
const sig = CryptoJS.HmacSHA256(canonical, pm.environment.get('hmacSecret')).toString(CryptoJS.enc.Base64);
pm.request.headers.upsert({ key: 'Authorization', value: `HMAC ${pm.environment.get('hmacKeyId')}:${sig}` });
pm.request.headers.upsert({ key: 'X-Timestamp', value: ts });
```

The dashboard's **Auth** page has a "Get a test token" button, an OAuth client manager, and an HMAC signer that produces a ready-to-run curl.

---

## Mock API conventions

```bash
# create -> 201, Location, ETag
curl -si -X POST "$B/v1/employees" -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","departmentId":1}'

# conditional GET -> 304
curl -si "$B/v1/employees/1" -H 'If-None-Match: "<etag>"'

# JSON Merge Patch with optimistic concurrency (412 if the ETag is stale)
curl -si -X PATCH "$B/v1/employees/1" -H 'Content-Type: application/merge-patch+json' \
  -H 'If-Match: "<etag>"' -d '{"title":"Engineer","performanceRating":null}'

# idempotent POST: replays return the stored response with Idempotent-Replayed: true; another body -> 409
curl -si -X POST "$B/v1/departments" -H 'Idempotency-Key: 7d1c…' -H 'Content-Type: application/json' -d '{"name":"R&D","code":"RND"}'

# query features
curl -s "$B/v1/employees?fields=id,firstName,department.name&sort=-salary&level=L5,L6&limit=5"
curl -s "$B/v1/products?price[gte]=10&price[lt]=50&inStock=true&q=café"
```

Errors are RFC 9457 `application/problem+json`:

```json
{
  "type": "https://<base>/problems/validation-failed",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "employee failed validation",
  "instance": "/v1/employees",
  "requestId": "5f754b61-…",
  "timestamp": "2026-01-15T14:30:00.000Z",
  "code": "validation-failed",
  "errors": [{ "field": "email", "message": "must match format \"email\"" }]
}
```

---

## Pagination

Every scheme has its own path, so all of them can be tested side by side. Each one supports the same filters, sort and `fields`.

| Path | Request | Response |
|---|---|---|
| `/v1/p/offset/employees` (also `/v1/employees`) | `?offset=0&limit=25` | `{data, meta:{offset, limit, total}}` |
| `/v1/p/page/employees` | `?page=1&size=25` | `{data, meta:{page, size, totalPages, totalItems}}` |
| `/v1/p/cursor/employees` | `?cursor=&limit=25` | `{data, nextCursor, prevCursor}` (opaque, `null` at the ends) |
| `/v1/p/keyset/employees` | `?after_id=0&limit=25` or `?before_id=100` | `{data, hasMore, firstId, lastId}` (always ordered by id) |
| `/v1/p/link/employees` | `?page=1&per_page=25` | Bare array, plus RFC 8288 `Link` (`first`, `prev`, `next`, `last`) and `X-Total-Count` |
| `/v1/p/hal/employees` | `?page=1&size=25` | `application/hal+json` with `_embedded`, `_links` (`self`, `first`, `prev`, `next`, `last`) and `page` |
| `/v1/p/token/employees` | `?pageToken=&pageSize=25` | `{items, nextPageToken}` (`null` on the last page) |

`limit`, `size`, `per_page` and `pageSize` accept 1–200 (default 25). The same paths exist for `products`, `departments` and `categories`.

---

## Chaos: errors and latency

Chaos applies to `/v1/*`. It can be random (`ERROR_RATE`, `ERROR_TYPES`, `LATENCY_MIN_MS`/`LATENCY_MAX_MS`, plus per-route overrides) or forced per request with headers. **Forcing headers always win over the random settings.**

| Header | Effect |
|---|---|
| `X-Force-Error: 503` | `problem+json` with that status (any 4xx/5xx; 429 and 503 add `Retry-After: 5`) |
| `X-Force-Error: timeout` | Hang (`CHAOS_TIMEOUT_SECONDS`, or until the client gives up) |
| `X-Force-Error: reset` | Destroy the socket |
| `X-Force-Error: malformed-json` | Real response, broken JSON |
| `X-Force-Error: truncated-body` | Correct `Content-Length`, half the body, then the socket drops |
| `X-Force-Error: empty-body` | 200 with an empty body |
| `X-Force-Error: wrong-content-type` | Real body sent as `text/html` |
| `X-Force-Error: slow-drip` | Body streamed in 20 chunks, `CHAOS_SLOW_DRIP_MS` apart |
| `X-Force-Status: 202` | Override the status of the real response (≥ 400 returns a problem) |
| `X-Force-Latency: 2000` | Add latency in ms (max 120000) |

Injected responses carry `X-Chaos-Injected: <type>` (except `reset`). The body-corruption types act on JSON responses, not on streamed file downloads.

```bash
curl -si "$B/v1/employees/1" -H 'X-Force-Error: 503'
curl -s  "$B/v1/employees/1" -H 'X-Force-Error: malformed-json'
curl -s -o /dev/null -w '%{time_total}\n' "$B/v1/employees/1" -H 'X-Force-Latency: 1500'
```

---

## Files

All protocols read from and write to **one pool**, local disk or S3. A file uploaded with tus can be downloaded by range, presigned, or fetched as base64.

| Path | Protocol |
|---|---|
| `GET /v1/files`, `GET /v1/files/{id}`, `DELETE /v1/files/{id}` | List, metadata, delete |
| `POST /v1/files/multipart` | `multipart/form-data`: several files plus extra fields |
| `PUT /v1/files/raw/{name}`, `POST /v1/files/raw` | Raw body; the name comes from the path, `Content-Disposition`, `X-Filename` or `?name=` |
| `POST /v1/files/base64`, `GET /v1/files/{id}/base64` | Base64 in JSON (`data` may also be a `data:` URL) |
| `/v1/files/tus` | tus 1.0.0: creation, creation-with-upload, termination. `X-File-Id` appears once the upload completes. |
| `POST /v1/files/presign` | Presigned `PUT` (upload) or `GET` (download). Real S3 URLs with `FILE_STORE=s3`; HMAC-signed expiring URLs of the same shape with local storage. |
| `GET /v1/files/{id}/download` | Streaming, `Range` → 206 / 416, `ETag`, `Last-Modified`, `Accept-Ranges`, `Content-Disposition` (`?inline=true`) |
| `GET /v1/files/{id}/chunked` | `Transfer-Encoding: chunked` (no `Content-Length`) |

Generated samples have stable ids: `sample-employees-csv`, `sample-products-csv`, `sample-data-xlsx`, `sample-data-json`, `sample-image-png`, `sample-image-jpg`, `sample-report-pdf`, `sample-readme-txt`, `sample-bundle-zip` (the others zipped), and `sample-large-bin` (10 MB, deterministic, for range tests).

```bash
curl -s -F file=@report.pdf -F description=Q3 "$B/v1/files/multipart"
curl -s -X PUT --data-binary @photo.jpg -H 'Content-Type: image/jpeg' "$B/v1/files/raw/photo.jpg"
curl -s "$B/v1/files/base64" -H 'Content-Type: application/json' -d '{"name":"hi.txt","data":"aGVsbG8="}'
curl -s -r 0-1023 -o part.bin -w '%{http_code}\n' "$B/v1/files/sample-large-bin/download"

# presigned round trip
P=$(curl -s "$B/v1/files/presign" -H 'Content-Type: application/json' -d '{"method":"PUT","name":"up.txt","contentType":"text/plain"}')
curl -s -X PUT -H 'Content-Type: text/plain' --data 'hello' "$(echo "$P" | sed -E 's/.*"url":"([^"]+)".*/\1/')"

# tus
LOC=$(curl -si -X POST "$B/v1/files/tus" -H 'Tus-Resumable: 1.0.0' -H 'Upload-Length: 11' | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r')
curl -si -X PATCH "$LOC" -H 'Tus-Resumable: 1.0.0' -H 'Upload-Offset: 0' -H 'Content-Type: application/offset+octet-stream' --data-binary 'hello world'
```

---

## Inspector

Send anything to any non-reserved path and it shows up live on the dashboard's **Inspector** page with:

- the actual path, method and query;
- all headers, the client IP, and the body (pretty JSON, form fields, XML or text, multipart parts with file downloads, or hex for binary);
- detected auth: Basic username, decoded JWT header and claims, API-key headers and query parameters;
- the response that was sent and the duration.

```bash
curl -s -X POST "$B/hooks/order-created?env=dev" -H 'Content-Type: application/json' -d '{"orderId":42}'
# {"status":"captured","id":"…","method":"POST","path":"/hooks/order-created",…}
```

- **Default response:** status, content type, body, headers and delay (`INSPECTOR_RESPONSE_*`).
- **Path rules** (first match wins) support `*`, `**`, `{param}` and templates. For example:

  ```json
  [{ "method": "POST", "path": "/hooks/{name}", "status": 202,
     "body": { "ok": true, "hook": "{{params.name}}", "id": "{{uuid}}" },
     "headers": [{ "name": "X-Hook", "value": "{{params.name}}" }], "delayMs": 0 }]
  ```

  Available templates: `{{uuid}}`, `{{now}}`, `{{nowEpoch}}`, `{{id}}`, `{{path}}`, `{{method}}`, `{{params.x}}`, `{{query.x}}`, `{{body.x}}`, `{{baseUrl}}`.
- **Detail pane:** copy as curl, replay (to this server or any URL), and auto-forward every capture to a target URL (the original path is appended).
- **Housekeeping:** export JSON, clear. The last `INSPECTOR_RETENTION` captures are kept.
- **API traffic:** `/v1/*` and `/oauth/*` calls are recorded with their real responses, including requests rejected early (bad JSON, missing headers, auth, rate limit) and connections dropped by chaos (shown as *dropped*). Filter by source (webhooks / mock API / OAuth) or switch it off with **Record /v1 & /oauth** (`INSPECTOR_LOG_ALL`). Streamed file uploads show their size only.

---

## API tester walkthrough

This walkthrough uses the bundled Supplier Order Collaboration spec (`samples/Supplier_Order_Collaboration_OpenAPI_3_1.yaml`).

1. **Load it.** Open **API Tester** and click **Load** next to the sample. You can also upload a file, paste YAML/JSON, or use **Load via URL** (which goes through `/samples/...`). Swagger 2.0 files are converted to OAS 3.0 automatically; try the bundled `Inventory_Swagger_2_0.yaml`.
2. **Read the Spec lint tab.** For this sample it reports:
   - **error `allof-additional-properties`:** `Shipment` is `allOf: [CreateShipmentRequest, {shipmentId, status, …}]`, and `CreateShipmentRequest` has `additionalProperties: false`. Under JSON Schema rules every valid Shipment fails validation, because `shipmentId`, `status` and the rest are "additional" to the first member. The fix is to remove `additionalProperties: false` from `CreateShipmentRequest` and put `unevaluatedProperties: false` on `Shipment` (OAS 3.1).
   - warnings for the placeholder servers and token URL (`example.invalid`);
   - warnings for examples that fail their own schemas (the shipment examples, which follow from the issue above);
   - info that `Idempotency-Key` is required on both POSTs (the tester sends a fresh UUID every time).
3. **Set the target** on the **Target** tab:
   - a base URL override (your implementation's endpoint, for example);
   - an auth profile from the spec's `securitySchemes`: API key (`X-API-Key`), or OAuth2 client credentials with an overridable token URL, client id/secret, scopes and Basic or body client auth. **Test token request** shows the full token exchange. Tokens are cached until they expire.
   - default headers, a timeout, and the **Lenient allOf** toggle.
4. **Try it.** Pick an operation. The form is pre-filled from named examples, then schema examples, then generated values that honour `pattern` (`^PO-[0-9]{10}$`, `^SHP-[0-9]{8}-[0-9]{5}$`, …), `format`, `enum`, limits and nullability. Switch between named examples, edit path, query, header and body values, or pick files from the pool for multipart and binary bodies. Requests go through the server-side proxy, so CORS never applies. You see the full request, the response, the token exchange, and every check:
   - the status code is documented;
   - the `Content-Type` matches;
   - declared headers such as `Location` (on 201) and `ETag` are present;
   - the body matches the schema. Errors show the JSON pointer, a plain-English message, and a hint when the allOf trap is the cause.
5. **Run all.** Operations run in this order: collection POSTs (creates), then collection GETs (lists, which also harvest ids), then item operations, then DELETEs. IDs from `Location` headers and response bodies (`id`, `*Id`) are fed into later path parameters, and you can override any variable. Optional negative tests check that a request without auth gets 401, a missing required field gets 400 or 422, and an unknown id gets 404. Runs are saved in **History** and can be exported as JSON or as a standalone HTML report.
6. **No implementation yet?** Click **Install mock & use as target**. The spec's 2xx examples are served from this tool under `/mock/<spec-name>/…` through inspector rules, including generated `Location` and `ETag` headers. Run all with Lenient allOf off and the shipment responses fail with `additionalProperties` errors; turn it on and they pass. That is the allOf issue in action.

**Load "This tool (live /openapi.json)"** to point the tester at the mock API itself. Set the auth profile to the OAuth2 client credentials scheme with `demo-client` / `demo-secret` and a full contract run passes, including the negative tests.

---

## Postman and Newman

- `postman/API-Test-Tool.postman_collection.json` has 71 requests with test scripts, covering:
  - health, OpenAPI and discovery;
  - OAuth: token, introspect, revoke, error cases;
  - each auth mode (with and without credentials);
  - CRUD with `Location`, `ETag`, `If-Match` and `Idempotency-Key`;
  - fields, filters and sort;
  - every pagination scheme, each request looping on itself to **follow the next link to the end** and assert that every item was seen exactly once;
  - every chaos forcing header;
  - every file protocol (multipart, raw, base64, presign round trip, range, chunked, tus);
  - headers and the inspector.
- `postman/API-Test-Tool.postman_environment.json` holds `baseUrl`, `authMode` and credentials. Set `authMode` to the server's `AUTH_MODE`; the collection-level pre-request script then authenticates every `/v1` call, fetching and caching an OAuth token for `jwt` and `oauth2` and signing requests for `hmac`.
- `npm run postman` boots a fresh server for each auth mode and runs Newman against it. `npm run postman -- --mode hmac` runs one mode, and `npm run postman -- --url https://your-app.fly.dev --mode none` runs against a deployed instance.
- `.github/workflows/newman.yml` runs `npm test` and then a Newman matrix over all seven auth modes (SQLite + local files) on every push.
- The collection is generated by `scripts/build-postman.js`. Edit that file and run `npm run postman:build`.

---

## Deployment

### Fly.io

```bash
fly launch --no-deploy --copy-config --name my-api-test-tool
fly volumes create att_data --size 1 --region bos
fly secrets set ADMIN_PASSWORD='something-long'
fly deploy
```

`fly.toml` mounts `/data` for SQLite and the file pool, and health-checks `/health`. `PUBLIC_BASE_URL` is detected from `FLY_APP_NAME`. For S3 storage on Fly, `fly storage create` (Tigris) gives you the `S3_*` values.

### Render

`render.yaml` deploys the Dockerfile. Render's free plan has no persistent disk, so either:

- use `DB_DRIVER=postgres` with a Neon `DATABASE_URL`, plus `FILE_STORE=s3` with any S3-compatible bucket (the blueprint defaults to this), **or**
- switch to a paid plan, uncomment the `disk` block, and keep SQLite and local files under `/data`.

`PUBLIC_BASE_URL` is detected from `RENDER_EXTERNAL_URL`.

### Northflank

1. Create a **combined service** from this GitHub repo with build type **Dockerfile**.
2. Expose port **3000** as public HTTP and set the health check to `GET /health`.
3. Persistence: add a volume mounted at `/data` (`SQLITE_PATH=/data/app.db`, `FILE_DIR=/data/files`), **or** use `DB_DRIVER=postgres` (a Northflank Postgres addon or Neon) with `FILE_STORE=s3` (a MinIO addon or an external bucket).
4. Environment checklist:
   - `ADMIN_PASSWORD` (secret);
   - `PUBLIC_BASE_URL=https://<your-service-domain>` (Northflank isn't auto-detected);
   - optionally `AUTH_MODE`, `DATE_FORMAT`, and the `S3_*` / `DATABASE_URL` values for your storage choice.

### Docker / any container host

The image is multi-stage, runs as the non-root `node` user, and declares `/data` as a volume. Mount a volume (or configure Postgres + S3), set `ADMIN_PASSWORD`, and set `PUBLIC_BASE_URL` when the host isn't auto-detected.

### Codespaces

`.devcontainer/` uses Node 22, runs `npm install` on create, and on every start runs `.devcontainer/start.sh`. That script copies `.env.example` to `.env` if missing, makes port 3000 public with `gh codespace ports visibility 3000:public -c $CODESPACE_NAME`, and starts the server in the background.

> Run one instance per database. Resource lists and idempotency keys are cached in process, so several machines writing to the same Postgres database can briefly see stale data.

---

## Development

```
src/
  server.js            entry point (.env loader, listen, graceful shutdown)
  app.js               context + Express app (middleware order, routers, error handler)
  config/              settings registry (env -> override), base URL detection
  db/                  sqlite.js, postgres.js, repo.js (one generic docs table)
  middleware/          requestId, headers, cors, ratelimit, auth, chaos, idempotency, body, adminAuth, inspector
  routes/              platform, oauth, resources, files, admin, tester, appApi
  services/            seed, schemas, resources, query, paginate, dateFormat, files + fileStore/, sampleFiles,
                       keys, oauth, inspector, openapiGen (data spec), openapiAdminGen (admin spec), tester/ (load, lint, sample, validate, runner, auth, mock, report)
  public/              dashboard (index.html, app.js, styles.css)
  webapp/              back office app at /app (index.html, app.js, app.css)
samples/               Supplier_Order_Collaboration_OpenAPI_3_1.yaml, Inventory_Swagger_2_0.yaml
postman/               collection, environment, fixtures
scripts/               seed.js, build-postman.js, run-newman.js
test/                  node:test + supertest
```

```bash
npm run dev            # node --watch
npm test               # unit/integration tests (node:test + supertest)
npm run seed -- --employees 100 --products 200 --seed 7
npm run postman        # Newman across all auth modes
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| External caller can't reach the Codespace | The port must be **public**. Run `gh codespace ports visibility 3000:public -c $CODESPACE_NAME`, or set it in the Ports tab. |
| `Location` headers or OpenAPI `servers` show the wrong host | Set `PUBLIC_BASE_URL`. Behind a proxy, make sure it sends `X-Forwarded-Proto` and `X-Forwarded-Host`. |
| Dashboard asks for a password you never set | `ADMIN_PASSWORD` is set in the environment (on Render, `generateValue` creates one; read it in the Render dashboard). |
| `better-sqlite3` fails to install | Use Node 22 (prebuilt binaries); in containers the Dockerfile installs the build tools. Or use `DB_DRIVER=postgres`. |
| Data disappears after a redeploy | There's no volume. Mount `/data`, or use Postgres + S3. |
| 401 under `jwt`/`oauth2` with a token from another environment | The issuer is the base URL. Tokens from `localhost` aren't valid on the Fly URL. Set `JWT_ISSUER` to pin it. |
| HMAC 401 "signature mismatch" | Compare your canonical string with the one in the 401 body's `errors[0]`. Usual causes: missing query string, wrong body bytes, or the hash for a streamed upload (use `UNSIGNED-PAYLOAD`). |
| `/v1/...` returns 400 "Missing required header" | `REQUIRED_HEADERS` is set (see the Headers page). |
| Inspector doesn't show `/v1` or `/oauth` calls | Tick **Record /v1 & /oauth** on the Inspector page (or set `INSPECTOR_LOG_ALL=true`). The dashboard, docs and `/health` are never recorded. |
| Tester: "No usable base URL" | The spec's servers are relative or placeholders. Set a base URL override on the Target tab. |
| Tester: every `Shipment` response fails | That's the spec's allOf issue. Fix the spec, or enable **Lenient allOf**. |
| Large uploads time out on the host | Check the platform's request timeout. tus uploads are resumable and avoid this. |

---

## License

MIT
