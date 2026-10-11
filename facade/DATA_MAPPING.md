# Workforce & Catalog Experience API — data mapping

How to implement each operation of [`Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml`](Workforce_Catalog_Experience_API_OpenAPI_3_0_1.yaml)
in your API framework, on top of this tool's `/v1` REST API.

`B` below is the tool's base URL (for example `https://your-app.fly.dev`). Every backend call is a plain
HTTPS request; nothing here depends on a particular integration product.

- [Backend setup](#backend-setup)
- [Conventions used in every operation](#conventions-used-in-every-operation)
- [1. GET /people](#1-get-people--searchpeople)
- [2. GET /people/{employeeNumber}](#2-get-peopleemployeenumber--getpersonprofile)
- [3. POST /people/hires](#3-post-peoplehires--createhire)
- [4. GET /teams](#4-get-teams--listteams)
- [5. GET /teams/{departmentCode}/snapshot](#5-get-teamsdepartmentcodesnapshot--getteamsnapshot)
- [6. GET /catalog/items](#6-get-catalogitems--searchcatalogitems)
- [Error mapping](#error-mapping)
- [Error code catalog](#error-code-catalog)
- [Facade configuration](#facade-configuration)
- [Alternative backends: GraphQL and OData](#alternative-backends-graphql-and-odata)

---

## Backend setup

| Tool setting | Recommended | Why |
|---|---|---|
| `DATE_FORMAT` | `iso` | Timestamps arrive as ISO 8601 UTC. With any other format, convert every timestamp (see [Dates](#dates)). |
| `AUTH_MODE` | any | The facade holds its own backend credentials (see [Backend authentication](#backend-authentication)). |
| `SEED_EMPLOYEES` / `SEED_PRODUCTS` | defaults (250 / 500) | The spec's examples (`EMP-000005`, `ENG`, `ELEC`) exist with the default seed. |
| `REQUIRED_HEADERS` | optional | If set, add those headers to every backend call through facade configuration. |

Reference data in the default seed:

- Department codes: `ENG`, `SALES`, `MKT`, `FIN`, `HR`, `OPS`, `CS`, `LEGAL`, `PROD`, `SCM`
- Category codes: `ELEC`, `HOME`, `OUT`, `OFFICE`, `APP`, `TOYS`, `HEALTH`, `AUTO`, `BOOKS`, `IND`, `GARDEN`, `PANTRY`
- Employee numbers: `EMP-000001` … `EMP-000250`; the first 20 (8 %) are the managers everyone else reports to
- SKUs: `SKU-00001` … `SKU-00500`; currencies `USD`, `EUR`, `GBP`, `JPY`, `CAD`

## Conventions used in every operation

### Headers sent to the backend

| Header | Value |
|---|---|
| `Accept` | `application/json` |
| `X-Correlation-Id` | The caller's `X-Correlation-Id`, or a new UUID. The tool echoes it, and it shows in the tool's Inspector, so one id traces a facade call through every backend call. |
| Backend credentials | Per the tool's `AUTH_MODE` (below). **Never** forward the caller's own `Authorization` or `X-API-Key`. |
| `Idempotency-Key` | Only on `POST /v1/employees` (operation 3). |

Return the same `X-Correlation-Id` to the caller on every response, including errors (`correlationId` in the problem body).

### Backend authentication

| Tool `AUTH_MODE` | What the facade sends |
|---|---|
| `none` | nothing |
| `apikey` | `X-API-Key: <API_KEY>` (or the configured name/location) |
| `basic` | `Authorization: Basic base64(BASIC_USER:BASIC_PASS)` |
| `bearer` | `Authorization: Bearer <BEARER_TOKEN>` |
| `jwt`, `oauth2` | Client-credentials token from `POST B/oauth/token` (`grant_type=client_credentials`, `scope=read write`). Cache it until 60 s before `expires_in`; on a backend 401, refresh once and retry. Operation 2 needs `write`. |
| `hmac` | `Authorization: HMAC <keyId>:<sig>` plus `Date`, per the tool README's canonical string. |

### Dates

- Backend timestamps (`createdAt`, `updatedAt`, `issuedAt`, `expiresAt`, `discontinuedAt`) follow the tool's
  `DATE_FORMAT`. With `iso` they pass through. With `epoch-s` multiply by 1000; with `epoch-ms`, `rfc1123`,
  `iso-offset` or `custom`, parse and re-emit as ISO 8601 UTC with a `Z` suffix.
- Date-only fields (`hireDate`, `releaseDate`) are always `YYYY-MM-DD` and pass through.
- "Today" / `asOf` is the facade's clock in UTC.

### Money

Use the backend's decimal-string fields (`salaryDecimal`, `priceDecimal`), never the floats (`salary`,
`price`), for amounts. Do arithmetic in integer cents.

### Business keys

The facade never exposes backend integer `id`s. Lookups by business key are list calls with an equality
filter and `limit=1`; an empty `data` array means "not found". The tool's equality filter is
case-insensitive, so validate the key against the spec's pattern first (uppercase).

### Sparse fieldsets

Every `/v1` read below passes `fields=` so the backend sends only what the facade maps. This is an
optimisation; the mappings are the same without it.

---

## 1. GET /people — searchPeople

**Scope:** `people.read`. **Backend calls:** 1, or 3 in parallel for a name/email search.

### Facade-side validation

| Check | Error |
|---|---|
| `q` 2–100 characters, `department` matches `^[A-Z]{2,10}$`, `status` and `pageSize` valid | 400 `REQUEST_VALIDATION_FAILED` |
| `pageToken` not decodable, or its filter hash differs from this request's | 400 `INVALID_PAGE_TOKEN` |

An unknown `department` code is not an error: it matches nobody, so the page is empty.

### Orchestration

Every backend call below carries the common filters `F`:

```
F = [department.code={department}] [&isActive=true|false   (status ACTIVE | INACTIVE)]
    &fields=employeeNumber,firstName,lastName,title,email,department,isActive
```

The embedded `department` object is filterable, so no department lookup is needed. Pick one of
three strategies from `q`:

```
A. no q
   GET B/v1/employees?{F}&sort=lastName,firstName&offset={o}&limit={pageSize}
     totalMatches = meta.total

B. q looks like an employee number (^EMP-?[0-9]*$, case-insensitive), or contains a space
   EMP number:  GET B/v1/employees?{F}&employeeNumber[like]={q}&sort=lastName,firstName&offset={o}&limit={pageSize}
   "dana whit": GET B/v1/employees?{F}&firstName[like]=dana&lastName[like]=whit&sort=…&offset={o}&limit={pageSize}
                (first word → given name, the rest → family name)
     totalMatches = meta.total

C. any other q: three calls in parallel, each {F}&limit=200
   GET B/v1/employees?{F}&firstName[like]={q}&limit=200
   GET B/v1/employees?{F}&lastName[like]={q}&limit=200
   GET B/v1/employees?{F}&email[like]={q}&limit=200
     any meta.total > FACADE_SEARCH_FIELD_LIMIT (200)        → 400 QUERY_TOO_BROAD
     merge the three data[] arrays, de-duplicate by employeeNumber,
     sort by lastName, then firstName (case-insensitive), then employeeNumber
     totalMatches = merged count; this page = merged[o, o + pageSize)
```

`[like]` is a case-insensitive substring match. URL-encode `q` in every call. Strategy C is the
de-duplication pattern: one person can match on given name and on email, and must appear once.

`nextPageToken` = `o + pageSize < totalMatches ? encode({o: o + pageSize, h: filterHash}) : null`, with
the same token format as operation 6 (the hash covers `q`, `department` and `status`).

### Response mapping (`DirectoryEntry`)

| Facade field | Source | Rule |
|---|---|---|
| `employeeNumber` | `employeeNumber` | |
| `displayName` | `firstName`, `lastName` | `firstName + " " + lastName` |
| `jobTitle` | `title` | |
| `email` | `email` | |
| `department` | `department.code` / `.name` | embedded by `/v1` |
| `employmentStatus` | `isActive` | `ACTIVE` / `INACTIVE` |

---

## 2. GET /people/{employeeNumber} — getPersonProfile

**Scope:** `people.read`. **Backend calls:** 1, then 2 in parallel.

```
validate employeeNumber against ^EMP-[0-9]{6}$            → else 400 INVALID_EMPLOYEE_NUMBER

① GET B/v1/employees?employeeNumber={employeeNumber}&limit=1
     data == []                                             → 404 PERSON_NOT_FOUND
     emp = data[0]

② in parallel:
   a. if emp.managerId != null:
        GET B/v1/employees/{emp.managerId}?fields=employeeNumber,firstName,lastName,title,email
        404 → manager = null (dangling reference: log a warning, do not fail)
   b. GET B/v1/employees?managerId={emp.id}&isActive=true&sort=lastName,firstName&limit=50
          &fields=employeeNumber,firstName,lastName,title,email
        reports = data, reportCount = meta.total
```

### Response mapping (`PersonProfile`)

| Facade field | Source | Rule |
|---|---|---|
| `employeeNumber` | `emp.employeeNumber` | |
| `displayName` | `emp.firstName`, `emp.lastName` | `firstName + " " + lastName` |
| `givenName` | `emp.firstName` | |
| `familyName` | `emp.lastName` | |
| `email` | `emp.email` | |
| `jobTitle` | `emp.title` | |
| `level` | `emp.level` | `L1`…`L7`, unchanged |
| `employmentStatus` | `emp.isActive` | `true` → `ACTIVE`, `false` → `INACTIVE` |
| `hireDate` | `emp.hireDate` | unchanged |
| `tenureYears` | `emp.hireDate` | `floor(daysBetween(hireDate, today) / 365.25 × 10) / 10`; `0` if negative |
| `department.code` / `.name` | `emp.department.code` / `.name` | `department` is embedded by `/v1`; if it is `null`, answer 502 `BACKEND_INVALID_RESPONSE` |
| `manager` | call ②a | `null` when `managerId` is null or the manager is missing; otherwise a `PersonSummary` (below) |
| `directReports.count` | call ②b `meta.total` | |
| `directReports.items[]` | call ②b `data[]` | each as a `PersonSummary` |
| `skills` | `emp.skills` | unchanged |
| `certifications[].name` | `emp.certifications[].name` | |
| `certifications[].issuedOn` | `.issuedAt` | UTC date part (`YYYY-MM-DD`) |
| `certifications[].expiresOn` | `.expiresAt` | UTC date part, or `null` |
| `certifications[].status` | `.expiresAt` | `null` → `NO_EXPIRY`; before today → `EXPIRED`; within 90 days → `EXPIRING_SOON`; else `VALID` |
| `contact.email` | `emp.email` | |
| `contact.workPhone` | `emp.phoneNumbers[]` | first with `type == "work"`, else first `"mobile"`, else `null` (never `home` or `fax`) |
| `contact.workLocation` | `emp.address` | `city`, `region`, `postalCode`, `countryCode`; omit the whole object when `countryCode` is missing (records created without an address) |
| `hasPhoto` | `emp.avatarFileId` | `!= null` |
| `lastUpdatedAt` | `emp.updatedAt` | ISO 8601 UTC |

**PersonSummary** (manager and each direct report): `employeeNumber`, `displayName` (as above),
`jobTitle` ← `title`, `email`.

**Deliberately dropped** (data minimisation): `id`, `uuid`, `salary`, `salaryDecimal`,
`performanceRating`, `address.street`, `address.geo`, `metadata`, `departmentId`, `managerId`,
`createdAt`, `phoneNumbers` other than the chosen one.

---

## 3. POST /people/hires — createHire

**Scope:** `people.write`. **Backend calls:** up to 3 lookups in parallel, then 1 create.

### Facade-side validation (no backend call)

| Check | Error |
|---|---|
| Body matches `HireRequest` | 400 `REQUEST_VALIDATION_FAILED` with `violations[]` |
| `Idempotency-Key` present, 8–128 chars | 400 `IDEMPOTENCY_KEY_REQUIRED` |
| `startDate` ≥ today − 30 days | 422 `START_DATE_TOO_EARLY` |
| `annualSalary.currency` == `FACADE_PAYROLL_CURRENCY` | 422 `UNSUPPORTED_SALARY_CURRENCY` (the backend stores salaries without a currency) |

### Orchestration

```
key = "facade-hire:" + Idempotency-Key       (namespaced: the tool's idempotency store is shared by all clients)

① in parallel:
   a. GET B/v1/departments?code={departmentCode}&limit=1&fields=id,code,name
        data == []                                → 422 UNKNOWN_DEPARTMENT   (field departmentCode)
   b. if managerEmployeeNumber:
        GET B/v1/employees?employeeNumber={managerEmployeeNumber}&limit=1
            &fields=id,employeeNumber,firstName,lastName,title,email,isActive
        data == []                                → 422 UNKNOWN_MANAGER      (field managerEmployeeNumber)
        isActive == false                         → 422 MANAGER_INACTIVE     (field managerEmployeeNumber)
   c. GET B/v1/employees?email={urlencode(lowercase(email))}&limit=1
        found and found.metadata.hireRequestId == Idempotency-Key
                                                  → replay: skip ②, build the 201 from `found`
        found otherwise                           → 409 PERSON_ALREADY_EXISTS (detail names its employeeNumber)

② POST B/v1/employees
     Content-Type: application/json
     Idempotency-Key: {key}
     X-Correlation-Id: {correlationId}
     body: (mapping below)
   201 → created = body
   409 → 409 IDEMPOTENCY_KEY_REUSED (same key, different body)
   400/422 → 422 BACKEND_VALIDATION_FAILED, violations mapped back to facade field names

③ 201 to the caller
     Location: {facadeBase}/people/{created.employeeNumber}
     body: PersonProfile built from `created` as in operation 2, with
           manager = the employee from ①b (or null), directReports = {count: 0, items: []}
```

Run ①c even on a retry: a client that times out and retries with the same key finds its own record and
gets the same 201 instead of a 409. The backend's own idempotency (step ②) covers the narrower race of
two identical requests arriving together.

### Request mapping (`HireRequest` → `/v1` employee)

| `/v1` field | Source | Rule |
|---|---|---|
| `firstName` | `givenName` | trimmed |
| `lastName` | `familyName` | trimmed |
| `email` | `email` | lower-cased |
| `title` | `jobTitle` | |
| `level` | `level` | |
| `isActive` | — | `true` |
| `departmentId` | call ①a | `data[0].id` |
| `managerId` | call ①b | `data[0].id`, or `null` |
| `hireDate` | `startDate` | |
| `salaryDecimal` | `annualSalary.amount` | the backend derives `salary` from it |
| `skills` | `skills` | `[]` when absent |
| `address` | `workLocation` | `{city, region, postalCode, countryCode}`; omit when absent |
| `phoneNumbers` | `workPhone` | `[{type: "work", number}]`, or `[]` |
| `certifications` | — | `[]` |
| `performanceRating` | — | `null` |
| `metadata` | — | `{source: "workforce-facade", hireRequestId: <Idempotency-Key>, requestedBy: <caller client id>}` |

The backend assigns `id`, `uuid`, `employeeNumber`, `createdAt` and `updatedAt`.

**Violation field names** from a backend 400/422, mapped back: `firstName` → `givenName`,
`lastName` → `familyName`, `title` → `jobTitle`, `departmentId` → `departmentCode`,
`managerId` → `managerEmployeeNumber`, `hireDate` → `startDate`, `salaryDecimal` → `annualSalary.amount`,
`address.*` → `workLocation.*`, `phoneNumbers` → `workPhone`.

**Known limitation:** the backend does not enforce unique emails, so two *different* idempotency keys
with the same email arriving at the same moment can both pass ①c. A production facade serialises hires
per email (a short lock) if that matters.

---

## 4. GET /teams — listTeams

**Scope:** `teams.read`. **Backend calls:** 1 + ⌈active employees / 200⌉, in parallel.

```
① in parallel:
   a. GET B/v1/departments?sort=name&limit=200&fields=id,code,name
   b. offset = 0; repeat
        GET B/v1/employees?isActive=true&offset={offset}&limit=200&fields=departmentId
        offset += 200
      until offset >= meta.total
② counts = number of b rows per departmentId
   items  = a.data.map(d → {code: d.code, name: d.name, activeHeadcount: counts[d.id] ?? 0})
```

With the default seed (250 employees, about 225 active) ① b is two calls. A department with no active
employees is still listed, with `activeHeadcount: 0`.

**Caching (optional):** the list changes only when employees or departments change. Cache it for
`FACADE_TEAMS_TTL_SECONDS`, and evict it from the same `employees` / `departments` webhooks as the
snapshot cache (operation 5).

**One-call OData alternative:**
`GET B/odata/v4/Departments?$select=code,name&$orderby=name&$expand=employees($filter=isActive eq true;$count=true;$top=0)`
returns each department with `employees@odata.count` and no employee rows.

---

## 5. GET /teams/{departmentCode}/snapshot — getTeamSnapshot

**Scope:** `teams.read` (+ `compensation.read` for `payroll`). **Backend calls:** 1 + ⌈members / 200⌉.

```
validate departmentCode against ^[A-Z]{2,10}$             → else 400 INVALID_DEPARTMENT_CODE

① GET B/v1/departments?code={departmentCode}&limit=1&fields=id,code,name
     data == []                                             → 404 TEAM_NOT_FOUND
     dept = data[0]

② offset = 0
   repeat:
     GET B/v1/departments/{dept.id}/employees?offset={offset}&limit=200
         &fields=isActive,level,hireDate,performanceRating,skills,certifications[,salaryDecimal]
     members += data
     offset += 200
   until offset >= meta.total          (stop after 50 pages and answer 502 BACKEND_INVALID_RESPONSE)

   Request salaryDecimal only when the caller has compensation.read.

③ asOf = now (UTC); compute the snapshot
```

With the default seed a department has roughly 25 members, so ② is a single call.

### Aggregation rules (`TeamSnapshot`)

"Active" means `isActive == true`. Everything except `headcount` and `newHiresLast12Months` counts
active members only.

| Facade field | Rule |
|---|---|
| `department` | `{code, name}` from ① |
| `asOf` | the facade's clock, ISO 8601 UTC |
| `headcount.total` / `.active` / `.inactive` | all members / active / inactive |
| `levelMix` | seven entries `L1`…`L7` in order, `count` of active members at that level (0 included) |
| `tenure.averageYears` | mean of each active member's tenure (same formula as `tenureYears`), one decimal; `0` when no active members |
| `tenure.newHiresLast12Months` | all members with `hireDate` in (`asOf` − 365 days, `asOf`] |
| `performance.ratedEmployees` | active members with `performanceRating != null` |
| `performance.averageRating` | mean of those ratings, two decimals; `null` when none are rated |
| `topSkills` | count active members per skill (exact string), sort by count desc then skill asc, first five |
| `certifications.certifiedEmployees` | active members with ≥ 1 certification whose `expiresAt` is null or after `asOf` |
| `certifications.expiringWithin90Days` | certifications of active members with `asOf` < `expiresAt` ≤ `asOf` + 90 days |
| `payroll` | **omit the property entirely** without `compensation.read` |
| `payroll.annualTotal` | sum of active `salaryDecimal`, in cents |
| `payroll.averageSalary` | total ÷ active count, rounded half-up to cents; `"0.00"` when no active members |
| `payroll.medianSalary` | median of active salaries (mean of the middle two for an even count) |
| `payroll.*.currency` | `FACADE_PAYROLL_CURRENCY` |

**Caching (optional):** cache a snapshot per department for `FACADE_SNAPSHOT_TTL_SECONDS`. To keep it
fresh, add a webhook on the tool's **Webhooks** page for `employees` created/updated/deleted pointing at
the facade, and evict the cache entry for the event's department. Cache the payroll and non-payroll
variants separately.

---

## 6. GET /catalog/items — searchCatalogItems

**Scope:** `catalog.read`. **Backend calls:** 1 (+1 for an uncached category lookup).

### Facade-side validation

| Check | Error |
|---|---|
| `minPrice` or `maxPrice` without `currency` | 400 `CURRENCY_REQUIRED` |
| `minPrice` > `maxPrice` | 400 `INVALID_PRICE_RANGE` |
| `pageToken` not decodable, or its filter hash differs from this request's | 400 `INVALID_PAGE_TOKEN` |
| Other parameter errors (enum, range) | 400 `REQUEST_VALIDATION_FAILED` |

### Orchestration

```
① if category:
     categoryId = cache[category] ?? GET B/v1/categories?code={category}&limit=1&fields=id,code,name
     not found                                               → 400 UNKNOWN_CATEGORY
   (12 categories: cache the code → id map for 10 minutes)
   Single-call alternative: skip ① and filter `category.code={category}` on ② (the embedded
   category is filterable); an unknown code then returns an empty page instead of 400.

② GET B/v1/products?{mapped query}
     &fields=sku,name,description,category,priceDecimal,currency,stockQty,rating,tags,variants,
             releaseDate,discontinuedAt,updatedAt

③ map data[] to CatalogItem; totalMatches = meta.total;
   nextPageToken = offset + limit < meta.total ? encode({o: offset + limit, h: filterHash}) : null
```

### Query mapping (facade → `/v1/products`)

`T` = `FACADE_LOW_STOCK_THRESHOLD` (default 25).

| Facade parameter | `/v1/products` query |
|---|---|
| `q` | `q={q}` (the tool's full-text search over every field: name, description, tags, SKU, variants) |
| `category` | `categoryId={id from ①}` |
| `availability=IN_STOCK` | `stockQty[gte]={T}` |
| `availability=LOW_STOCK` | `stockQty[gt]=0&stockQty[lt]={T}` |
| `availability=OUT_OF_STOCK` | `stockQty=0` |
| `currency` | `currency={currency}` |
| `minPrice` | `price[gte]={minPrice}` |
| `maxPrice` | `price[lte]={maxPrice}` |
| `tag` | `tags={tag}` (equality on an array matches any element) |
| `includeDiscontinued` absent/`false` | `discontinuedAt[exists]=false` |
| `includeDiscontinued=true` | nothing |
| `sort=name` (default) | `sort=name` |
| `sort=price_asc` | `sort=price,name` |
| `sort=price_desc` | `sort=-price,name` |
| `sort=rating_desc` | `sort=-rating,name&rating[exists]=true` (the backend sorts nulls first on a descending sort, so unrated items are filtered out, as the spec says) |
| `sort=newest` | `sort=-releaseDate,name` |
| `pageSize` (default 20, max 100) | `limit={pageSize}` |
| `pageToken` | `offset={decoded o}`; no token → `offset=0` |

**Page token:** `base64url(JSON {o: <offset>, h: <first 6 hex chars of sha256 of the normalised filters + sort>})`.
The hash stops a token from one search being replayed against another. Tokens are not secret.

### Response mapping (`CatalogItem`)

| Facade field | Source | Rule |
|---|---|---|
| `sku` | `sku` | |
| `name` | `name` | |
| `summary` | `description` | text up to and including the first `. `; if longer than 160 characters, cut at 159 code points and add `…`. Count code points, not UTF-16 units: descriptions contain emoji and accented text. |
| `category.code` / `.name` | `category.code` / `.name` | embedded by `/v1` |
| `price.amount` | `priceDecimal` | |
| `price.currency` | `currency` | |
| `availability.status` | `stockQty` | `0` → `OUT_OF_STOCK`; `< T` → `LOW_STOCK`; else `IN_STOCK` |
| `availability.quantityOnHand` | `stockQty` | |
| `rating` | `rating` | `null` stays `null` |
| `tags` | `tags` | |
| `variantOptions.sizes` | `variants[].size` | distinct, in `XS, S, M, L, XL` order |
| `variantOptions.colors` | `variants[].color` | distinct, alphabetical |
| `releaseDate` | `releaseDate` | |
| `discontinued` | `discontinuedAt` | `!= null` |
| `lastUpdatedAt` | `updatedAt` | ISO 8601 UTC |

---

## Error mapping

Backend failures are the facade's problem, not the caller's: a backend 401 is never returned as 401.

| Backend outcome (any call) | Facade response | `errorCode` | Notes |
|---|---|---|---|
| 400 on a facade-built query | 502 | `BACKEND_REJECTED_REQUEST` | A facade mapping bug; log the backend `detail`. |
| 401 / 403 | 502 | `BACKEND_AUTH_FAILED` | For `jwt`/`oauth2`, refresh the token and retry once first. Alert. |
| 404 on a key lookup | per operation | `PERSON_NOT_FOUND` / `TEAM_NOT_FOUND` | Lookups by filter return 200 + empty `data`, not 404. |
| 404 on the manager GET | — | — | `manager: null`, logged. |
| 409 on `POST /v1/employees` | 409 | `IDEMPOTENCY_KEY_REUSED` | |
| 422 on `POST /v1/employees` | 422 | `BACKEND_VALIDATION_FAILED` | Violations renamed to facade fields. |
| 429 | 503 + `Retry-After` | `BACKEND_UNAVAILABLE` | Pass the backend's `Retry-After` through. The facade's own rate limit is a separate 429. |
| 500 | 502 | `BACKEND_ERROR` | |
| 503 | 503 + `Retry-After` | `BACKEND_UNAVAILABLE` | |
| No answer within `FACADE_BACKEND_TIMEOUT_MS` | 504 | `BACKEND_TIMEOUT` | |
| Malformed or truncated JSON, empty body, wrong `Content-Type` | 502 | `BACKEND_INVALID_RESPONSE` | |
| Connection reset | 502 | `BACKEND_ERROR` | After one retry for GETs. |

**Retries:** GETs retry once on 502, 503, 504, timeout or connection reset, waiting the backend's
`Retry-After` if it is ≤ 2 s (else fail fast). The `POST /v1/employees` call may retry with the
**same** `Idempotency-Key`; never with a new one.

Log the backend problem's `requestId` with the correlation id on every mapped error.

### Testing the error mapping with the tool's chaos

| To see | Do this on the tool |
|---|---|
| 503 / 504 / 502 paths | Chaos page: set `ERROR_RATE` with types `503`, `timeout`, `500`, or a per-route override on `/v1/employees` only |
| `BACKEND_INVALID_RESPONSE` | Chaos types `malformed-json`, `truncated-body`, `empty-body`, `wrong-content-type` |
| Connection reset retry | Chaos type `reset` |
| Backend 429 → facade 503 | `RATE_LIMIT_RPM=5`, then call `/teams/ENG/snapshot` repeatedly |
| `BACKEND_AUTH_FAILED` | Change `AUTH_MODE` or the API key on the tool without updating the facade |
| Deterministic, per request | In non-production, let the facade forward an allow-listed `X-Force-Error` / `X-Force-Latency` header to the backend |

Turn on **Record API calls** on the Inspector page to see every backend call the facade made, with the
shared `X-Correlation-Id`.

## Error code catalog

| `errorCode` | Status | Operation(s) |
|---|---|---|
| `REQUEST_VALIDATION_FAILED` | 400 | all |
| `INVALID_EMPLOYEE_NUMBER` | 400 | 2 |
| `INVALID_DEPARTMENT_CODE` | 400 | 5 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 3 |
| `CURRENCY_REQUIRED` | 400 | 6 |
| `INVALID_PRICE_RANGE` | 400 | 6 |
| `INVALID_PAGE_TOKEN` | 400 | 1, 6 |
| `UNKNOWN_CATEGORY` | 400 | 6 |
| `QUERY_TOO_BROAD` | 400 | 1 |
| `AUTHENTICATION_REQUIRED` | 401 | all |
| `INSUFFICIENT_SCOPE` | 403 | all |
| `PERSON_NOT_FOUND` | 404 | 2 |
| `TEAM_NOT_FOUND` | 404 | 5 |
| `PERSON_ALREADY_EXISTS` | 409 | 3 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 3 |
| `UNKNOWN_DEPARTMENT` | 422 | 3 |
| `UNKNOWN_MANAGER` | 422 | 3 |
| `MANAGER_INACTIVE` | 422 | 3 |
| `START_DATE_TOO_EARLY` | 422 | 3 |
| `UNSUPPORTED_SALARY_CURRENCY` | 422 | 3 |
| `BACKEND_VALIDATION_FAILED` | 422 | 3 |
| `RATE_LIMIT_EXCEEDED` | 429 | all (the facade's own limit) |
| `BACKEND_REJECTED_REQUEST` | 502 | all |
| `BACKEND_AUTH_FAILED` | 502 | all |
| `BACKEND_ERROR` | 502 | all |
| `BACKEND_INVALID_RESPONSE` | 502 | all |
| `BACKEND_UNAVAILABLE` | 503 | all |
| `BACKEND_TIMEOUT` | 504 | all |

## Facade configuration

| Setting | Default | Used by |
|---|---|---|
| `BACKEND_BASE_URL` | — | all (`B`) |
| Backend credentials | — | all, per the tool's `AUTH_MODE` |
| `FACADE_BACKEND_TIMEOUT_MS` | `5000` | all (per backend call) |
| `FACADE_REQUEST_TIMEOUT_MS` | `10000` | all (whole facade request) |
| `FACADE_PAYROLL_CURRENCY` | `USD` | 3, 5 |
| `FACADE_LOW_STOCK_THRESHOLD` | `25` | 6 |
| `FACADE_DIRECT_REPORTS_MAX` | `50` | 2 (must not exceed the spec's `maxItems`) |
| `FACADE_SNAPSHOT_TTL_SECONDS` | `0` (off) | 5 |
| `FACADE_SEARCH_FIELD_LIMIT` | `200` | 1 (per-field match cap before `QUERY_TOO_BROAD`) |
| `FACADE_TEAMS_TTL_SECONDS` | `0` (off) | 4 |
| `FACADE_FORWARD_CHAOS_HEADERS` | `false` | all (non-production only) |

## Alternative backends: GraphQL and OData

The tool serves the same data over GraphQL and OData v4, so the same facade can be built with fewer
calls. The response mappings above stay the same; only the backend calls change.

**Person profile in one GraphQL call** (`POST B/graphql`):

```graphql
query Profile($num: String!) {
  employees(limit: 1, filter: [{ field: "employeeNumber", op: eq, value: $num }]) {
    items {
      employeeNumber firstName lastName email title level isActive hireDate skills
      avatarFileId updatedAt
      department { code name }
      certifications { name issuedAt expiresAt }
      phoneNumbers { type number }
      address { city region postalCode countryCode }
      manager { employeeNumber firstName lastName title email }
      directReports { employeeNumber firstName lastName title email isActive }
    }
  }
}
```

`directReports` here is unfiltered: keep the active ones, sort by `lastName`, `firstName`, take 50 and
use the filtered count. GraphQL execution errors arrive as HTTP 200 with `errors[]`; treat any `errors`
entry as a backend failure (502), and HTTP 401/429/503 as in the error mapping.

**Person profile in one OData call:**

```
GET B/odata/v4/Employees?$filter=employeeNumber eq 'EMP-000005'
    &$expand=department,manager,directReports($filter=isActive eq true;$orderby=lastName,firstName;$top=50;$count=true)
```

**Team snapshot via OData:** `GET B/odata/v4/Departments?$filter=code eq 'ENG'&$expand=employees`, or
page `Employees?$filter=departmentId eq {id}` with `@odata.nextLink`. OData error bodies are
`{"error":{"code","message"}}`; map them by HTTP status as above.

Pick one backend protocol per facade; mixing them adds nothing but extra failure modes.
