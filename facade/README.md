# Facade API sample — Workforce & Catalog Experience API

A ready-made contract for building a **facade (experience) API** in your API framework or integration
platform, on top of this tool. The facade orchestrates several calls to the tool's `/v1` REST API and
returns aggregated, business-friendly objects, so you can demo or test orchestration, aggregation,
data minimisation, idempotent writes and backend error mapping against a realistic system of record.

| File | What it is |
|---|---|
| [`Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml`](Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml) | The facade contract (OpenAPI 3.0.1), with examples for every response |
| [`DATA_MAPPING.md`](DATA_MAPPING.md) | For each operation: the backend calls, their order, field-by-field mappings, aggregation rules, error mapping and configuration |

## The four operations

| Operation | What the facade does | Backend calls |
|---|---|---|
| `GET /people/{employeeNumber}` | 360° profile: employee, department, manager and active direct reports; salary, home address and metadata removed; tenure and certification status derived | 1, then 2 in parallel |
| `POST /people/hires` | Onboarding: resolves department by code and manager by employee number, rejects duplicate emails, creates the record idempotently, returns the new profile | 3 in parallel, then 1 create |
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

## Same facade, other backend protocols

The tool serves the same data over GraphQL and OData v4. `DATA_MAPPING.md` ends with the single-call
GraphQL and OData equivalents of the profile and snapshot reads, if your framework prefers them.
