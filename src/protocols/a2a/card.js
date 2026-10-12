'use strict';
// Agent Cards. /.well-known/agent-card.json (and /a2a/.well-known/agent-card.json) serve the 1.0 card, whose
// supportedInterfaces list the 1.0 JSON-RPC and HTTP+JSON endpoints and the 0.3 JSON-RPC endpoint (/a2a/v0.3).
// /a2a/v0.3/.well-known/agent-card.json serves the same agent as a 0.3 card (url, protocolVersion,
// preferredTransport, OpenAPI-style securitySchemes) for 0.3 clients that resolve the card from a base URL.
// securitySchemes follow the active AUTH_MODE.
const pkg = require('../../../package.json');

const SKILLS = [
  { id: 'employee-directory', name: 'Employee directory', description: 'Find employees by department, level, role or name, and look up one employee\'s full record.', tags: ['employees', 'hr', 'directory'],
    examples: ['Who works in Engineering at level L5?', 'Show employee 12', 'Highest paid managers'] },
  { id: 'product-catalog', name: 'Product catalog', description: 'Search products by category, price range and stock, and look up one product.', tags: ['products', 'catalog', 'inventory'],
    examples: ['Products under $50 that are in stock', 'Cheapest products in Electronics', 'Show product 7'] },
  { id: 'business-stats', name: 'Business statistics', description: 'Headcount, payroll, stock value and the lists of departments and categories.', tags: ['statistics', 'kpi', 'reporting'],
    examples: ['How many employees do we have?', 'List departments', 'What is our stock value?'] },
  { id: 'data-updates', name: 'Data updates', description: 'Change employees and products, create departments and categories, delete records (asks for confirmation). The changes show up on every API of this tool.', tags: ['crud', 'write'],
    examples: ['Set employee 12 title to Staff Engineer', 'Create department Research code RND', 'Delete product 9'] },
];
const EXTENDED_SKILL = { id: 'direct-operations', name: 'Direct operations', description: 'Send a data part {"tool": "<operation>", "arguments": {...}} to run any of the agent\'s 22 operations (the same ones as the MCP server\'s tools) with exact arguments.', tags: ['structured', 'automation'],
  examples: ['{"tool": "search_employees", "arguments": {"department": "Sales", "limit": 5}}'], inputModes: ['application/json'], outputModes: ['application/json', 'text/plain'] };

function schemes(settings, base, v03) {
  const mode = settings.get('authMode');
  const name = mode;
  let s;
  switch (mode) {
    case 'apikey': s = v03 ? { type: 'apiKey', in: settings.get('apiKeyIn'), name: settings.get('apiKeyName') } : { apiKeySecurityScheme: { location: settings.get('apiKeyIn'), name: settings.get('apiKeyName') } }; break;
    case 'basic': s = v03 ? { type: 'http', scheme: 'basic' } : { httpAuthSecurityScheme: { scheme: 'Basic' } }; break;
    case 'bearer': s = v03 ? { type: 'http', scheme: 'bearer' } : { httpAuthSecurityScheme: { scheme: 'Bearer' } }; break;
    case 'jwt': s = v03 ? { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } : { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } }; break;
    case 'oauth2': {
      const scopes = { read: 'Ask questions and read tasks', write: 'Change data' };
      s = v03
        ? { type: 'oauth2', oauth2MetadataUrl: `${base}/.well-known/oauth-authorization-server`, flows: { clientCredentials: { tokenUrl: `${base}/oauth/token`, scopes } } }
        : { oauth2SecurityScheme: { oauth2MetadataUrl: `${base}/.well-known/oauth-authorization-server`, flows: { clientCredentials: { tokenUrl: `${base}/oauth/token`, scopes } } } };
      break;
    }
    case 'hmac': s = v03 ? { type: 'http', scheme: 'HMAC', description: 'Authorization: HMAC <keyId>:<signature> (see the tool\'s README)' } : { httpAuthSecurityScheme: { scheme: 'HMAC', description: 'Authorization: HMAC <keyId>:<signature> (see the tool\'s README)' } }; break;
    default: return {};
  }
  return v03
    ? { securitySchemes: { [name]: s }, security: [{ [name]: mode === 'oauth2' ? ['read'] : [] }] }
    : { securitySchemes: { [name]: s }, securityRequirements: [{ schemes: { [name]: { list: mode === 'oauth2' ? ['read'] : [] } } }] };
}

function common(settings, base, { extended }) {
  return {
    name: 'API Test Tool data assistant',
    description: 'Answers questions about a mock company\'s employees, products, departments and categories, and makes changes to that data. A mock A2A agent for integration testing: the same data is served by this tool\'s REST, SOAP, GraphQL, OData and MCP APIs.',
    provider: { organization: 'API Test Tool', url: base },
    version: pkg.version,
    documentationUrl: 'https://github.com/lbrenman/api-test-tool#a2a-agent',
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: extended ? [...SKILLS, EXTENDED_SKILL] : SKILLS,
  };
}

function card10(ctx, req, { extended = false } = {}) {
  const base = ctx.baseUrl(req);
  const { settings } = ctx;
  return {
    ...common(settings, base, { extended }),
    supportedInterfaces: [
      { url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${base}/a2a/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      ...(settings.get('a2aLegacy') ? [{ url: `${base}/a2a/v0.3`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] : []),
    ],
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: settings.get('authMode') !== 'none' },
    ...schemes(settings, base, false),
  };
}

function card03(ctx, req, { extended = false } = {}) {
  const base = ctx.baseUrl(req);
  const { settings } = ctx;
  return {
    protocolVersion: '0.3.0',
    ...common(settings, base, { extended }),
    url: `${base}/a2a/v0.3`,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    supportsAuthenticatedExtendedCard: settings.get('authMode') !== 'none',
    ...schemes(settings, base, true),
  };
}

module.exports = { card10, card03, SKILLS };
