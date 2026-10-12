'use strict';
// The mock A2A agent's "brain": plain-language questions about the mock company (employees, products,
// departments, categories, statistics) are matched to the same operations the MCP tools use
// (protocols/mcp/catalog.js), so answers come from the shared data and changes show up on every protocol.
// No LLM: matching is rule-based and deterministic, which keeps tests and demos repeatable.
//
// plan() turns a user message into one of:
//   { kind: 'reply', text }                     a direct Message (no task): greetings, help
//   { kind: 'reject', text }                    the task is REJECTED (out of scope, writes switched off)
//   { kind: 'ask', text, pending }              the task waits in INPUT_REQUIRED (missing id, delete confirmation)
//   { kind: 'tool', tool, args, label, write }  the task runs the operation and returns artifacts
const { makeCatalog } = require('../mcp/catalog');

const HELP = [
  'I answer questions about the mock company\'s data. Try:',
  '- "Who works in Engineering at level L5?"',
  '- "Show employee 12" or "product 7"',
  '- "Products under $50 that are in stock" or "cheapest products in Electronics"',
  '- "How many employees do we have?" (headcount, payroll, stock value)',
  '- "List departments" / "list categories"',
  '- Changes: "set employee 12 title to Staff Engineer", "create department Research code RND", "delete product 9"',
  'You can also send a data part {"tool": "search_employees", "arguments": {...}} to call an operation directly.',
].join('\n');

const ROLE_WORDS = ['engineer', 'manager', 'director', 'analyst', 'designer', 'developer', 'architect', 'specialist', 'consultant', 'coordinator', 'administrator', 'officer', 'agent', 'producer', 'strategist', 'planner', 'technician', 'representative', 'supervisor', 'associate', 'assistant', 'executive', 'liaison', 'facilitator', 'orchestrator'];
const UPDATABLE = {
  employee: { title: 'string', level: 'level', email: 'string', salary: 'number', isActive: 'boolean', performanceRating: 'number' },
  product: { name: 'string', price: 'number', stockQty: 'integer', inStock: 'boolean', currency: 'string', rating: 'number' },
};

function coerce(type, raw) {
  const v = String(raw).trim().replace(/^["']|["']$/g, '');
  if (type === 'number') return Number(v.replace(/[$,]/g, ''));
  if (type === 'integer') return parseInt(v.replace(/,/g, ''), 10);
  if (type === 'boolean') return /^(true|yes|on|active|1)$/i.test(v);
  if (type === 'level') return v.toUpperCase();
  return v;
}

const isWriteTool = (name) => /^(create|update|delete)_/.test(name);

function makeAgent(ctx) {
  const catalog = makeCatalog(ctx);
  const allowWrites = () => ctx.settings.get('a2aAllowWrites');

  /** Cheap, synchronous check used for the oauth2 scope before the request is processed. */
  function looksLikeWrite(text, data) {
    if (data && typeof data.tool === 'string') return isWriteTool(data.tool);
    return /\b(delete|remove|set|change|update|create|add)\b/i.test(text || '') && /\b(employee|product|department|category)\b/i.test(text || '');
  }

  async function names(resource) {
    return (await ctx.resources.all(resource)).map((d) => d.name).sort((a, b) => b.length - a.length);
  }

  async function plan(text, data, pending) {
    const t = String(text || '').trim();
    const lower = t.toLowerCase();

    // A follow-up to a task that is waiting for input.
    if (pending) {
      if (pending.type === 'confirm') {
        if (/^(y|yes|confirm|ok|okay|sure|do it|go ahead)\b/i.test(t)) return { kind: 'tool', ...pending.call };
        if (/^(n|no|cancel|stop|abort)\b/i.test(t)) return { kind: 'reject', text: 'OK, nothing was changed.' };
        return { kind: 'ask', text: 'Please answer yes or no.', pending };
      }
      if (pending.type === 'id') {
        const m = /(\d+)/.exec(t);
        if (!m) return { kind: 'ask', text: `I need a numeric ${pending.what} id.`, pending };
        if (pending.then === 'delete') return confirmDelete(pending.what, Number(m[1]));
        return { kind: 'tool', tool: `get_${pending.what}`, args: { id: Number(m[1]) }, label: `Looking up ${pending.what} ${m[1]}` };
      }
    }

    // Direct operation call through a data part.
    if (data && typeof data.tool === 'string') {
      const def = catalog.toolDef(data.tool);
      if (!def) return { kind: 'reject', text: `Unknown operation "${data.tool}". Operations: ${catalog.tools().map((x) => x.name).join(', ')}.` };
      if (isWriteTool(data.tool) && !allowWrites()) return { kind: 'reject', text: 'Changing data is switched off for this agent (A2A_ALLOW_WRITES=false).' };
      return { kind: 'tool', tool: data.tool, args: data.arguments && typeof data.arguments === 'object' ? data.arguments : {}, label: `Running ${data.tool}`, write: isWriteTool(data.tool) };
    }

    if (!t || /^(hi|hello|hey|help|what can you do|\?)\b/i.test(t)) return { kind: 'reply', text: HELP };

    // ---- changes ----
    const write = (call) => (allowWrites() ? { kind: 'tool', write: true, ...call } : { kind: 'reject', text: 'Changing data is switched off for this agent (A2A_ALLOW_WRITES=false).' });
    let m = /\b(?:delete|remove)\s+(employee|product)\b(?:\s*#?\s*(\d+))?/i.exec(t);
    if (m) {
      if (!allowWrites()) return write({});
      const what = m[1].toLowerCase();
      if (!m[2]) return { kind: 'ask', text: `Which ${what} should I delete? Reply with its id.`, pending: { type: 'id', what, then: 'delete' } };
      return confirmDelete(what, Number(m[2]));
    }
    m = /\b(?:set|change|update)\s+(employee|product)\s*#?\s*(\d+)(?:'s)?\s+([a-z]+)\s+(?:to|=)\s+(.+)$/i.exec(t);
    if (m) {
      const what = m[1].toLowerCase();
      const fields = UPDATABLE[what];
      const field = Object.keys(fields).find((f) => f.toLowerCase() === m[3].toLowerCase());
      if (!field) return { kind: 'reject', text: `I can change these ${what} fields: ${Object.keys(fields).join(', ')}.` };
      return write({ tool: `update_${what}`, args: { id: Number(m[2]), changes: { [field]: coerce(fields[field], m[4]) } }, label: `Updating ${what} ${m[2]}` });
    }
    if (/\b(?:set|change|update)\s+(employee|product)\b/i.test(t)) {
      return { kind: 'ask', text: 'Tell me the id, the field and the new value, for example: set employee 12 title to Staff Engineer.', pending: { type: 'reparse' } };
    }
    m = /\b(?:create|add)\s+(?:a\s+)?(department|category)\s+(?:called\s+|named\s+)?["']?([A-Za-z][\w &-]*?)["']?(?:\s+(?:with\s+)?code\s+([A-Za-z0-9-]{2,}))?\s*$/i.exec(t);
    if (m) {
      const kind = m[1].toLowerCase();
      const name = m[2].trim();
      const code = (m[3] || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4)).toUpperCase();
      return write({ tool: `create_${kind === 'category' ? 'category' : 'department'}`, args: { name, code }, label: `Creating ${kind} ${name}` });
    }

    // ---- single records ----
    for (const [word, tool] of [['employee', 'get_employee'], ['product', 'get_product'], ['department', 'get_department'], ['category', 'get_category']]) {
      m = new RegExp(`\\b${word}\\s*(?:id\\s*)?#?\\s*(\\d+)\\b`, 'i').exec(t);
      if (m) return { kind: 'tool', tool, args: { id: Number(m[1]) }, label: `Looking up ${word} ${m[1]}` };
    }

    // ---- statistics and lists ----
    if (/\b(how many|headcount|payroll|stock value|statistics|stats|summary|overview|kpis?|numbers)\b/i.test(t)) return { kind: 'tool', tool: 'get_stats', args: {}, label: 'Adding up the numbers' };
    const limit = Number(/\b(?:top|first|show|list)\s+(\d{1,3})\b/i.exec(t)?.[1]) || undefined;

    // ---- product search ----
    if (/\b(products?|items?|stock|price|priced|cheap|cheapest|expensive|catalog|sku|\$\d)/i.test(t)) {
      const args = {};
      const under = /\b(?:under|below|less than|cheaper than|up to|max)\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(t);
      const over = /\b(?:over|above|more than|at least|min)\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(t);
      if (under) args.maxPrice = Number(under[1]);
      if (over) args.minPrice = Number(over[1]);
      if (/\bout of stock\b/i.test(t)) args.inStock = false;
      else if (/\bin stock\b/i.test(t)) args.inStock = true;
      const cat = (await names('categories')).find((n) => lower.includes(n.toLowerCase()));
      if (cat) args.category = cat;
      const sku = /\bsku\s*([A-Z0-9-]{3,})/i.exec(t);
      if (sku) args.query = sku[1];
      if (/\bcheapest\b/i.test(t)) args.sort = 'price';
      else if (/\b(most expensive|priciest)\b/i.test(t)) args.sort = '-price';
      else if (/\b(best|top|highest)[ -]rated\b/i.test(t)) args.sort = '-rating';
      if (limit) args.limit = Math.min(limit, 100);
      if (!sku && !cat && !under && !over && args.inStock === undefined && /^(list|show)?\s*categor(y|ies)\b/i.test(t)) return { kind: 'tool', tool: 'list_categories', args: {}, label: 'Listing categories' };
      return { kind: 'tool', tool: 'search_products', args, label: 'Searching products' };
    }
    if (/\bcategor(y|ies)\b/i.test(t)) return { kind: 'tool', tool: 'list_categories', args: {}, label: 'Listing categories' };

    // ---- employee search ----
    const dept = (await names('departments')).find((n) => lower.includes(n.toLowerCase()));
    if (/\bdepartments\b/i.test(t) && !dept) return { kind: 'tool', tool: 'list_departments', args: {}, label: 'Listing departments' };
    const level = /\b(?:level\s*)?(l[1-7])\b/i.exec(t);
    const role = ROLE_WORDS.find((w) => new RegExp(`\\b${w}s?\\b`, 'i').test(t));
    if (dept || level || role || /\b(employees?|people|staff|who|team|works?|workers?|person|colleagues?|hired)\b/i.test(t)) {
      const args = {};
      if (dept) args.department = dept;
      if (level) args.level = level[1].toUpperCase();
      if (role) args.query = role;
      if (/\binactive\b/i.test(t)) args.isActive = false;
      else if (/\bactive\b/i.test(t)) args.isActive = true;
      if (/\b(highest|best)[ -]paid\b/i.test(t)) args.sort = '-salary';
      else if (/\b(newest|recently hired|latest hires?)\b/i.test(t)) args.sort = '-hireDate';
      if (limit) args.limit = Math.min(limit, 100);
      return { kind: 'tool', tool: 'search_employees', args, label: 'Searching employees' };
    }

    return { kind: 'reject', text: `That is outside what I can help with. ${HELP}` };

    function confirmDelete(what, id) {
      return { kind: 'ask', text: `Delete ${what} ${id}? This cannot be undone. Reply yes or no.`, pending: { type: 'confirm', call: { tool: `delete_${what}`, args: { id }, label: `Deleting ${what} ${id}`, write: true } } };
    }
  }

  /** Runs the operation; returns { ok, text, data } with a human summary of the structured result. */
  async function run(tool, args, signal) {
    const r = await catalog.callTool(tool, args, { allowWrites: allowWrites(), signal });
    const text = r.content?.map((c) => c.text).filter(Boolean).join('\n') || '';
    if (r.isError) return { ok: false, text: text || 'The operation failed.' };
    return { ok: true, text: summarize(tool, r.structuredContent), data: r.structuredContent };
  }

  return { plan, run, looksLikeWrite, help: HELP, isWriteTool };
}

// Readable answers for each operation's structured result.
function summarize(tool, d) {
  if (!d) return 'Done.';
  const money = (n, c = 'USD') => (typeof n === 'number' ? `${c === 'USD' ? '$' : `${c} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : n);
  switch (tool) {
    case 'search_employees': {
      if (!d.total) return 'No employees match that.';
      const lines = d.items.map((e) => `- ${e.name} (#${e.id}): ${e.title || 'no title'}, ${e.level}, ${e.department || 'no department'}${e.isActive === false ? ', inactive' : ''}`);
      return `Found ${d.total} employee${d.total === 1 ? '' : 's'}${d.total > d.items.length ? ` (showing ${d.items.length})` : ''}:\n${lines.join('\n')}`;
    }
    case 'search_products': {
      if (!d.total) return 'No products match that.';
      const lines = d.items.map((p) => `- ${p.name} (#${p.id}, ${p.sku}): ${money(p.price, p.currency)}, ${p.inStock && p.stockQty ? `${p.stockQty} in stock` : 'out of stock'}, ${p.category || 'no category'}`);
      return `Found ${d.total} product${d.total === 1 ? '' : 's'}${d.total > d.items.length ? ` (showing ${d.items.length})` : ''}:\n${lines.join('\n')}`;
    }
    case 'get_employee':
    case 'update_employee':
    case 'create_employee':
      return `${d.firstName} ${d.lastName} (#${d.id}, ${d.employeeNumber}) is ${/^[aeiou]/i.test(d.title || '') ? 'an' : 'a'} ${d.title || 'team member'} (${d.level}) in ${d.department?.name || 'no department'}. Email ${d.email}; hired ${d.hireDate}; ${d.isActive ? 'active' : 'inactive'}.${tool === 'update_employee' ? ' Updated.' : ''}`;
    case 'get_product':
    case 'update_product':
    case 'create_product':
      return `${d.name} (#${d.id}, SKU ${d.sku}) costs ${money(d.price, d.currency)}, ${d.inStock && d.stockQty ? `${d.stockQty} in stock` : 'out of stock'}, category ${d.category?.name || 'none'}${d.rating != null ? `, rated ${d.rating}` : ''}.${tool === 'update_product' ? ' Updated.' : ''}`;
    case 'get_department':
      return `${d.name} (${d.code}) has ${d.employeeCount} employee${d.employeeCount === 1 ? '' : 's'}${d.employees?.length ? `, including ${d.employees.slice(0, 5).map((e) => e.name).join(', ')}` : ''}.`;
    case 'get_category':
      return `${d.name} (${d.code}) has ${d.productCount} product${d.productCount === 1 ? '' : 's'}${d.products?.length ? `, including ${d.products.slice(0, 5).map((p) => p.name).join(', ')}` : ''}.`;
    case 'list_departments':
      return `${d.departments.length} departments:\n${d.departments.map((x) => `- ${x.name} (${x.code}): ${x.employeeCount} employees`).join('\n')}`;
    case 'list_categories':
      return `${d.categories.length} categories:\n${d.categories.map((x) => `- ${x.name} (${x.code}): ${x.productCount} products`).join('\n')}`;
    case 'get_stats':
      return [`${d.employees} employees (${d.activeEmployees} active), annual payroll ${money(d.annualPayroll)}.`,
        `${d.products} products, ${d.outOfStock} out of stock, stock value ${money(d.stockValue)}.`,
        `Largest departments: ${[...d.headcountByDepartment].sort((a, b) => b.employees - a.employees).slice(0, 3).map((x) => `${x.department} (${x.employees})`).join(', ')}.`].join('\n');
    case 'create_department':
    case 'create_category':
      return `Created ${tool === 'create_department' ? 'department' : 'category'} ${d.name} (${d.code}) with id ${d.id}.`;
    case 'delete_employee':
    case 'delete_product':
      return `Deleted ${tool === 'delete_employee' ? 'employee' : 'product'} ${d.name} (#${d.id}).`;
    default:
      return JSON.stringify(d, null, 2);
  }
}

module.exports = { makeAgent, summarize, HELP };
