# API Test Tool — contributor onboarding map

Repo: https://github.com/lbrenman/api-test-tool (public, MIT, default branch `master`)
Mapped at: `a46e3d2` (2026-10-19, "Merge pull request #4 … feat/health-commit") on 2026-10-26.
Method: read-only shallow clone. **Nothing was installed or executed** (running the repo's code in the
cloud sandbox was blocked), so the run/test commands below come from the repo's README, `package.json`
and CI workflow, not from a local run. Verify them on first use.

> This is a point-in-time map, not kept current line by line. `CLAUDE.md` is the maintained source of truth
> for rules, commands and CI; when the two disagree, `CLAUDE.md` wins. Counts below (lines, tests, requests)
> drift with every PR.

---

## 1. What the app is

One Node/Express app that tests an API platform in both directions:

1. **Outgoing (mock target).** Your integration calls it. Seeded employees/products/departments/categories
   over REST `/v1` plus SOAP, WebSocket, SSE, GraphQL, OData v4 and an S3-compatible API; 7 pagination
   styles; chaos (errors, latency, broken bodies); a file pool over many upload protocols (multipart, raw,
   base64, presigned, range, tus); 7 auth modes with a built-in OAuth 2.0 server (DCR, PKCE, introspection);
   outgoing webhooks; and a webhook.site-style **inspector** that captures every unreserved path.
2. **AI-facing mocks.** OpenAI-compatible mock LLM `/llm/v1`, MCP server `/mcp`, A2A agent `/a2a`.
   No real model is called.
3. **Incoming (contract tester).** Load OpenAPI 3.0/3.1/Swagger 2.0, WSDL 1.1 or AsyncAPI; it generates
   requests, proxies them to your implementation, validates responses, runs the whole contract with ID
   chaining and negative tests.

UIs: dashboard `/dashboard` (vanilla JS, `src/public/`), back-office demo app `/app` (`src/webapp/`),
Swagger UI `/docs`. Admin is protected by `ADMIN_PASSWORD`.

Size: ~43k lines in tracked JS/MD/YAML/JSON; README alone is 1,321 lines and is the de facto spec.

## 2. Architecture

```
src/server.js     entry: tiny .env loader (real env wins), listen, graceful shutdown
src/app.js        createContext() builds ctx; createApp() wires middleware + routers in a fixed order
```

**`ctx` is the spine.** Everything hangs off one context object created in `createContext()`:
`settings, repo, log, baseUrl, dates, events (EventEmitter), wsHub, resources, files, keys, oauth,
inspector, tester, webhooks`. Routers are factories `xRouter(ctx)`.

**Request flow (app.js order matters):**
requestId → response headers → CORS → S3 detect → inspector `logAll` → S3 router → platform/OAuth/
well-known → `/dashboard`, `/app`, `/admin/api` → presigned files → `/v1` (protocolStack + idempotency)
→ `/soap /ws /sse /graphql /odata /llm /mcp /a2a` → inspector `catchAll` → error handler.
WebSocket upgrades are re-injected into the Express chain by a wrapped `app.listen` (see bottom of app.js).

**The shared protocol spine** (`src/middleware/protocol.js`, design in `docs/multi-protocol-design.md`):
`errorFormat → body parser → required headers → rate limit → auth → chaos`. Every protocol uses it, so
auth/chaos/rate-limit behave identically everywhere; only the error *shape* differs via renderers
registered in `src/util/problem.js` (`sendProblem`). Rate limit is one budget across all protocols.

Design principles (from the design doc; respect these in PRs):
1. One dataset, many projections: protocols read/write via `ctx.resources`, never own data.
2. One shared spine for headers/rate-limit/auth/chaos/inspector.
3. Protocol-native errors via renderers, never ad-hoc.
4. Contracts in their own language (OpenAPI, WSDL, CSDL, SDL, AsyncAPI).
5. Tester = shared core + per-contract adapters.
6. Every protocol has a `<PROTOCOL>_ENABLED` switch and costs nothing when off.
7. Vendor neutrality: no iPaaS product names in UI or docs.

### Module map

| Area | Path | Notes |
|---|---|---|
| Settings registry | `src/config/settings.js` | `DEFS` array: one row per setting (key, env, default, type, section, restart, secret). Effective value = dashboard override in DB ?? env ?? default. |
| Base URL | `src/config/baseUrl.js` | Auto-detects Codespaces, Fly, Render, then request headers. |
| DB | `src/db/repo.js`, `sqlite.js`, `postgres.js` | One generic document table; `get/list/put/putMany/del/count/trim` + kv helpers. SQLite (better-sqlite3) or Postgres. |
| Middleware | `src/middleware/` | requestId, headers, cors, ratelimit, auth (7 modes), chaos, idempotency, body, adminAuth, inspector, protocol. |
| REST routes | `src/routes/` | platform (health, openapi, docs), oauth, resources, files, admin, tester, appApi. |
| Services | `src/services/` | seed (deterministic Faker), schemas, resources (emits `change` events), query, paginate, dateFormat, files + `fileStore/{local,s3,meter}`, sampleFiles, keys, oauth, inspector, webhooks, openapiGen (data spec), openapiAdminGen (admin spec). |
| Tester | `src/services/tester/` | core: index, load, lint, sample, validate, runner, auth, mock, report, refs, operations; adapters: `openapi.js`, `wsdl/`, `websocket/`. |
| Protocols | `src/protocols/{soap,ws,sse,graphql,odata,s3,llm,mcp,a2a}/` | Each has `router.js`, usually `errors.js` (renderer) and a model/schema file. SOAP `model.js` is one field table that generates XSD, XML out and XML in. S3 has its own SigV4 (`sigv4.js`), AUTH_MODE does not apply. |
| Utils | `src/util/` | problem (HttpError, renderers), xml (saxes-based tiny DOM, DOCTYPE rejected), websocket (hand-rolled, no `ws` dep), build. |
| Dashboard | `src/public/app.js` (2,380 lines), `guides.js` (1,407), `index.html`, `styles.css` | Single-file vanilla JS. `guides.js` holds the per-page `?` guides with curls for every auth mode. |
| Back office | `src/webapp/` | Business view of the data at `/app`. |
| Postman | `scripts/build-postman.js` → `postman/*.json` | **Collection is generated**: edit the script, run `npm run postman:build`, commit both. |
| Facade sample | `facade/` | Experience API OpenAPI + data mapping + single-file "Acme Front Office" app. |

## 3. Running it locally

Requires **Node 22+** (`engines`). better-sqlite3 needs prebuilt binaries for Node 22 (or build tools).

```bash
git clone https://github.com/lbrenman/api-test-tool && cd api-test-tool
npm install                 # CI uses npm ci (lockfile present)
cp .env.example .env        # optional; documents every setting
npm start                   # http://localhost:3000/dashboard   (npm run dev = node --watch)
npm run seed -- --employees 100 --products 200 --seed 7
```

Codespaces: the devcontainer installs, starts the server and makes port 3000 public (`.devcontainer/start.sh`,
logs in `/tmp/api-test-tool.log`). Set `ADMIN_PASSWORD` before sharing a public URL.

## 4. Tests: the four CI jobs, and how to reproduce each

CI is `.github/workflows/newman.yml`, triggered on **every push (any branch) and every PR**.

| CI job | What it does | Local equivalent |
|---|---|---|
| `unit` | `npm test` on SQLite + local files | `npm test` (= `node --test --test-concurrency=1 "test/**/*.test.js"`; 27 files, ~243 tests, node:test + supertest) |
| `newman (matrix)` | Boots server with `SEED_ON_START=always` for each of `none, apikey, basic, bearer, jwt, oauth2, hmac`, runs the Postman collection (198 requests) | `npm run postman` (all modes, boots its own servers) · `npm run postman -- --mode hmac` · `npm run postman -- --url https://host --mode none` (against a deployed box) |
| `storage` | `npm test` again on Postgres 16 + MinIO S3 (SeaweedFS fallback) | `TEST_DB_DRIVER=postgres TEST_DATABASE_URL=postgres://… TEST_FILE_STORE=s3 S3_BUCKET=… S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin npm test` (with local postgres + minio containers; the helper creates a fresh DB and S3 prefix per app) |
| `docker` | Build image, run, smoke `/ready`, `/health` (status ok, commit = SHA), cursor pagination, a 206 range download, 401 on admin, restart keeps 250 employees | `docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t att . && docker run -p 3000:3000 -v att-data:/data -e ADMIN_PASSWORD=x att`, then the curls from the workflow |
| `deploy` | **Only on push to master** after all four pass: arm64 build, smoke, push to ECR, roll out to Arun's API Lab over SSM, confirm `/health` commit. Gated on repo var `API_LAB_DEPLOY_ROLE_ARN`. | n/a — this is att-ops territory |

Test harness facts worth knowing:
- `test/helpers.js` `makeApp(env)` builds an isolated app in a temp dir (40 employees, 60 products) and
  passes **only** its own env, so host env does not leak. `listen(env)` gives a real port when the tool
  must call itself over HTTP.
- `--test-concurrency=1`: tests run serially; keep new tests independent of order anyway.
- **Guardrail tests that will fail your PR if you forget docs:**
  - `test/docs-consistency.test.js`: every `DEFS` setting must appear in `.env.example` **and** the README
    env table; every protocol `/health` reports must have dashboard help, an Inspector filter source, a
    reserved-paths row and a README section.
  - `test/guides.test.js`: dashboard guide curls must work in all 7 auth modes (needs bash + openssl).
  - `test/openapi.test.js`, `build.test.js`: generated specs and build metadata.

## 5. Conventions (inferred from code and history)

- **Plain CommonJS, `'use strict'`, no build step, no TypeScript, no linter config** (despite
  `eslint-disable` comments and the ESLint devcontainer extension). Two-space indent, single quotes,
  dense one-liners, a short header comment at the top of every file explaining its role. Match that.
- Few dependencies; hand-rolled where it lets chaos break things on purpose (XML, WebSocket, SigV4).
  Adding a dependency is a real decision; justify it in the PR.
- **Adding a setting** = row in `DEFS` + line in `.env.example` + row in the README env table (enforced).
- **Adding a protocol** = router under `src/protocols/<p>/` mounted in `app.js` behind `protocolStack`,
  an error renderer, `<P>_ENABLED`, `/health` entry, dashboard Protocols tab + `?` guide, Inspector
  source, reserved-path row, README section, Postman folder in `build-postman.js` (enforced by tests).
- Errors: throw `HttpError` or call `sendProblem(req, res, status, {detail, code})`; never hand-roll JSON errors.
- Branches: short topic names, sometimes prefixed (`oauth-users-roles`, `harden-dcr`, `ci/deploy-api-lab`,
  `feat/health-commit`). Commit subjects: imperative sentence, sometimes `feat:`/`ci:`/`docs:` prefixed.
  One concern per PR; green CI before merge (stated in the design doc's delivery plan).
- History: most commits are authored "Claude", Leor authors merges and small fixes. All 4 PRs to date
  (#1–#4, 2026-10-12 → 10-19) were Claude-authored branches Leor merged. No PR template, no CONTRIBUTING.md.
- **Lockfile in cloud sessions:** the design doc says the npm registry is blocked in Claude cloud
  sessions, so new packages were added to `package-lock.json` by hand (resolved/integrity values) and
  verified by `npm ci` in CI. Expect the same constraint in our sessions; prefer no new deps.

## 6. Where the shared context lives

- `CLAUDE.md`: rules, commands, CI, and the update checklist that `test/docs-consistency.test.js` points to
  (it used to live only in Leor's Claude project instructions).
- `docs/decisions.md`: deliberate deviations from the original spec, deployments, verification status.
- `docs/platform-test-checklist.md`: checks to run against the real integration platform.
- `docs/security-roadmap.md`: proposed order for new auth features (isolation, CIMD, mTLS, signed client assertions/SPIFFE).
- `docs/multi-protocol-design.md`: design record (principles, delivery plan, open questions). Partly stale (see §7).

## 7. Known gaps and drift (candidate contributions)

Issues/PR list: I could only see git refs (the GitHub tools are scoped to att-ops). Refs show PRs #1–#4,
all merged, none open. I did not see the issues list; check it on GitHub before picking work.

| # | Finding | Evidence | Size |
|---|---|---|---|
| A | ~~No `CLAUDE.md`; contribution checklist lives in Leor's private project instructions~~ Done: `CLAUDE.md` | §6 | — |
| B | ~~README "Development" tree is stale~~ Done (#7) | README | — |
| C | ~~README says Postman collection has 196 requests~~ Done (#7), now checked by docs-consistency | README | — |
| D | Design doc drift: names `fast-xml-parser`, `xmllint-wasm`, `ws` as deps (none in package.json), `src/protocols/soap/xml.js` (actual `src/util/xml.js`), `SSE_HEARTBEAT_MS` (actual `SSE_HEARTBEAT_SECONDS`), protocolStack header comment still says "SOAP, OData… later" | grep | XS |
| E | No lint/format tooling despite eslint-disable comments | package.json | S, but a style decision for Leor |
| F | OData v2 (`d.results`, `__count`, `__next`) not implemented; the design kept envelope code separate for it | README L787, design doc | M–L, only if someone needs v2 |
| G | WebSocket channels and GraphQL subscriptions aren't in Newman (Postman can't drive WS); covered by `npm test` only | README | info only |
| H | Multi-instance caveat: resource lists and idempotency keys cached in process | README Deployment | info for att-ops (keep one instance) |

## 8. Coupling with att-ops (read before every PR)

- **Every merge to `master` auto-deploys to the API Lab** (the `deploy` job) once unit, newman, storage
  and docker pass. A merged PR is a production change for the lab. `/health` reports the commit.
- The deploy job, its repo variables (`API_LAB_DEPLOY_ROLE_ARN`, `API_LAB_REGION`, `API_LAB_STACK`,
  `API_LAB_URL`) and the role trust (`job_workflow_ref` on newman.yml@master) are shared with att-ops.
  Renaming the workflow file or the job breaks the AWS trust. Coordinate such changes with att-ops.
- The Docker image must keep: `/data` volume, `GIT_SHA` build arg, `/health` + `/ready`, port 3000,
  non-root `node` user, arm64 buildability (better-sqlite3 native build in the deps stage).
- Smoke test against the lab: `npm run postman -- --url <API_LAB_URL> --mode <lab AUTH_MODE>`.

## 9. Working agreement for contributing

1. Check open issues and PRs, claim an issue (assignee + `in progress` label), then branch in Leor's repo, one concern per branch.
2. Before pushing: `npm test`; if you touched routes, protocols, auth or Postman, also `npm run postman`
   (at least the affected mode); if you touched Dockerfile/startup, the docker smoke.
3. Settings/protocol changes: update `.env.example`, README tables and dashboard help in the same PR.
4. PR body: what, why, how tested, and whether it changes anything the lab deploy depends on (§8).
5. No review is required; merge when every required check is green (see `CLAUDE.md` → Merging). Merge = deploy to the lab.
