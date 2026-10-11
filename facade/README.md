# Facade API sample — Workforce & Catalog Experience API

A ready-made contract for building a **facade (experience) API** in your API framework or integration
platform, on top of this tool. The facade orchestrates several calls to the tool's `/v1` REST API and
returns aggregated, business-friendly objects, so you can demo or test orchestration, aggregation,
data minimisation, idempotent writes and backend error mapping against a realistic system of record.

| File | What it is |
|---|---|
| [`Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml`](Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml) | The facade contract (OpenAPI 3.0.1), with examples for every response |
| [`DATA_MAPPING.md`](DATA_MAPPING.md) | For each operation: the backend calls, their order, field-by-field mappings, aggregation rules, error mapping and configuration |
| [`facade-app.html`](facade-app.html) | **Acme Front Office** (Experience console): a single-file, mobile-friendly web app that exercises all six operations (no build, no dependencies) |

## The six operations

Two list operations let callers discover business keys; the other four drill in or act.

| Operation | What the facade does | Backend calls |
|---|---|---|
| `GET /people` | Directory search by name, email or employee number, filtered by department and status; light summaries only. A name search runs given name, family name and email in parallel and de-duplicates | 1, or 3 in parallel |
| `GET /people/{employeeNumber}` | 360° profile: employee, department, manager and active direct reports; salary, home address and metadata removed; tenure and certification status derived | 1, then 2 in parallel |
| `POST /people/hires` | Onboarding: resolves department by code and manager by employee number, rejects duplicate emails, creates the record idempotently, returns the new profile | 3 in parallel, then 1 create |
| `GET /teams` | Every department with its active headcount, counted from the employee records | 1 + 1 per 200 active employees, in parallel |
| `GET /teams/{departmentCode}/snapshot` | Aggregates a whole department: headcount, level mix, tenure, top skills, certification coverage, ratings, and payroll for callers with `compensation.read` | 1 + one per 200 members |
| `GET /catalog/items` | Storefront search: category, availability, price-in-currency and tag filters, business sort orders, opaque page tokens, derived stock status | 1 (+1 uncached category lookup) |

Callers use business keys (`EMP-000005`, `ENG`, `ELEC`, `SKU-00042`); backend integer ids never leave
the facade. Every error is RFC 9457 problem+json with a stable `errorCode`.

## How to use it

1. **Deploy the tool** and note its base URL (`B`). Set `DATE_FORMAT=iso` (or convert timestamps as
   `DATA_MAPPING.md` describes). Pick any `AUTH_MODE`; the facade keeps its own backend credentials.
2. **Import the spec** into your API framework to generate the facade's interface, then implement each
   operation from `DATA_MAPPING.md`.
3. **Let consumers start early (optional):** on the tool's **API tester** page, load the facade spec
   and use **Mock from spec** to serve its examples under `/mock/<name>` before the facade exists.
4. **Watch the orchestration:** turn on **Record API calls** on the Inspector page. Each facade request
   shows up as its backend calls, linked by the same `X-Correlation-Id`.
5. **Contract-test the facade:** load the spec into the tool's **API tester**, set the target base URL to
   your facade, set the auth profile (OAuth2 client credentials or API key), then **Run all**. The tester
   validates every response against the spec and runs the negative tests (no auth, invalid body,
   unknown id).
6. **Test resilience:** use the tool's Chaos page (error rates, `timeout`, `malformed-json`, `reset`,
   rate limits) and check the facade answers with the mapped 502/503/504 codes. `DATA_MAPPING.md` has a
   table of which chaos setting exercises which path.

### Tips for Run all

- `POST /people/hires` uses the spec's named example. Its email (`priya.raman.hire@example.com`) exists
  after the first successful run, so a second run with a new `Idempotency-Key` correctly gets 409
  `PERSON_ALREADY_EXISTS`. Change the email in **Try it**, or re-seed the tool, to create again.
- The tester chains the new `employeeNumber` from the 201 into `GET /people/{employeeNumber}`.
- `ENG` and `EMP-000005` exist with the default seed (`SEED_RANDOM_SEED=42`, 250 employees).

## Acme Front Office (`facade-app.html`)

The front-office counterpart to the tool's **Acme Back Office** app (`/app`): where the back office works
on the systems of record directly, Acme Front Office only ever calls the facade. One HTML file with its CSS
and JavaScript inline. Open it straight from disk, or host it anywhere static (a web server, a bucket, your
API gateway's portal). It works on a phone: bottom tab bar, large touch targets, no horizontal scrolling,
light and dark themes.

Profiles render as employee ID badges, and each department keeps one colour across People, Teams and
the team snapshot. Tap the Acme Front Office name to return to the people directory, the connection
chip to open Settings, and **?** for in-app help with links back to this repo.

| Tab | What it does |
|---|---|
| **People** | Search the directory (name, email or employee number, plus department and status filters), tap a person for their profile, then tap the manager or a direct report to open theirs. Typing a full employee number opens that profile directly |
| **Hire** | Submit a hire. The `Idempotency-Key` is kept when you resubmit the same form (a safe retry) and replaced when you change it; on success, open the new profile |
| **Teams** | The list of teams with active headcounts; tap one for its snapshot with tiles and bar charts (payroll shows only when the facade returns it) |
| **Catalog** | Search with every filter and sort, and **Load more** through `nextPageToken` |
| **Trace** | Every request and response this page made, newest first: status, timing, correlation id, request and response headers, and pretty-printed bodies, including OAuth token requests and network failures. Credentials are masked unless you tick **Show secrets**. **Copy as curl** per call, **Copy all as JSON**, and **Clear trace**. Kept in memory only (the last 200 calls) |
| **Settings** | Facade base URL, authentication, extra headers, theme, and **Test connection** |

Every call shows the HTTP status, method and path, duration and `X-Correlation-Id`, plus the raw
response; the Trace tab keeps the full exchange. A live call only shows the response headers the facade
lists in `Access-Control-Expose-Headers`. Errors render the problem+json `title`, `detail`, `errorCode` and `violations`.

**Authentication** (Settings tab): none, API key (header name configurable), Bearer token (paste),
Basic, or OAuth 2.0 client credentials (token URL, client id/secret, scopes, client auth via Basic header
or form body). OAuth tokens are cached until they expire and refreshed once on a 401.

**Demo mode** is on until you turn it off: the app answers from the spec's examples, including the
facade's validation and business-rule errors (try `EMP-999999`, a price filter without a currency, or
submitting the same hire twice with a new key). Use it to show the UI before the facade exists.

**Storage:** settings are kept in this browser's `localStorage` only when "Remember settings" is ticked;
secrets (keys, passwords, tokens, client secret) only when "Also remember secrets" is ticked too.
**Reset** clears everything.

**CORS:** the browser calls the facade (and the OAuth token URL) directly, so both must allow CORS from
the page's origin and allow the `Authorization`, `X-API-Key`, `Idempotency-Key`, `X-Correlation-Id` and
`Content-Type` request headers. Expose `Location` and `X-Correlation-Id` so the app can show them. A
page opened from disk has the origin `null`. If the token endpoint has no CORS, get a token elsewhere
and paste it under **Bearer token**.

## Same facade, other backend protocols

The tool serves the same data over GraphQL and OData v4. `DATA_MAPPING.md` ends with the single-call
GraphQL and OData equivalents of the profile and snapshot reads, if your framework prefers them.
