/* API Test Tool dashboard — per-component "how to use" guides with ready-to-run curl commands.
 *
 * Every curl is built from the server's resolved base URL and the auth mode that is active right now
 * (from the environment or a dashboard override). Nothing here changes a setting: the guides only read
 * the current configuration and write commands that will work against it.
 *
 * Exposes window.ATT_GUIDES = { makeCurl(ctx), build(C, extra) }. No build step, no dependencies.
 */
(function () {
  'use strict';

  const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  // Single-quote for POSIX shells (bash, zsh). zsh treats an unquoted "?" in a URL as a glob.
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  // Paths that take API credentials: the /v1 mock API and SOAP requests (the WSDL and /soap listing are open).
  const isApiPath = (p) => p === '/v1' || p.startsWith('/v1/') || p.startsWith('/v1?') || (p.startsWith('/soap/') && !/[?.]wsdl$/i.test(p))
    || p.startsWith('/sse/') || p === '/graphql' || p.startsWith('/graphql?') || p.startsWith('/llm/v1/') || p === '/mcp' || p.startsWith('/mcp?') || ((p === '/a2a' || p.startsWith('/a2a?') || p.startsWith('/a2a/')) && !p.includes('agent-card.json'))
    || (p.startsWith('/odata/v4/') && !/^\/odata\/v4\/(\$metadata)?([?#]|$)/.test(p));

  /**
   * ctx: {
   *   base, root, mode, apiKey: {name, in, value}, basic: {user, pass}, bearer, hmac: {keyId, secret},
   *   tokenUrl, client: {clientId, secret}, required: [{name, value}], adminPasswordRequired
   * }
   * base is where the mock APIs are: the server itself (root), or root + /p/<name> when the dashboard's profile
   * picker selects a settings profile. The admin API and the S3 API are always at root.
   */
  function makeCurl(ctx) {
    const root = ctx.root || ctx.base;
    const prefix = ctx.base.startsWith(root) ? ctx.base.slice(root.length) : ''; // '/p/<name>' or ''
    const lines = (pre, parts) => {
      const flat = parts.join(' ');
      const cmd = flat.length > 110 ? parts.join(' \\\n  ') : flat;
      return [...pre, cmd].join('\n');
    };

    const tokenLine = () => {
      const c = ctx.client || { clientId: 'demo-client', secret: 'demo-secret' };
      return `TOKEN=$(curl -s -u ${q(`${c.clientId}:${c.secret}`)} -d grant_type=client_credentials ${q(ctx.tokenUrl)} | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')`;
    };

    /**
     * Call this server. Auth and required headers are added automatically for /v1 paths and SOAP requests.
     * o: { json, body, contentType, headers, form: [...-F values], file (path for --data-binary @),
     *      signFile (HMAC: hash the file's bytes, for a JSON body sent from a file; a plain file is a
     *      streamed upload and signs UNSIGNED-PAYLOAD), include, output, unsigned (HMAC: streamed
     *      upload with an inline body), noAuth, extra: [flags] }
     */
    function curl(method, path, o = {}) {
      const pre = [];
      const parts = [o.include ? 'curl -s -i' : 'curl -s'];
      const api = !o.noAuth && isApiPath(path);
      let p = path;
      if (api && ctx.mode === 'apikey' && ctx.apiKey.in === 'query') {
        p += `${p.includes('?') ? '&' : '?'}${encodeURIComponent(ctx.apiKey.name)}=${encodeURIComponent(ctx.apiKey.value)}`;
      }
      if (method !== 'GET') parts.push(`-X ${method}`);
      parts.push(q(ctx.base + p));

      const bodyStr = o.json !== undefined ? JSON.stringify(o.json) : o.body;
      const hasInlineBody = bodyStr !== undefined;
      const contentType = o.contentType || (o.json !== undefined ? 'application/json' : null);

      if (api) {
        switch (ctx.mode) {
          case 'apikey':
            if (ctx.apiKey.in === 'header') parts.push(`-H ${q(`${ctx.apiKey.name}: ${ctx.apiKey.value}`)}`);
            break;
          case 'basic':
            parts.push(`-u ${q(`${ctx.basic.user}:${ctx.basic.pass}`)}`);
            break;
          case 'bearer':
            parts.push(`-H ${q(`Authorization: Bearer ${ctx.bearer}`)}`);
            break;
          case 'jwt':
          case 'oauth2':
            pre.push(tokenLine());
            parts.push('-H "Authorization: Bearer $TOKEN"');
            break;
          case 'hmac': {
            if (hasInlineBody) pre.push(`BODY=${q(bodyStr)}`);
            const hash = o.file && o.signFile ? `$(openssl dgst -sha256 -r ${q(o.file)} | cut -d' ' -f1)`
              : o.unsigned || o.form || o.file ? 'UNSIGNED-PAYLOAD'
              : hasInlineBody ? '$(printf \'%s\' "$BODY" | openssl dgst -sha256 -r | cut -d\' \' -f1)' : EMPTY_SHA256;
            pre.push('TS=$(date +%s)');
            pre.push(`SIG=$(printf '%s\\n%s\\n%s\\n%s' ${method} ${q(prefix + p)} "$TS" "${hash}" | openssl dgst -sha256 -hmac ${q(ctx.hmac.secret)} -binary | openssl base64 -A)`);
            parts.push(`-H "Authorization: HMAC ${ctx.hmac.keyId}:$SIG"`, '-H "X-Timestamp: $TS"');
            break;
          }
          default: break;
        }
        for (const r of ctx.required || []) parts.push(`-H ${q(`${r.name}: ${r.value ?? 'test'}`)}`);
      }

      for (const [k, v] of Object.entries(o.headers || {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
      if (contentType) parts.push(`-H ${q(`Content-Type: ${contentType}`)}`);
      if (hasInlineBody) parts.push(api && ctx.mode === 'hmac' ? '--data-binary "$BODY"' : `-d ${q(bodyStr)}`);
      for (const f of o.form || []) parts.push(`-F ${q(f)}`);
      if (o.file) parts.push(`--data-binary @${o.file}`);
      for (const x of o.extra || []) parts.push(x);
      if (o.output) parts.push(`-o ${q(o.output)}`);
      return lines(pre, parts);
    }

    /** Call the dashboard's own API (/admin/api). Uses the admin password when one is set. */
    function admin(method, path, o = {}) {
      const parts = [o.include ? 'curl -s -i' : 'curl -s'];
      if (method !== 'GET') parts.push(`-X ${method}`);
      parts.push(q(`${root}/admin/api${path}`));
      if (ctx.adminPasswordRequired) parts.push('-u "admin:$ADMIN_PASSWORD"');
      if (o.json !== undefined) parts.push("-H 'Content-Type: application/json'", `-d ${q(JSON.stringify(o.json))}`);
      for (const x of o.extra || []) parts.push(x);
      if (o.output) parts.push(`-o ${q(o.output)}`);
      return lines([], parts);
    }

    /** A plain call with no credentials (webhooks, health, discovery). */
    const plain = (method, path, o = {}) => curl(method, path, { ...o, noAuth: true });

    const authLabel = {
      none: 'none — no credentials needed',
      apikey: `API key in the ${ctx.apiKey.in} "${ctx.apiKey.name}"`,
      basic: `HTTP Basic (user "${ctx.basic.user}")`,
      bearer: 'a static Bearer token',
      jwt: 'a JWT Bearer token (fetched from the built-in OAuth server on the first line)',
      oauth2: 'an OAuth 2.0 access token (fetched with client credentials on the first line)',
      hmac: `an HMAC signature (key id "${ctx.hmac.keyId}", computed with openssl on the first lines)`,
    }[ctx.mode] || ctx.mode;

    /**
     * Connect to a WebSocket path of this server with Node's built-in WebSocket client (Node 22+),
     * send one message (or an array of messages, in order) and print what comes back. Credentials
     * follow the active auth mode; protocols are offered as Sec-WebSocket-Protocol.
     */
    function ws(path, message, { listenMs = 2000, protocols } = {}) {
      const pre = [];
      const envs = [];
      const hdrs = [];
      let p = path;
      switch (ctx.mode) {
        case 'apikey':
          if (ctx.apiKey.in === 'query') p += `${p.includes('?') ? '&' : '?'}${encodeURIComponent(ctx.apiKey.name)}=${encodeURIComponent(ctx.apiKey.value)}`;
          else hdrs.push([ctx.apiKey.name, JSON.stringify(ctx.apiKey.value)]);
          break;
        case 'basic': hdrs.push(['Authorization', `'Basic '+Buffer.from(${JSON.stringify(`${ctx.basic.user}:${ctx.basic.pass}`)}).toString('base64')`]); break;
        case 'bearer': hdrs.push(['Authorization', JSON.stringify(`Bearer ${ctx.bearer}`)]); break;
        case 'jwt':
        case 'oauth2':
          pre.push(tokenLine());
          envs.push('TOKEN="$TOKEN"');
          hdrs.push(['Authorization', "'Bearer '+process.env.TOKEN"]);
          break;
        case 'hmac':
          pre.push('TS=$(date +%s)');
          pre.push(`SIG=$(printf '%s\\n%s\\n%s\\n%s' GET ${q(prefix + p)} "$TS" "${EMPTY_SHA256}" | openssl dgst -sha256 -hmac ${q(ctx.hmac.secret)} -binary | openssl base64 -A)`);
          envs.push('TS="$TS"', 'SIG="$SIG"');
          hdrs.push(['Authorization', `'HMAC ${ctx.hmac.keyId}:'+process.env.SIG`], ['X-Timestamp', 'process.env.TS']);
          break;
        default: break;
      }
      for (const r of ctx.required || []) hdrs.push([r.name, JSON.stringify(r.value ?? 'test')]);
      const url = `${ctx.base}${p}`.replace(/^http/, 'ws');
      const headerSrc = hdrs.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',');
      const init = [protocols?.length ? `protocols:${JSON.stringify(protocols)}` : '', headerSrc ? `headers:{${headerSrc}}` : ''].filter(Boolean).join(',');
      const sends = (message === undefined ? [] : [].concat(message)).map((m) => `ws.send(${JSON.stringify(m)});`).join('');
      const js = `const ws=new WebSocket(${JSON.stringify(url)}${init ? `,{${init}}` : ''});`
        + `ws.onopen=()=>{console.log('open',ws.protocol||'');${sends}};`
        + 'ws.onmessage=(e)=>console.log(e.data);ws.onerror=()=>console.log(\'handshake or connection failed\');'
        + `ws.onclose=(e)=>console.log('closed',e.code);setTimeout(()=>ws.close(),${listenMs})`;
      return [...pre, `${envs.length ? `${envs.join(' ')} ` : ''}node -e ${q(js)}`].join('\n');
    }

    /**
     * Call the S3-compatible API with curl's built-in AWS Signature V4 (--aws-sigv4, curl 7.75+).
     * key: object key ('' for the bucket, null for the service root). The S3 API ignores AUTH_MODE.
     * o: { query, upload (file for -T), headers, include, head, output }
     */
    function s3(method, key, o = {}) {
      const c = ctx.s3 || { bucket: 'files', region: 'us-east-1', accessKeyId: 'demo-access-key', secretAccessKey: 'demo-secret-key' };
      const enc = (k) => String(k).split('/').map(encodeURIComponent).join('/');
      const p = key === null ? '/' : `/${c.bucket}${key ? `/${enc(key)}` : ''}`;
      const parts = [o.include ? 'curl -s -i' : (o.head ? 'curl -s -I' : 'curl -s')];
      if (method !== 'GET' && !(method === 'HEAD' && o.head) && !(method === 'PUT' && o.upload)) parts.push(`-X ${method}`);
      parts.push(`--aws-sigv4 ${q(`aws:amz:${c.region}:s3`)}`, `--user ${q(`${c.accessKeyId}:${c.secretAccessKey}`)}`);
      for (const [k, v] of Object.entries(o.headers || {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
      if (o.upload) parts.push(`-T ${q(o.upload)}`);
      if (o.body !== undefined) parts.push(`--data-binary ${q(o.body)}`);
      if (o.output) parts.push(`-o ${q(o.output)}`);
      parts.push(q(`${root}${p}${o.query ? `?${o.query}` : ''}`));
      return lines([], parts);
    }

    /** The same with the AWS CLI (path-style is used automatically with --endpoint-url). */
    function aws(args) {
      const c = ctx.s3 || { bucket: 'files', region: 'us-east-1', accessKeyId: 'demo-access-key', secretAccessKey: 'demo-secret-key' };
      return `AWS_ACCESS_KEY_ID=${q(c.accessKeyId)} AWS_SECRET_ACCESS_KEY=${q(c.secretAccessKey)} AWS_REGION=${q(c.region)} aws --endpoint-url ${q(root)} ${args}`;
    }

    return { curl, admin, plain, ws, s3, aws, tokenLine, ctx, authLabel, base: ctx.base, root, prefix, mode: ctx.mode };
  }

  /**
   * Guides keyed by component id. Strings may use `backticks` for inline code.
   * extra: { specId, specName, firstOpId, fileId, fileName }
   */
  function build(C, extra = {}) {
    const B = C.base;
    const { curl, admin, plain, ws, s3, aws } = C;
    const S3 = C.ctx.s3 || { bucket: 'files', region: 'us-east-1', accessKeyId: 'demo-access-key', secretAccessKey: 'demo-secret-key' };
    const c = C.ctx.client || { clientId: 'demo-client', secret: 'demo-secret' };
    const fileId = extra.fileId || 'FILE_ID';
    const specId = extra.specId || 'SPEC_ID';
    const pw = C.ctx.adminPasswordRequired ? ['Admin API calls use the dashboard password: run `export ADMIN_PASSWORD=…` first.'] : [];
    const EMP_NS = 'urn:api-test-tool:soap:EmployeeService';
    const PROD_NS = 'urn:api-test-tool:soap:ProductService';
    const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
    const soapEnv = (version, ns, body, hdr = '') => `<soapenv:Envelope xmlns:soapenv="${version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/'}" xmlns:tns="${ns}">${hdr ? `<soapenv:Header>${hdr}</soapenv:Header>` : ''}<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

    return {
      // ------------------------------------------------------------ overview
      'overview.endpoints': {
        title: 'Endpoints',
        purpose: 'The addresses you give to the system you are testing. The base URL is resolved from PUBLIC_BASE_URL or the host this tool runs on.',
        steps: [
          `In your integration or API client, set the base URL to \`${B}/v1\`.`,
          `Configure credentials to match the active auth mode: ${C.authLabel}.`,
          `Point webhooks at any path that is not reserved, e.g. \`${B}/hooks/orders\`, and watch them on the Inspector page.`,
          `Import \`${B}/openapi.json\` into your client tool to get every endpoint pre-defined.`,
          'The other entries are the same data over SOAP, WebSocket, SSE, GraphQL and OData, an OpenAI-compatible mock LLM, an MCP server, an A2A agent, and the file pool as an S3 bucket (endpoint = the base URL); the Protocols page has the details for each.',
        ],
        curls: [
          ['List two employees', curl('GET', '/v1/employees?limit=2')],
          ['Check health', plain('GET', '/health')],
          ['Download the mock data API spec', plain('GET', '/openapi.json', { output: 'api-test-tool.openapi.json' })],
        ],
      },
      'overview.data': {
        title: 'Data summary',
        purpose: 'How much mock data and how many files and captures exist right now.',
        steps: [
          'Use the counts to check that a seed or a test run did what you expected.',
          'Lists return `meta.total`, so your client can assert the same numbers through the API.',
          'Change the data on the Data page; files on the Files page; captures on the Inspector page.',
        ],
        curls: [
          ['Total employees (meta.total)', curl('GET', '/v1/employees?limit=1&fields=id')],
          ['Total products', curl('GET', '/v1/products?limit=1&fields=id')],
        ],
      },
      'overview.curls': {
        title: 'Quick curls',
        purpose: 'Copy-ready commands that already carry the active credentials and required headers.',
        steps: [
          'Copy a command and run it in a terminal (bash or zsh).',
          'If a call returns 401, compare it with the credentials shown on the Auth page.',
          'Use these as the reference request when building the same call in your integration.',
        ],
        curls: [
          ['List employees', curl('GET', '/v1/employees?limit=2')],
          ['Cursor pagination', curl('GET', '/v1/p/cursor/products?limit=5')],
          ['Send a webhook to the Inspector', plain('POST', '/hooks/my-webhook', { json: { hello: 'inspector' } })],
          ['Force a 503 to test error handling', curl('GET', '/v1/employees/1', { include: true, headers: { 'X-Force-Error': '503' } })],
        ],
      },

      // ------------------------------------------------------------ settings
      settings: {
        title: 'Settings',
        purpose: 'Every setting. Environment variables set the defaults; saving here overrides them and survives restarts. "Reset" returns to the env value.',
        steps: [
          'Open a section, change a value and press Save — it takes effect immediately (except settings marked env: …, which need a restart).',
          'The badge shows the source of each value: `env`, `default` or `override`.',
          'Script the same changes through the admin API, e.g. to set up a demo before a test run.',
          ...pw,
        ],
        curls: [
          ['Active settings summary (no secrets)', plain('GET', '/health')],
          ['Read every setting', admin('GET', '/settings')],
          ['Change a setting', admin('PUT', '/settings', { json: { dateFormat: 'epoch-ms' } })],
          ['Reset one setting to its env default', admin('POST', '/settings/reset', { json: { key: 'dateFormat' } })],
        ],
      },

      // ------------------------------------------------------------ data
      'data.seed': {
        title: 'Reset & re-seed',
        purpose: 'Rebuild the mock data with chosen sizes. The same random seed always produces the same records, so test assertions stay stable.',
        steps: [
          'Choose how many employees and products you want and a random seed.',
          'Press "Reset & re-seed". Departments and categories are rebuilt too, with valid links between records.',
          'Keep the seed the same across runs when your tests assert on specific values.',
          ...pw,
        ],
        curls: [
          ['Re-seed with 50 employees and 100 products', admin('POST', '/data/seed', { json: { employees: 50, products: 100, seed: 42, sampleFiles: false } })],
          ['Clear all data', admin('POST', '/data/clear')],
        ],
      },
      'data.preview': {
        title: 'Working with the data',
        purpose: 'The four resources (employees, products, departments, categories) support full CRUD, filters, sorting, sparse fields and seven pagination styles.',
        steps: [
          'List: `GET /v1/{resource}`. Filter with `?field=value` or `?price[gte]=10`, search with `?q=`, sort with `?sort=-createdAt`, trim with `?fields=id,name`.',
          'Create with POST (201 + Location + ETag). Replace with PUT, merge with PATCH, remove with DELETE (204).',
          'Send `If-Match: <etag>` on writes to test optimistic locking (412 when stale), and `Idempotency-Key` on POST to test safe retries.',
          'Pick a pagination style by path: `/v1/p/{offset|page|cursor|keyset|link|hal|token}/employees`.',
        ],
        curls: [
          ['Filter, sort and trim fields', curl('GET', '/v1/products?inStock=true&price[gte]=10&sort=-price&fields=id,name,price&limit=5')],
          ['Create an employee (idempotent)', curl('POST', '/v1/employees', { include: true, json: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', departmentId: 1 }, headers: { 'Idempotency-Key': 'demo-0001' } })],
          ['Partially update with JSON Merge Patch', curl('PATCH', '/v1/employees/1', { json: { title: 'Principal Engineer' }, contentType: 'application/merge-patch+json' })],
          ['Page-number pagination', curl('GET', '/v1/p/page/employees?page=2&size=10')],
          ['Token (AIP) pagination', curl('GET', '/v1/p/token/products?pageSize=20')],
          ['Link-header pagination (see headers)', curl('GET', '/v1/p/link/employees?page=1&per_page=10', { include: true })],
        ],
      },

      // ------------------------------------------------------------ inspector
      'inspector.capture': {
        title: 'Inspector',
        purpose: 'A webhook catcher. Any call to a path the tool does not reserve is recorded with its headers, detected auth, body and the response sent back. Calls to the APIs (/v1, SOAP, WebSocket upgrades, SSE, GraphQL, OData, the LLM mock, the MCP server, the A2A agent, the S3 API and OAuth) are recorded too while "Record API calls" is on.',
        steps: [
          `Configure the system under test to send its webhook or callback to \`${B}/<any-path>\`, for example \`${B}/hooks/orders\`.`,
          'Trigger the event. The request appears here live — click it to see Request, Auth, Response and a ready-made curl.',
          'Filter by source, method or any text to find a specific call.',
          'Use Replay to resend a captured call to this server or to another URL, and Export JSON to keep the evidence.',
          'Remove a single capture with the × on its row (or Delete in the detail pane); Clear removes them all.',
        ],
        curls: [
          ['Send a JSON webhook', plain('POST', '/hooks/orders', { json: { event: 'order.created', orderId: 'PO-4500123456' } })],
          ['Send a form-encoded callback', plain('POST', '/callbacks/payment', { body: 'status=paid&amount=19.99', contentType: 'application/x-www-form-urlencoded' })],
          ['Export every capture', admin('GET', '/inspector/export', { output: 'inspector.json' })],
          ['Delete one capture', admin('DELETE', '/inspector/CAPTURE_ID')],
        ],
      },
      'inspector.rules': {
        title: 'Default response & path rules',
        purpose: 'Decide what the catch-all answers. Use it to imitate the endpoint your integration expects — a 202 Accepted, a specific JSON reply, or a slow or failing receiver.',
        steps: [
          'Set the default status, content type, body, headers and delay for every captured call.',
          'Add path rules for specific paths. The first match wins; paths support `*`, `**` and `{param}`.',
          'Templates such as `{{uuid}}`, `{{now}}`, `{{params.x}}` and `{{body.x}}` are filled in per request.',
          'Send a test call and confirm the reply on the Response tab of the capture.',
          ...pw,
        ],
        curls: [
          ['Add a rule that answers 202 with an id', admin('PUT', '/settings', { json: { inspectorRules: [{ method: 'POST', path: '/hooks/{name}', status: 202, contentType: 'application/json', body: { ok: true, hook: '{{params.name}}', id: '{{uuid}}' } }] } })],
          ['Try the rule', plain('POST', '/hooks/orders', { include: true, json: { event: 'order.created' } })],
          ['Make every other path return 500 after 2 s', admin('PUT', '/settings', { json: { inspectorResponseStatus: 500, inspectorResponseDelayMs: 2000 } })],
        ],
      },
      'inspector.forward': {
        title: 'Auto-forward',
        purpose: 'Record a webhook here and also pass it on to a real receiver, so you can watch traffic without breaking the flow.',
        steps: [
          'Tick "Forward every capture" and enter the receiver base URL. The captured path is appended to it.',
          'Save forwarding. Each capture then shows a Forwarded section with the receiver\'s status and timing.',
          'Turn it off again when you are done, so test traffic does not reach the receiver.',
          ...pw,
        ],
        curls: [
          ['Enable forwarding', admin('PUT', '/settings', { json: { inspectorForwardEnabled: true, inspectorForwardUrl: 'https://receiver.example.com' } })],
          ['Send a call that will be forwarded', plain('POST', '/hooks/orders', { json: { event: 'order.created' } })],
          ['Disable forwarding', admin('PUT', '/settings', { json: { inspectorForwardEnabled: false } })],
        ],
      },
      'inspector.replay': {
        title: 'Replay',
        purpose: 'Send a captured request again — to this server, or to another URL such as your own endpoint.',
        steps: [
          'Leave the target blank to replay against this server on the same path.',
          'Enter a base URL to send it elsewhere; a URL with its own path replaces the captured path.',
          'The replay response is shown below the button. Use the curl tab to rerun it from a terminal instead.',
          ...pw,
        ],
        curls: [
          ['Replay a capture to another URL', admin('POST', `/inspector/${extra.captureId || 'CAPTURE_ID'}/replay`, { json: { targetUrl: 'https://receiver.example.com' } })],
        ],
      },

      // ------------------------------------------------------------ files
      // ------------------------------------------------------------ webhooks (outgoing)
      'webhooks.list': {
        title: 'Webhooks',
        purpose: 'Every outgoing webhook: which resources and events it watches, where it posts, and how its last delivery went. Data changes through any protocol (/v1, SOAP, GraphQL, OData, the back office) and file uploads, downloads and deletes through any file protocol (including the S3 API) trigger them.',
        steps: [
          'Untick On to pause one webhook; turn off webhooksEnabled (settings card) to pause them all. Definitions are kept either way.',
          'Test sends a delivery now for the first record of the webhook\'s first resource, marked `"test": true`, so you can check your receiver without changing data.',
          'Webhooks are stored in the database and survive restarts and re-seeding. Seeding itself does not fire them.',
          ...pw,
        ],
        curls: [
          ['List webhooks', admin('GET', '/webhooks')],
          ['Send a test delivery', admin('POST', '/webhooks/WEBHOOK_ID/test', { json: { type: 'created' } })],
          ['Pause one', admin('PATCH', '/webhooks/WEBHOOK_ID', { json: { enabled: false } })],
          ['Delete one', admin('DELETE', '/webhooks/WEBHOOK_ID')],
        ],
      },
      'webhooks.form': {
        title: 'Add or edit a webhook',
        purpose: 'Choose the resources and events to watch and the URL that receives a JSON POST with the event, the resource type and the record id.',
        steps: [
          'URL: your integration\'s endpoint. "Use this tool\'s inspector" points it at this server so you can see a delivery first.',
          'Data resources: all, or any of employees, products, departments, categories, with created / updated / deleted. File pool: files, with uploaded / downloaded / deleted (multipart, raw, base64, tus, presigned, range and chunked downloads, the S3 API, the Files page). One webhook can watch both.',
          'File events also carry `via` (how it happened), `file` (name, type, size, sha256) and, for downloads, `status`, `range` and `bytes`. Failed uploads and regenerated sample files do not fire.',
          `The body is \`{"id", "event": "employees.created", "type", "resource", "resourceId", "href", "occurredAt", "webhookId"}\`; \`href\` is the record on \`${B}/v1\`. Tick "Include the record" to add it as \`data\`.`,
          'Signing secret: each delivery gets `X-Webhook-Signature: sha256=` + hex HMAC-SHA256(secret, `<X-Webhook-Timestamp>.<raw body>`). Extra headers carry credentials your receiver needs (e.g. an API key).',
        ],
        curls: [
          ['Webhook for new employees', admin('POST', '/webhooks', { json: { name: 'New employees', url: 'https://example.com/hooks/employees', resources: ['employees'], events: ['created'] } })],
          ['Every file upload and delete', admin('POST', '/webhooks', { json: { name: 'File pool', url: 'https://example.com/hooks/files', resources: ['files'], events: ['uploaded', 'deleted'] } })],
          ['Signed, with a header and the record', admin('POST', '/webhooks', { json: { name: 'Products to integration', url: 'https://example.com/hooks/products', resources: ['products'], events: ['created', 'updated'], includeData: true, secret: 'change-me', headers: { 'X-API-Key': 'integration-key' } } })],
          ['Check a signature on the receiving side', "BODY='<raw request body>'; TS='<X-Webhook-Timestamp>'\nprintf '%s.%s' \"$TS\" \"$BODY\" | openssl dgst -sha256 -hmac 'change-me' | sed 's/^.* /sha256=/'"],
        ],
      },
      'webhooks.settings': {
        title: 'Webhook settings',
        purpose: 'Pause all deliveries, set how long a delivery waits for your receiver, and how many deliveries the log keeps.',
        steps: [
          '`webhooksEnabled`: off pauses every webhook without deleting any.',
          '`webhookTimeoutMs`: a receiver slower than this is logged as failed.',
          '`webhookDeliveryRetention`: deliveries kept in the log, across all webhooks.',
          ...pw,
        ],
        curls: [
          ['Pause all webhooks', admin('PUT', '/settings', { json: { webhooksEnabled: false } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'webhooks' } })],
        ],
      },
      'webhooks.deliveries': {
        title: 'Deliveries',
        purpose: 'Every delivery with its request (headers and body) and your receiver\'s response, newest first.',
        steps: [
          'A delivery is OK when the receiver answers 2xx within the timeout. There is one attempt per event; nothing is retried automatically.',
          'Details shows what was sent and what came back. Custom header values are hidden as "(set)".',
          'Resend sends the same payload again with a new delivery id and a fresh timestamp and signature.',
        ],
        curls: [
          ['Last 20 deliveries', admin('GET', '/webhooks/deliveries?limit=20')],
          ['Resend one', admin('POST', '/webhooks/deliveries/DELIVERY_ID/redeliver')],
          ['Make a change that fires webhooks', curl('POST', '/v1/departments', { json: { name: 'Webhook test', code: 'WH-1' } })],
        ],
      },

      'files.upload': {
        title: 'Uploading files: multipart and raw (octet-stream)',
        purpose: 'The two upload styles most integrations use. Every upload lands in the shared file pool, so you can upload one way and download (or list over S3) another. Run the first command once to create the test files the others send.',
        steps: [
          'Multipart (`POST /v1/files/multipart`, `multipart/form-data`): every file part becomes one pool file, keeping the part\'s filename and Content-Type; text parts come back under `fields` (a repeated name becomes an array). Up to 20 files and 200 fields per request.',
          'Raw / octet-stream: the request body is the file, streamed to the pool. `PUT /v1/files/raw/{name}` takes the name from the path; `POST /v1/files/raw` takes it from `Content-Disposition` (`filename=` or `filename*=`), then `X-Filename`, then `?name=`, else `upload.bin`. The request Content-Type is stored as the file type.',
          'Check the 201: `Location` points to `/v1/files/{id}`, and the body has `id`, `name`, `contentType`, `size`, `sha256` and `links` (multipart returns `{files: [...], fields}` and Location for the first file). Compare `sha256` with the local hash, or download the file back and `cmp` it.',
          `Error cases (problem+json): a file over MAX_FILE_SIZE_MB (now ${extra.maxFileSizeMb ?? 100} MB) → 413 \`file-too-large\` (nothing is kept, also for the other parts of a multipart request); multipart with no file part → 400 \`no-files\`; a non-multipart body sent to /multipart → 415; an empty raw body → 400 \`empty-body\`.`,
          'Every successful upload fires a `files.uploaded` webhook with `via` = `multipart` or `raw`, and shows on the Inspector page (with the multipart parts listed) when Record API calls is on. Auth, required headers, rate limit and chaos apply as on the rest of /v1; in HMAC mode uploads sign `UNSIGNED-PAYLOAD`.',
        ],
        curls: [
          ['Create the test files (13-byte text, 2 MB binary)', "printf 'Hello, world!' > hello.txt && head -c 2097152 /dev/urandom > blob.bin"],
          ['Multipart: one file', curl('POST', '/v1/files/multipart', { include: true, form: ['file=@./blob.bin;type=application/octet-stream'] })],
          ['Multipart: two files + text fields', curl('POST', '/v1/files/multipart', { form: ['file=@./hello.txt;type=text/plain', 'file=@./blob.bin;type=application/octet-stream', 'description=Monthly batch', 'batchId=B-1001'] })],
          ['Raw PUT, name from the path', curl('PUT', '/v1/files/raw/blob.bin', { include: true, contentType: 'application/octet-stream', file: './blob.bin' })],
          ['Raw POST octet-stream, name from Content-Disposition', curl('POST', '/v1/files/raw', { contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="blob.bin"' }, file: './blob.bin' })],
          ['Raw POST, name from X-Filename', curl('POST', '/v1/files/raw', { contentType: 'text/plain', headers: { 'X-Filename': 'hello.txt' }, file: './hello.txt' })],
          ['Raw POST, name from ?name=', curl('POST', '/v1/files/raw?name=hello.txt', { contentType: 'text/plain', file: './hello.txt' })],
          ['Local SHA-256 (compare with sha256 in the response)', 'openssl dgst -sha256 blob.bin'],
          ['Round trip: download FILE_ID (from the upload response) and compare', `${curl('GET', '/v1/files/FILE_ID/download', { output: 'roundtrip.bin' })} && cmp blob.bin roundtrip.bin && echo identical`],
          [`413: a file one MB over the limit`, `head -c ${((extra.maxFileSizeMb ?? 100) + 1) * 1048576} /dev/zero > too-big.bin\n${curl('PUT', '/v1/files/raw/too-big.bin', { include: true, contentType: 'application/octet-stream', file: './too-big.bin' })}`],
          ['400: multipart with no file part', curl('POST', '/v1/files/multipart', { include: true, form: ['description=no file here'] })],
          ['415: a body that is not multipart', curl('POST', '/v1/files/multipart', { include: true, contentType: 'text/plain', body: 'not a form', unsigned: true })],
        ],
      },
      'files.upload-more': {
        title: 'Uploading files: base64, tus, presigned URLs and S3',
        purpose: 'The other upload protocols, into the same pool. The commands reuse hello.txt and blob.bin from the multipart and raw guide.',
        steps: [
          'Base64 in JSON (`POST /v1/files/base64`): `{name, contentType?, data}`, where `data` is base64 (standard or URL-safe) or a `data:` URL whose type is used when `contentType` is missing. Missing `name`/`data` or invalid base64 → 422 with field errors. The JSON body may be about 1.4 × MAX_FILE_SIZE_MB.',
          'tus 1.0.0 (`/v1/files/tus`): POST with `Upload-Length` and `Upload-Metadata` (`filename`, `filetype`, values base64) → 201 + `Location`. Send the bytes with PATCH (`Upload-Offset`, `Content-Type: application/offset+octet-stream`) → 204 with the new `Upload-Offset`, in as many chunks as you like. `GET` the upload URL to see the offset when resuming (HEAD works too). The response that completes the upload carries `X-File-Id`. Wrong offset → 409 with the expected offset; DELETE cancels. Every request needs `Tus-Resumable: 1.0.0` (else 412).',
          'Presigned URL: `POST /v1/files/presign` with `{method: "PUT", name, contentType, expiresIn?}` returns `url`, the `headers` to send and the future `fileId`. PUT the bytes to `url` with those headers and no credentials. The URL expires (default 900 s); it is a real S3 URL when FILE_STORE=s3.',
          'S3 API: PutObject to the bucket with the S3 API keys (Protocols page), AWS Signature V4; folder-style keys such as `in/2026/blob.bin` are fine. AUTH_MODE does not apply here.',
          'Webhooks report each as `via` = `base64`, `tus` (after the last chunk only), `presigned` or `s3`.',
        ],
        curls: [
          ['Base64: encode a file and upload it', `printf '{"name":"blob.bin","contentType":"application/octet-stream","data":"%s"}' "$(openssl base64 -A -in blob.bin)" > blob.json\n${curl('POST', '/v1/files/base64', { contentType: 'application/json', file: './blob.json', signFile: true })}`],
          ['Base64: inline value', curl('POST', '/v1/files/base64', { json: { name: 'hello.txt', contentType: 'text/plain', data: 'SGVsbG8sIHdvcmxkIQ==' } })],
          ['Base64: data: URL (type taken from it)', curl('POST', '/v1/files/base64', { json: { name: 'hello.txt', data: 'data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==' } })],
          ['422: invalid base64', curl('POST', '/v1/files/base64', { include: true, json: { name: 'bad.txt', data: '*' } })],
          ['tus: create the upload (copy UPLOAD_ID from Location)', curl('POST', '/v1/files/tus', { include: true, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '13', 'Upload-Metadata': 'filename aGVsbG8udHh0,filetype dGV4dC9wbGFpbg==' } })],
          ['tus: send the bytes (X-File-Id appears when complete)', curl('PATCH', '/v1/files/tus/UPLOAD_ID', { include: true, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0' }, contentType: 'application/offset+octet-stream', file: './hello.txt' })],
          ['tus: current offset (to resume)', curl('GET', '/v1/files/tus/UPLOAD_ID')],
          ['tus: create and upload in one request', curl('POST', '/v1/files/tus', { include: true, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '13', 'Upload-Metadata': 'filename aGVsbG8udHh0' }, contentType: 'application/offset+octet-stream', file: './hello.txt' })],
          ['Presigned — step 1: get a URL', curl('POST', '/v1/files/presign', { json: { method: 'PUT', name: 'blob.bin', contentType: 'application/octet-stream', expiresIn: 600 } })],
          ['Presigned — step 2: PUT to the returned url (no credentials)', "curl -s -i -X PUT 'PRESIGNED_URL' -H 'Content-Type: application/octet-stream' --data-binary @./blob.bin"],
          ['S3 API: PutObject with a folder-style key', s3('PUT', 'in/2026/blob.bin', { upload: './blob.bin' })],
          ['S3 API: the same with the AWS CLI', aws(`s3 cp blob.bin s3://${S3.bucket}/in/2026/blob.bin`)],
        ],
      },
      'files.download': {
        title: 'Downloading & managing files',
        purpose: 'Read files back with streaming, byte ranges (206), chunked transfer, base64 or presigned links.',
        steps: [
          'List files with `GET /v1/files` and copy an id (or use "Copy URL" in the table).',
          'Download with `/download`. Add `Range: bytes=0-1023` to test partial content (206), and `If-None-Match` with the ETag to test 304.',
          'Use `/chunked` for a response without Content-Length, or `/base64` for the file inside JSON.',
          'Press "Regenerate samples" to recreate the CSV, XLSX, JSON, images, PDF, ZIP, TXT and ~10 MB binary.',
        ],
        curls: [
          ['List files', curl('GET', '/v1/files?limit=10&fields=id,name,size')],
          ['Download a file', curl('GET', `/v1/files/${fileId}/download`, { output: extra.fileName || 'download.bin' })],
          ['First 1 KB only (206 Partial Content)', curl('GET', `/v1/files/${fileId}/download`, { include: true, headers: { Range: 'bytes=0-1023' }, output: 'part.bin' })],
          ['Chunked transfer', curl('GET', `/v1/files/${fileId}/chunked`, { include: true, output: 'chunked.bin' })],
          ['As base64 JSON', curl('GET', `/v1/files/${fileId}/base64`)],
          ['Presigned download link', curl('POST', '/v1/files/presign', { json: { method: 'GET', fileId, expiresIn: 600 } })],
          ['Delete a file', curl('DELETE', `/v1/files/${fileId}`, { include: true })],
        ],
      },

      // ------------------------------------------------------------ auth
      'auth.mode': {
        title: 'Mode & credentials',
        purpose: 'How every API call must authenticate: /v1, SOAP, WebSocket upgrades, SSE, GraphQL, OData, the LLM mock, the MCP server and the A2A agent all use this mode (the S3 API signs with its own keys instead). The mode comes from AUTH_MODE in the environment unless it is overridden here. The examples in these guides always follow the active mode.',
        steps: [
          `The active mode is \`${C.mode}\`: ${C.authLabel}.`,
          'Configure your integration with the credentials shown in the form (API key name and location, Basic user and password, Bearer token, JWT settings or the HMAC key).',
          'Call any /v1 endpoint. A missing or wrong credential returns 401 problem+json with a WWW-Authenticate header (other protocols answer 401 in their own error format).',
          'Health, docs, OpenAPI, OAuth and discovery endpoints never need credentials.',
        ],
        curls: [
          ['Authenticated call with the active mode', curl('GET', '/v1/employees?limit=1', { include: true })],
          ['Same call without credentials (expect 401)', plain('GET', '/v1/employees?limit=1', { include: true })],
        ],
      },
      'profiles.list': {
        title: 'Settings profiles',
        purpose: 'Several auth modes or chaos setups at once on one server: a request to `/p/<name>/…` runs with that profile\'s settings, and nothing global changes.',
        steps: [
          `Pick a profile and give its base URL to your integration instead of \`${C.root}\`, e.g. \`${C.root}/p/apikey/v1\` for the REST API or \`${C.root}/p/oauth2/mcp\` for the MCP server.`,
          'There is one built-in profile per auth mode (`none`, `apikey`, `basic`, `bearer`, `jwt`, `oauth2`, `hmac`) using the credentials configured on the Auth page. Add your own for a person or a demo: auth mode, credentials, chaos, headers, rate limit and formats.',
          `The OAuth server is shared: get tokens from \`${C.ctx.tokenUrl}\` and use them in any profile. HMAC signs the path as sent, \`/p/<name>\` included.`,
          'Data, files, OAuth clients and users, webhooks and the inspector are shared by every profile. The inspector tags each request with its profile.',
          C.prefix ? `The guides are written for \`${C.prefix}\` right now (picker at the bottom of the menu).` : 'Pick a profile at the bottom of the menu to write every guide and curl for it.',
        ],
        curls: [
          ['API key profile: without, then with the key (401, then 200)', `curl -s -i ${q(`${C.root}/p/apikey/v1/employees?limit=1`)}\ncurl -s ${q(`${C.root}/p/apikey/v1/employees?limit=1`)} -H 'X-API-Key: <the API key on the Auth page>'`],
          ['OAuth2 profile with a token from the shared OAuth server', `${C.tokenLine()}\ncurl -s ${q(`${C.root}/p/oauth2/v1/employees?limit=1`)} -H "Authorization: Bearer $TOKEN"`],
          ['List the profiles', admin('GET', '/profiles')],
        ],
      },
      'profiles.edit': {
        title: 'Create or edit a profile',
        purpose: 'A custom profile holds only the settings that differ from the global ones; everything else follows the global settings.',
        steps: [
          'Name it (lowercase letters, digits, hyphens): the name becomes the path `/p/<name>`.',
          'Add the settings to change, e.g. `authMode` = `oauth2` and `errorRate` = `20` for a flaky OAuth API. Remove a row to fall back to the global value.',
          'Save, then copy the profile\'s base URL from the table. Changes apply to the next request; the built-in profiles cannot be edited.',
        ],
        curls: [
          ['Create a profile', admin('POST', '/profiles', { json: { name: 'flaky-oauth', description: 'OAuth2 with 20% 503s', settings: { authMode: 'oauth2', errorRate: 20, errorTypes: '503' } } })],
          ['Change its settings (replaces the whole set)', admin('PATCH', '/profiles/flaky-oauth', { json: { settings: { authMode: 'oauth2', errorRate: 0 } } })],
          ['Delete it', admin('DELETE', '/profiles/flaky-oauth')],
        ],
      },
      'auth.token': {
        title: 'Get a test token',
        purpose: 'Issue an access token from the built-in OAuth server. Tokens are signed JWTs and are accepted in both `jwt` and `oauth2` modes.',
        steps: [
          'Pick a client and, optionally, a narrower scope (`read` allows GET; `write` allows changes in `oauth2` mode). The MCP server and the A2A agent check by operation: `read` for reading tools and questions, `write` for anything that changes data.',
          'Press "Issue token", then copy the token or the whole Authorization header.',
          `In your integration, use the client-credentials grant against \`${C.ctx.tokenUrl}\` to fetch tokens automatically.`,
        ],
        curls: [
          ['Client credentials grant', `curl -s -u ${q(`${c.clientId}:${c.secret}`)} -d grant_type=client_credentials -d scope='read write' ${q(C.ctx.tokenUrl)}`],
          ['Client credentials with the secret in the form body', `curl -s -d grant_type=client_credentials -d client_id=${q(c.clientId)} -d client_secret=${q(c.secret)} ${q(C.ctx.tokenUrl)}`],
          ['Fetch a token and call the API', `${C.tokenLine()}\ncurl -s ${q(`${B}/v1/employees?limit=1`)} -H "Authorization: Bearer $TOKEN"`],
        ],
      },
      'auth.server': {
        title: 'OAuth server',
        purpose: 'A standalone OAuth 2.0 / OIDC-style server: client credentials, authorization code with PKCE, refresh tokens, introspection, revocation, dynamic client registration, discovery and JWKS.',
        steps: [
          'Point your platform\'s OAuth configuration at the discovery document, or enter the token and authorize URLs by hand.',
          'For authorization code + PKCE, send the user to the authorize URL; they sign in as one of the OAuth users (see the OAuth users card for their roles and attributes) and consent.',
          'Validate tokens yourself with the JWKS, or ask the server with introspection.',
          'Clients that register themselves (MCP clients, for example) find `registration_endpoint` in the discovery document; see the Dynamic client registration card.',
          'MCP clients find this server from the MCP endpoint\'s 401 (its `resource_metadata` points at `/.well-known/oauth-protected-resource/mcp`). A `resource` parameter (RFC 8707) on the authorize or token request is added to the token\'s audience.',
        ],
        curls: [
          ['Discovery metadata', plain('GET', '/.well-known/oauth-authorization-server')],
          ['Signing keys (JWKS)', plain('GET', '/.well-known/jwks.json')],
          ['Introspect a token', `${C.tokenLine()}\ncurl -s -u ${q(`${c.clientId}:${c.secret}`)} -d "token=$TOKEN" ${q(`${B}/oauth/introspect`)}`],
          ['Revoke a token', `curl -s -u ${q(`${c.clientId}:${c.secret}`)} -d "token=$TOKEN" ${q(`${B}/oauth/revoke`)}`],
          ['Authorization code + PKCE (open in a browser)', `${B}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(c.clientId)}&redirect_uri=https%3A%2F%2Foauth.pstmn.io%2Fv1%2Fcallback&scope=read&state=xyz&code_challenge=CHALLENGE&code_challenge_method=S256`],
        ],
      },
      'auth.clients': {
        title: 'OAuth clients',
        purpose: 'The client ids and secrets the OAuth server accepts: clients from OAUTH_CLIENTS (env), clients added here, and clients that registered themselves through /oauth/register (source "registered"), with their grants and redirect URIs.',
        steps: [
          'Add a client per integration you test, with the scopes it should get (e.g. `read` only, to test 403 on writes).',
          'Leave the secret blank to generate one; add redirect URIs for the authorization code flow.',
          'Use the new id and secret in your platform\'s OAuth connection.',
          'Edit changes a client in place: add or remove redirect URIs (handy while developing: loopback http URIs match on any port, custom schemes like `myapp://callback` work), change scopes or grant types, set or regenerate the secret. Fields you leave alone are kept.',
          'Editing an env client (OAUTH_CLIENTS) stores an edited copy that wins over the env entry; Revert removes the copy. Delete removes a dashboard-added or registered client.',
          ...pw,
        ],
        curls: [
          ['Add a read-only client', admin('POST', '/oauth/clients', { json: { clientId: 'read-only-app', scopes: 'read' } })],
          ['Get a token for it', `curl -s -u 'read-only-app:SECRET' -d grant_type=client_credentials ${q(C.ctx.tokenUrl)}`],
          ['Add a redirect URI to an existing client', admin('PATCH', `/oauth/clients/${encodeURIComponent(c.clientId)}`, { json: { redirectUris: ['https://oauth.pstmn.io/v1/callback', 'http://localhost:8080/callback'] } })],
          ['Regenerate its secret', admin('PATCH', `/oauth/clients/${encodeURIComponent(c.clientId)}`, { json: { secret: '' } })],
        ],
      },
      'auth.users': {
        title: 'OAuth users',
        purpose: 'The users who can sign in on the authorization_code (PKCE) login page, and the roles and attributes their tokens carry. Users come from OAUTH_USERS (env) and from this card (stored in the database).',
        steps: [
          `Roles go to each claim path in \`oauthRolesClaim\` (now \`${extra.rolesClaim || 'realm_access.roles'}\`). The default \`realm_access.roles\` is the Keycloak shape; list several paths, comma separated (e.g. \`realm_access.roles,roles\`), to write the roles to each. A user with no roles gets no roles claim.`,
          'Attributes are a JSON object: each key becomes a top-level claim with its value (string, number, boolean, array or object). Standard and server claims (`iss`, `sub`, `aud`, `exp`, `scope`, `client_id`, `preferred_username`, …) and the roles claim\'s top level cannot be attributes.',
          'A user\'s token also has `sub` and `preferred_username` set to the username. Introspection returns the same roles and attributes, and a refreshed token picks up the user\'s current roles and attributes; a deleted user\'s codes and refresh tokens stop working.',
          'Editing a user from OAUTH_USERS stores an edited copy that wins over the env entry; Revert removes it. In OAUTH_USERS: `user:password:role1,role2:key=value,key2=value2`, entries separated by `;` (a value that is valid JSON, like `42` or `true`, is kept as JSON).',
          'To see a user\'s claims without signing in, pick the user under "Get a test token".',
          ...pw,
        ],
        curls: [
          ['Add a user with roles and attributes', admin('POST', '/oauth/users', { json: { username: 'alice', password: 'alice', roles: ['admin', 'buyer'], attributes: { region: 'EMEA', tier: 'gold' } } })],
          ['Change their roles', admin('PATCH', '/oauth/users/alice', { json: { roles: ['viewer'] } })],
          ['The token alice would get (decoded)', admin('POST', '/auth/test-token', { json: { clientId: c.clientId, username: 'alice' } })],
          ['Sign in as alice with PKCE from a terminal, then introspect the token', [
            "VERIFIER=$(openssl rand -hex 32)",
            "CHALLENGE=$(printf %s \"$VERIFIER\" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')",
            `LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -d response_type=code -d client_id=${q(c.clientId)} -d redirect_uri=https://oauth.pstmn.io/v1/callback -d scope=read -d code_challenge="$CHALLENGE" -d code_challenge_method=S256 -d decision=allow -d username=alice -d password=alice ${q(`${B}/oauth/authorize`)})`,
            "CODE=$(printf %s \"$LOC\" | sed -E 's/.*[?&]code=([^&]+).*/\\1/')",
            `TOKEN=$(curl -s -u ${q(`${c.clientId}:${c.secret}`)} -d grant_type=authorization_code -d code="$CODE" -d redirect_uri=https://oauth.pstmn.io/v1/callback -d code_verifier="$VERIFIER" ${q(C.ctx.tokenUrl)} | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')`,
            `curl -s -u ${q(`${c.clientId}:${c.secret}`)} -d "token=$TOKEN" ${q(`${B}/oauth/introspect`)}`,
          ].join('\n')],
          ['Put the roles in both shapes', admin('PUT', '/settings', { json: { oauthRolesClaim: 'realm_access.roles,roles' } })],
        ],
      },
      'auth.registration': {
        title: 'Dynamic client registration',
        purpose: 'Clients can register themselves (RFC 7591) instead of being added by hand: they POST their metadata and get a client_id, a secret unless they are public, and a token to read or delete the registration (RFC 7592). MCP clients use this to connect to an authorization server they have never seen.',
        steps: [
          `The endpoint is \`${B}/oauth/register\` and is advertised as \`registration_endpoint\` in \`${B}/.well-known/oauth-authorization-server\`.`,
          'Send JSON metadata: `redirect_uris` (needed for authorization_code; loopback http URIs match on any port, custom schemes such as `myapp://cb` are allowed), `grant_types` (authorization_code, refresh_token, client_credentials), `token_endpoint_auth_method` (client_secret_basic, client_secret_post, or none for a public client), optional `scope`, `client_name`.',
          'A public client (`none`) has no secret, must use PKCE, and cannot use client_credentials. Each client can use only the grants it registered for; refresh tokens are issued only to clients with the refresh_token grant.',
          'Open registration is limited, because anyone who finds the endpoint can use it: only the grants in `oauthRegistrationGrants` (by default authorization_code, refresh_token and client_credentials; remove client_credentials so that every token needs a user to sign in), redirect URIs that are https, loopback http or a custom scheme, and `oauthRegistrationRate` registrations per address per hour. Without client_credentials in `oauthRegistrationGrants`, a machine client needs the initial access token (`token` mode) or the Auth page.',
          'Registered clients that obtain no token for `oauthRegistrationTtlDays` are deleted. At `oauthRegistrationMax` the oldest never-used registration makes room.',
          'Keep the `registration_access_token` from the response: with it, GET or DELETE the `registration_client_uri`. Registered clients also show in the clients table, where you can delete them.',
          'Errors are RFC 7591 JSON: `invalid_client_metadata`, `invalid_redirect_uri`; 401 `invalid_token` when the mode needs an initial access token; 429 `rate_limited` with `Retry-After` past the hourly limit.',
        ],
        curls: [
          ['Register a public client with PKCE (as an MCP client does)', plain('POST', '/oauth/register', { json: { client_name: 'My MCP client', redirect_uris: ['http://127.0.0.1:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } })],
          ['Register a machine client, then get a token', `REG=$(curl -s ${q(`${B}/oauth/register`)} -H 'Content-Type: application/json' -d '{"client_name":"Integration","grant_types":["client_credentials"],"scope":"read"}')\nID=$(printf '%s' "$REG" | sed -E 's/.*"client_id":"([^"]+)".*/\\1/'); SECRET=$(printf '%s' "$REG" | sed -E 's/.*"client_secret":"([^"]+)".*/\\1/')\ncurl -s -u "$ID:$SECRET" -d grant_type=client_credentials ${q(`${B}/oauth/token`)}`],
          ['Read the registration (RFC 7592)', "curl -s -H 'Authorization: Bearer REGISTRATION_ACCESS_TOKEN' 'REGISTRATION_CLIENT_URI'"],
          ['Delete the registration', "curl -s -X DELETE -H 'Authorization: Bearer REGISTRATION_ACCESS_TOKEN' 'REGISTRATION_CLIENT_URI'"],
          ['Is registration advertised?', plain('GET', '/.well-known/oauth-authorization-server')],
        ],
      },
      'auth.registration-settings': {
        title: 'Registration settings',
        purpose: 'Decide who may register clients and what they may ask for.',
        steps: [
          '`oauthRegistration`: `open` (anyone, what MCP clients expect), `token` (the client must send `Authorization: Bearer <oauthRegistrationToken>`), or `off` (no endpoint, not advertised).',
          '`oauthRegistrationScopes`: the scopes a registered client may ask for; a client that asks for none gets all of them.',
          '`oauthRegistrationGrants`: the grants an open registration may ask for (default authorization_code refresh_token client_credentials). With client_credentials, anyone who finds the endpoint can mint tokens without a user signing in; set authorization_code refresh_token to lock that down. `token` mode allows every grant and any http(s) redirect URI.',
          '`oauthRegistrationRate`: open registrations per client address per hour (0 = no limit); beyond it 429 with `Retry-After`.',
          '`oauthRegistrationTtlDays`: registered clients that have not obtained a token for this many days are deleted (0 = keep forever).',
          '`oauthRegistrationMax`: the most registered clients kept. At the limit the oldest never-used registration makes room; if all have been used, registration is refused. **Delete unused** and **Delete all registered** on the Dynamic client registration card clean up by hand.',
          'With `AUTH_MODE=oauth2` or `jwt`, tokens issued to registered clients are accepted on every protocol, like any other client\'s.',
          ...pw,
        ],
        curls: [
          ['Require an initial access token', admin('PUT', '/settings', { json: { oauthRegistration: 'token', oauthRegistrationToken: 'change-me' } })],
          ['Register with it', `curl -s ${q(`${B}/oauth/register`)} -H 'Authorization: Bearer change-me' -H 'Content-Type: application/json' -d '{"grant_types":["client_credentials"]}'`],
          ['Turn registration off', admin('PUT', '/settings', { json: { oauthRegistration: 'off' } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'oauth' } })],
        ],
      },
      'auth.hmac': {
        title: 'HMAC signer',
        purpose: 'Signs a request the way the `hmac` mode expects, so you can compare it with the signature your integration produces.',
        steps: [
          'Canonical string: method, path with query, X-Timestamp and the hex SHA-256 of the body, joined by newlines.',
          'Signature: base64 of HMAC-SHA256(secret, canonical). Send `Authorization: HMAC <keyId>:<signature>` and `X-Timestamp`.',
          'Streamed file uploads sign the literal `UNSIGNED-PAYLOAD` instead of a body hash.',
          'Enter a request here and press Sign to see the canonical string and headers.',
        ],
        curls: [
          ['Sign and send a GET with openssl', makeCurl({ ...C.ctx, mode: 'hmac', required: C.ctx.required }).curl('GET', '/v1/employees?limit=2')],
          ['Sign and send a POST with a body', makeCurl({ ...C.ctx, mode: 'hmac', required: C.ctx.required }).curl('POST', '/v1/departments', { json: { name: 'Research', code: 'RND' } })],
        ],
      },

      // ------------------------------------------------------------ chaos
      'chaos.rates': {
        title: 'Rates & latency',
        purpose: 'Random failures and slowness on every API protocol (/v1, SOAP, WebSocket, SSE, GraphQL, OData, LLM, MCP, A2A, S3), so you can test retries, timeouts and error handling under realistic conditions.',
        steps: [
          'Set an error rate (0–100 %) and the error types to draw from: any status, `timeout`, `reset`, `malformed-json`, `truncated-body`, `empty-body`, `wrong-content-type`, `slow-drip`.',
          'Add a latency range to slow every call, and a requests-per-minute limit to trigger 429 with `Retry-After`.',
          'Run your integration and check how it behaves. Injected responses carry `X-Chaos-Injected`.',
          'Set the rate back to 0 when you are done.',
          ...pw,
        ],
        curls: [
          ['20 % of calls fail with 500 or 503', admin('PUT', '/settings', { json: { errorRate: 20, errorTypes: '500,503' } })],
          ['Add 200–800 ms latency and a 60 rpm limit', admin('PUT', '/settings', { json: { latencyMinMs: 200, latencyMaxMs: 800, rateLimitRpm: 60 } })],
          ['Watch the headers (RateLimit-*, X-Chaos-Injected)', curl('GET', '/v1/employees?limit=1', { include: true })],
          ['Turn chaos off', admin('PUT', '/settings', { json: { errorRate: 0, latencyMinMs: 0, latencyMaxMs: 0, rateLimitRpm: 0 } })],
        ],
      },
      'chaos.routes': {
        title: 'Per-route overrides',
        purpose: 'Different chaos for specific paths or methods — for example, make only file uploads slow, or only products flaky.',
        steps: [
          'Add a JSON list of overrides. Each has `path`, optionally `method`, and any of `errorRate`, `errorTypes`, `latencyMinMs`, `latencyMaxMs`.',
          'Save. Overrides win over the global rates for matching calls.',
          'Call the route and confirm with the `X-Chaos-Injected` header.',
          ...pw,
        ],
        curls: [
          ['Half of /v1/products calls fail', admin('PUT', '/settings', { json: { chaosRouteOverrides: [{ path: '/v1/products', errorRate: 50, errorTypes: '503,timeout' }] } })],
          ['Try it', curl('GET', '/v1/products?limit=1', { include: true })],
        ],
      },
      'chaos.force': {
        title: 'Forcing headers',
        purpose: 'Make one specific request fail or slow down, every time. Ideal for automated tests because the result is deterministic.',
        steps: [
          'Add `X-Force-Error`, `X-Force-Status` or `X-Force-Latency` to a single request.',
          'Forcing headers always win over random rates and per-route settings.',
          'Assert on the status, the problem+json body and the `X-Chaos-Injected` header in your test.',
        ],
        curls: [
          ['Force a 503', curl('GET', '/v1/employees/1', { include: true, headers: { 'X-Force-Error': '503' } })],
          ['Force malformed JSON', curl('GET', '/v1/employees/1', { include: true, headers: { 'X-Force-Error': 'malformed-json' } })],
          ['Force a timeout (curl gives up after 5 s)', curl('GET', '/v1/employees/1', { headers: { 'X-Force-Error': 'timeout' }, extra: ['--max-time 5'] })],
          ['Add 2 s of latency', curl('GET', '/v1/employees?limit=1', { headers: { 'X-Force-Latency': '2000' }, extra: ['-w "\\n%{time_total}s\\n"'] })],
        ],
      },

      // ------------------------------------------------------------ headers
      'headers.response': {
        title: 'Response headers',
        purpose: 'Headers added to every response from this server — useful to test that your integration reads or forwards custom headers.',
        steps: [
          'Enter a JSON list such as `[{"name":"X-Env","value":"demo"}]` and Save.',
          'Call any endpoint with `-i` and look for the header.',
          ...pw,
        ],
        curls: [
          ['Add X-Env: demo to every response', admin('PUT', '/settings', { json: { responseHeaders: [{ name: 'X-Env', value: 'demo' }] } })],
          ['Check the headers', curl('GET', '/v1/employees?limit=1', { include: true })],
        ],
      },
      'headers.required': {
        title: 'Required request headers',
        purpose: 'Headers every API request must carry on every protocol (/v1, SOAP, WebSocket, SSE, GraphQL, OData, LLM, MCP, A2A, S3), optionally with an exact value. Missing or wrong ones return 400 in that protocol\'s error format (problem+json on /v1).',
        steps: [
          'Enter a JSON list such as `[{"name":"X-Tenant"},{"name":"X-Env","value":"demo"}]` and Save.',
          'Configure the same headers in your integration.',
          'The curl examples in every guide already include the required headers that are set now.',
          ...pw,
        ],
        curls: [
          ['Require X-Tenant', admin('PUT', '/settings', { json: { requiredHeaders: [{ name: 'X-Tenant' }] } })],
          ['A call that includes the required headers', curl('GET', '/v1/employees?limit=1', { include: true })],
          ['A call without them (expect 400 when any are required)', makeCurl({ ...C.ctx, required: [] }).curl('GET', '/v1/employees?limit=1', { include: true })],
        ],
      },

      // ------------------------------------------------------------ protocols: SOAP
      'protocols.soap': {
        title: 'SOAP services',
        purpose: 'SOAP 1.1 and 1.2 services over the same mock data as /v1, for integrations that call SOAP. Each service has a live WSDL; auth, chaos, rate limits and required headers work exactly as on /v1, but errors come back as SOAP faults.',
        steps: [
          `Import the WSDL into your integration or SOAP client: \`${B}/soap/EmployeeService?wsdl\` or \`${B}/soap/ProductService?wsdl\`. The WSDL is always open.`,
          'Send `text/xml` with a `SOAPAction` header for SOAP 1.1, or `application/soap+xml; action="…"` for SOAP 1.2. The version of the reply follows the request.',
          `Requests use the active auth mode (${C.authLabel}) and any required headers, the same as /v1.`,
          'Faults: SOAP 1.1 faults are HTTP 500 and SOAP 1.2 Sender faults are HTTP 400. Errors before the envelope is read (401, 429, injected chaos statuses) keep their real HTTP status. Every fault carries an `f:faultDetail` with status, code, requestId and field errors.',
          'Use `X-Force-Error: 503` (or any chaos setting) to test fault handling. Every call shows up on the Inspector page.',
        ],
        curls: [
          ['List the services', plain('GET', '/soap')],
          ['Download the EmployeeService WSDL', plain('GET', '/soap/EmployeeService?wsdl', { output: 'EmployeeService.wsdl' })],
          ['GetEmployee (SOAP 1.1)', curl('POST', '/soap/EmployeeService', {
            body: soapEnv('1.1', EMP_NS, '<tns:GetEmployee><tns:id>1</tns:id></tns:GetEmployee>'),
            contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: `"${EMP_NS}/GetEmployee"` },
          })],
          ['ListProducts, page 2 of 5 (SOAP 1.2)', curl('POST', '/soap/ProductService', {
            body: soapEnv('1.2', PROD_NS, '<tns:ListProducts><tns:page>2</tns:page><tns:pageSize>5</tns:pageSize></tns:ListProducts>'),
            contentType: `application/soap+xml; charset=utf-8; action="${PROD_NS}/ListProducts"`,
          })],
          ['CreateDepartment is not an operation: see the fault', curl('POST', '/soap/EmployeeService', {
            include: true,
            body: soapEnv('1.1', EMP_NS, '<tns:CreateDepartment><tns:name>Ops</tns:name></tns:CreateDepartment>'),
            contentType: 'text/xml; charset=utf-8',
          })],
          ['Force a 503 fault', curl('POST', '/soap/EmployeeService', {
            include: true,
            body: soapEnv('1.1', EMP_NS, '<tns:GetEmployee><tns:id>1</tns:id></tns:GetEmployee>'),
            contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: `"${EMP_NS}/GetEmployee"`, 'X-Force-Error': '503' },
          })],
        ],
      },
      'protocols.soap-settings': {
        title: 'SOAP settings',
        purpose: 'Turn the SOAP mock on or off, require WS-Security, and choose how strictly SOAPAction is checked.',
        steps: [
          '`soapWsse`: off ignores the wsse:Security header; optional checks it when present; required rejects requests without a valid UsernameToken. The username and password are BASIC_USER / BASIC_PASS; PasswordText and PasswordDigest both work.',
          'WS-Security is separate from the auth mode: when both are set, a request needs both.',
          '`soapActionCheck`: lenient faults on a wrong action but accepts a missing one; strict requires the right one; off ignores it.',
          ...pw,
        ],
        curls: [
          ['Require WS-Security', admin('PUT', '/settings', { json: { soapWsse: 'required' } })],
          ['Call with a UsernameToken (PasswordText)', curl('POST', '/soap/EmployeeService', {
            body: soapEnv('1.1', EMP_NS, '<tns:GetEmployee><tns:id>1</tns:id></tns:GetEmployee>',
              `<wsse:Security xmlns:wsse="${WSSE_NS}"><wsse:UsernameToken><wsse:Username>${C.ctx.basic.user}</wsse:Username><wsse:Password>${C.ctx.basic.pass}</wsse:Password></wsse:UsernameToken></wsse:Security>`),
            contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: `"${EMP_NS}/GetEmployee"` },
          })],
          ['Strict SOAPAction checking', admin('PUT', '/settings', { json: { soapActionCheck: 'strict' } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'soap' } })],
        ],
      },

      'protocols.soap-try': {
        title: 'Try a SOAP request',
        purpose: 'Send one SOAP request from the browser and see the raw response or fault. The envelope is pre-filled for the chosen operation.',
        steps: [
          'Pick a service, an operation and the SOAP version; edit the envelope if you want (ids, fields, a deliberate mistake).',
          'Credentials for the active auth mode and any required headers are added for you. Tick the WS-Security box when soapWsse is on.',
          'Put a status or failure type in X-Force-Error to see how faults and broken responses look.',
          'Use the copied response as a fixture, or compare it with what your integration received on the Inspector page.',
        ],
        curls: [
          ['UpdateEmployee (SOAP 1.1)', curl('POST', '/soap/EmployeeService', {
            body: soapEnv('1.1', EMP_NS, '<tns:UpdateEmployee><tns:id>1</tns:id><tns:employee><tns:title>Senior Analyst</tns:title></tns:employee></tns:UpdateEmployee>'),
            contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: `"${EMP_NS}/UpdateEmployee"` },
          })],
          ['A broken response to test parsing', curl('POST', '/soap/ProductService', {
            body: soapEnv('1.2', PROD_NS, '<tns:GetProduct><tns:id>1</tns:id></tns:GetProduct>'),
            contentType: `application/soap+xml; charset=utf-8; action="${PROD_NS}/GetProduct"`, headers: { 'X-Force-Error': 'truncated-body' },
          })],
        ],
      },

      // ------------------------------------------------------------ protocols: WebSocket
      'protocols.ws': {
        title: 'WebSocket channels',
        purpose: 'Mock WebSocket endpoints over the same data: echo, a JSON-RPC style request/response channel, and a live change feed. The upgrade request uses the active auth mode, rate limit, required headers and chaos, so a rejected upgrade returns the usual HTTP status.',
        steps: [
          `Connect your client to \`${B.replace(/^http/, 'ws')}/ws/echo\`, \`/ws/rpc\` or \`/ws/changes\` (add \`?resource=employees\` to filter the feed).`,
          `Credentials: ${C.authLabel}. Browsers cannot set headers, so for Bearer, JWT and OAuth2 a \`?access_token=\` query parameter is accepted on the upgrade too.`,
          'On /ws/rpc send `{"jsonrpc":"2.0","id":1,"method":"getEmployee","params":{"id":1}}`; the reply has the same id. Methods: ping, time, echo, getEmployee/Product/Department/Category, listEmployees/Products/Departments/Categories.',
          'Change any record (in /v1, /soap or the back office) and /ws/changes pushes a created/updated/deleted event.',
          `Import \`${B}/ws/asyncapi.json\` (AsyncAPI 3.0) into a client or into this tool\'s API Tester.`,
        ],
        curls: [
          ['List the channels', plain('GET', '/ws')],
          ['Download the AsyncAPI document', plain('GET', '/ws/asyncapi.json', { output: 'api-test-tool.asyncapi.json' })],
          ['Call getEmployee over /ws/rpc (Node 22+)', ws('/ws/rpc', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEmployee', params: { id: 1 } }))],
          ['Echo a message', ws('/ws/echo', 'hello')],
          ['Watch the change feed for 30 seconds', ws('/ws/changes?resource=employees', undefined, { listenMs: 30000 })],
          ['Check the upgrade handshake with curl', curl('GET', '/ws/echo', { include: true, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }, extra: ['--http1.1', '--max-time 2'] })],
        ],
      },
      'protocols.ws-settings': {
        title: 'WebSocket settings',
        purpose: 'Turn the WebSocket mock on or off, and set its message size limit, idle timeout and keep-alive pings.',
        steps: [
          '`wsMaxMessageKb`: larger messages close the connection with 1009 (message too big).',
          '`wsIdleTimeoutSeconds`: close connections that send nothing for that long (1001); 0 keeps them open.',
          '`wsPingIntervalSeconds`: the server pings; a connection that misses a pong is dropped. 0 turns pings off.',
          'Use X-Force-Error on the upgrade request (e.g. 503) or a chaos rate to test reconnect logic.',
          ...pw,
        ],
        curls: [
          ['Close idle connections after 30 s', admin('PUT', '/settings', { json: { wsIdleTimeoutSeconds: 30 } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'websocket' } })],
        ],
      },
      'protocols.ws-try': {
        title: 'Live WebSocket console',
        purpose: 'Connect from this page to one of the mock channels, send messages and watch everything that comes back.',
        steps: [
          'Pick a channel and press Connect. The browser sends the active credentials where it can: query-string API keys, and ?access_token= for Bearer, JWT and OAuth2.',
          'HTTP Basic, header API keys, HMAC and required headers cannot be set by a browser: use the Node command from the channel guide, or switch the auth mode while you experiment.',
          'Every connection also shows up on the Inspector page as a 101 upgrade.',
        ],
        curls: [
          ['The same from a terminal (Node 22+)', ws('/ws/rpc', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'listDepartments', params: { limit: 3 } }))],
        ],
      },

      // ------------------------------------------------------------ protocols: SSE
      'protocols.sse': {
        title: 'Server-Sent Events streams',
        purpose: 'text/event-stream endpoints for integrations that consume streams: a live change feed with Last-Event-ID replay, numbered ticks, and a request that answers with a token stream (LLM-style). They use the active auth mode, rate limit, required headers and chaos like /v1.',
        steps: [
          `Subscribe to \`${B}/sse/changes\` (add \`?resource=employees\`), then change a record anywhere: each create, update and delete arrives as an event whose type is the change type.`,
          'Reconnect with the `Last-Event-ID` header (EventSource does this itself) and missed events are replayed from the buffer; a too-old id gets `event: reset`.',
          '`/sse/ticks?interval=500&count=10` sends numbered events, then `event: end`. `POST /sse/stream` with `{"prompt": "…", "words": 40, "format": "openai"}` streams chat.completion.chunk objects and `data: [DONE]`.',
          'Test failure handling with `dropAfter=N` (cut the connection), `malformedAt=N` (a broken frame) and `skipIds=true` on any stream, or with X-Force-Error before the stream starts.',
          `Credentials: ${C.authLabel}. EventSource cannot set headers, so for Bearer, JWT and OAuth2 \`?access_token=\` is accepted on streams.`,
        ],
        curls: [
          ['Watch the change feed (Ctrl-C to stop)', curl('GET', '/sse/changes?resource=employees', { extra: ['-N'] })],
          ['Three ticks, then the stream ends', curl('GET', '/sse/ticks?interval=200&count=3', { extra: ['-N'] })],
          ['Resume ticks after id 5', curl('GET', '/sse/ticks?interval=200&count=8', { headers: { 'Last-Event-ID': '5' }, extra: ['-N'] })],
          ['Stream an answer (OpenAI chunk format)', curl('POST', '/sse/stream', { json: { prompt: 'Who works in R&D?', words: 30, delayMs: 30, format: 'openai' }, extra: ['-N'] })],
          ['A connection cut after 3 events', curl('GET', '/sse/ticks?interval=200&dropAfter=3', { extra: ['-N'] })],
        ],
      },
      'protocols.sse-settings': {
        title: 'SSE settings',
        purpose: 'Turn the SSE mock on or off and tune heartbeats, the client retry hint, the replay buffer and the default tick interval.',
        steps: [
          '`sseHeartbeatSeconds`: a comment line keeps idle streams alive through proxies; 0 turns it off.',
          '`sseRetryMs`: the `retry:` value sent first on every stream, i.e. how long EventSource waits before reconnecting.',
          '`sseReplayBuffer`: how many change events are kept for Last-Event-ID resume.',
          ...pw,
        ],
        curls: [
          ['Heartbeat every 5 seconds', admin('PUT', '/settings', { json: { sseHeartbeatSeconds: 5 } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'sse' } })],
        ],
      },
      'protocols.sse-try': {
        title: 'Live SSE viewer',
        purpose: 'Open a stream from this page with the browser\'s EventSource and watch the events arrive, including automatic reconnects.',
        steps: [
          'Pick changes or ticks, optionally add query parameters, and press Connect.',
          'Add `dropAfter=3` to see EventSource reconnect on its own and resume from the last id.',
          'Credentials go in the query string where a browser allows it; for header-based modes use the curl from the streams guide.',
        ],
        curls: [
          ['The same stream from a terminal', curl('GET', '/sse/ticks?interval=500&count=5', { extra: ['-N'] })],
        ],
      },

      // ------------------------------------------------------------ protocols: A2A
      'protocols.a2a': (() => {
        const msg = (text, extra = {}) => ({ messageId: 'msg-1', role: 'ROLE_USER', parts: [{ text }], ...extra });
        const rpc = (method, params, o = {}) => curl('POST', '/a2a', { json: { jsonrpc: '2.0', id: 1, method, params }, headers: { 'A2A-Version': '1.0', ...(o.headers || {}) }, extra: o.extra });
        return {
          title: 'A2A agent',
          purpose: 'A mock Agent2Agent (A2A) agent that answers questions about the mock company (employees, products, departments, categories, statistics) and can change that data. Answers come back as tasks with artifacts, so you can test an agent platform, an orchestrator or an A2A gateway against a real protocol peer. It uses the active auth mode, rate limit, required headers and chaos like /v1.',
          steps: [
            `Give your A2A client the Agent Card URL \`${B}/.well-known/agent-card.json\`. It lists three interfaces: JSON-RPC 1.0 at \`${B}/a2a\`, HTTP+JSON 1.0 at \`${B}/a2a/rest\` and JSON-RPC 0.3 at \`${B}/a2a/v0.3\` (whose own card is at \`${B}/a2a/v0.3/.well-known/agent-card.json\`). Credentials: ${C.authLabel}.`,
            'A2A 1.0 requests carry the header `A2A-Version: 1.0`; without it a request is 0.3, as the spec requires, so `SendMessage` without the header is "method not found" (the error says why).',
            'Ask in plain words: "Who works in Engineering at level L5?", "Products under $50 that are in stock", "How many employees do we have?". A greeting or "help" gets a direct Message; questions become tasks that go SUBMITTED → WORKING → COMPLETED with an `answer` artifact (text, streamed in chunks) and a `data` artifact (JSON). A missing record ends FAILED; an unrelated question ("the weather") is REJECTED.',
            'Multi-turn: "Delete product 9" stops at INPUT_REQUIRED and asks for confirmation; send "yes" with the same `taskId` to finish it. Changes show up on every other API of the tool and fire webhooks.',
            'SendMessage waits for the result unless `configuration.returnImmediately` is true; then poll GetTask, open SubscribeToTask, or set `configuration.taskPushNotificationConfig` to have every event POSTed to your URL. A2A_WORK_MS sets how long a task takes.',
            'Chaos: `X-Force-A2A-Error: fail | reject | input-required | auth-required` ends the task in that state, `rpc` returns a JSON-RPC error and `drop` cuts a stream.',
          ],
          curls: [
            ['Fetch the Agent Card', plain('GET', '/.well-known/agent-card.json')],
            ['Ask a question (JSON-RPC 1.0)', rpc('SendMessage', { message: msg('Who works in Engineering at level L5?') })],
            ['Stream the answer', rpc('SendStreamingMessage', { message: msg('Products under $50 that are in stock') }, { extra: ['-N'] })],
            ['Start a task and return at once', rpc('SendMessage', { message: msg('How many employees do we have?'), configuration: { returnImmediately: true } })],
            ['Get a task (replace <task id>)', rpc('GetTask', { id: '<task id>', historyLength: 2 })],
            ['List tasks', rpc('ListTasks', { pageSize: 5 })],
            ['A change that asks for confirmation', rpc('SendMessage', { message: msg('Delete product 9') })],
            ['The same question over HTTP+JSON', curl('POST', '/a2a/rest/message:send', { json: { message: msg('Show employee 12') }, contentType: 'application/a2a+json', headers: { 'A2A-Version': '1.0' } })],
            ['An A2A 0.3 request', curl('POST', '/a2a/v0.3', { json: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: 'msg-1', role: 'user', parts: [{ kind: 'text', text: 'List departments' }] } } } })],
            ['A forced failure', rpc('SendMessage', { message: msg('Show employee 1') }, { headers: { 'X-Force-A2A-Error': 'fail' } })],
          ],
        };
      })(),
      'protocols.a2a-settings': {
        title: 'A2A settings',
        purpose: 'Turn the A2A agent on or off, stop it from changing data, choose whether it also speaks A2A 0.3, and set how long a task takes and how many are kept.',
        steps: [
          '`a2aAllowWrites` off makes change requests ("set employee 12 title to …", "delete product 9") end REJECTED.',
          '`a2aLegacy` off drops 0.3: requests without `A2A-Version: 1.0` get VersionNotSupportedError (-32009), and the 0.3 interface leaves the Agent Card.',
          '`a2aWorkMs`: time from WORKING to COMPLETED; raise it to test polling, SubscribeToTask and CancelTask. `a2aTaskRetention`: tasks kept in memory (they are lost on restart).',
          ...pw,
        ],
        curls: [
          ['Slow tasks (5 seconds)', admin('PUT', '/settings', { json: { a2aWorkMs: 5000 } })],
          ['A2A 1.0 only', admin('PUT', '/settings', { json: { a2aLegacy: false } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'a2a' } })],
        ],
      },
      'protocols.a2a-try': {
        title: 'Talk to the agent',
        purpose: 'Send a message from this page through any of the agent\'s interfaces, with the active auth mode, and watch the task and its events.',
        steps: [
          'Pick an interface and a sample question (or type your own), then Send. With Stream ticked the events appear as they arrive.',
          'When the agent asks for input ("Delete product 9"), the task id fills in "Continue task": answer "yes" to finish it.',
          'Tick "Return immediately" and raise a2aWorkMs to try Get task and Cancel task while the task is still working.',
        ],
        curls: [
          ['The same question from a terminal', curl('POST', '/a2a', { json: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'msg-1', role: 'ROLE_USER', parts: [{ text: 'Who works in Engineering at level L5?' }] } } }, headers: { 'A2A-Version': '1.0' } })],
        ],
      },

      // ------------------------------------------------------------ protocols: MCP
      'protocols.mcp': (() => {
        const M = 'io.modelcontextprotocol/';
        const meta = { [`${M}protocolVersion`]: '2026-07-28', [`${M}clientCapabilities`]: {}, [`${M}clientInfo`]: { name: 'curl', version: '1' } };
        const accept = { Accept: 'application/json, text/event-stream' };
        const modern = (method, params = {}, extraHeaders = {}) => curl('POST', '/mcp', {
          json: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...meta, ...(params._meta || {}) } } },
          headers: { ...accept, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(params.name || params.uri ? { 'Mcp-Name': params.name || params.uri } : {}), ...extraHeaders },
        });
        const legacy = (method, params, o = {}) => curl('POST', '/mcp', {
          json: { jsonrpc: '2.0', ...(o.notification ? {} : { id: 2 }), method, ...(params ? { params } : {}) },
          headers: { ...accept, 'MCP-Protocol-Version': '2025-11-25' }, extra: ['-H "Mcp-Session-Id: $SID"'],
        });
        return {
          title: 'MCP server',
          purpose: 'A mock MCP server (Streamable HTTP) whose tools, resources and prompts read and change the same employees, products, departments, categories and files as every other protocol. Point an MCP client, an agent platform or an MCP gateway at it. It uses the active auth mode, rate limit, required headers and chaos like /v1.',
          steps: [
            `Give your MCP client the server URL \`${B}/mcp\`. Credentials: ${C.authLabel}. In the jwt and oauth2 modes an MCP client can find the OAuth server itself: a 401 carries \`resource_metadata\` pointing at \`${B}/.well-known/oauth-protected-resource/mcp\`, and dynamic client registration is open by default.`,
            'Protocol 2026-07-28 is stateless: every request carries `io.modelcontextprotocol/protocolVersion` and `clientCapabilities` in `params._meta`, plus the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, which must match the body (400 with -32020 HeaderMismatch otherwise). `server/discover` lists the supported versions.',
            'Older clients (2025-11-25, 2025-06-18, 2025-03-26) send `initialize` first: the response carries an `Mcp-Session-Id` header that every later request repeats; GET opens the session\'s notification stream and DELETE ends it.',
            'Tools: search_employees, get_employee, create/update/delete_employee, the same for products, departments and categories, get_stats, list_files, read_file, echo, long_running_task (progress) and simulate_error. Missing records and bad arguments come back as tool errors (`isError: true`); an unknown tool is a JSON-RPC error.',
            'search_employees marks its `department` argument with `x-mcp-header: Department`, so a 2026-07-28 client must also send `Mcp-Param-Department` (a test for clients and gateways).',
            'Resources: `att://departments/1`, `att://employees/{id}`, `att://files/{id}` and more (resources/list, templates, read); `subscriptions/listen` (or a legacy GET stream) sends `notifications/resources/updated` when a record changes through any protocol. Prompts: summarize_department, draft_welcome_email, compare_products.',
            'Chaos: `X-Force-MCP-Error: tool` (a tool error), `rpc` or `rpc:-32603` (a JSON-RPC error) or `drop` (the connection closes), on top of X-Force-Error and the other chaos settings.',
          ],
          curls: [
            ['Discover the server (2026-07-28)', modern('server/discover')],
            ['List the tools', modern('tools/list')],
            ['Call a tool', modern('tools/call', { name: 'get_employee', arguments: { id: 1 } })],
            ['A tool whose argument is mirrored in a header', modern('tools/call', { name: 'search_employees', arguments: { department: 'Engineering', limit: 3 } }, { 'Mcp-Param-Department': 'Engineering' })],
            ['Progress notifications (streamed response)', modern('tools/call', { name: 'long_running_task', arguments: { seconds: 3, steps: 3 }, _meta: { progressToken: 'p1' } })],
            ['Read a resource', modern('resources/read', { uri: 'att://departments/1' })],
            ['Get a prompt', modern('prompts/get', { name: 'summarize_department', arguments: { departmentId: '1' } })],
            ['A forced tool error', modern('tools/call', { name: 'echo', arguments: { message: 'hi' } }, { 'X-Force-MCP-Error': 'tool' })],
            ['Legacy: initialize (copy the Mcp-Session-Id header into SID)', curl('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } }, headers: accept, include: true })],
            ['Legacy: initialized, then list the tools in the session', `SID='<the Mcp-Session-Id value>'\n${legacy('notifications/initialized', undefined, { notification: true })}\n${legacy('tools/list')}`],
            ['Protected resource metadata (for OAuth clients)', plain('GET', '/.well-known/oauth-protected-resource/mcp')],
          ],
        };
      })(),
      'protocols.mcp-settings': {
        title: 'MCP settings',
        purpose: 'Turn the MCP server on or off, make it read-only, choose JSON or streamed answers, and decide how strict it is about headers and which protocol versions it serves.',
        steps: [
          '`mcpAllowWrites` off hides the create, update and delete tools; open notification streams get `notifications/tools/list_changed`.',
          '`mcpResponseMode`: auto answers in JSON unless a tools/call asks for progress; sse always streams (useful to test a gateway with SSE); json never does.',
          '`mcpValidateHeaders` off accepts 2026-07-28 requests without matching MCP-Protocol-Version, Mcp-Method, Mcp-Name or Mcp-Param-* headers. `mcpLegacy` off serves 2026-07-28 only (initialize is refused with the supported versions).',
          '`mcpSessionTtlMinutes`: idle legacy sessions are dropped after this; `mcpKeepAliveSeconds`: comment lines on open notification streams.',
          ...pw,
        ],
        curls: [
          ['Read-only tools', admin('PUT', '/settings', { json: { mcpAllowWrites: false } })],
          ['Always stream responses', admin('PUT', '/settings', { json: { mcpResponseMode: 'sse' } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'mcp' } })],
        ],
      },
      'protocols.mcp-try': {
        title: 'Try an MCP request',
        purpose: 'Send any MCP request from this page with the active auth mode, as a 2026-07-28 client or as a session-based 2025 client, and see the status, headers, streamed notifications and the result.',
        steps: [
          'Pick a protocol version and a method. A session version sends initialize and notifications/initialized first and keeps the session for later requests.',
          'Run tools/list once to fill the tool names. For tools/call, edit the arguments; tick progress on long_running_task to see a streamed response.',
          'Fill X-Force-MCP-Error with tool, rpc or drop to see how failures look.',
        ],
        curls: [
          ['The same tools/list from a terminal', curl('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' } })],
        ],
      },

      // ------------------------------------------------------------ protocols: LLM
      'protocols.llm': {
        title: 'Mock LLM (OpenAI-compatible)',
        purpose: 'An OpenAI-compatible chat completions API that answers with vague, plausible text and reports token usage the way a real model does, so you can test an LLM connector, a proxy in front of one, or cost tracking without paying for tokens. It uses the active auth mode, rate limit, required headers and chaos like /v1.',
        steps: [
          `Give your OpenAI client or connector the base URL \`${B}/llm/v1\`. It appends \`/chat/completions\`, \`/embeddings\` and \`/models\`. Any model name works unless llmRequireKnownModel is on.`,
          `The API key is the active auth mode's credential: ${C.authLabel}. In bearer mode, use the bearer token as the API key (OpenAI SDKs send it as \`Authorization: Bearer\`).`,
          '`usage.prompt_tokens` is estimated from the request (about 4 characters per token plus per-message overhead); `completion_tokens` is random between llmCompletionTokensMin and llmCompletionTokensMax. `max_tokens` or `max_completion_tokens` cuts the answer with finish_reason "length"; `reasoning_effort` adds reasoning_tokens; the same `seed` gives the same answer and counts.',
          'Send `tools` to get tool calls (finish_reason "tool_calls", arguments generated from each tool\'s JSON Schema): `tool_choice: "required"` or a named tool always calls, "auto" calls llmToolCallRate % of the time, and a reply to a tool result is always text. `response_format` json_object or json_schema returns JSON.',
          '`stream: true` sends chat.completion.chunk events ending with `data: [DONE]`; add `stream_options: {"include_usage": true}` for a final usage chunk. `X-Force-Stream-Drop: N` cuts the stream and `X-Force-Stream-Error: N` sends an error chunk after N chunks.',
          'Errors are OpenAI-shaped: `{"error": {"message", "type", "param", "code"}}` with codes such as invalid_api_key (401), model_not_found (404) and rate_limit_exceeded (429, with Retry-After and x-ratelimit-* headers).',
        ],
        curls: [
          ['A chat completion', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Summarize our Q3 plan.' }] } })],
          ['Repeatable answer, capped at 20 tokens', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-small', seed: 7, max_tokens: 20, messages: [{ role: 'user', content: 'Hello' }] } })],
          ['A tool call', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', tool_choice: 'required', tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }], messages: [{ role: 'user', content: 'Weather in Boston?' }] } })],
          ['JSON output', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Give me a risk summary as JSON.' }] } })],
          ['Streamed, with usage at the end', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Tell me something vague.' }] }, extra: ['-N'] })],
          ['A stream cut after 5 chunks', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', stream: true, messages: [{ role: 'user', content: 'Hi' }] }, headers: { 'X-Force-Stream-Drop': '5' }, extra: ['-N'] })],
          ['Embeddings', curl('POST', '/llm/v1/embeddings', { json: { model: 'mock-embed-small', input: ['first text', 'second text'], dimensions: 8 } })],
          ['List models', curl('GET', '/llm/v1/models')],
          ['A rate-limit error in OpenAI shape', curl('GET', '/llm/v1/models', { headers: { 'X-Force-Error': '429' }, include: true })],
        ],
      },
      'protocols.llm-settings': {
        title: 'LLM settings',
        purpose: 'Turn the mock LLM on or off, choose the model list, the range of completion tokens, the streaming speed and how often tools are called.',
        steps: [
          '`llmModels`: the ids /llm/v1/models returns. With `llmRequireKnownModel` on, other model names get 404 model_not_found.',
          '`llmCompletionTokensMin` / `llmCompletionTokensMax`: the range of completion tokens in a random answer (the text length follows it, about 0.75 words per token).',
          '`llmStreamDelayMs`: the pause between streamed chunks. `llmToolCallRate`: percent of tool_choice "auto" requests answered with a tool call.',
          ...pw,
        ],
        curls: [
          ['Longer answers', admin('PUT', '/settings', { json: { llmCompletionTokensMin: 500, llmCompletionTokensMax: 1500 } })],
          ['Only accept the listed models', admin('PUT', '/settings', { json: { llmRequireKnownModel: true } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'llm' } })],
        ],
      },
      'protocols.llm-try': {
        title: 'Try a chat completion',
        purpose: 'Send a chat completion from this page with the active auth mode and see the answer, the finish reason and the token usage, plain or streamed.',
        steps: [
          'Pick a model, write a message and press Send. Tick Stream to watch chunks arrive; the usage comes in the last chunk.',
          'Tick JSON output for response_format json_object, or Force a get_weather tool call to see generated tool arguments.',
          'Set max_tokens below the usual answer length to get finish_reason "length"; set a seed to get the same answer twice.',
        ],
        curls: [
          ['The same request from a terminal', curl('POST', '/llm/v1/chat/completions', { json: { model: 'mock-chat-large', messages: [{ role: 'user', content: 'What should we prioritize next quarter?' }] } })],
        ],
      },

      // ------------------------------------------------------------ protocols: OData
      'protocols.odata': {
        title: 'OData v4',
        purpose: 'An OData v4 (JSON) service over the same data, for platforms with an OData connector. It uses the active auth mode, rate limit, required headers and chaos like /v1; the service document and $metadata are open.',
        steps: [
          `Point your OData connector at the service root \`${B}/odata/v4\`; the CSDL is at \`${B}/odata/v4/$metadata\`. Entity sets: Employees, Products, Departments, Categories (key \`id\`).`,
          'Query options: $filter (eq ne gt ge lt le, and or not, in, arithmetic, contains/startswith/endswith/tolower/year/…, any/all lambdas, navigation paths like department/name), $select, $expand with nested options, $orderby, $top, $skip, $count, $search.',
          'Long results are paged by the server: follow `@odata.nextLink` until it is absent. Ask for smaller pages with `Prefer: odata.maxpagesize=N`.',
          'Writes: POST to a set (201 + Location; `Prefer: return=minimal` → 204), PATCH merges, PUT replaces, DELETE. Link related records with `"department@odata.bind": "Departments(3)"`. Send the ETag back in If-Match to get 412 on a stale write.',
          `Errors use \`{"error": {"code", "message", "target", "details"}}\` with the real HTTP status. Credentials: ${C.authLabel}.`,
        ],
        curls: [
          ['Filter, select, sort, count', curl('GET', `/odata/v4/Employees?$filter=${encodeURIComponent("level eq 'L3' and salary gt 90000")}&$select=firstName,lastName,salary&$orderby=${encodeURIComponent('salary desc')}&$count=true&$top=5`)],
          ['Expand related records', curl('GET', `/odata/v4/Departments(1)?$expand=${encodeURIComponent('employees($select=firstName,lastName;$top=3)')}`)],
          ['Count only', curl('GET', `/odata/v4/Products/$count?$filter=${encodeURIComponent('inStock eq true')}`)],
          ['Small pages (follow @odata.nextLink)', curl('GET', '/odata/v4/Products?$select=id,name', { headers: { Prefer: 'odata.maxpagesize=5' } })],
          ['Create an employee bound to a department', curl('POST', '/odata/v4/Employees', { json: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada.lovelace@example.com', 'department@odata.bind': 'Departments(1)' }, include: true })],
          ['Update (PATCH, return the entity)', curl('PATCH', '/odata/v4/Employees(1)', { json: { title: 'Principal Engineer' }, headers: { Prefer: 'return=representation' } })],
          ['Download $metadata', plain('GET', '/odata/v4/$metadata', { output: 'metadata.xml' })],
        ],
      },
      'protocols.odata-settings': {
        title: 'OData settings',
        purpose: 'Turn the OData service on or off and set the server-driven page size.',
        steps: [
          '`odataMaxPageSize`: collections longer than this answer with `@odata.nextLink`. Lower it to test that your connector follows next links.',
          'A client can ask for smaller pages with `Prefer: odata.maxpagesize=N`; the response says what was applied in `Preference-Applied`.',
          ...pw,
        ],
        curls: [
          ['Pages of 10', admin('PUT', '/settings', { json: { odataMaxPageSize: 10 } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'odata' } })],
        ],
      },
      'protocols.odata-try': {
        title: 'Try an OData query',
        purpose: 'Send a GET from this page with the active auth mode and see the status, headers and payload.',
        steps: [
          'Pick a sample or type a resource path (Employees, Employees(1), Departments(1)/employees, Products/$count) and query options.',
          'Switch the metadata level to see @odata.type, ids and navigation links (full) or a bare payload (none).',
          'Set Prefer odata.maxpagesize and use Next page to walk @odata.nextLink.',
        ],
        curls: [
          ['The same from a terminal', curl('GET', '/odata/v4/Employees?$top=3&$select=firstName,lastName')],
        ],
      },

      // ------------------------------------------------------------ protocols: S3
      'protocols.s3': {
        title: 'S3-compatible API',
        purpose: 'The file pool as an S3 bucket, for platforms with an S3 connector. It works the same whether files are stored locally or in an S3 bucket behind the tool. Requests are signed with AWS Signature V4 using the keys on this card (AUTH_MODE does not apply); the rate limit, required headers and chaos apply as on every protocol.',
        steps: [
          `In your S3 connector set the endpoint (or "custom endpoint" / "service URL") to \`${C.root}\`, the access key ID to \`${S3.accessKeyId}\`, the secret access key to the one on this card, and the region to \`${S3.region}\`.`,
          `Turn on path-style addressing ("force path style", "use path-style access"): requests go to \`${C.root}/${S3.bucket}/<key>\`. Virtual-hosted style needs a DNS name per bucket, which this host does not have.`,
          `The bucket is \`${S3.bucket}\`. Every file in the pool is an object keyed by its file name; uploads through this API can use folder-style keys such as \`in/2026/orders.csv\`.`,
          'Supported: ListBuckets, HeadBucket, GetBucketLocation, ListObjects (v1 and v2, prefix, delimiter, paging), Get/Head (Range, conditional headers), Put (including aws-chunked streaming and checksums), Copy, Delete, DeleteObjects, multipart uploads (parts of at least 5 MiB except the last) and presigned URLs.',
          'Errors use the S3 XML format (`<Error><Code>NoSuchKey</Code>…`). A wrong secret gives SignatureDoesNotMatch, a wrong key InvalidAccessKeyId, a wrong region AuthorizationHeaderMalformed with the expected region. Uploads, downloads and deletes fire the file webhooks with `via: "s3"`.',
        ],
        curls: [
          ['List the bucket (curl signs the request)', s3('GET', '', { query: 'list-type=2&max-keys=5' })],
          ['List one "folder"', s3('GET', '', { query: 'list-type=2&prefix=in%2F&delimiter=%2F' })],
          ['Upload a file', s3('PUT', 'in/hello.txt', { upload: 'hello.txt', headers: { 'Content-Type': 'text/plain' } })],
          ['Download a file', s3('GET', 'employees.csv', { output: 'employees.csv' })],
          ['Object headers (HEAD)', s3('HEAD', 'employees.csv', { head: true })],
          ['Delete an object', s3('DELETE', 'in/hello.txt')],
          ['AWS CLI: list', aws(`s3 ls s3://${S3.bucket}/`)],
          ['AWS CLI: copy a file in and out', `${aws(`s3 cp hello.txt s3://${S3.bucket}/in/hello.txt`)}\n${aws(`s3 cp s3://${S3.bucket}/in/hello.txt copy.txt`)}`],
          ['AWS CLI: presigned download link (1 hour)', aws(`s3 presign s3://${S3.bucket}/employees.csv --expires-in 3600`)],
        ],
      },
      'protocols.s3-settings': {
        title: 'S3 API settings',
        purpose: 'Turn the S3 API on or off and set the bucket name, region and keys clients sign with.',
        steps: [
          '`s3ApiAccessKeyId` / `s3ApiSecretAccessKey`: the credentials your connector uses. Change them from the demo values before you share the URL.',
          '`s3ApiRegion`: clients must sign with this region (a mismatch is rejected with the expected region in the error).',
          '`s3ApiBucket`: the bucket name. It cannot be a path the tool already uses (v1, admin, soap, …).',
          'These are separate from the S3_* variables, which choose where the tool itself stores files (FILE_STORE=s3).',
          ...pw,
        ],
        curls: [
          ['Rotate the keys', admin('PUT', '/settings', { json: { s3ApiAccessKeyId: 'my-connector', s3ApiSecretAccessKey: 'change-me-to-something-long' } })],
          ['Sign with eu-west-1', admin('PUT', '/settings', { json: { s3ApiRegion: 'eu-west-1' } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 's3api' } })],
        ],
      },
      'protocols.s3-try': {
        title: 'Try the S3 API',
        purpose: 'Send a signed request from this page (the page signs it with AWS Signature V4, like a client would) and see the status, headers and XML.',
        steps: [
          'List objects with an optional prefix and delimiter, or enter a key to HEAD or GET one object.',
          'The request is signed in your browser with the keys on this page; the same signature check runs as for any client.',
        ],
        curls: [
          ['The same from a terminal', s3('GET', '', { query: 'list-type=2&max-keys=10' })],
        ],
      },

      // ------------------------------------------------------------ protocols: GraphQL
      'protocols.graphql': {
        title: 'GraphQL',
        purpose: 'A GraphQL endpoint over the same data: queries with offset pages and Relay connections, CRUD mutations, and a live changes subscription over WebSocket (graphql-transport-ws). It uses the active auth mode, rate limit, required headers and chaos like /v1.',
        steps: [
          `POST \`${B}/graphql\` with \`{"query": "…", "variables": {…}}\` (or GET with ?query= for queries). The schema is at \`${B}/graphql/schema.graphql\`; introspection works unless turned off.`,
          'Lists take `limit`, `offset`, `sort` ("-salary,lastName"), `search` and `filter: [{ field, op, value }]` (the REST filter operators). `…Connection` fields take `first/after/last/before` and return edges, nodes, pageInfo and totalCount.',
          'Field errors (validation, not found, conflicts) come back as HTTP 200 with partial `data` and `errors[].extensions.code` (BAD_USER_INPUT, NOT_FOUND, CONFLICT…); auth, rate-limit and chaos errors keep their HTTP status. Send `Accept: application/graphql-response+json` to get 400 for invalid queries.',
          'Inject a field error with `X-Force-GraphQL-Error: department` (or `Query.employees:503`) to test partial-data handling; X-Force-Error still fails the whole request.',
          `Subscriptions: connect a WebSocket to \`${B.replace(/^http/, 'ws')}/graphql\` with subprotocol graphql-transport-ws, send connection_init, then subscribe to \`changes\`. Credentials: ${C.authLabel}.`,
        ],
        curls: [
          ['A query', curl('POST', '/graphql', { json: { query: '{ employees(limit: 3, sort: "lastName") { total items { id fullName department { name } } } }' } })],
          ['A query with variables (GET)', curl('GET', `/graphql?query=${encodeURIComponent('query($id: Int!) { product(id: $id) { id name price category { name } } }')}&variables=${encodeURIComponent('{"id":1}')}`)],
          ['Relay pagination', curl('POST', '/graphql', { json: { query: '{ productsConnection(first: 2) { totalCount pageInfo { hasNextPage endCursor } nodes { id name } } }' } })],
          ['Create a department', curl('POST', '/graphql', { json: { query: 'mutation($in: DepartmentInput!) { createDepartment(input: $in) { id name code } }', variables: { in: { name: 'Research', code: 'RND-2' } } } })],
          ['Partial data with an injected field error', curl('POST', '/graphql', { json: { query: '{ employees(limit: 2) { items { id department { name } } } }' }, headers: { 'X-Force-GraphQL-Error': 'department' } })],
          ['Download the SDL', plain('GET', '/graphql/schema.graphql', { output: 'schema.graphql' })],
          ['Subscribe to changes for 30 s (Node 22+)', ws('/graphql', [JSON.stringify({ type: 'connection_init' }), JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { changes { type resource id at } }' } })], { listenMs: 30000, protocols: ['graphql-transport-ws'] })],
        ],
      },
      'protocols.graphql-settings': {
        title: 'GraphQL settings',
        purpose: 'Turn the GraphQL mock on or off, allow or block introspection, and limit how deeply operations may nest.',
        steps: [
          '`graphqlIntrospection`: off makes __schema / __type queries fail validation, like many production servers. The SDL file stays available.',
          '`graphqlMaxDepth`: operations nested deeper than this are rejected with QUERY_TOO_DEEP (fragments are expanded; introspection fields do not count). 0 = no limit.',
          'Subscriptions use the WebSocket settings (message size, idle timeout, pings).',
          ...pw,
        ],
        curls: [
          ['Turn introspection off', admin('PUT', '/settings', { json: { graphqlIntrospection: false } })],
          ['Back to the defaults', admin('POST', '/settings/reset', { json: { section: 'graphql' } })],
        ],
      },
      'protocols.graphql-try': {
        title: 'Try a GraphQL request',
        purpose: 'Send a query or mutation from this page with the active auth mode and see the status, the errors and the data.',
        steps: [
          'Pick a sample or write your own query, add variables as JSON, and press Send.',
          'Fill X-Force-GraphQL-Error with a field name to see partial data, or X-Force-Error with a status to fail the whole request.',
          `For an editor with autocompletion, open GraphiQL at \`${B}/graphql\` in a browser tab and add auth headers in its Headers tab.`,
        ],
        curls: [
          ['The same from a terminal', curl('POST', '/graphql', { json: { query: '{ counts { employees products departments categories } }' } })],
        ],
      },

      // ------------------------------------------------------------ openapi
      openapi: {
        title: 'Live OpenAPI (two specs)',
        purpose: 'Two OpenAPI 3.1 documents, regenerated on every request from the current settings. The Mock Data API spec is for integrations; the Admin API spec is for scripting this tool.',
        steps: [
          `Integrations: import \`${B}/openapi.json\` (or .yaml) into your platform, Postman or a code generator. It covers /v1 and the OAuth token endpoint only.`,
          'Re-import after changing auth, date format or headers so the definitions match.',
          `Automation: \`${C.root}/admin/api/openapi.json\` describes settings, seeding, files, OAuth clients, the inspector, the tester and /health. It needs the dashboard password.`,
          'Open Swagger UI and switch between the two specs with the tabs at the top.',
        ],
        curls: [
          ['Mock Data API spec (JSON)', plain('GET', '/openapi.json', { output: 'api-test-tool.openapi.json' })],
          ['Mock Data API spec (YAML)', plain('GET', '/openapi.yaml', { output: 'api-test-tool.openapi.yaml' })],
          ['Admin API spec (JSON)', admin('GET', '/openapi.json', { output: 'api-test-tool-admin.openapi.json' })],
        ],
      },

      // ------------------------------------------------------------ tester (spec list)
      'tester.add': {
        title: 'Add a spec',
        purpose: 'Load the contract your implementation is supposed to follow: OpenAPI 3.0, 3.1 or Swagger 2.0 (converted) for REST, a WSDL 1.1 for SOAP, or AsyncAPI 2.x / 3.0 for WebSocket. The kind is detected from the content. A WebSocket API without a contract can be tested with a hand-written scenario.',
        steps: [
          'Upload a file, load it from a URL, or paste YAML/JSON (OpenAPI) or XML (WSDL).',
          'For a WSDL with imported schemas, load it by URL (e.g. `https://host/Service?wsdl`) so relative imports resolve.',
          'The spec is dereferenced, linted and saved. You land on its Target tab.',
          'Set the base URL and auth for your implementation there, then use Try it or Run all.',
          ...pw,
        ],
        curls: [
          ['Load a spec from a URL', admin('POST', '/tester/specs', { json: { name: 'my-api', url: 'https://example.com/openapi.yaml' } })],
          ['Upload a local file (needs jq)', `jq -Rs '{name: "my-api", content: .}' ./openapi.yaml | ${admin('POST', '/tester/specs', { extra: ["-H 'Content-Type: application/json'", '--data-binary @-'] })}`],
          ['Load a WSDL from a URL', admin('POST', '/tester/specs', { json: { name: 'my-soap-service', url: 'https://example.com/OrderService?wsdl' } })],
          ['Load an AsyncAPI document from a URL', admin('POST', '/tester/specs', { json: { name: 'my-ws-api', url: 'https://example.com/asyncapi.yaml' } })],
          ['A WebSocket scenario without a contract', admin('POST', '/tester/specs', { json: { name: 'my-socket', kind: 'websocket', url: 'wss://example.com/socket' } })],
        ],
      },
      'tester.samples': {
        title: 'Bundled samples',
        purpose: 'Example specs to learn the tester with — including this tool\'s own live OpenAPI spec and SOAP WSDL, which you can test against this server.',
        steps: [
          'Press Load on a sample.',
          'For "This tool (live /openapi.json)", the target is already this server: run all operations against the mock API.',
          'For "This tool (live SOAP WSDL)", the endpoint is this server\'s /soap/EmployeeService: try the WSDL tester end to end.',
          'For "This tool (live AsyncAPI)", the server URL is this server\'s /ws: try the WebSocket tester end to end.',
          'The Supplier Order sample has a deliberate allOf problem: see it on the Spec lint tab.',
          ...pw,
        ],
        curls: [
          ['Load the Supplier Order sample', admin('POST', '/tester/specs', { json: { sample: 'Supplier_Order_Collaboration_OpenAPI_3_1.yaml' } })],
          ['Load this tool\'s own spec', admin('POST', '/tester/specs', { json: { sample: 'self' } })],
          ['Load this tool\'s own SOAP WSDL', admin('POST', '/tester/specs', { json: { sample: 'self-soap' } })],
          ['Load this tool\'s own AsyncAPI (WebSocket)', admin('POST', '/tester/specs', { json: { sample: 'self-ws' } })],
        ],
      },
      'tester.specs': {
        title: 'Specs',
        purpose: 'Every loaded spec with its target and last run result. Click a row to open it.',
        steps: [
          'Open a spec, configure its Target, then test with Try it or Run all.',
          'The "Last run" column shows passed/total for the most recent contract run.',
          ...pw,
        ],
        curls: [
          ['List specs', admin('GET', '/tester/specs')],
        ],
      },

      // ------------------------------------------------------------ tester (one spec)
      'tester.target': {
        title: 'Target',
        purpose: 'Where and how the tester calls your implementation. Spec servers, WSDL addresses and token URLs are often placeholders, so set the real ones here.',
        steps: [
          'OpenAPI: set the base URL of your implementation (or "use this tool" to call the mock API). WSDL: set the endpoint URL every operation is posted to, and the SOAP version (Auto uses SOAP 1.1 when the WSDL has it). WebSocket: set the ws:// or wss:// server URL (channel addresses are appended) and any subprotocols to offer.',
          'Choose an auth profile that matches the spec\'s security schemes: API key, OAuth2 client credentials (with your token URL), Basic or Bearer. "Test token request" shows the full exchange. For SOAP there is also WS-Security UsernameToken (text or digest password), added to every envelope.',
          'Add default headers sent on every call; `{{uuid}}` and `{{now}}` are expanded.',
          'Tick "Lenient allOf" only if the spec combines allOf with additionalProperties: false. Save target.',
          ...pw,
        ],
        curls: [
          ['Set the target with an API key', admin('PUT', `/tester/specs/${specId}`, { json: { target: { baseUrl: 'https://my-api.example.com/v1', auth: { type: 'apikey', name: 'X-API-Key', in: 'header', value: 'MY_KEY' }, headers: {}, timeoutMs: 30000 } } })],
          ['Set the target with OAuth2 client credentials', admin('PUT', `/tester/specs/${specId}`, { json: { target: { baseUrl: 'https://my-api.example.com/v1', auth: { type: 'oauth2cc', tokenUrl: 'https://idp.example.com/oauth2/token', clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET', scopes: 'read write', clientAuth: 'basic' }, headers: {}, timeoutMs: 30000 } } })],
          ['SOAP: endpoint, SOAP 1.2 and WS-Security', admin('PUT', `/tester/specs/${specId}`, { json: { target: { baseUrl: 'https://my-soap.example.com/services/OrderService', soapVersion: '1.2', auth: { type: 'wsse', username: 'USER', password: 'PASSWORD', passwordType: 'digest' } } } })],
          ['WebSocket: server URL, subprotocol and a token in the query string', admin('PUT', `/tester/specs/${specId}`, { json: { target: { baseUrl: 'wss://my-ws.example.com', subprotocols: ['v1.json'], auth: { type: 'apikey', in: 'query', name: 'access_token', value: 'TOKEN' } } } })],
        ],
      },
      'tester.mock': {
        title: 'Mock from spec',
        purpose: 'Serve the spec\'s own example responses from this tool, so you can rehearse a contract run before your implementation exists.',
        steps: [
          'Press "Install mock & use as target". Rules are added under `/mock/<name>` and the target switches to them.',
          'Run all. Failures here mean the spec\'s examples do not match its own schemas.',
          'Remove the mock rules and point the target back at your implementation when it is ready.',
          ...pw,
        ],
        curls: [
          ['Install the mock and use it as target', admin('POST', `/tester/specs/${specId}/mock`, { json: { useAsTarget: true } })],
          ['Remove the mock rules', admin('DELETE', `/tester/specs/${specId}/mock`)],
        ],
      },
      'tester.lint': {
        title: 'Spec lint',
        purpose: 'Problems in the spec that make correct responses fail validation, or make the spec hard to call — fix these before blaming the implementation.',
        steps: [
          'Read each issue: the rule, the JSON pointer into the spec, the explanation and the suggested fix.',
          'Errors usually break validation (e.g. allOf with additionalProperties: false). Warnings flag placeholders such as example.invalid servers.',
          'Fix the spec and Reload it, or use "Lenient allOf" on the Target tab as a stop-gap.',
          ...pw,
        ],
        curls: [
          ['Lint results', admin('GET', `/tester/specs/${specId}/lint`)],
        ],
      },
      'tester.tryit': {
        title: 'Try it',
        purpose: 'Send one operation to your implementation and check the response against the spec: status code, content type, declared headers and body schema.',
        steps: [
          'Pick an operation. Parameters and body are pre-filled from the spec\'s examples, or generated from its schemas (honouring patterns and enums).',
          'Edit values, choose a different named example, or attach a file for multipart and binary bodies.',
          'Press Send. Each check passes or fails with a JSON pointer and a plain-English reason.',
          'Use "Copy as curl" on the Request tab to run the exact same call from a terminal or in your own tests.',
          ...pw,
        ],
        curls: [
          ['Get the pre-filled request for an operation', admin('GET', `/tester/specs/${specId}/request?op=${encodeURIComponent(extra.firstOpId || 'GET /path')}`)],
          ['Send it and validate (needs jq)', `${admin('GET', `/tester/specs/${specId}/request?op=${encodeURIComponent(extra.firstOpId || 'GET /path')}`)} \\\n  | jq '{opId: ${JSON.stringify(extra.firstOpId || 'GET /path')}, request: .}' \\\n  | ${admin('POST', `/tester/specs/${specId}/send`, { extra: ["-H 'Content-Type: application/json'", '--data-binary @-'] })}`],
        ],
      },
      'tester.run': {
        title: 'Run all',
        purpose: 'Run the whole contract in a sensible order, chaining ids from earlier responses into later calls, and optionally add negative tests.',
        steps: [
          'Order: collection POSTs → collection GETs → item operations → DELETEs. Ids are taken from Location headers and response bodies.',
          'Add variables (JSON) to supply ids the run cannot discover, e.g. `{"purchaseOrderId":"PO-4500123456"}`.',
          'Tick "Negative tests" to also check 401 without auth, 400/422 for invalid bodies and 404 for unknown ids. For WSDL contracts: no credentials, a missing required element, an unknown id and malformed XML must each be rejected with the right SOAP fault. For WebSocket: no credentials (upgrade rejected with 401), a malformed message, an oversized message (close 1009) and invalid UTF-8 (close 1007).',
          'WebSocket specs run a scenario (connect, send, expect, listen, ping, close…): the automatic one comes from the AsyncAPI channels; edit and save your own on this tab.',
          'Open the HTML report or export JSON to share the result. Automate it from CI with the commands below.',
          ...pw,
        ],
        curls: [
          ['Run the full contract with negative tests', admin('POST', `/tester/specs/${specId}/runs`, { json: { negative: true } })],
          ['Run with known ids', admin('POST', `/tester/specs/${specId}/runs`, { json: { variables: { purchaseOrderId: 'PO-4500123456' } } })],
          ['Download a run\'s HTML report', admin('GET', '/tester/runs/RUN_ID/report.html', { output: 'contract-report.html' })],
        ],
      },
      'tester.history': {
        title: 'History',
        purpose: 'Every saved contract run for this spec, with its target, result and reports.',
        steps: [
          'Open a run to see each step, or open its HTML report in a new tab.',
          'Export JSON to compare runs or feed results into another system.',
          ...pw,
        ],
        curls: [
          ['List runs for this spec', admin('GET', `/tester/specs/${specId}/runs`)],
          ['Export one run as JSON', admin('GET', '/tester/runs/RUN_ID/export.json', { output: 'run.json' })],
        ],
      },
    };
  }

  /** curl for a request the tester actually sent to a target (method, url, headers, body). */
  function fromSentRequest(r) {
    if (!r) return '';
    const parts = ['curl -s -i'];
    if (r.method && r.method.toUpperCase() !== 'GET') parts.push(`-X ${r.method.toUpperCase()}`);
    parts.push(q(r.url));
    for (const [k, v] of Object.entries(r.headers || {})) {
      if (/^(content-length|host|connection)$/i.test(k)) continue;
      parts.push(`-H ${q(`${k}: ${v}`)}`);
    }
    if (r.body !== undefined && r.body !== null && r.body !== '') {
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      parts.push(`--data-binary ${q(body)}`);
    }
    return parts.join(' \\\n  ');
  }

  window.ATT_GUIDES = { makeCurl, build, fromSentRequest };
})();
