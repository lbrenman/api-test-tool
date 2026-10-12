'use strict';
// What the mock MCP server offers: tools, resources and prompts over the shared mock data (ctx.resources) and
// the file pool (ctx.files). Transport-free: the router (router.js) speaks JSON-RPC and calls into this.
//
// Tool results follow the MCP tool result shape: content[] (text), structuredContent (JSON, matching
// outputSchema where one is declared) and isError for tool execution errors (not found, validation,
// conflicts, invalid arguments), so a model can read the error and try again. An unknown tool is a
// protocol error (thrown as McpError -32602) instead.
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { HttpError } = require('../../util/problem');
const { applyQuery } = require('../../services/query');
const { INPUT, LEVELS, CURRENCIES } = require('../../services/schemas');

class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Input schema for create tools: the resource's input schema without the read-only placeholders.
function inputSchemaFor(name) {
  const s = JSON.parse(JSON.stringify(INPUT[name]));
  for (const [k, v] of Object.entries(s.properties)) if (v && typeof v === 'object' && !Object.keys(v).length) delete s.properties[k];
  return s;
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DEL = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const idArg = (what) => ({ type: 'object', properties: { id: { type: 'integer', minimum: 1, description: `${what} id` } }, required: ['id'], additionalProperties: false });
const page = { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, offset: { type: 'integer', minimum: 0, default: 0 } };
const listOut = (item) => ({ type: 'object', properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' }, items: { type: 'array', items: item } }, required: ['total', 'limit', 'offset', 'items'] });
const empSummary = { type: 'object', properties: { id: { type: 'integer' }, employeeNumber: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, title: { type: 'string' }, level: { type: 'string' }, department: { type: ['string', 'null'] }, isActive: { type: 'boolean' } }, required: ['id', 'name'] };
const prodSummary = { type: 'object', properties: { id: { type: 'integer' }, sku: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' }, inStock: { type: 'boolean' }, stockQty: { type: 'integer' }, category: { type: ['string', 'null'] } }, required: ['id', 'name'] };
const groupOut = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, code: { type: 'string' } }, required: ['id', 'name', 'code'] };

function toolDefs() {
  return [
    { name: 'search_employees', title: 'Search employees', write: false,
      description: 'Find employees by free text (name, email, title, skills…), department name, level or active flag. Returns a page of summaries; use get_employee for the full record.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', description: 'Free-text search' },
        department: { type: 'string', description: 'Department name (or part of it)', 'x-mcp-header': 'Department' },
        level: { type: 'string', enum: LEVELS }, isActive: { type: 'boolean' },
        sort: { type: 'string', description: 'Comma list of fields, - for descending, e.g. "-salary,lastName"' }, ...page } },
      outputSchema: listOut(empSummary), annotations: RO },
    { name: 'get_employee', title: 'Get an employee', write: false, description: 'The full employee record: contact details, address, skills, certifications, salary, manager and department.', inputSchema: idArg('Employee'), annotations: RO },
    { name: 'create_employee', title: 'Create an employee', write: true, description: 'Add an employee. firstName, lastName, email and departmentId are required.', inputSchema: inputSchemaFor('employees'), annotations: ADD },
    { name: 'update_employee', title: 'Update an employee', write: true, description: 'Change some fields of an employee (JSON merge patch: fields you leave out are kept; null clears a field).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, changes: { type: 'object', description: 'Fields to change, e.g. {"title": "Staff Engineer", "level": "L5"}' } }, required: ['id', 'changes'] }, annotations: EDIT },
    { name: 'delete_employee', title: 'Delete an employee', write: true, description: 'Delete an employee. Their direct reports lose their manager.', inputSchema: idArg('Employee'), annotations: DEL },
    { name: 'search_products', title: 'Search products', write: false,
      description: 'Find products by free text, category name, stock and price range. Returns a page of summaries; use get_product for the full record.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string' }, category: { type: 'string', description: 'Category name (or part of it)' }, inStock: { type: 'boolean' },
        minPrice: { type: 'number', minimum: 0 }, maxPrice: { type: 'number', minimum: 0 }, currency: { type: 'string', enum: CURRENCIES },
        sort: { type: 'string', description: 'e.g. "price" or "-rating"' }, ...page } },
      outputSchema: listOut(prodSummary), annotations: RO },
    { name: 'get_product', title: 'Get a product', write: false, description: 'The full product record: description, price, stock, dimensions, variants, tags and category.', inputSchema: idArg('Product'), annotations: RO },
    { name: 'create_product', title: 'Create a product', write: true, description: 'Add a product. name, sku, price, currency and categoryId are required.', inputSchema: inputSchemaFor('products'), annotations: ADD },
    { name: 'update_product', title: 'Update a product', write: true, description: 'Change some fields of a product (JSON merge patch).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, changes: { type: 'object' } }, required: ['id', 'changes'] }, annotations: EDIT },
    { name: 'delete_product', title: 'Delete a product', write: true, description: 'Delete a product.', inputSchema: idArg('Product'), annotations: DEL },
    { name: 'list_departments', title: 'List departments', write: false, description: 'Every department with its code and headcount.', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object', properties: { departments: { type: 'array', items: { ...groupOut, properties: { ...groupOut.properties, employeeCount: { type: 'integer' } } } } }, required: ['departments'] }, annotations: RO },
    { name: 'get_department', title: 'Get a department', write: false, description: 'A department and (by default) its first employees.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, includeEmployees: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, required: ['id'] }, annotations: RO },
    { name: 'create_department', title: 'Create a department', write: true, description: 'Add a department (name and an upper-case code).', inputSchema: inputSchemaFor('departments'), annotations: ADD },
    { name: 'list_categories', title: 'List categories', write: false, description: 'Every product category with its code and product count.', inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object', properties: { categories: { type: 'array', items: { ...groupOut, properties: { ...groupOut.properties, productCount: { type: 'integer' } } } } }, required: ['categories'] }, annotations: RO },
    { name: 'get_category', title: 'Get a category', write: false, description: 'A category and (by default) its first products.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, includeProducts: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }, required: ['id'] }, annotations: RO },
    { name: 'create_category', title: 'Create a category', write: true, description: 'Add a product category (name and an upper-case code).', inputSchema: inputSchemaFor('categories'), annotations: ADD },
    { name: 'get_stats', title: 'Business statistics', write: false, description: 'Headcount, payroll, headcount by department, product count, stock value and out-of-stock count.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: RO },
    { name: 'list_files', title: 'List files', write: false, description: 'Files in the shared file pool (newest first) with their resource URIs.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { ...page, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }, annotations: RO },
    { name: 'read_file', title: 'Read a file', write: false, description: 'A file from the pool: text files come back as text, others as an embedded base64 resource (up to 2 MB).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'File id from list_files' } }, required: ['id'] }, annotations: RO },
    { name: 'echo', title: 'Echo', write: false, description: 'Returns the message and the arguments it received (connectivity and argument-mapping checks).',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, annotations: RO },
    { name: 'long_running_task', title: 'Long-running task', write: false,
      description: 'Takes `seconds` to finish and reports progress in `steps` notifications (sent when the request has a progressToken and the response is streamed). Closing the stream cancels it.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { seconds: { type: 'integer', minimum: 1, maximum: 60, default: 5 }, steps: { type: 'integer', minimum: 1, maximum: 100, default: 5 } } }, annotations: RO },
    { name: 'simulate_error', title: 'Simulate an error', write: false,
      description: 'Fails on purpose: kind "tool" returns a tool error (isError: true), "protocol" a JSON-RPC error, "slow" waits `seconds` first.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['tool', 'protocol'], default: 'tool' }, seconds: { type: 'integer', minimum: 0, maximum: 60, default: 0 } } }, annotations: RO },
  ];
}

const DEFS = toolDefs();
const VALIDATORS = new Map(DEFS.map((d) => [d.name, ajv.compile(d.inputSchema)]));

const PROMPTS = [
  { name: 'summarize_department', title: 'Summarize a department', description: 'Ask for a short summary of a department and its people, with the department attached as a resource.',
    arguments: [{ name: 'departmentId', description: 'Department id', required: true }] },
  { name: 'draft_welcome_email', title: 'Draft a welcome email', description: 'Ask for a welcome email to an employee, with their record attached.',
    arguments: [{ name: 'employeeId', description: 'Employee id', required: true }, { name: 'tone', description: 'friendly (default), formal or playful', required: false }] },
  { name: 'compare_products', title: 'Compare products', description: 'Ask for a comparison of two or more products, with their records attached.',
    arguments: [{ name: 'productIds', description: 'Comma-separated product ids, e.g. "1,2,3"', required: true }] },
];

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|yaml|x-yaml|javascript)|image\/svg\+xml)/;
const MAX_TEXT = 256 * 1024;
const MAX_BLOB = 2 * 1024 * 1024;
const URI = /^att:\/\/(employees|products|departments|categories|files)\/([^/?#]+)$/;

function makeCatalog(ctx) {
  const res = ctx.resources;
  const fmt = (doc) => (doc ? ctx.dates.formatDoc(doc) : doc);
  const fullName = (e) => `${e.firstName} ${e.lastName}`;
  const empSum = (e) => ({ id: e.id, employeeNumber: e.employeeNumber, name: fullName(e), email: e.email, title: e.title, level: e.level, department: e.department?.name ?? null, isActive: e.isActive });
  const prodSum = (p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.price, currency: p.currency, inStock: p.inStock, stockQty: p.stockQty, category: p.category?.name ?? null });

  const mustGet = async (name, id, label) => {
    const doc = await res.get(name, id);
    if (!doc) throw new HttpError(404, `${label} ${id} not found`, { code: 'not-found' });
    return doc;
  };
  const rendered = async (name, doc) => fmt((await res.render(name, [doc]))[0]);
  const search = async (name, q, args) => {
    const all = await res.render(name, await res.all(name));
    const list = applyQuery(all, q, { parseDate: ctx.dates.parseValue });
    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    return { list, limit, offset };
  };

  const handlers = {
    async search_employees(a) {
      const q = {};
      if (a.query) q.q = a.query;
      if (a.department) q['department.name'] = { like: a.department };
      if (a.level) q.level = a.level;
      if (a.isActive !== undefined) q.isActive = String(a.isActive);
      if (a.sort) q.sort = a.sort;
      const { list, limit, offset } = await search('employees', q, a);
      return { total: list.length, limit, offset, items: list.slice(offset, offset + limit).map(empSum) };
    },
    async get_employee(a) { return rendered('employees', await mustGet('employees', a.id, 'Employee')); },
    async create_employee(a) { return rendered('employees', await res.create('employees', a)); },
    async update_employee(a) { return rendered('employees', await res.patch('employees', await mustGet('employees', a.id, 'Employee'), a.changes)); },
    async delete_employee(a) { const e = await mustGet('employees', a.id, 'Employee'); await res.remove('employees', e); return { deleted: true, id: e.id, name: fullName(e) }; },
    async search_products(a) {
      const q = {};
      if (a.query) q.q = a.query;
      if (a.category) q['category.name'] = { like: a.category };
      if (a.inStock !== undefined) q.inStock = String(a.inStock);
      if (a.currency) q.currency = a.currency;
      const price = {};
      if (a.minPrice !== undefined) price.gte = String(a.minPrice);
      if (a.maxPrice !== undefined) price.lte = String(a.maxPrice);
      if (Object.keys(price).length) q.price = price;
      if (a.sort) q.sort = a.sort;
      const { list, limit, offset } = await search('products', q, a);
      return { total: list.length, limit, offset, items: list.slice(offset, offset + limit).map(prodSum) };
    },
    async get_product(a) { return rendered('products', await mustGet('products', a.id, 'Product')); },
    async create_product(a) { return rendered('products', await res.create('products', a)); },
    async update_product(a) { return rendered('products', await res.patch('products', await mustGet('products', a.id, 'Product'), a.changes)); },
    async delete_product(a) { const p = await mustGet('products', a.id, 'Product'); await res.remove('products', p); return { deleted: true, id: p.id, name: p.name }; },
    async list_departments() {
      const emps = await res.all('employees');
      return { departments: (await res.all('departments')).map((d) => ({ id: d.id, name: d.name, code: d.code, employeeCount: emps.filter((e) => e.departmentId === d.id).length })) };
    },
    async get_department(a) {
      const d = await mustGet('departments', a.id, 'Department');
      const emps = (await res.all('employees')).filter((e) => e.departmentId === d.id);
      const out = { ...fmt(d), employeeCount: emps.length };
      if (a.includeEmployees !== false) out.employees = (await res.render('employees', emps.slice(0, a.limit ?? 25))).map(empSum);
      return out;
    },
    async create_department(a) { return fmt(await res.create('departments', a)); },
    async list_categories() {
      const prods = await res.all('products');
      return { categories: (await res.all('categories')).map((c) => ({ id: c.id, name: c.name, code: c.code, productCount: prods.filter((p) => p.categoryId === c.id).length })) };
    },
    async get_category(a) {
      const c = await mustGet('categories', a.id, 'Category');
      const prods = (await res.all('products')).filter((p) => p.categoryId === c.id);
      const out = { ...fmt(c), productCount: prods.length };
      if (a.includeProducts !== false) out.products = (await res.render('products', prods.slice(0, a.limit ?? 25))).map(prodSum);
      return out;
    },
    async create_category(a) { return fmt(await res.create('categories', a)); },
    async get_stats() {
      const [emps, prods, deps] = [await res.all('employees'), await res.all('products'), await res.all('departments')];
      const active = emps.filter((e) => e.isActive);
      const round = (n) => Math.round(n * 100) / 100;
      return {
        employees: emps.length, activeEmployees: active.length,
        annualPayroll: round(active.reduce((s, e) => s + (Number(e.salary) || 0), 0)),
        headcountByDepartment: deps.map((d) => ({ department: d.name, employees: emps.filter((e) => e.departmentId === d.id).length })),
        products: prods.length, outOfStock: prods.filter((p) => !p.inStock || !p.stockQty).length,
        stockValue: round(prods.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.stockQty) || 0), 0)),
      };
    },
    async list_files(a) {
      const all = await ctx.files.list();
      const limit = a.limit ?? 20;
      const offset = a.offset ?? 0;
      return { total: all.length, limit, offset, items: all.slice(offset, offset + limit).map((f) => ({ id: f.id, name: f.name, contentType: f.contentType, size: f.size, uri: `att://files/${f.id}`, createdAt: f.createdAt })) };
    },
    async read_file(a) {
      const content = await readResource(`att://files/${a.id}`);
      return { _content: content.contents.map((c) => ({ type: 'resource', resource: c })) };
    },
    async echo(a) { return { message: a.message, arguments: a, at: new Date().toISOString() }; },
    async long_running_task(a, x) {
      const seconds = a.seconds ?? 5;
      const steps = a.steps ?? 5;
      for (let i = 1; i <= steps; i += 1) {
        await sleep((seconds * 1000) / steps, x.signal);
        if (x.signal?.aborted) return { cancelled: true, completedSteps: i - 1 };
        x.progress?.(i, steps, `Step ${i} of ${steps}`);
      }
      return { done: true, seconds, steps };
    },
    async simulate_error(a, x) {
      if (a.seconds) await sleep(a.seconds * 1000, x.signal);
      if (a.kind === 'protocol') throw new McpError(-32603, 'Simulated protocol error (simulate_error kind "protocol")');
      throw new HttpError(500, 'Simulated tool failure (simulate_error kind "tool")', { code: 'simulated' });
    },
  };

  function tools({ allowWrites = true } = {}) {
    return DEFS.filter((d) => allowWrites || !d.write).map(({ write, ...d }) => d); // eslint-disable-line no-unused-vars
  }
  const toolDef = (name) => DEFS.find((d) => d.name === name);

  const textOf = (v) => JSON.stringify(v, null, 2);
  const toolError = (message, extra) => ({ content: [{ type: 'text', text: message }], isError: true, ...(extra ? { structuredContent: extra } : {}) });

  /** Runs a tool. Throws McpError for protocol errors; returns a tool result (isError for tool failures). */
  async function callTool(name, args, x = {}) {
    const def = toolDef(name);
    if (!def || (def.write && x.allowWrites === false)) throw new McpError(-32602, `Unknown tool: ${name}`);
    const a = args === undefined || args === null ? {} : args;
    if (typeof a !== 'object' || Array.isArray(a)) return toolError('Invalid arguments: arguments must be an object');
    const validate = VALIDATORS.get(name);
    if (!validate(a)) {
      const errors = validate.errors.map((e) => ({ field: (e.instancePath.replace(/^\//, '').replace(/\//g, '.') || (e.params?.missingProperty ?? e.params?.additionalProperty ?? '(arguments)')), message: e.message }));
      return toolError(`Invalid arguments: ${errors.map((e) => `${e.field} ${e.message}`).join('; ')}`, { errors });
    }
    try {
      const out = await handlers[name](a, x);
      if (out && out._content) return { content: out._content };
      return { content: [{ type: 'text', text: textOf(out) }], structuredContent: out };
    } catch (e) {
      if (e instanceof McpError) throw e;
      if (e instanceof HttpError) {
        const errors = e.errors?.length ? e.errors : undefined;
        const msg = errors ? `${e.detail || e.message}: ${errors.map((x2) => `${x2.field} ${x2.message}`).join('; ')}` : (e.detail || e.message);
        return toolError(msg, { status: e.status, code: e.code, ...(errors ? { errors } : {}) });
      }
      throw e;
    }
  }

  // ---- resources ----------------------------------------------------------------
  const PAGE = 50;
  const cursorOf = (n) => Buffer.from(JSON.stringify({ o: n })).toString('base64url');
  const fromCursor = (c) => {
    if (c === undefined || c === null) return 0;
    try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')).o; if (Number.isInteger(o) && o >= 0) return o; } catch { /* fall through */ }
    throw new McpError(-32602, 'Invalid cursor');
  };

  async function listResources(cursor) {
    const all = [
      { uri: 'att://stats', name: 'stats', title: 'Business statistics', mimeType: 'application/json', description: 'Headcount, payroll, stock value' },
      ...(await res.all('departments')).map((d) => ({ uri: `att://departments/${d.id}`, name: `department-${d.id}`, title: `Department: ${d.name}`, mimeType: 'application/json' })),
      ...(await res.all('categories')).map((c) => ({ uri: `att://categories/${c.id}`, name: `category-${c.id}`, title: `Category: ${c.name}`, mimeType: 'application/json' })),
      ...(await ctx.files.list()).map((f) => ({ uri: `att://files/${f.id}`, name: f.name, title: `File: ${f.name}`, mimeType: f.contentType || 'application/octet-stream', size: f.size })),
    ];
    const start = fromCursor(cursor);
    const out = { resources: all.slice(start, start + PAGE) };
    if (start + PAGE < all.length) out.nextCursor = cursorOf(start + PAGE);
    return out;
  }

  function templates() {
    return { resourceTemplates: [
      { uriTemplate: 'att://employees/{id}', name: 'employee', title: 'Employee record', mimeType: 'application/json' },
      { uriTemplate: 'att://products/{id}', name: 'product', title: 'Product record', mimeType: 'application/json' },
      { uriTemplate: 'att://departments/{id}', name: 'department', title: 'Department with its employees', mimeType: 'application/json' },
      { uriTemplate: 'att://categories/{id}', name: 'category', title: 'Category with its products', mimeType: 'application/json' },
      { uriTemplate: 'att://files/{id}', name: 'file', title: 'File from the pool (text or base64)' },
    ] };
  }

  const notFound = (uri) => new McpError(-32602, `Resource not found: ${uri}`, { uri });

  async function readResource(uri) {
    if (uri === 'att://stats') return { contents: [{ uri, mimeType: 'application/json', text: textOf(await handlers.get_stats()) }] };
    const m = URI.exec(String(uri || ''));
    if (!m) throw notFound(uri);
    const [, kind, id] = m;
    const json = (v) => ({ contents: [{ uri, mimeType: 'application/json', text: textOf(v) }] });
    try {
      if (kind === 'employees') return json(await handlers.get_employee({ id: Number(id) }));
      if (kind === 'products') return json(await handlers.get_product({ id: Number(id) }));
      if (kind === 'departments') return json(await handlers.get_department({ id: Number(id), limit: 100 }));
      if (kind === 'categories') return json(await handlers.get_category({ id: Number(id), limit: 100 }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw notFound(uri);
      throw e;
    }
    const f = await ctx.files.get(decodeURIComponent(id));
    if (!f) throw notFound(uri);
    const mimeType = f.contentType || 'application/octet-stream';
    const isText = TEXT_TYPES.test(mimeType);
    if (f.size > (isText ? MAX_TEXT : MAX_BLOB)) throw new McpError(-32602, `File ${f.name} is too large to read over MCP (${f.size} bytes; limit ${isText ? MAX_TEXT : MAX_BLOB})`, { uri, size: f.size });
    const buf = await ctx.files.readBuffer(f);
    return { contents: [isText ? { uri, mimeType, text: buf.toString('utf8') } : { uri, mimeType, blob: buf.toString('base64') }] };
  }

  // ---- prompts ---------------------------------------------------------------------
  function listPrompts() { return { prompts: PROMPTS }; }

  const embed = async (uri) => ({ type: 'resource', resource: (await readResource(uri)).contents[0] });

  async function getPrompt(name, args = {}) {
    const p = PROMPTS.find((x) => x.name === name);
    if (!p) throw new McpError(-32602, `Unknown prompt: ${name}`);
    const missing = p.arguments.filter((x) => x.required && (args[x.name] === undefined || args[x.name] === '')).map((x) => x.name);
    if (missing.length) throw new McpError(-32602, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    const user = (content) => ({ role: 'user', content });
    try {
      if (name === 'summarize_department') {
        return { description: p.description, messages: [
          user({ type: 'text', text: 'Summarize this department in three sentences: what it does, who leads it, and anything notable about its people.' }),
          user(await embed(`att://departments/${Number(args.departmentId)}`)),
        ] };
      }
      if (name === 'draft_welcome_email') {
        const tone = ['friendly', 'formal', 'playful'].includes(args.tone) ? args.tone : 'friendly';
        return { description: p.description, messages: [
          user({ type: 'text', text: `Write a short, ${tone} welcome email to this new team member. Mention their title and department.` }),
          user(await embed(`att://employees/${Number(args.employeeId)}`)),
        ] };
      }
      const ids = String(args.productIds).split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
      if (ids.length < 2) throw new McpError(-32602, 'productIds needs at least two ids');
      return { description: p.description, messages: [
        user({ type: 'text', text: 'Compare these products for a buyer: price, stock, ratings and the main differences. End with a recommendation.' }),
        ...await Promise.all(ids.map(async (id) => user(await embed(`att://products/${id}`)))),
      ] };
    } catch (e) {
      if (e instanceof McpError && e.message.startsWith('Resource not found')) throw new McpError(-32602, `Invalid argument: ${e.message.replace('Resource not found: ', '')} does not exist`);
      throw e;
    }
  }

  async function complete(ref, argument) {
    const value = String(argument?.value ?? '');
    let pool = [];
    const ids = async (name) => (await res.all(name)).map((d) => String(d.id));
    if (ref?.type === 'ref/prompt') {
      if (argument?.name === 'departmentId') pool = await ids('departments');
      else if (argument?.name === 'employeeId') pool = await ids('employees');
      else if (argument?.name === 'productIds') pool = await ids('products');
      else if (argument?.name === 'tone') pool = ['friendly', 'formal', 'playful'];
    } else if (ref?.type === 'ref/resource') {
      const m = /^att:\/\/(employees|products|departments|categories)\/\{id\}$/.exec(ref.uri || '');
      if (m) pool = await ids(m[1]);
    }
    const hits = pool.filter((v) => v.startsWith(value));
    return { completion: { values: hits.slice(0, 100), total: hits.length, hasMore: hits.length > 100 } };
  }

  return { tools, toolDef, callTool, listResources, templates, readResource, listPrompts, getPrompt, complete };
}

module.exports = { makeCatalog, McpError, toolDefs };
