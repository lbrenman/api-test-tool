# Multi-protocol support — design

Status: **proposed** (step 1 implemented on branch `feat/protocol-error-renderers`)
Date: 2026-10-07

## Goal

The integration platform under test can:

| Direction | Protocols | What this tool must be |
|---|---|---|
| **Calls** (outgoing) | REST, **SOAP, SSE, OData, GraphQL** | a mock *target* for each |
| **Exposes** (incoming) | REST, **SOAP, WebSocket** | a *tester* (client) for each |

Add these without turning the codebase into five parallel apps.

## Principles

1. **One dataset, many projections.** SOAP, OData and GraphQL serve the *same* employees /
   products / departments / categories through `ctx.resources`. No protocol owns data.
2. **One shared spine.** Required headers, rate limiting, the 7 auth modes, chaos and the inspector
   are protocol-agnostic and run once, in one order, for every protocol (`protocolStack`).
3. **Protocol-native errors.** The spine never formats errors itself; it calls `sendProblem`, and a
   per-protocol *error renderer* decides the shape (problem+json, SOAP Fault, OData error, GraphQL
   `errors[]`).
4. **Contracts in their own language.** OpenAPI for REST (+ SSE), WSDL for SOAP, CSDL `$metadata`
   for OData, SDL for GraphQL, AsyncAPI for WebSocket. No forcing everything into OpenAPI.
5. **Tester = core + adapters.** Proxying, auth profiles, variables/ID chaining, run history and
   reports are shared; parsing, sample generation and validation are per contract type.
6. **Each protocol can be switched off** (`PROTOCOLS_ENABLED`), and costs nothing when off.

## Architecture

```
                       ┌──────────────── shared spine (middleware/protocol.js) ────────────────┐
request ─► requestId ─►│ errorFormat ─► body parser ─► required headers ─► rate limit ─► auth ─► chaos │─► protocol handler
                       └─────────────────────────────────────────────────────────────────────────┘        │
                                         sendProblem(req, …) ─► renderer[req.errorFormat]                  ▼
                                                                                          ctx.resources (one dataset)
```

### Error renderers (step 1 — done)

`src/util/problem.js` keeps `sendProblem(req, res, status, opts)` as the single error path and adds
a registry:

```js
registerErrorRenderer('soap', (problem, req) => ({ status, contentType, body, headers }));
```

`problem` is the usual problem+json object (status, detail, code, errors, requestId, …), so every
format carries the same information. Caller headers (`WWW-Authenticate`, `Retry-After`) are always
kept. A renderer that throws falls back to problem+json. Unknown/unset format = problem+json.

| Format | Shape | HTTP status |
|---|---|---|
| `problem` | RFC 9457 problem+json | as given |
| `soap` (step 2) | SOAP 1.1 `faultcode/faultstring/detail` or 1.2 `Code/Subcode/Reason/Detail`, by request version | 1.1: 500 for faults (4xx kept for transport-level 401/429 so clients see the challenge); 1.2: as given |
| `odata` (step 6) | `{"error":{"code","message","target","details":[]}}` | as given |
| `graphql` (step 5) | `{"data":null,"errors":[{"message","extensions":{"code","status","requestId"}}]}` | 200 for execution errors; real 4xx/5xx for transport errors (auth, rate limit, chaos statuses) |
| `sse` (step 4) | before the stream starts: problem+json; after: `event: error` frame | — |

### Shared stack (step 1 — done)

`protocolStack(ctx, { format, body })` returns
`[errorFormat, body…, requiredHeaders, rateLimit, auth, chaos]`. The middleware instances are created
once per context, so **`RATE_LIMIT_RPM` is one budget per client across all protocols**. `/v1` now
uses this stack (+ idempotency, which stays REST-only). Behaviour of `/v1` is unchanged.

Chaos body corruptions (`malformed-json`, `truncated-body`, `slow-drip`, …) already operate on the
raw string, so they work for XML too. Step 2 may add protocol-specific variants
(`malformed-xml`, `fault-in-200`) via an optional renderer hook.

## Outgoing: mock targets

New reserved prefixes: `/soap`, `/odata`, `/graphql`, `/sse`, `/ws`. Each is a router under
`src/protocols/<name>/` with `router.js`, optional `contract.js` (WSDL/CSDL/SDL generator using the
resolved base URL) and `renderer.js`.

### SOAP — `/soap/EmployeeService`, `/soap/ProductService`
- `?wsdl` generated live; SOAP 1.1 and 1.2 bindings, document/literal.
- Operations: `GetEmployee`, `ListEmployees` (page/size elements + total), `CreateEmployee`,
  `UpdateEmployee`, `DeleteEmployee`; same for products.
- Version detection: `text/xml` + `SOAPAction` (1.1) vs `application/soap+xml; action=` (1.2).
  Mismatched or missing action → fault (a common integration bug).
- Hand-rolled with `fast-xml-parser` (not `node-soap`) so chaos can emit broken XML deliberately.
- Auth: the same 7 HTTP modes, plus `SOAP_WSSE=off|optional|required` for a WS-Security
  UsernameToken (PasswordText and PasswordDigest). Not an 8th auth mode, so the Newman matrix and
  guide tests stay at 7.
- Later: MTOM attachments backed by the shared file pool.

### SSE — `/sse/*`
- `/sse/changes`: live change feed of create/update/delete across all protocols (emitted by
  `ctx.resources`). `/sse/ticks`: synthetic, configurable interval/count/event names.
- `POST /sse/stream`: JSON request → event-stream response (LLM/MCP-style streaming).
- `Last-Event-ID` resume (ring buffer), `retry:`, heartbeat comments.
- Chaos: mid-stream disconnect, malformed frame, skipped ids, slow drip.
- Documented in the data OpenAPI spec (`text/event-stream`).

### GraphQL — `/graphql`
- Reference `graphql` package only; GraphiQL from CDN on GET with `Accept: text/html`; SDL at
  `/graphql/schema.graphql`.
- Queries with offset args **and** Relay connections; mutations for CRUD; nested
  `department`/`category`/`employees` resolvers.
- GraphQL chaos: partial data + `errors[]`, `extensions.code`, depth/complexity rejections.
- Settings: `GRAPHQL_INTROSPECTION`, `GRAPHQL_MAX_DEPTH`.

### OData — `/odata/v4/`, optional `/odata/v2/`
- Service document, `$metadata` (CSDL XML), entity sets, key access `Employees(1)`, navigation.
- `$filter` (in-house parser: `eq ne gt ge lt le and or not`, `contains`, `startswith`, `endswith`)
  compiled into the same filter structure `/v1` uses; `$select`, `$expand`, `$orderby`, `$top`,
  `$skip`, `$count`, `@odata.nextLink`. `$batch` later.
- v2: `d.results`, `__count`, `__next` envelope (relevant for SAP-style consumers).
- Setting: `ODATA_MAX_PAGE_SIZE`.

### WebSocket — `/ws/echo`, `/ws/changes`
Only to give the WebSocket tester (below) a self-test target and CI coverage. Auth runs on the
upgrade request through the same spine.

## Incoming: tester adapters

`tester_specs` gain a `kind`: `openapi | wsdl | asyncapi | scripted` (existing rows default to
`openapi`). `src/services/tester/` splits into:

```
tester/core/      proxy (fetch), auth profiles, variables + chaining, runs, reports
tester/adapters/  openapi/  wsdl/  websocket/
```

Adapter interface:

```js
{
  kind, detect(content),          // sniff on upload
  load(content|url) -> doc,
  lint(doc) -> findings[],
  operations(doc) -> ops[],
  sampleRequest(doc, op, example?) -> request,
  execute(request, target, auth) -> exchange,   // default: HTTP via core proxy
  validate(doc, op, exchange) -> checks[],
  planRunAll(doc, ops, { negative }) -> steps[],
}
```

The existing OpenAPI code moves into `adapters/openapi` with no behaviour change.

### WSDL adapter (SOAP exposed by the platform)
- Parse WSDL 1.1 + imported/included XSDs; operations per binding/port; endpoint override for
  placeholder `soap:address` values.
- Sample envelopes from XSD (enumerations, patterns via the existing generator, `minOccurs`,
  `nillable`, `choice`).
- Validate: status (1.1 faults = 500), content type per version, envelope structure, fault
  detection, body against XSD via `xmllint-wasm` (libxml2 in WASM — no native build).
- Lint: unresolved imports, rpc vs document mismatch, missing `soapAction`, placeholder addresses,
  types referenced but undefined.
- Negative tests: no auth → 401/fault, schema-invalid body → Client/Sender fault, unknown
  operation → fault.
- "Mock from WSDL" mirrors "mock from spec" via inspector rules under `/mock/<name>`.

### WebSocket adapter (WebSocket exposed by the platform)
- Contract optional: AsyncAPI 2.x/3.0 (channels, messages, JSON Schema payloads → Ajv), or a
  hand-written **scripted** scenario.
- Server-held connections (`ws` client — needed for custom upgrade headers); the dashboard sends via
  `POST /admin/api/tester/ws/<session>/send` and receives frames over SSE.
- Auth profiles: upgrade header (reusing Bearer/API key/Basic/OAuth client-credentials), query
  token, token in `Sec-WebSocket-Protocol`, or first-message auth template.
- Scenario steps: `send`, `expect` (JSONPath / schema / correlation id, with timeout), `capture`,
  `wait`, `ping`, `close`. Assertions on 101 upgrade, negotiated subprotocol, ordering, message
  counts in a window, close code.
- Negative tests: no auth → 401/403 upgrade or close 1008; malformed JSON → error message or
  1003/1007; oversized frame → 1009; idle timeout behaviour.
- Lint (AsyncAPI): placeholder servers, messages without payload schema, `ws`/`wss` mismatch,
  missing security schemes.

## Cross-cutting

- **Inspector:** reserved-path list gains the new prefixes; `INSPECTOR_LOG_ALL` covers them; detail
  pane pretty-prints XML, shows `SOAPAction`/SOAP version, GraphQL `operationName`, OData system
  query options.
- **Settings** (DEFS + `.env.example` + README env table): `PROTOCOLS_ENABLED`, `SOAP_WSSE`,
  `SOAP_DEFAULT_VERSION`, `SSE_TICK_INTERVAL_MS`, `SSE_HEARTBEAT_MS`, `SSE_REPLAY_BUFFER`,
  `GRAPHQL_INTROSPECTION`, `GRAPHQL_MAX_DEPTH`, `ODATA_MAX_PAGE_SIZE`, `WS_MAX_MESSAGE_KB`.
- **Contracts list:** `/health` and the Overview page list every live contract URL. The data and
  admin OpenAPI specs stay separate and non-overlapping.
- **Dashboard:** one new **Protocols** page (tab per protocol: endpoint, contract download, sample
  request, enable toggle), each with a `?` guide whose curls run in all 7 auth modes
  (`test/guides.test.js`). Tester gains the contract kind selector and a WebSocket session view.
- **Postman:** a folder per protocol in `scripts/build-postman.js`.
- **Dependencies** (pure JS / WASM): `fast-xml-parser`, `graphql`, `xmllint-wasm`, `ws`.
- **Vendor neutrality:** no iPaaS product names in UI or docs.

## Delivery plan

Each step is its own branch, green CI before merge.

| # | Step | Why this order |
|---|---|---|
| 1 | Error-renderer registry + shared `protocolStack` (no behaviour change) | foundation for everything else |
| 2 | SOAP mock + WSDL tester adapter (incl. tester core/adapter split) | covers SOAP in both directions; forces the adapter seam early |
| 3 | WebSocket tester adapter + `/ws/echo` | completes everything the platform *exposes* |
| 4 | SSE mock (change feed + POST streaming) | small; change feed is reused by step 3's `/ws/changes` |
| 5 | GraphQL mock | |
| 6 | OData v4 mock (+ v2) | largest parser surface; last |

## Open questions

- OData v2 needed now, or v4 only?
- SOAP 1.2 needed for exposed services, or 1.1 only?
- Any WebSocket subprotocols in use (e.g. `graphql-transport-ws`, STOMP) worth first-class support?
