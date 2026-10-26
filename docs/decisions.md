# Decisions, deployments and verification status

Reference notes that used to live only in Leor's Claude project instructions. `CLAUDE.md` holds the rules for
working on the repo; this file holds the *why* and the current state. Update it in the same PR when one of these
changes.

## Deliberate deviations from the original build spec

The app was first built from a written spec (not in the repo). These choices differ from it on purpose:

- **Tester run-all order:** collection POSTs → collection GETs (to harvest ids) → item operations → DELETEs.
- **In-house implementations:** tus and WebSocket (no `@tus/server`, no `ws`); outbound calls use Node's global
  `fetch` (no `undici`); XML on `saxes` (no `fast-xml-parser`); the OData `$filter` parser; SigV4 verification and
  aws-chunked decoding (checked against the AWS documentation example); MCP and A2A (no SDK dependency — the
  official SDKs are used only as test clients in scratch CI runs). GraphQL uses the reference `graphql` package (16.11.0).
- **Extra settings** beyond the spec: `S3_PREFIX`, `CHAOS_TIMEOUT_SECONDS`, `CHAOS_SLOW_DRIP_MS`, `HMAC_KEY_ID`,
  `HMAC_MAX_SKEW_SECONDS`, `OAUTH_USERS` (`user:password[:roles[:attributes]]`), `OAUTH_ROLES_CLAIM`,
  `OAUTH_REFRESH_TTL`, `OAUTH_REGISTRATION(_TOKEN, _SCOPES, _MAX, _GRANTS, _RATE, _TTL_DAYS)`, and the `SOAP_*`,
  `WS_*`, `SSE_*`, `GRAPHQL_*`, `ODATA_*`, `S3_API_*`, `WEBHOOK(S)_*`, `LLM_*`, `MCP_*` and `A2A_*` groups.
  `S3_API_*` are the keys S3 *clients* sign with; `S3_*` choose where the tool *stores* files.
- **Extra reserved paths:** `/samples/*`, `/app`, `GET /` (redirects to the dashboard; a SigV4-signed request to `/`
  is S3 ListBuckets), `/soap`, `/ws`, `/sse`, `/graphql`, `/odata`, `/llm`, `/mcp`, `/a2a`, `/oauth/register`,
  `/.well-known/oauth-protected-resource/mcp`, `/.well-known/agent-card.json`, and the S3 bucket name (`/files` by default).
- **OpenAPI** is split into a data spec and an admin spec (see `CLAUDE.md`).
- **HMAC:** streamed `/v1/files` uploads sign the literal `UNSIGNED-PAYLOAD` instead of a body hash.
- An explicit `If-None-Match` returns 304 even when `Cache-Control: no-cache` is sent.
- The S3 storage client computes checksums only when required (needed for presigned PUTs on MinIO/R2).
- "Mock from spec" serves a spec's examples under `/mock/<name>` through inspector rules.
- **OData:** property names match `/v1` (camelCase), timestamps are always ISO, `Employee.metadata` is not modelled;
  `$batch`, `$apply`, `$compute` and deep insert return 501. v2 is not built.
- **S3 API:** one bucket, path-style only (virtual-host only if DNS allows), objects keyed by file name or the S3 key
  given on upload (stored as `file.s3.key`). Files uploaded through other protocols have a SHA-256 ETag, S3 uploads
  an MD5 ETag. Multipart parts ≥ 5 MiB except the last, kept on local disk under `<data>/s3-multipart`. Versioning,
  tagging, ACL writes and UploadPartCopy return 501. `AUTH_MODE` does not apply (SigV4 with `S3_API_*` keys);
  rate limit, required headers and chaos do.
- **OAuth users:** env users (`OAUTH_USERS`) can be edited on the Auth page, which stores an override; deleting it
  reverts to the env values (same as clients). A refreshed token gets the user's current roles and attributes; a
  deleted user's codes and refresh tokens fail with `invalid_grant`.
- **OAuth dynamic registration** is open by default (MCP clients expect it). Open registration (no initial access
  token) accepts only the grants in `OAUTH_REGISTRATION_GRANTS` (default `authorization_code refresh_token
  client_credentials`), redirect URIs that are https, loopback http or a custom scheme (at most 10), and
  `OAUTH_REGISTRATION_RATE` per client IP per hour (429 `rate_limited` + `Retry-After`; `Fly-Client-IP` on Fly, else
  `req.ip`). Token mode lifts those three limits. Registered clients record `lastUsedAt` when they get a token;
  unused ones are pruned after `OAUTH_REGISTRATION_TTL_DAYS`; at `OAUTH_REGISTRATION_MAX` the oldest never-used
  registration is evicted, and registration is refused only when every one has been used. Public clients must use
  PKCE and cannot use client_credentials; registered clients may use only their registered grants; loopback
  redirects match on any port; RFC 7592 GET/DELETE only (no PUT). Admin bulk delete:
  `DELETE /admin/api/oauth/registered[?unused=true]`.
- **Webhooks** send one attempt per event (no automatic retries). With `FILE_STORE=s3`, presigned uploads fire when
  the tool next sees the object, and presigned downloads cannot be seen.
- **Mock LLM:** chat completions, embeddings and models only (no Responses API, legacy completions, images, audio or
  files). Answers are deliberately vague prose.
- **MCP:** no HTTP+SSE transport (2024-11-05), no batches, no server-to-client requests (sampling, elicitation,
  roots, 2026-07-28 input requests), no tasks, no client ID metadata documents.
- **A2A:** rule-based agent (no LLM, no outside calls — it answers about the mock data only); no gRPC binding; file
  parts (`url`, `raw`) accepted but not read; extensions not implemented; tasks in memory (`A2A_TASK_RETENTION`).

Out of scope: HSM/PKCS#11, mTLS, FTP/SFTP, multi-user dashboard, Hookdeck-style retries, TypeScript.

## Deployments

### API Lab on AWS (automatic, from CI)

See `CLAUDE.md` → *Master deploys to the API Lab*. Operated from `arunkumard/att-ops`.

### Fly.io (manual, Leor's)

- One app (`api-test-tool`, as in `fly.toml`), one 1 GB volume `att_data` at `/data`, one machine, region `ewr`.
  `fly.toml` is used as-is.
- `fly.toml` keeps the machine always on (`auto_stop_machines = "off"`, `min_machines_running = 1`), raises the
  proxy connection limit to 200 soft / 250 hard (long-lived SSE, WebSocket, MCP and A2A streams and the Inspector
  live stream count against it), and adds 512 MB swap with `NODE_OPTIONS=--max-old-space-size=384` (keep it at
  about 75% of VM memory if the VM is resized).
- Keep **one** machine and ignore Fly's "add a second machine" advice: volumes aren't replicated, and in-process
  state (see `CLAUDE.md` → *Known gaps*) means two instances don't work.
- Update: `git pull`, then `fly deploy --build-arg GIT_SHA=$(git rev-parse HEAD)`. `/health` then reports that commit
  as `commit` (`version` is package.json's and doesn't change). The volume (database, files, dashboard settings,
  webhooks, OAuth clients and users, signing keys) carries over; MCP sessions and A2A tasks are lost on a deploy or
  restart. Dashboard overrides win over Fly secrets until reset.
- `ADMIN_PASSWORD` is a Fly secret. If a secrets rollout fails with "insufficient CPUs available … on the current
  host", the secret is saved but not applied: retry with `fly secrets deploy` (the machine is pinned to its volume's host).
- `FILE_STORE=s3` with Fly Tigris: set `FILE_STORE`, `S3_BUCKET`, `S3_REGION=auto` and `S3_ENDPOINT`; the `AWS_*` keys
  that `fly storage create` sets are picked up by the SDK's default chain.
- Open OAuth registration on a public deployment lets anyone mint tokens with `OAUTH_REGISTRATION_SCOPES` (default
  `read write`). To lock it down: `OAUTH_REGISTRATION_GRANTS="authorization_code refresh_token"` (MCP clients still
  self-register; add machine clients on the Auth page), or `OAUTH_REGISTRATION_SCOPES=read`.

## Verification status

Verified:
- Fly.io deploy (one volume, local storage, region `ewr`, always-on machine).
- MCP with the official SDK clients (`@modelcontextprotocol/sdk` 1.32.1, `@modelcontextprotocol/client` 2.3.1,
  speaking 2025-11-25), in CI.
- A2A with the official SDKs in CI: Python `a2a-sdk` 1.2.2 (JSON-RPC and HTTP+JSON), `@a2a-js/sdk` 1.3.0, and
  `a2a-sdk` 0.3.26 against `/a2a/v0.3`.
- The API Lab deploy job (OIDC role, ECR push and rollout all green, Oct 19, 2026, including PR #4's `commit` in `/health`).

Not yet verified:
- The API Lab `/health` commit check (needs `API_LAB_URL`), Render deploy, Fly with `FILE_STORE=s3` on Tigris.
- Swagger UI and GraphiQL CDN loading; dashboard `?` guide popovers on mobile.
- `docs/platform-test-checklist.md` against the real integration platform.
- The S3 API with clients other than the AWS SDK for JS v3, curl and Postman (AWS CLI, boto3, rclone, the platform's S3 connector).
- Dynamic client registration with a real MCP client, and the open-registration limits on the live Fly deployment.
- The Files upload guides' curls against a live deployment (CI only syntax-checks them; supertest covers the server side).
- The mock LLM with the official OpenAI SDKs or the platform's LLM connector.
- The MCP 2026-07-28 path with a real client (covered by the tool's own tests only).
- The MCP server and A2A agent with the platform's own clients or gateways.
