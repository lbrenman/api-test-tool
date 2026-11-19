'use strict';
// Tool access control for the mock MCP server (MCP_TOOL_ACL): the decision a gateway in front of an MCP server
// makes about which agent may call which tool, built in as a reference. Off by default, so a gateway under test
// can do the enforcing; on (globally or in a settings profile) it checks the caller's JWT:
//   * every MCP request needs the base scope (MCP_TOOL_ACL_BASE_SCOPE, default mcp:access): 403 insufficient_scope
//     without it, so a suspended agent gets nothing through, not even tools/list;
//   * each tools/call needs tool:<name> (or tool:*): a missing one is a tool error (isError), so the tools stay
//     visible but the call is denied (default deny: no grant, no call).
// Every decision is kept in memory (the last 500) for the dashboard's Tool access tab. setupDemo() creates the
// "tool-acl" profile and three agents (OAuth clients whose scopes are their grants).

const MAX = 500;
const PROFILE = 'tool-acl';
const TOOLS = [
  { name: 'search_employees', why: 'Safe read: names, titles, departments' },
  { name: 'get_employee', why: 'Sensitive read: the full record includes salary' },
  { name: 'search_products', why: 'Safe read: catalog and stock' },
  { name: 'update_product', why: 'Write: changes product data' },
];
const AGENTS = [
  { clientId: 'alice-agent', clientName: 'Alice (admin)', role: 'admin', scopes: ['mcp:access', 'tool:search_employees', 'tool:get_employee', 'tool:search_products', 'tool:update_product'] },
  { clientId: 'bob-agent', clientName: 'Bob (developer)', role: 'developer', scopes: ['mcp:access', 'tool:search_employees', 'tool:search_products'] },
  // Carol keeps an old tool grant, but without mcp:access (suspended) nothing gets through.
  { clientId: 'carol-agent', clientName: 'Carol (suspended)', role: 'suspended', scopes: ['tool:search_employees'] },
];

const toolScope = (name) => `tool:${name}`;
const scopesOf = (claims) => new Set(String(claims?.scope || '').split(/\s+/).filter(Boolean));

class ToolAclService {
  constructor(ctx) {
    this.ctx = ctx;
    this.entries = [];
    this.seq = 0;
  }

  enabled() { return !!this.ctx.settings.get('mcpToolAcl'); }

  baseScope() { return String(this.ctx.settings.get('mcpToolAclBaseScope') || '').trim(); }

  baseScopeFor(profile) { return String(profile?.settings?.mcpToolAclBaseScope ?? this.ctx.settings.get('mcpToolAclBaseScope') ?? '').trim(); }

  /** Any MCP request: null when allowed, else { status, code, detail, scope } (and the decision is recorded). */
  checkRequest(req, method, tool) {
    if (!this.enabled()) return null;
    const claims = req.auth?.claims;
    if (!claims) {
      const detail = `Tool access control needs the caller's JWT, but the auth mode is "${this.ctx.settings.get('authMode')}": use jwt or oauth2`;
      this.record(req, { method, tool, allowed: false, reason: detail });
      return { status: 401, code: 'jwt-required', detail };
    }
    const base = this.baseScope();
    if (base && !scopesOf(claims).has(base)) {
      const detail = `Access denied: ${claims.sub} lacks the scope "${base}" that every MCP request needs`;
      this.record(req, { method, tool, allowed: false, requiredScope: base, reason: detail });
      return { status: 403, code: 'insufficient-scope', detail, scope: base };
    }
    return null;
  }

  /** tools/call: null when allowed (recorded), else a tool error result (recorded). */
  checkTool(req, tool) {
    if (!this.enabled()) return null;
    const claims = req.auth?.claims || {};
    const need = toolScope(tool);
    const scopes = scopesOf(claims);
    if (scopes.has(need) || scopes.has('tool:*')) {
      this.record(req, { method: 'tools/call', tool, allowed: true, requiredScope: need, reason: `Granted by scope "${scopes.has(need) ? need : 'tool:*'}"` });
      return null;
    }
    const text = `Access denied: ${claims.sub || 'the caller'} may not call ${tool}; the token lacks the scope "${need}".`;
    this.record(req, { method: 'tools/call', tool, allowed: false, requiredScope: need, reason: text });
    return { content: [{ type: 'text', text }], isError: true, structuredContent: { error: 'access_denied', tool, requiredScope: need } };
  }

  record(req, d) {
    const c = req.auth?.claims || {};
    const entry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      requestId: req.id,
      profile: req.profile?.name || null,
      method: d.method,
      tool: d.tool || null,
      allowed: d.allowed,
      requiredScope: d.requiredScope || null,
      reason: d.reason,
      sub: c.sub || null,
      clientId: c.client_id || null,
      scopes: [...scopesOf(c)],
    };
    this.entries.push(entry);
    if (this.entries.length > MAX) this.entries.shift();
    return entry;
  }

  /** Decisions after `after` (a seq), newest last. */
  decisions({ after = 0, limit = 200 } = {}) {
    return this.entries.filter((e) => e.seq > after).slice(-limit);
  }

  clear() { this.entries = []; }

  /** The demo: its profile, tools and agents as they are now (agents missing until setupDemo runs). */
  async demo(req) {
    const profile = this.ctx.profiles.get(PROFILE);
    const clients = await this.ctx.oauth.clients();
    const base = `${this.ctx.baseUrl.root(req)}/p/${PROFILE}`;
    const agents = AGENTS.map((a) => {
      const c = clients.find((x) => x.clientId === a.clientId);
      return { clientId: a.clientId, clientName: c?.clientName || a.clientName, role: a.role, exists: !!c, scopes: c?.scopes || [], secret: c?.secret || null, defaultScopes: a.scopes };
    });
    return {
      profile: PROFILE,
      exists: !!profile,
      enabled: !!profile?.settings?.mcpToolAcl,
      settings: profile?.settings || null,
      endpoint: `${base}/mcp`,
      tokenUrl: `${this.ctx.baseUrl.root(req)}/oauth/token`,
      baseScope: this.baseScopeFor(profile),
      tools: TOOLS.map((t) => ({ ...t, scope: toolScope(t.name) })),
      agents,
      // The same rules as data, e.g. to copy into a gateway's policy: who may call each tool.
      policy: TOOLS.map((t) => ({
        tool: t.name,
        requiredScopes: [...(this.baseScopeFor(profile) ? [this.baseScopeFor(profile)] : []), toolScope(t.name)],
        allowed: agents.filter((a) => (!this.baseScopeFor(profile) || a.scopes.includes(this.baseScopeFor(profile))) && (a.scopes.includes(toolScope(t.name)) || a.scopes.includes('tool:*'))).map((a) => a.clientId),
      })),
    };
  }

  /** Creates (or resets) the profile and the three agents. Existing secrets are kept; reset puts the default grants back. */
  async setupDemo(req, { enabled = true, reset = true } = {}) {
    const settings = { authMode: 'jwt', mcpToolAcl: !!enabled, mcpTools: TOOLS.map((t) => t.name).join(','), mcpToolAclBaseScope: 'mcp:access' };
    const existing = this.ctx.profiles.get(PROFILE);
    const description = 'Tool access control demo: JWT auth, 4 MCP tools, per-tool scopes';
    if (existing) await this.ctx.profiles.save(PROFILE, { description, settings: { ...existing.settings, ...settings } });
    else await this.ctx.profiles.save(PROFILE, { description, settings }, { create: true });
    for (const a of AGENTS) {
      const c = await this.ctx.oauth.client(a.clientId);
      if (!c) {
        await this.ctx.oauth.addClient({ clientId: a.clientId, scopes: a.scopes });
        await this.ctx.oauth.updateClient(a.clientId, { clientName: a.clientName, grantTypes: ['client_credentials'] });
      } else if (reset) {
        await this.ctx.oauth.updateClient(a.clientId, { scopes: a.scopes, clientName: a.clientName });
      }
    }
    return this.demo(req);
  }

  /** Turns tool access control on or off in the demo profile (creating the demo first if needed). */
  async setEnabled(req, enabled) {
    const p = this.ctx.profiles.get(PROFILE);
    if (!p) return this.setupDemo(req, { enabled, reset: false });
    await this.ctx.profiles.save(PROFILE, { settings: { ...p.settings, mcpToolAcl: !!enabled } });
    return this.demo(req);
  }
}

module.exports = { ToolAclService, TOOLS, AGENTS, PROFILE, toolScope };
