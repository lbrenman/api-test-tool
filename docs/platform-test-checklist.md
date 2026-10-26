# Platform test checklist

> Checks to run against the real integration platform, one section per protocol it uses. This file is the shared
> copy: update it in the same PR when a feature it covers changes. To record a test pass, copy the sections you
> need into a GitHub issue (task lists tick in place) rather than ticking boxes here.

First written Oct 7, 2026 (S3 API added Oct 10, file uploads Oct 11, mock LLM, MCP server and A2A agent Oct 12).

Work through one section per protocol your platform uses; every item is a check you tick when your platform behaves as described.

## Before you start

Deploy master (it now has SOAP, WebSocket, SSE, GraphQL, OData, the mock LLM, the MCP server, the A2A agent and the S3 API) and use its public HTTPS URL as `B` below. Start with `AUTH_MODE=none`, then repeat the checks in the auth modes your platform uses.

| Protocol | Your platform... | Endpoint | Contract to import |
| --- | --- | --- | --- |
| SOAP | calls it | `B/soap/EmployeeService`, `B/soap/ProductService` | `B/soap/EmployeeService?wsdl` |
| SOAP | exposes it | your service | your WSDL, loaded into the API tester |
| WebSocket | exposes it | your endpoint | your AsyncAPI, or a scenario |
| SSE | calls it | `B/sse/changes`, `B/sse/ticks`, `B/sse/stream` | `B/openapi.json` (tag Streaming) |
| GraphQL | calls it | `B/graphql` | `B/graphql/schema.graphql` |
| OData v4 | calls it | `B/odata/v4` | `B/odata/v4/$metadata` |
| LLM (OpenAI-compatible) | calls it | base URL `B/llm/v1` | `B/openapi.json` (tag LLM), or the connector's built-in OpenAI profile |
| MCP | calls it, or proxies it | `B/mcp` | none: tools/list, resources/list and prompts/list describe it |
| A2A | calls it, or proxies it | `B/a2a` (JSON-RPC 1.0), `B/a2a/rest` (HTTP+JSON 1.0), `B/a2a/v0.3` | Agent Card `B/.well-known/agent-card.json` |
| File uploads | calls it | `B/v1/files/multipart`, `B/v1/files/raw`, `/base64`, `/tus`, `/presign` | `B/openapi.json` (tag Files) |
| S3 | calls it | `B` (path-style, bucket `files`) | none: endpoint, keys and region from the Protocols page |

- [ ] Open the dashboard's **Protocols** page and confirm the SOAP, WebSocket, SSE, GraphQL, OData, LLM, MCP, A2A and S3 API tabs are on (a tab that is off says "(off)").
- [ ] Open `B/health` and confirm `soap`, `websocket`, `sse`, `graphql`, `odata`, `llm`, `mcp`, `a2a` and `s3` are listed.
- [ ] Turn on **Record API calls** on the Inspector page, so every call your platform makes shows up there with its real response.
- [ ] Each tab's **?** guide gives curl commands for the active auth mode; run one per protocol from a terminal first, so you know the tool works before blaming the platform.

## SOAP mock (your platform calls SOAP)

Import `B/soap/EmployeeService?wsdl` (and `ProductService`) into your platform's SOAP connector, then check:

- [ ] The connector reads the WSDL and lists the operations: GetEmployee, ListEmployees, CreateEmployee, UpdateEmployee, DeleteEmployee and the department ones.
- [ ] **GetEmployee** with id 1 returns the employee; the same id appears on the Data page.
- [ ] **ListEmployees** with page 2 and pageSize 5 returns five employees; filters and sort work if your connector exposes them.
- [ ] **CreateEmployee**, then **UpdateEmployee** with only a title: the other fields are kept. **DeleteEmployee** removes it.
- [ ] Both bindings: call once with SOAP 1.1 (`text/xml` + SOAPAction) and once with SOAP 1.2 (`application/soap+xml; action=...`) if your platform supports both.
- [ ] Faults: GetEmployee with a missing id gives a Client fault (1.1, HTTP 500) or Sender fault (1.2, HTTP 400), and your platform surfaces `f:code` = `not-found`.
- [ ] A CreateEmployee missing the email gives a fault whose detail lists the field error.
- [ ] Set `SOAP_WSSE=required`: calls without a UsernameToken fail with `wsse:InvalidSecurity`; with `BASIC_USER` / `BASIC_PASS` (PasswordText, then PasswordDigest) they succeed.
- [ ] Set `SOAP_ACTION_CHECK=strict`: a call without SOAPAction faults; a wrong SOAPAction always faults.
- [ ] Send `X-Force-Error: 503`: your platform sees HTTP 503 with a Server fault, and retries if it is configured to.

## SOAP tester (your platform exposes SOAP)

The API tester now reads WSDL 1.1. Warm up against the tool's own service before pointing it at your platform.

- [ ] Tester page → load **This tool (live WSDL: EmployeeService)** → **Run all**: every check passes. This proves the tester itself.
- [ ] Load your platform's WSDL (upload, paste or URL). The Lint tab lists no errors you did not expect.
- [ ] Target tab: set the endpoint URL if the WSDL's address is a placeholder, and pick SOAP 1.1 or 1.2.
- [ ] Auth tab: set the profile your API uses (Basic, Bearer, API key, OAuth2 client credentials or WS-Security UsernameToken).
- [ ] Try it: send one operation with the generated sample; the response validates against the WSDL's XSD.
- [ ] Run all: creates run before reads, ids are chained from create responses, deletes run last.
- [ ] Negative tests report what your API does without auth, with a missing required element, an unknown id and malformed XML. Each should be a SOAP fault, not a 200.
- [ ] Download the HTML report and keep it with the test record.

## WebSocket tester (your platform exposes a WebSocket)

Use an AsyncAPI 2.x or 3.0 document if you have one; otherwise write a scenario.

- [ ] Warm-up: load **This tool (live AsyncAPI: WebSocket channels)** → Run all passes against `/ws/echo`, `/ws/rpc` and `/ws/changes`.
- [ ] Load your AsyncAPI document. Lint shows the server URL and channels; fix a placeholder host on the Target tab.
- [ ] If your API needs a subprotocol, add it under Target → subprotocols and check the handshake accepts it.
- [ ] Auth: the upgrade request carries your credentials (header, or `?access_token=` for browser-style clients).
- [ ] Try it on one channel: connect, send the example message, and the reply validates against the message schema; replies are matched by the correlation id when the document defines one.
- [ ] Run all: every channel connects, sends its examples and checks the replies.
- [ ] Negative tests: no auth (expect a rejected upgrade such as 401), a malformed message, an oversized message (default 2 MB; set `oversizeKb` to your limit) and invalid UTF-8. Note which close code your platform uses for each.
- [ ] No AsyncAPI? **New WebSocket scenario** with your URL, then script it: connect → send → expect (with captures and templates) → close.

## SSE mock (your platform consumes a stream)

- [ ] Subscribe your platform to `B/sse/changes?resource=employees`. It first receives `event: subscribed`.
- [ ] Change an employee anywhere (Data page, back office, `/v1`, `/soap`, GraphQL or OData): one `updated` event arrives with the record in `data`.
- [ ] `B/sse/ticks?interval=500&count=5` delivers five `tick` events and then `event: end`; your platform ends the stream cleanly.
- [ ] Reconnect: `B/sse/ticks?interval=500&dropAfter=3` cuts the connection after 3 events. Your platform reconnects with `Last-Event-ID: 3` and continues at id 4.
- [ ] `malformedAt=2` sends a broken event 2: your platform logs or skips it rather than stopping the flow.
- [ ] `skipIds=true`: ids jump. Note whether your platform flags the gap.
- [ ] Request/stream: `POST B/sse/stream` with `{"prompt": "hi", "format": "openai"}` streams `chat.completion.chunk` objects ending with `data: [DONE]`; with `format: events` it ends with `event: done`.
- [ ] Heartbeats: with `SSE_HEARTBEAT_SECONDS=5`, an idle `/sse/changes` stream stays open through your platform and any proxy in front of it.
- [ ] Auth: bearer, JWT and OAuth2 also work as `?access_token=` for clients that cannot set headers.

## GraphQL mock (your platform calls GraphQL)

Point your GraphQL connector at `B/graphql`; it can introspect the schema or import `B/graphql/schema.graphql`.

- [ ] The connector discovers the schema (introspection) and lists queries such as `employees`, `employeesConnection`, `employee(id)` and the create/update/delete mutations.
- [ ] Query `employees(limit: 3) { total items { id fullName department { name } } }`: three items with nested departments.
- [ ] Variables: the same query with `$limit` passed as a variable.
- [ ] Relay paging: `productsConnection(first: 10)`, then `after: <endCursor>` until `hasNextPage` is false; your platform collects every product once.
- [ ] Filters: `filter: [{ field: "level", value: "L3" }]` and `sort: "-salary"`.
- [ ] Mutations: createDepartment → updateDepartment (only the name; the code is kept) → deleteDepartment.
- [ ] Field errors arrive as HTTP 200 with `errors[]`: a validation error (`code: "lower case"`) gives `BAD_USER_INPUT` with field details; deleting a missing id gives `NOT_FOUND`. Your platform must not treat these 200s as success.
- [ ] Partial data: header `X-Force-GraphQL-Error: department` returns employees with `department: null` plus one error per item. Check how your platform maps partial results.
- [ ] Transport errors keep their status: no credentials → 401 `UNAUTHENTICATED`; `X-Force-Error: 503` → 503 `SERVICE_UNAVAILABLE`.
- [ ] Turn off `GRAPHQL_INTROSPECTION`: your connector still works from the SDL file, or you know it needs introspection.
- [ ] Optional, if your platform supports subscriptions: `subscription { changes { type resource id } }` over WebSocket (graphql-transport-ws) on `B/graphql` receives an event for each change.

## OData mock (your platform's OData connector)

Use service root `B/odata/v4`. The service document and `$metadata` are open; everything else uses the auth mode.

- [ ] The connector reads `$metadata` and lists the entity sets Employees, Products, Departments and Categories, with key `id` and navigation properties (department, manager, directReports, employees, category, products).
- [ ] A read with `$filter=level eq 'L3' and salary gt 90000`, `$select=firstName,lastName,salary`, `$orderby=salary desc` returns only matching rows, in order, with only those fields.
- [ ] `$count=true` gives `@odata.count`; `Products/$count` returns a plain number.
- [ ] `$expand=department` on Employees, and `Departments(1)?$expand=employees($top=3)`.
- [ ] Paging: set `ODATA_MAX_PAGE_SIZE=10`. Reading all Products (500 with the default seed) takes 50 pages via `@odata.nextLink`; your platform returns all of them, once each.
- [ ] With `$top=25` and page size 10, your platform stops at 25 rows (the last page has 5 and no nextLink).
- [ ] Dates: `createdAt` and `updatedAt` are ISO 8601 (`Edm.DateTimeOffset`) whatever `DATE_FORMAT` is set to, and `hireDate` is `Edm.Date`.
- [ ] Create: POST an Employee with `"department@odata.bind": "Departments(1)"` → 201 and a `Location` header.
- [ ] Update: PATCH changes only the fields sent (204). With the `ETag` from a read in `If-Match`, a stale value gives 412.
- [ ] Delete: 204; deleting a department that still has employees gives 409.
- [ ] Errors: an unknown property in `$filter` gives 400, and your platform shows `error.message` from the OData error body.
- [ ] `X-Force-Error: 503` and the auth modes behave as on `/v1`.

## Mock LLM (your platform calls an OpenAI-compatible LLM)

Give your platform's LLM connector, AI gateway or proxy the base URL `B/llm/v1` and, as the API key, the active auth mode's credential (in `bearer` mode, the bearer token; with `AUTH_MODE=none` any key works). Nothing is sent to a real model.

- [ ] The connector lists or validates models through `GET B/llm/v1/models` (mock-chat-large, mock-chat-small, …); any other model name also works unless `LLM_REQUIRE_KNOWN_MODEL=true`.
- [ ] A chat completion returns `choices[0].message.content` (vague prose) with `finish_reason: "stop"`, and your platform maps the answer where it should.
- [ ] Token usage: `usage.prompt_tokens` grows with the size of the prompt, `completion_tokens` varies between calls (`LLM_COMPLETION_TOKENS_MIN`–`_MAX`), and `total_tokens` is their sum. Your platform's cost or usage tracking records the numbers it received.
- [ ] Repeatability: the same request with the same `seed` gives the same answer and the same usage.
- [ ] `max_tokens: 5` cuts the answer with `finish_reason: "length"` and `completion_tokens: 5`; your platform surfaces or handles the truncation.
- [ ] Tool calls: send a `tools` array with `tool_choice: "required"` → `finish_reason: "tool_calls"` and `arguments` that fit the tool's schema. Your platform runs the tool, sends back a `role: "tool"` message, and the next answer is text (an agent loop ends).
- [ ] JSON output: `response_format: {"type": "json_object"}` (or `json_schema` with a schema) returns JSON content your platform can parse.
- [ ] Streaming: `stream: true` with `stream_options: {"include_usage": true}` delivers `chat.completion.chunk` events, a final usage chunk and `data: [DONE]`; your platform reassembles the full text and reads the usage.
- [ ] Stream failures: `X-Force-Stream-Drop: 5` cuts the stream after 5 chunks, and `X-Force-Stream-Error: 5` sends an error chunk and ends without `[DONE]`. Your platform reports the failure rather than a partial answer as success.
- [ ] Errors arrive OpenAI-shaped (`{"error": {message, type, param, code}}`): no credentials → 401 `invalid_api_key`; `X-Force-Error: 429` → 429 `rate_limit_exceeded` with `Retry-After` (your platform backs off and retries if configured to); `X-Force-Error: 503` → `server_error`; a missing `messages` → 400 with `param: "messages"`.
- [ ] Rate limits: with `RATE_LIMIT_RPM` set, responses carry `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests`, as OpenAI clients expect.
- [ ] Embeddings, if your platform uses them: `POST B/llm/v1/embeddings` returns unit vectors of the requested `dimensions` (default 1536); the same text always gives the same vector; `encoding_format: "base64"` works if your client asks for it.
- [ ] Proxying: put your platform in front of `B/llm/v1` and check that streaming passes through chunk by chunk (not buffered until the end) and that the usage reaches whatever meters it.

## MCP server (your platform calls MCP tools, or proxies an MCP server)

Give your platform's MCP client, agent or MCP gateway the server URL `B/mcp`. Credentials follow the auth mode; in `jwt` and `oauth2` an OAuth-capable client can discover the OAuth server from the 401. Warm up with the Protocols page's MCP console (both protocol eras) before blaming the platform.

- [ ] The client connects and lists 22 tools (search_employees, get_employee, … simulate_error), with titles, input schemas and annotations; note which protocol version it negotiated (Inspector: `initialize` with `protocolVersion`, or `_meta` with `2026-07-28`).
- [ ] A session client (2025-11-25 or earlier): the `initialize` response's `Mcp-Session-Id` is sent on every later request, `notifications/initialized` gets 202, and the session ends with DELETE if your client does that.
- [ ] A 2026-07-28 client: every request carries `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` matching the body; nothing comes back as 400 `-32020` HeaderMismatch.
- [ ] `search_employees` with `department: "Engineering"`: a 2026-07-28 client sends `Mcp-Param-Department: Engineering` (its `x-mcp-header`); results are all in Engineering.
- [ ] `get_employee` with id 1 returns `structuredContent` with the employee, and the same record is on the Data page; your platform maps the fields it needs.
- [ ] Writes reach the shared data: `create_department`, then `update_employee` with `changes: {"title": "…"}` show up on `/v1`, GraphQL and the Data page, and fire webhooks.
- [ ] Tool errors: `get_employee` with id 999999 returns `isError: true` with a message (not a JSON-RPC error); your platform surfaces it, or lets its model retry. An unknown tool name gives JSON-RPC `-32602`.
- [ ] Progress: `long_running_task` with a progressToken streams `notifications/progress` before the result (SSE); your platform shows or forwards them. Closing the call early cancels it.
- [ ] Resources and prompts, if your platform uses them: `att://departments/1` reads as JSON; `summarize_department` returns messages with the department embedded.
- [ ] Notifications, if your platform keeps a stream open (`subscriptions/listen`, or a session's GET stream): change employee 4 anywhere and `notifications/resources/updated` arrives for `att://employees/4` after subscribing; turning `mcpAllowWrites` off sends `notifications/tools/list_changed` and the write tools disappear.
- [ ] Chaos: `X-Force-MCP-Error: tool` (tool error), `rpc` (JSON-RPC error) and `drop` (connection closed) if your platform can add headers; `X-Force-Error: 503` and `RATE_LIMIT_RPM` give JSON-RPC errors with HTTP 503 / 429.
- [ ] OAuth (`AUTH_MODE=oauth2`), if your platform's MCP client supports it: the 401 points at `B/.well-known/oauth-protected-resource/mcp`; the client registers itself (dynamic client registration), signs in with PKCE and calls tools. A read-only token can list and read but gets 403 on write tools.
- [ ] Proxying: put your platform in front of `B/mcp` and repeat the checks through it. It must pass `Mcp-Session-Id` (session clients) or the `MCP-*` / `Mcp-*` headers (2026-07-28), and stream SSE responses chunk by chunk. Set `MCP_RESPONSE_MODE=sse` to force every answer onto a stream.

## A2A agent (your platform calls an A2A agent, or proxies one)

Give your platform's A2A client, agent orchestrator or A2A gateway the Agent Card URL `B/.well-known/agent-card.json` (or the base URL `B`). Credentials follow the auth mode, as the card's `securitySchemes` describe. Warm up with the console on **Protocols → A2A** (each interface, streamed and not) before blaming the platform.

- [ ] The client reads the card: name, four skills, and `supportedInterfaces` with JSON-RPC 1.0 (`B/a2a`), HTTP+JSON 1.0 (`B/a2a/rest`) and JSON-RPC 0.3 (`B/a2a/v0.3`). Note which interface and version it picked (Inspector: the `A2A-Version` header and the method name).
- [ ] "Hello" comes back as a direct `Message` (no task); your platform handles a reply that is not a task.
- [ ] "Who works in Engineering at level L5?" ends `TASK_STATE_COMPLETED` with an `answer` artifact (text) and a `data` artifact (JSON); your platform maps the one it needs. The same employees appear on the Data page.
- [ ] Streaming (`SendStreamingMessage`, `message:stream` or `message/stream`): the task, `statusUpdate` events (SUBMITTED → WORKING → COMPLETED) and `artifactUpdate` chunks with `append` / `lastChunk` arrive one by one; your platform reassembles the answer and stops at the terminal state.
- [ ] Non-blocking: with `returnImmediately` (1.0) or `blocking: false` (0.3) the call returns a WORKING task; your platform polls `GetTask` or reopens the stream with `SubscribeToTask` and gets the final result.
- [ ] Multi-turn: "delete product 9" stops at `TASK_STATE_INPUT_REQUIRED`; your platform sends "yes" on the same `taskId` / `contextId` and the task completes (the product is gone on `/v1`). "no" ends it `TASK_STATE_REJECTED` with nothing changed.
- [ ] Writes reach the shared data: "set employee 12 title to Staff Engineer" shows up on `/v1`, GraphQL and the Data page, and fires webhooks. With `a2aAllowWrites` off it ends `TASK_STATE_REJECTED`.
- [ ] Out of scope ("the weather in Boston") ends `TASK_STATE_REJECTED`; a missing record ("show employee 999999") ends `TASK_STATE_FAILED`. Your platform reports both as failures, not answers.
- [ ] Push notifications, if your platform receives them: register a config with your URL and token; each event arrives as a POST with `X-A2A-Notification-Token` (and your `Authorization`). Point one at `B/hooks/a2a` first to see them on the Inspector.
- [ ] Task management: `ListTasks` returns your tasks (most recently updated first, with paging); `CancelTask` on a WORKING task gives `TASK_STATE_CANCELED`; cancelling a finished task gives `-32002` TaskNotCancelable; an unknown id gives `-32001` TaskNotFound.
- [ ] Versions: a call to `B/a2a` without `A2A-Version` is treated as 0.3 (as the spec requires); `A2A-Version: 2.0` gives `-32009` VersionNotSupported. Your platform sends the header it means.
- [ ] Errors: a bad request gives `-32602` with field violations (JSON-RPC) or `google.rpc.Status` 400 (HTTP+JSON), each with a `google.rpc.ErrorInfo`; your platform surfaces the reason.
- [ ] Chaos: `X-Force-A2A-Error: fail`, `reject`, `input-required` and `auth-required` end the task in that state; `rpc` gives a JSON-RPC error; `drop` cuts a stream after two events (your platform resubscribes or reports it). `X-Force-Error: 503` and `RATE_LIMIT_RPM` keep their HTTP status.
- [ ] Auth: with auth on, `GetExtendedAgentCard` returns the card with the extra **Direct operations** skill; in `oauth2` mode a `read` token can ask questions but changes need `write`. Callers only see their own tasks.
- [ ] Direct operations, if your platform sends structured data: a data part `{"tool": "search_employees", "arguments": {"department": "Sales", "limit": 5}}` runs that operation exactly.
- [ ] Proxying: put your platform in front of `B/a2a` and repeat the checks through it. It must forward `A2A-Version`, keep streams unbuffered, and rewrite or pass through the card's interface URLs.

## File uploads (your platform sends files to /v1/files)

Point your platform's HTTP or file connector at `B/v1/files/…`. Before testing the platform, run the curls in the **?** guides on the Files page's **Upload** card (multipart and raw first, then base64, tus, presigned and S3) to confirm the tool itself works.

- [ ] Multipart, one file (`POST B/v1/files/multipart`): 201 with a `Location` header, and the file appears on the Files page with the right name, content type and size.
- [ ] Multipart, several files plus form fields: every file is saved, and the text fields come back under `fields`. The Inspector lists each part.
- [ ] Octet-stream with the name in the path (`PUT B/v1/files/raw/{name}`): the stored name and content type match what your platform sent.
- [ ] Octet-stream POST (`POST B/v1/files/raw`): the name comes from `Content-Disposition`, `X-Filename` or `?name=` (in that order), whichever your platform sets; with none of them the file is `upload.bin`.
- [ ] Integrity: the `sha256` in the response matches the source file, and downloading it back gives identical bytes, including binary files such as PDFs, images and ZIPs (no re-encoding).
- [ ] Large file: a file of several MB, close to `MAX_FILE_SIZE_MB`, arrives intact (no truncation or memory errors in your platform).
- [ ] Errors: a file over `MAX_FILE_SIZE_MB` gives 413 `file-too-large`, a multipart request with no file part gives 400 `no-files`, and an empty octet-stream body gives 400 `empty-body`. Your platform surfaces each instead of reporting success.
- [ ] Base64 in JSON (`POST B/v1/files/base64`), if your platform builds JSON payloads: the decoded file matches the original; invalid base64 gives 422.
- [ ] tus, if your platform supports it: interrupt an upload, then resume from the offset `GET B/v1/files/tus/{id}` reports; the file appears (and `X-File-Id` is returned) only after the last chunk.
- [ ] Presigned PUT, if your platform supports it: `POST B/v1/files/presign` with credentials, then PUT to the returned URL with its headers and no credentials.
- [ ] Auth: repeat the multipart and octet-stream uploads in the auth modes your platform uses. In HMAC mode, uploads sign `UNSIGNED-PAYLOAD` instead of a body hash.
- [ ] Chaos: with `X-Force-Error: 503` or `ERROR_RATE`, your platform retries or reports the failure as configured, and a failed upload leaves no file behind.

## S3 API (your platform's S3 connector)

The file pool is also an S3 bucket. In your platform's S3 connector set the endpoint to `B`, the access key ID, secret and region from the **S3 API** tab on the Protocols page, **path-style** addressing, and bucket `files`. Change the keys from the demo values first.

- [ ] The connector connects and finds the bucket `files` (ListBuckets / HeadBucket).
- [ ] Listing shows the sample files (`employees.csv`, …) and any file uploaded through `/v1` or the Files page.
- [ ] Listing with a prefix and the `/` delimiter shows folders as common prefixes; paging through a long listing returns every key once.
- [ ] Upload to a folder-style key such as `in/2026/orders.csv`: the file appears on the Files page, and a file webhook arrives with `via: "s3"`.
- [ ] Download it back intact; byte ranges work if your connector uses them.
- [ ] A file above your connector's multipart threshold (often 8–16 MB; raise `MAX_FILE_SIZE_MB` if needed) uploads in parts and downloads intact.
- [ ] Copy and delete work; deleting a key that does not exist is not an error.
- [ ] A wrong secret gives `SignatureDoesNotMatch` (403); a wrong region gives `AuthorizationHeaderMalformed` naming the expected region. Your platform surfaces the S3 error code.
- [ ] Presigned URLs your platform generates work for download and upload.
- [ ] Set `ERROR_RATE` (or send `X-Force-Error: 503` if your connector can add headers): your connector sees `ServiceUnavailable` and retries if configured to.
- [ ] Repeat the upload and download checks with `FILE_STORE=s3` if the tool stores its files in a bucket.

## Outgoing webhooks (your platform receives events)

On the dashboard's **Webhooks** page, point a webhook at an endpoint your platform exposes. First press **Use this tool's inspector as the receiver** to see one delivery arrive on the Inspector page.

- [ ] A webhook on employees, event created: adding an employee (Data page, back office, `/v1`, SOAP, GraphQL, OData, MCP or A2A) makes your platform receive one POST with `event: "employees.created"`, `resource`, `resourceId` and `href`.
- [ ] Your platform follows `href` (a `/v1` GET with your credentials) to fetch the full record, or you tick **Include the record** and it reads `data`.
- [ ] Updated and deleted events arrive only when ticked; a webhook on employees ignores product changes.
- [ ] With a signing secret, your platform verifies `X-Webhook-Signature` (sha256 HMAC of `<X-Webhook-Timestamp>.<raw body>`); the guide's openssl line computes the same value.
- [ ] Extra headers (e.g. an API key your endpoint requires) reach your platform.
- [ ] **Test** sends a delivery marked `"test": true`; the Deliveries table shows your platform's status code and response body.
- [ ] Failure handling: make your endpoint return 500 (or stop it). The delivery is logged as failed and is not retried; **Resend** sends it again.
- [ ] Restart the tool (or redeploy): the webhooks are still there and still fire.
- [ ] Pause one webhook (untick On), then all of them (`webhooksEnabled` off): no deliveries.

## File webhooks (uploads, downloads, deletes)

Tick **files** under File pool, with the events uploaded, downloaded and/or deleted.

- [ ] Upload a file each way your platform uses (multipart, raw, base64, tus, presigned, the S3 API, the Files page): each sends one `files.uploaded` with `via` naming the method and `file` giving name, type, size and sha256.
- [ ] A tus upload fires only after the last chunk.
- [ ] Downloads fire `files.downloaded` with `status` 200, or 206 plus `range` and `bytes` for a partial download; HEAD requests and 304s do not fire.
- [ ] Deleting a file fires `files.deleted`; a failed upload and **Regenerate samples** fire nothing.
- [ ] With `FILE_STORE=s3`: a presigned upload fires when the tool next sees the file; a presigned download does not fire (the bucket serves it).

## Every protocol: auth, chaos, rate limits, inspector

All mocks share one request pipeline (required headers → rate limit → auth → chaos), so run these once per protocol your platform calls.

- [ ] Auth: switch `AUTH_MODE` through the modes your platform uses (apikey, basic, bearer, jwt, oauth2, hmac). Each protocol accepts the right credentials and answers 401 without them, in its own error shape (SOAP fault, GraphQL errors, OData error, OpenAI error for the LLM, JSON-RPC error for MCP and A2A JSON-RPC, `google.rpc.Status` for A2A HTTP+JSON, problem+json for SSE). The S3 API is the exception: it always uses AWS Signature V4 with its own keys.
- [ ] Required headers: add one under Settings → required headers; calls without it are rejected on every protocol.
- [ ] Rate limit: set `RATE_LIMIT_RPM` low; the limit is one budget across all protocols, and 429 carries `Retry-After`.
- [ ] Chaos: `ERROR_RATE` and latency settings hit every protocol; `X-Force-Error` and `X-Force-Latency` work per request.
- [ ] Inspector: filter by source (SOAP, WebSocket, SSE, GraphQL, OData, LLM, MCP, A2A, S3 API) and check each call your platform made, with its real response.
- [ ] Cross-protocol: create a record through one protocol and read it through another (for example OData create, GraphQL read, SSE change event, or an A2A question about it).

## Not covered yet, and what to report back

- OData v2 (`d.results`, `__count`, `__next`, `/Date(ms)/`) is not built. Open an issue if your platform's OData connector needs v2.
- OData `$batch`, `$apply` and deep insert answer 501.
- No WebSocket subprotocol presets (STOMP and others); any subprotocol name is passed through on the handshake.
- S3 API: one bucket, path-style only, no versioning, tagging, ACL writes or UploadPartCopy (501). Tested with the AWS SDK for JavaScript v3, curl and Postman; the AWS CLI, boto3 and your platform's connector have not been checked yet.
- Mock LLM: chat completions, embeddings and models only (no Responses API, legacy completions, images, audio or files). Tested with curl, Postman and Node's fetch; the official OpenAI SDKs and your platform's LLM connector have not been checked yet.
- MCP server: no HTTP+SSE transport (2024-11-05), batches, server-to-client requests (sampling, elicitation, roots, or 2026-07-28 input requests), tasks or client ID metadata documents. Checked with the official MCP SDK clients (`@modelcontextprotocol/sdk` 1.32.1 and `@modelcontextprotocol/client` 2.3.1, both speaking 2025-11-25); the 2026-07-28 path is covered by the tool's own tests only, and your platform's MCP client has not been checked yet.
- A2A agent: rule-based answers (no LLM), no gRPC binding, file parts (`url`, `raw`) are accepted but not read, tasks kept in memory (lost on restart), extensions not implemented. Checked with the official SDKs (Python `a2a-sdk` 1.2.2 over JSON-RPC and HTTP+JSON, `@a2a-js/sdk` 1.3.0, and `a2a-sdk` 0.3.26 against `/a2a/v0.3`); your platform's A2A client has not been checked yet.
- GraphiQL (`B/graphql` in a browser) and Swagger UI load from a CDN and have not been checked on your deployment.

For anything that fails, open a GitHub issue with the protocol, the auth mode, the request your platform sent (from the Inspector) and what it expected.
