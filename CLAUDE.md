# CLAUDE.md — api-test-tool

Shared working context for everyone who works on this repo, and for their Claude sessions. Leor's and
Arun's Claude projects live in separate accounts and share nothing except this repo, so **this file is
the shared memory**. Change it through PRs like any other code.

## ✅ Keep this file current (rule for every PR)

**When a change alters the architecture, conventions, commands, CI or gotchas, update this file in the same PR.**
Project memory and chat history aren't visible across the two accounts, so anything worth keeping goes here
(or in `docs/`), not only in a session. The PR template has a checkbox for this.

Related docs: `README.md` (about 1,300 lines; the user-facing spec), `docs/multi-protocol-design.md` (design
record), `docs/decisions.md` (deliberate deviations, verification status, deployments),
`docs/platform-test-checklist.md` (checks to run against the real integration platform), `docs/ONBOARDING.md`
(longer map of the codebase), `docs/security-roadmap.md` (proposed order for new auth features; read it before
adding an auth mode, OAuth client auth method or settings isolation).

## What this is

One Node 22 / Express 5 app (plain CommonJS, no TypeScript, no build step) for an integration platform that
both calls APIs and exposes them:
- **Mock target (outgoing):** seeded employees, products, departments and categories over REST `/v1`, SOAP
  1.1/1.2, WebSocket, SSE, GraphQL, OData v4 and an S3-compatible API. Also chaos, 7 pagination styles,
  rate limiting, custom/required headers, 8 auth modes (incl. `mtls` on a second, mutual-TLS listener with a
  built-in lab CA) with a built-in OAuth 2.0 server (client credentials, auth code + PKCE, refresh, introspection,
  revocation, JWKS, dynamic client registration, client ID metadata documents (CIMD), `private_key_jwt` /
  `client_secret_jwt`, RFC 8705 certificate client auth and bound tokens, resource indicators, users with roles
  and attributes), settings profiles (`/p/<name>/…`, one setup per demo on one server), a shared file pool (multipart, raw, base64, tus, presigned, range, chunked),
  outgoing webhooks, and an inspector that catches every unreserved path.
- **AI mocks** over the same data: OpenAI-compatible LLM `/llm/v1`, MCP server `/mcp` (2026-07-28 stateless and
  2025-xx session eras), A2A agent `/a2a` (1.0.1 JSON-RPC and HTTP+JSON, plus 0.3). No real model is called;
  the A2A agent is rule-based.
- **Observability of the tool itself:** `/metrics` (Prometheus text) and optional OTLP/HTTP export (protobuf or JSON) of
  the same metrics, one span per API request and logs (access logs linked to spans, the tool's own log lines) to any
  OpenTelemetry backend, configured with the standard `OTEL_*` vars.
- **Contract tester (incoming):** OpenAPI 3.0/3.1/Swagger 2.0, WSDL 1.1 (XSD validation), AsyncAPI 2.x/3.0 or
  scripted WebSocket scenarios. Lint, try-it, validation, run-all with ID chaining and negative tests, reports.

UIs: dashboard `/dashboard` (`src/public/`), back office `/app` (`src/webapp/`), Swagger UI `/docs`.
`ADMIN_PASSWORD` protects `/dashboard`, `/app` and `/admin/api/*`; it is empty by default and must be set on any
public deployment.

## Commands

```bash
npm install            # Node 22+; CI uses npm ci
npm start              # http://localhost:3000/dashboard   (npm run dev = node --watch)
npm test               # node:test + supertest, serial (--test-concurrency=1)
npm run postman        # Newman across all 7 auth modes (boots its own servers)
npm run postman -- --mode hmac                        # one mode
npm run postman -- --profiles                         # each mode through /p/<mode> on a server with another global mode
npm run postman -- --mode mtls                        # whole collection on the mTLS listener with a client certificate
npm run postman -- --url https://host --mode none     # against a running instance (no boot)
npm run postman:build  # regenerate postman/*.json from scripts/build-postman.js
npm run seed -- --employees 100 --products 200 --seed 7   # add --no-files to skip sample files
node --test test/guides.test.js                       # needs only Node, bash and openssl (no npm deps)
```

Storage variant of the tests (matches the CI `storage` job): `TEST_DB_DRIVER=postgres`,
`TEST_DATABASE_URL=postgres://…`, `TEST_FILE_STORE=s3` and `S3_BUCKET/S3_REGION/S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY`,
then `npm test`. The test helper creates a fresh database and S3 prefix per app.

## CI (`.github/workflows/newman.yml`): runs on every push and PR

| Job id | Check name (what branch protection sees) | What it does |
|---|---|---|
| `unit` | `npm test` | `npm test` on SQLite + local files |
| `newman` | `newman (none)` … `newman (mtls)` | Postman collection, one job per auth mode: `none apikey basic bearer jwt oauth2 hmac mtls`, then again through `/p/<mode>` on a second server with another global mode. Both servers run the mTLS listener (8443/8444) and get two client certificates from `scripts/mtls-newman-setup.js`. Failures appear as annotations |
| `storage` | `npm test (postgres + s3)` | `npm test` on Postgres 16 + MinIO (SeaweedFS as fallback) |
| `docker` | `docker build + smoke` | image build, `/ready`, `/health` commit = SHA, cursor pagination, 206 range download, admin 401, data survives a restart |
| `deploy` | `deploy to API Lab` | **push to master only**, after all of the above; shows as skipped on branches and PRs |

That is 12 jobs per run. **Required checks on master** are the 10 original non-deploy checks; `newman (mtls)` is new
and can be added to them once it has proved stable. Never make `deploy to API Lab` required: it never runs on a PR, so
it would block every merge.

The Postgres + S3 run is the one to watch: presigned URLs go straight to the bucket there, and slower DB calls
expose races (e.g. a stream erroring before its consumer attaches) that SQLite hides.

## ⚠️ Master deploys to the API Lab

Every green push to `master` is deployed to the API Lab on AWS (operated from Arun's `arunkumard/att-ops`).
**A merge is a production change for the lab.** So:
- Work on a branch and open a PR. Merge only with every required check green.
- Don't rename `.github/workflows/newman.yml` or the `deploy` job. The repo's OIDC subject is customized
  (repo, context, `job_workflow_ref`), and the AWS role trusts `newman.yml@refs/heads/master`, so a rename breaks
  deploys. Coordinate any such change with Arun.
- mTLS is off by default (`MTLS_ENABLED`). Turning it on in the lab needs att-ops changes (open the mTLS port, 8443,
  in the security group and container, pass it through without TLS termination, set `MTLS_PUBLIC_URL`); agree them with Arun.
- Keep what the deploy relies on: port 3000, `/health` (with `commit`) and `/ready`, the `/data` volume, the
  `GIT_SHA` build arg, the non-root `node` user, and an image that builds on arm64 (better-sqlite3 is built in the deps stage).
- How the job works: native arm64 build on `ubuntu-24.04-arm`, smoke test, push `:<sha>` and `:latest` to ECR repo
  `<stack>/api-test-tool`, then, if the EC2 instance tagged `Name=<stack>` is running, the SSM document
  `<stack>-deploy` (waits up to 5 minutes). A stopped instance picks up `:latest` on its next start. If master
  has moved on by the time a commit's tests finish, its deploy skips (never overwrites `:latest` with an older build).
  Concurrency group `deploy-api-lab` runs one deploy at a time.
- Repo variables: `API_LAB_DEPLOY_ROLE_ARN` (the job is skipped while unset), `API_LAB_REGION` (default
  `us-east-2`), `API_LAB_STACK` (default `api-lab`), `API_LAB_URL` (when set, the job waits until the lab's
  `/health` reports the commit).

Leor also runs a Fly.io copy by hand (`fly deploy`), not from CI; see `docs/decisions.md`.

## Architecture

- `src/server.js`: entry point, a small `.env` loader (real env vars win), graceful shutdown. With `MTLS_ENABLED` it also
  starts `app.listenTls()`: an `https` server with `requestCert` (not `rejectUnauthorized`, so auth answers 401
  itself) whose certificate comes from the lab CA (`src/services/ca.js`), same Express app.
- `src/app.js`: `createContext()` builds **`ctx`** (settings, repo, log, baseUrl, dates, events, wsHub,
  resources, files, keys, oauth, inspector, tester, webhooks, profiles, ca). `ctx.events` is a `ScopedEmitter`: listeners
  run in the async context (profile) they were added in. `createApp()` mounts middleware and routers
  **in a fixed order**: S3 detection and router first (so a SigV4-signed `GET /` is ListBuckets), the MCP and A2A
  well-known routes before the protocol routers, the inspector catch-all last. WebSocket upgrades are fed back
  into the Express chain by a wrapped `app.listen`. Routers are factories `xRouter(ctx)`.
- **Shared protocol spine** `src/middleware/protocol.js`, in this order:
  `errorFormat → body → required headers → rate limit → auth → chaos`. Every protocol uses it, and the
  rate limit is one budget across all protocols. `protocolStack` takes an optional `auth` override for a
  protocol with its own authentication (the S3 API's SigV4). `auth.js` honours `req.requiredScope`.
- **Errors:** throw `HttpError`, or call `sendProblem(req, res, status, {detail, code})` (`src/util/problem.js`).
  A protocol sets `req.errorFormat` (via `protocolStack`) and its registered renderer shapes the error:
  `problem` (RFC 9457, the default), `soap`, `graphql`, `odata`, `s3`, `openai`, `jsonrpc` (MCP), `a2a`, `a2a-rest`.
  Don't hand-roll error bodies. OAuth endpoints use OAuth JSON errors (`{error, error_description}`); an
  `OAuthError` may carry extra headers (e.g. `Retry-After`). Protocol-level results that aren't HTTP errors
  (MCP tool errors with `isError`, A2A task states, GraphQL field errors) stay in the protocol's own result shape.
- **Data:** `src/db/repo.js` is one generic document table on SQLite or Postgres. Protocols read and write through
  `ctx.resources`, which emits `ctx.events` `'change'` (feeds `/ws/changes`, `/sse/changes`, GraphQL subscriptions,
  MCP resource updates and webhooks). The file service (`src/services/files.js`, used by every file protocol
  including the S3 API) emits `'file'`. No protocol owns data.
- **Settings:** each setting is one row in `DEFS` in `src/config/settings.js`. Effective value = profile value (for a
  request under `/p/<name>`), else dashboard override (in the DB), else env var, else default. Settings needing a
  restart are read-only in the dashboard.
- **Profiles:** `src/middleware/profile.js` strips `/p/<name>` from `req.url` (keeping `req.originalUrl` for signatures
  and links) and runs the rest of the request in `settings.runIn()` (AsyncLocalStorage). Body parsers can lose the async
  context, so `protocolStack` re-enters it (`rescope`) before auth. `src/services/profiles.js` lists the keys a profile
  may set (per-request behaviour only). `baseUrl(req)` is the profile's base (and the mTLS root on the TLS listener);
  `baseUrl.root(req)` is the server itself (OAuth issuer, dashboard); `baseUrl.mtls(req)` is the mTLS listener's URL.
  The dashboard, `/app` and `/admin` are global only.
- **OAuth client auth:** `src/services/oauth.js` `authenticateClient` covers secrets, RFC 7523 assertions
  (`authenticateAssertion`; `jti` replay cache, `aud` = issuer or a token URL incl. profile and mTLS aliases) and
  RFC 8705 (`authenticateTls`). `src/services/cimd.js` resolves URL client_ids (CIMD). Anything the server fetches for a
  client (`jwks_uri`, CIMD documents) goes through `src/util/safeFetch.js` (SSRF guard; `OAUTH_FETCH_PRIVATE` relaxes it).
- **mTLS:** `src/services/ca.js` (lab CA in repo collection `mtls`, issued certs in `mtls_certs`), certificates built
  with the in-house `src/util/der.js` and `.p12` files with `src/util/pkcs12.js`; `src/util/clientCert.js` reads the
  peer certificate. `auth.js` has the `mtls` mode and the `cnf` (certificate-bound token) check for jwt/oauth2.
- **Protocols:** `src/protocols/{soap,ws,sse,graphql,odata,s3,llm,mcp,a2a}/`, each with `router.js`, the error
  renderer in `renderer.js` or `errors.js`, and a model or schema. Notables: `soap/model.js` (one field table
  generates XSD, XML out and XML in), `s3/sigv4.js` (SigV4 + aws-chunked), `llm/generate.js` (text, usage, seeded
  RNG), `mcp/catalog.js` (the 22 tools, resources, prompts, completions — also used by the A2A agent),
  `a2a/{wire,agent,tasks,card}.js` (1.0↔0.3 converters, rule-based planner, task engine + push, Agent Cards).
- **Telemetry:** `src/middleware/telemetry.js` is mounted right after `requestId` (before profile routing, so every
  request is measured, rejected ones included) and calls `ctx.telemetry.begin/end` (`src/services/telemetry.js`). The
  protocol label reuses the inspector's `apiKind`, plus `platform`/`admin`/`ui`/`inspector`; routes are templated
  (`routeOf`) and each metric is capped at 2000 label sets. Services report activity through `ctx.events`
  (`change`, `file`) or a direct `ctx.telemetry?.…` call (webhook deliveries, OAuth tokens); chaos is read from the
  `X-Chaos-Injected` response header (set even for `reset`). Metric names follow OTel semantic conventions; `/metrics`
  renders them as an OTLP-to-Prometheus bridge would. The exporter is in-house: OTLP JSON built once, encoded to
  protobuf by `src/util/otlpProto.js` (field numbers from opentelemetry-proto v1). Spans only for API surfaces, never
  for the tool's own exports (`User-Agent: api-test-tool-otlp/…`). Export is off until `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  Delta temporality (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`) diffs against the values of the last
  *successful* export; exports over 900 KB are split (`split()` halves the spans, log records or data points).
  Logs: `end()` queues an access-log record (`TELEMETRY_ACCESS_LOGS`) with the span's trace/span ids; `ctx.log` feeds
  `telemetry.log()` through `log.sink` (set in `createContext`), so anything logged at `LOG_LEVEL` is exported. The
  exporter's own failure warnings run with `muted` set and are never exported (they would fail too, and feed themselves).
- **Tester:** shared core in `src/services/tester/`, adapters in `adapters/{openapi.js,wsdl/,websocket/}`.
- **OpenAPI:** two specs that must not overlap. `src/services/openapiGen.js` = data spec (`/v1`, `/oauth/token`,
  `/oauth/register`, `/sse`, `/llm/v1`) at `/openapi.json`; `src/services/openapiAdminGen.js` = admin spec
  (`/admin/api`, incl. webhooks, OAuth clients/users, tester) at `/admin/api/openapi.json`.
- **Other contracts** (all open): WSDLs `/soap/{Service}?wsdl`, AsyncAPI `/ws/asyncapi.json`, SDL
  `/graphql/schema.graphql`, CSDL `/odata/v4/$metadata`, Agent Card `/.well-known/agent-card.json`. MCP describes
  itself (`tools/list` etc.). The S3 API has no contract file.
- **UI:** dashboard `src/public/app.js` + `guides.js` (the `?` guides). The Protocols page is tabbed
  (`PROTOCOL_TABS`, routes `#/protocols/<tab>`). Back office `src/webapp/`, backend `/admin/api/app/*`.
- `src/util/`: `problem.js` (renderers), `xml.js` (tiny DOM on saxes, DOCTYPE rejected), `websocket.js` (in-house RFC 6455),
  `safeFetch.js`, `der.js`, `pkcs12.js`, `clientCert.js`.

## Design rules

1. One dataset, many projections.
2. One shared spine for headers, rate limit, auth, chaos and the inspector.
3. Protocol-native errors, rendered through renderers.
4. Each contract in its own language (OpenAPI, WSDL, CSDL, SDL, AsyncAPI).
5. The tester is a shared core plus adapters.
6. Every protocol has a `<P>_ENABLED` switch and costs nothing when off.
7. Vendor neutrality: no iPaaS product names in the UI or docs.
8. Wire formats follow the published spec exactly. Protobuf-based clients (e.g. the Python a2a-sdk 1.x) reject
   unknown fields, so internal bookkeeping (e.g. A2A task `createdAt`/`lastModified`) never goes on the wire.

## Conventions

- CommonJS with `'use strict'`. No build step, no TypeScript, no linter config. Two-space indent, single quotes,
  dense code, a short header comment at the top of each file saying what it is for. Match the code around your change.
- Keep dependencies minimal. tus, WebSocket, XML parsing (on saxes), SigV4, the OData `$filter` parser, MCP,
  A2A, and the X.509 / PKCS#12 writer for the lab CA are in-house on purpose (so chaos can break them, and no SDK pins the wire format). Outbound calls use
  Node's global `fetch`. GraphQL uses the reference `graphql` package. A new dependency needs a reason in the PR.
- The Postman collection is **generated**: edit `scripts/build-postman.js`, run `npm run postman:build`, commit both.
- One concern per branch, short topic names (`feat/…`, `fix/…`, `ci/…`, `docs/…`). Imperative commit subjects.
- Tests: never sleep a fixed time before reading something written asynchronously (inspector records, webhook
  deliveries, events). Poll with `waitFor(fn)` from `test/helpers.js`, and match the exact record (e.g. by
  `X-Request-Id`), not "the newest one". Postgres writes land later than SQLite's, so a fixed sleep that passes
  in `npm test` can flake in `npm test (postgres + s3)`.

## Checklist: what to update when a feature changes

`test/docs-consistency.test.js` points here ("see the checklist in CLAUDE.md"). Update **every item that
applies**, in the same PR. The help text once drifted for weeks because nothing listed these.

- **Settings:** `DEFS` in `src/config/settings.js`, `.env.example`, and the README env table (enforced by docs-consistency).
- **README:** features table, route map, the feature's own section, troubleshooting, Postman section (the request
  count is enforced by docs-consistency), and the Development tree when files or folders are added.
- **Dashboard:** the feature's tab or card, `PAGE_HELP`, page subtitles, About & Help (what it is, quick starts,
  reserved paths, headers cheat sheet).
- **`src/public/guides.js`:** every affected `?` guide.
- **`/health`** settings summary and the admin overview URLs.
- **Telemetry:** a new metric goes in the `TelemetryService` constructor and the README's "What is measured" table.
  A new top-level API path gets its protocol label from `apiKind`; check `routeOf` turns its ids into `{id}`.
- **Inspector:** `apiKind` and the source filter.
- **Both OpenAPI specs:** `openapiGen.js` for `/v1`, `/oauth/*`, `/sse`, `/llm/v1`; `openapiAdminGen.js` for
  `/admin/api`. `test/openapi.test.js` checks every admin/tester route is documented and the specs don't overlap.
- **Postman:** `scripts/build-postman.js`, then `npm run postman:build`.
- **`docs/platform-test-checklist.md`** when a feature it covers changes.
- **This file** when architecture, conventions, commands, CI or gotchas change.

**Adding a setting:** `DEFS` row + `.env.example` line + README env table row.

**Adding a protocol surface:** `src/protocols/<name>/` mounted behind `protocolStack`, a registered error renderer,
`<P>_ENABLED`, an inspector `apiKind` + source-filter option, a `/health` + admin overview entry, a Protocols tab
(`PROTOCOL_TABS`) with guides, `PAGE_HELP`/help-page mentions (reserved paths, headers cheat sheet), a Postman
folder, a README section and tests. If it claims a top-level path, add it to the S3 bucket-name exclusion regex in
`settings.js` (it reserves `llm|mcp|a2a` among others).

### Guide rules (`src/public/guides.js`)

- Curls are built from the resolved base URL and the **active** auth mode (env or override); guides never change it.
  `test/guides.test.js` shell-checks every curl in all 8 modes and verifies the HMAC snippet against the server. In
  `mtls` mode `curl()` uses the mTLS base and adds `--cert client.pem --key client-key.pem --cacert lab-ca.pem`.
- `isApiPath` decides which paths get `AUTH_MODE` credentials. The S3 API never does (its curls use the `s3()`
  helper, `curl --aws-sigv4` and the AWS CLI with the S3 API keys); open contract paths such as `agent-card.json` don't either.
- Guide text (steps/purpose) renders only `backticks` as code; Markdown like `**bold**` shows literally.
- HMAC: `curl()` signs `UNSIGNED-PAYLOAD` for form/file uploads and when `unsigned` is set. A request with no body
  (e.g. tus create) must **not** pass `unsigned`, or it signs the wrong hash. A JSON body sent from a file (base64
  upload) needs `signFile: true` so it signs the file's real hash.

### Postman rules

- HMAC mode: query strings in the builder must be fully percent-encoded (Postman re-encodes `'` and the signature breaks).
- mTLS requests use `{{mtlsUrl}}` / `{{mtlsUrlOther}}` (two hosts, so Newman's `--ssl-client-cert-list` can present two
  different certificates) and skip themselves when `mtlsUrl` is unset. `X-Skip-Auth: 1` skips the collection auth.
- S3 requests use Postman's `awsv4` auth per request. In test scripts use `require('crypto-js')` inline;
  `CryptoJS` is already a sandbox global, so redeclaring it is a syntax error.

## Before you open a PR

- `npm test`. If you touched routes, auth, protocols or Postman: `npm run postman` (at least the modes affected).
  If you touched the Dockerfile or startup: the docker smoke steps from the workflow.
- Report the test counts you see; don't rely on fixed counts.
- Fill the PR body from `.github/pull_request_template.md`. A PR opened through the API doesn't get the template
  automatically, so copy it in yourself.
- Check the open issues and PRs first (see **Who is working on what**).

## Merging

- No review is required, but every required check must be green. A merge deploys to the API Lab.
- Each person decides whether their Claude may merge on its own. By default a Claude session **asks its user
  before merging to master**.
- Merge through the PR (merge commit):
  `gh api -X PUT repos/lbrenman/api-test-tool/pulls/<n>/merge -f merge_method=merge`.
  Branch protection blocks direct pushes to master, so the old fast-forward `git push origin <branch>:master` no longer works.

## Working from Claude cloud sessions

- The npm registry (and PyPI) is blocked by the egress policy, so `npm ci` fails. Workflow: `node --check` changed
  files, run `node --test test/guides.test.js` if guides changed, push a feature branch, open a PR with
  `gh api repos/lbrenman/api-test-tool/pulls` (`gh pr create` uses GraphQL, which is blocked), and watch CI with
  `gh run view <id> --json conclusion,jobs` or `gh api repos/lbrenman/api-test-tool/actions/runs/<id>`.
- New dependencies: add the lockfile entry by hand (`resolved` + `integrity`, read from a CI job annotation) and let
  `npm ci` in CI verify it.
- Running tests locally: push a scratch branch whose only workflow runs `npm ci`, tars `node_modules` (split into
  <95 MB parts) and pushes the parts to another scratch branch; clone that and `cat parts | tar xz`.
- Checking a protocol against official client SDKs (done for MCP and A2A): a scratch branch whose workflow starts
  the app, installs the SDKs (pip/npm work in CI) and runs small client scripts, reporting each result as an
  `::error`/`::notice` annotation.
- CI log downloads are blocked. Failures surface as check-run annotations
  (`gh api repos/lbrenman/api-test-tool/check-runs/<job-id>/annotations`), but `npm test` failures often show only
  "exit code 1". For more, push a scratch branch whose workflow runs just that test file and writes its tail as an
  `::error title=…::` annotation.
- Protocol specs (MCP, A2A) can't be fetched reliably with WebFetch; clone the spec repos
  (`modelcontextprotocol/modelcontextprotocol`, `a2aproject/A2A` at a release tag).
- Clones are shallow and single-branch. After pushing a feature branch, add a fetch refspec
  (`git config --add remote.origin.fetch +refs/heads/<b>:refs/remotes/origin/<b>`, then `git fetch origin`).
- A push that returns 403 "not in this session's authorized repository set": attach the repo to the session with push access.
- Deleting remote branches is blocked from cloud sessions; list leftover branches (scratch ones included) in the
  PR or final message so a person can delete them.

## Who is working on what

GitHub issues are the shared list. Before starting, check open issues and PRs. When you start something, open or
claim an issue: assign yourself and add the `in progress` label. Link the PR to the issue (`Closes #n`).

## Known gaps

- OData v2 (`d.results`, `__count`, `__next`, `/Date(ms)/`) isn't built; OData `$batch`, `$apply`, `$compute` and deep insert return 501.
- Postman can't drive WebSockets, so `/ws` and GraphQL subscriptions are tested only by `npm test`.
- Profiles share data, OAuth clients and the rate-limit budget; they isolate behaviour only. A multi-tenant split
  (data per profile) isn't built.
- SPIFFE (roadmap step 4b) is parked: `spiffe://` URI SANs work in lab CA certificates and `tls_client_auth`
  (`san_uri`), but there is no SVID/trust-bundle handling.
- Telemetry: no gRPC export (http/protobuf and http/json only), server spans only (no client spans or `traceparent`
  on outgoing webhooks and inspector forwards yet). Log lines written with `console.*` directly (a few in the inspector)
  are not exported; use `ctx.log`.
- Run **one instance**. Resource lists, idempotency keys, MCP sessions, A2A tasks, the SSE/WebSocket change feeds,
  the Inspector live stream and the rate-limit budget are in-process, so even Postgres + S3 doesn't make two instances work.
- More in `docs/decisions.md` (deliberate deviations, and what has and hasn't been verified in a real environment).
