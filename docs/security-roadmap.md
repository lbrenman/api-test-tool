# API security roadmap (proposed)

Status: **proposal**, tracked in issue #13. Nothing here is built yet. Once Arun and Leor agree on it, each step
gets its own issue and PR, and `docs/decisions.md` is updated as steps land (step 3 reverses the "mTLS out of scope" line).

## Who this is for, and how steps are ranked

The lab is for sales engineers (SEs) who demo an integration platform against it. Success means the platform can
reach every API style and auth scheme a customer asks about **without a third-party service** (no Okta, no
Keycloak, no SPIRE). So each step is ranked by **demo value**: does it unblock or add a scenario an SE can show? Production
hardening of the public lab ranks lower; the data is disposable and reseeding is easy.

Order: **1. Isolation → 2. CIMD (MCP client ID metadata documents) → 3. mTLS → 4. Signed client assertions, with SPIFFE on top.**

Sizes are rough: **S** = one small PR, **M** = one PR of a few days, **L** = two or more PRs.

## Where things stand today

- One global `AUTH_MODE` (`none apikey basic bearer jwt oauth2 hmac`) in `src/middleware/auth.js`, applied to every
  protocol through `protocolStack`. S3 (SigV4), SOAP WS-Security and webhook signatures sit outside it.
- Settings are one global object (`src/config/settings.js`): dashboard override in the DB, else the env var, else the default. About 220
  `settings.get()` calls in 43 files read them with no notion of who is asking.
- The OAuth server (`src/services/oauth.js`, `src/routes/oauth.js`) supports client credentials, auth code + PKCE,
  refresh, introspection, revocation, JWKS, DCR (RFC 7591) and resource indicators. Client authentication is
  `client_secret_basic`, `client_secret_post` or `none`. There is **no `private_key_jwt`** and no certificate-based client auth.
- TLS terminates in front of the app: Caddy on the AWS lab (att-ops `infra/stack.yaml`), the Fly edge on Leor's copy.
  The app itself only speaks HTTP on port 3000.
- Only `ADMIN_PASSWORD` protects the lab, and only `/dashboard`, `/app` and `/admin/api`. The data API, `/oauth/token`
  and open registration are public, and they use the demo secrets.

---

## Step 1: Isolation, so one SE's settings don't break another's demo

**Problem.** If SE A switches `AUTH_MODE` to `oauth2` or turns chaos to 50%, SE B's platform connection fails in the
middle of a demo. The same goes for required headers, rate limits, pagination style and date format. Leor raised this in the
team meeting.

**Options**

| | Option | Isolates | Cost / risk |
|---|---|---|---|
| A | **Process only**: the shared lab keeps a fixed "golden" config, and SEs never change global settings | nothing in code | Free, but it depends on discipline, and an SE still can't show two auth modes at once |
| B | **Auth lanes**: a path prefix forces the auth mode, e.g. `/auth/hmac/v1/employees` | auth only | S–M. Chaos, headers and the rest stay shared |
| C | **Profiles**: named bundles of *live* settings, selected by a path prefix `/p/<profile>/…` | behaviour (auth, chaos, headers, rate limit, pagination, formats); data stays shared | M–L, see the design below |
| D | **One lab per SE**: att-ops stack parameter, one EC2 instance each | everything | No app code, but one VM per SE (cost, patching, a URL per SE). Lives in att-ops |
| E | **Full multi-tenancy**: separate data, OAuth clients, webhooks and in-process state per tenant | everything | L+. It touches every protocol and contradicts "multi-user dashboard: out of scope" |

**Recommendation: C (profiles), with B delivered as its first slice.** Ship one built-in, read-only profile per auth mode
(`/p/apikey/…`, `/p/oauth2/…`, `/p/hmac/…`). That alone solves the most common collision and lets an SE show
API key and OAuth side by side. Then let SEs create their own profiles (e.g. `/p/arun-chaos/…`). Keep D as the
escape hatch for an SE who needs fully private data, since it costs no app code.

**Design sketch for C**

- A middleware at the very top of `createApp()` (before S3 detection) matches `^/p/([a-z0-9-]+)(/.*)`, strips the
  prefix from `req.url`, and runs the rest of the request inside an `AsyncLocalStorage` store `{ profile }`.
- `settings.get(key)` checks the active profile's overlay first, then the global override, env and default. Because the
  overlay lives in `settings.get`, the ~220 call sites don't change. Only **live** settings can go in a profile.
  The 14 settings marked `restart: true` stay global.
- `baseUrl(req)` appends `/p/<profile>` while a profile is active. Then the generated links (pagination `next`, `Location`,
  OpenAPI `servers`, WSDL addresses, OAuth issuer and metadata, MCP `resource_metadata`, Agent Card URL) all
  stay inside the profile. **This is the riskiest part.** Every place that builds an absolute URL without `baseUrl(req)`
  is a bug, so the tests need a "run the suite under a profile" pass.
- The OAuth issuer becomes per-profile automatically (it is `baseUrl(req)`), so a token minted in `/p/oauth2` is rejected in
  `/p/jwt` unless the issuers match. That's correct, but it needs to be documented.
- The rate-limit budget is keyed per profile.
- Inspector records carry the profile, and the source filter gains a profile filter.
- The dashboard gets a profile picker. The settings pages edit the selected profile's overlay. Guides build curls with the
  profile's base URL and auth mode.
- Storage: one `profile` document per profile in the existing repo (no schema change).

**Not isolated (say so in the docs):** data, OAuth clients and users, webhooks, files, MCP sessions and A2A tasks. Those
need E or D.

**Demo value: high.** It fixes Leor's concern, and an SE can show "the same API, five auth schemes" in one sitting.
**Dependencies:** none. **Size:** B slice M, full C L.
**Open questions:** do we allow profile creation without `ADMIN_PASSWORD`? (Recommendation: no.) Would a path prefix
confuse a platform's connector setup more than a subdomain would? (Subdomains need wildcard DNS and certs. sslip.io gives the DNS
but Caddy would need on-demand TLS, which is more att-ops work.)

---

## Step 2: CIMD (client ID metadata documents) for MCP

**What it is.** In MCP authorization (spec 2025-11-25 and later), a client can use an **HTTPS URL as its `client_id`**. The
authorization server fetches the JSON metadata document at that URL (client name, `redirect_uris`, grant types),
checks that its `client_id` equals the URL, and uses it with no registration step. The spec now prefers pre-registration first,
then CIMD, with DCR as the fallback. DCR is still allowed, so "deprecated" overstates it, but new MCP clients are
moving to CIMD. The lab lists CIMD as not built (`README.md`, `docs/decisions.md`).

**Options**

| | Option | Notes |
|---|---|---|
| A | Accept CIMD client IDs only (the server fetches and validates) | Minimum to interoperate with CIMD clients |
| B | A + **host sample metadata documents** in the lab (`/oauth/client-metadata/<name>.json`, editable on the Auth page) | Keeps a demo self-contained: no need to host a JSON file somewhere public |
| C | B + a switch that turns DCR off, so the client is forced onto CIMD | Lets an SE prove the platform's client really uses CIMD and isn't falling back to DCR |

**Recommendation: C.** It is small on top of A, and it's the only way to *prove* a client does CIMD.

**Work involved:** advertise `client_id_metadata_document_supported: true` in `/.well-known/oauth-authorization-server`.
In `/oauth/authorize` and `/oauth/token`, when `client_id` is an `https://` URL, fetch the document with `fetch` (no new
dependency), validate it (`client_id` match, `redirect_uris`, `token_endpoint_auth_method` = `none` or `private_key_jwt`), and
cache it under HTTP cache headers with a cap. Add an `OAUTH_CIMD` setting (`off|on`) and a CIMD clients section on the Auth page.

**Risk to design for: SSRF.** The lab will fetch any URL a caller names. Block private, loopback and link-local addresses (allow
loopback only in dev, and the lab's own `/oauth/client-metadata/`), and use short timeouts and a size cap. This is the first feature where
the lab makes outbound calls on a stranger's behalf (webhooks only go to URLs an admin configured).

**Demo value: medium-high, and it's time-sensitive.** It matters as soon as Engage or Fusion's MCP client (or a
customer's) uses CIMD. **Check first:** does Engage's MCP client support CIMD today, or is it on its roadmap? If neither,
this step can wait behind step 3.
**Dependencies:** none. With step 1 in place, the switch can be set per profile. Step 4 (`private_key_jwt`) lets CIMD clients be
confidential. **Size:** M. **Verification:** a CI scratch job with an official MCP SDK client that supports CIMD, the same
way MCP + DCR was verified (see `CLAUDE.md` → Working from Claude cloud sessions).

---

## Step 3: mTLS

**Problem.** Enterprise and B2B customers (banking, healthcare, partner APIs) often require client certificates. The lab
can't show "the platform authenticates with a client cert" today, and TLS ends before the app.

**Sub-steps**

1. **A built-in CA** (S–M). It generates a lab CA on first start, kept like the JWT keys. The Auth page issues client
   certificates (PEM + PKCS#12 download, chosen CN/SAN) and shows the CA bundle. Without it an SE would need
   openssl or a third-party CA, which defeats the purpose.
2. **mTLS as an auth mode** (M). Add `AUTH_MODE=mtls` (or a profile), where the principal comes from the verified cert's subject/SAN.
   Bad or missing certs get problem+json 401s, like the other modes.
3. **OAuth with certificates, RFC 8705** (M). `tls_client_auth` / `self_signed_tls_client_auth` client authentication
   at `/oauth/token`, plus **certificate-bound access tokens** (`cnf.x5t#S256`, checked on every call). This is the
   scenario a security-minded customer asks about.

**Where TLS terminates: the hard part**

| | Option | Notes |
|---|---|---|
| A | Caddy verifies the client cert and forwards it to the app in a header | Caddy needs our CA, and the app must trust the header only from Caddy (a spoofing risk with `trust proxy` on). Different on Fly |
| B | **The app runs its own TLS listener** on a second port (e.g. 8443, Node `https` with `requestCert`), reached directly | Same code everywhere (lab, Fly via a TCP service, Codespaces, local). Needs a server cert: reuse Caddy's ACME cert from `/data`, or have the lab CA issue one (clients must then trust our CA) |
| C | Caddy passes TLS through on a dedicated port (layer4) | Needs a Caddy plugin build. More att-ops complexity for the same result as B |

**Recommendation: B.** One code path, testable in `npm test`, and the cert seen by the app is real, not a header.
**Lab deploy impact:** att-ops must open the port (security group and Docker publish), and `CLAUDE.md` → "what the deploy
relies on" gains the new port. Coordinate with Arun before merging.

**Demo value: high** for enterprise accounts. It's a common checkbox item. **Dependencies:** step 1 recommended (an mTLS
profile next to the others, so turning it on doesn't break everyone). **Size:** L in total (three PRs plus an att-ops PR).
**When merged:** remove "mTLS" from "Out of scope" in `docs/decisions.md`, and add it to `docs/platform-test-checklist.md`.

---

## Step 4: Signed client assertions, with SPIFFE on top

**Challenging the ask first.** SPIFFE is workload identity *inside* a customer's infrastructure (Kubernetes, service mesh, SPIRE).
A Fusion SE demo rarely reaches "authenticate this connector with a SPIFFE ID". Two more points against a full step:

- The OAuth SPIFFE client-authentication spec is still an **IETF OAuth working-group draft**, not an RFC, so the wire format may change.
- "No third parties" means the lab would issue its own SVIDs instead of running SPIRE. That proves the platform can *present
  an SVID-shaped credential*. It does not prove the platform integrates with the customer's SPIRE, which is the actual question
  a customer would ask.

What *does* carry demo value is the general mechanism SPIFFE builds on: **a client proving itself with a signed JWT
instead of a shared secret.** That's `private_key_jwt` (RFC 7523 client assertions). Entra ID, Okta, Ping and others support it,
customers do ask about it, and CIMD clients use it to be confidential.

**Recommendation: split it.**

- **4a: `private_key_jwt` client authentication** (M, demo value **high**). Clients register a JWKS or `jwks_uri`, then
  authenticate at `/oauth/token` with a `client_assertion`. Validate `iss`/`sub` = client_id, `aud` = token endpoint,
  `exp`, and `jti` replay. Add it to `token_endpoint_auth_methods_supported`, DCR and CIMD. The Auth page can generate a key pair
  and a ready-made assertion for curl and Postman.
- **4b: SPIFFE add-on** (S–M once 4a and step 3 exist, demo value **low today**, so build it only when a customer or
  the product roadmap asks). The lab acts as a mini trust domain (`spiffe://api-lab/...`): it issues **JWT-SVIDs**
  (accepted as client assertions through 4a) and **X.509-SVIDs** (client certs with a SPIFFE URI SAN through step 3), and
  publishes the trust bundle. Most of the work is already done by then.

**Dependencies:** 4a none (CIMD benefits from it). 4b needs 4a and step 3.

---

## Summary

| Step | Recommendation | Demo value | Depends on | Size |
|---|---|---|---|---|
| 1 Isolation | Profiles (`/p/<name>/…`); auth-mode profiles first | High | — | M (first slice), L (full) |
| 2 CIMD | Accept + host sample docs + DCR-off switch | Medium-high, once clients use it | — (benefits from 1, 4a) | M |
| 3 mTLS | Built-in CA → `mtls` mode → RFC 8705; the app does its own TLS on a second port | High (enterprise) | 1 (recommended), att-ops port | L |
| 4a `private_key_jwt` | Build | High | — | M |
| 4b SPIFFE | Only when demand appears; thin layer over 3 + 4a | Low today | 3, 4a | S–M |

Suggested order to *build*: 1 (first slice) → 4a → 2 → 3 → rest of 1 → 4b. 4a moves ahead of CIMD because it is
useful on its own, and CIMD clients need it to be confidential. Keep the agreed priority (isolation, CIMD, mTLS) if CIMD
turns out to be urgent for Engage.

Cross-cutting for every step (the `CLAUDE.md` checklist): `DEFS` + `.env.example` + the README env table for new settings,
guides with curls in every mode, Postman requests, both OpenAPI specs where routes are added, the `/health` summary,
inspector `apiKind`/filters, `docs/platform-test-checklist.md`, and negative tests (expired, wrong issuer/audience,
wrong cert, replayed assertion), which are thin even for today's modes.

## Questions for Leor and Arun

1. Profiles by path prefix: is that acceptable for how SEs configure Fusion/Engage connectors, or do they need subdomains?
2. Does Engage's MCP client do CIMD today, or soon? That decides whether step 2 jumps ahead of 4a.
3. Opening a second port on the lab for mTLS: OK from the att-ops side?
4. Has any customer asked about SPIFFE? If not, 4b stays parked.
