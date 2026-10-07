'use strict';
// Parse, validate and execute one GraphQL request. Shared by HTTP (/graphql) and graphql-transport-ws.
//
//   prepare() -> { document, operation } | { requestErrors }   (nothing executed yet)
//   run()     -> { result, requestError }                      (requestError: no "data" entry)
const {
  parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, getOperationAST, GraphQLError, Kind,
} = require('graphql');
const { codeFor } = require('./errors');

// Errors produced before execution, as plain JSON with an extensions.code.
const coded = (e, code) => ({ ...(typeof e.toJSON === 'function' ? e.toJSON() : { message: String(e.message || e) }), extensions: { code, ...(e.extensions || {}) } });

// Deepest field nesting of an operation (fragments expanded, introspection fields ignored).
function depthOf(selectionSet, fragments, visited = new Set()) {
  let max = 0;
  for (const sel of selectionSet?.selections || []) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value.startsWith('__')) continue;
      max = Math.max(max, 1 + (sel.selectionSet ? depthOf(sel.selectionSet, fragments, visited) : 0));
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, depthOf(sel.selectionSet, fragments, visited));
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value;
      const frag = fragments[name];
      if (!frag || visited.has(name)) continue;
      max = Math.max(max, depthOf(frag.selectionSet, fragments, new Set([...visited, name])));
    }
  }
  return max;
}

function maxDepthRule(limit) {
  return (context) => ({
    OperationDefinition(node) {
      const fragments = Object.fromEntries(context.getDocument().definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
      const depth = depthOf(node.selectionSet, fragments);
      if (depth > limit) {
        context.reportError(new GraphQLError(`Operation ${node.name ? `"${node.name.value}" ` : ''}has depth ${depth}, more than the maximum of ${limit} (GRAPHQL_MAX_DEPTH)`, {
          nodes: node, extensions: { code: 'QUERY_TOO_DEEP', depth, maxDepth: limit },
        }));
      }
    },
  });
}

// X-Force-GraphQL-Error: "department, Query.employees:503" -> Map(field -> { status, code })
function parseForceErrors(header) {
  const out = new Map();
  for (const part of String(header || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, raw] = part.split(':');
    const status = /^\d{3}$/.test(raw || '') ? Number(raw) : 500;
    out.set(name.trim(), { status, code: `injected-${codeFor(status).toLowerCase().replace(/_/g, '-')}` });
  }
  return out;
}

// Request params from a JSON body / query string. Returns { params } or { error } (not well-formed: HTTP 400).
function readParams(src, { fromQueryString = false } = {}) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { error: 'The request must be a JSON object with "query", optional "variables" and "operationName"' };
  const { query, operationName } = src;
  let { variables, extensions } = src;
  if (typeof query !== 'string' || !query.trim()) return { error: 'Missing "query" (a GraphQL document string)' };
  if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') return { error: '"operationName" must be a string' };
  if (fromQueryString) {
    try {
      if (typeof variables === 'string' && variables) variables = JSON.parse(variables);
      if (typeof extensions === 'string' && extensions) extensions = JSON.parse(extensions);
    } catch (e) { return { error: `"variables" / "extensions" must be JSON: ${e.message}` }; }
  }
  if (variables !== undefined && variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) return { error: '"variables" must be an object' };
  return { params: { query, variables: variables || undefined, operationName: operationName || undefined, extensions } };
}

function prepare(schema, settings, { query, operationName }) {
  let document;
  try {
    document = parse(query, { maxTokens: 20000 });
  } catch (e) {
    return { requestErrors: [coded(e, 'GRAPHQL_PARSE_FAILED')] };
  }
  const rules = [...specifiedRules];
  if (!settings.get('graphqlIntrospection')) rules.push(NoSchemaIntrospectionCustomRule);
  const maxDepth = settings.get('graphqlMaxDepth');
  if (maxDepth) rules.push(maxDepthRule(maxDepth));
  const errors = validate(schema, document, rules);
  if (errors.length) return { requestErrors: errors.map((e) => coded(e, e.extensions?.code || 'GRAPHQL_VALIDATION_FAILED')) };
  const operation = getOperationAST(document, operationName);
  if (!operation) {
    const msg = operationName ? `Unknown operation "${operationName}"` : 'The document has several operations: send "operationName" to choose one';
    return { requestErrors: [{ message: msg, extensions: { code: 'OPERATION_RESOLUTION_FAILURE' } }] };
  }
  return { document, operation };
}

// Executes a query or mutation. Variable coercion failures are request errors (no "data").
async function run(schema, settings, params, contextValue) {
  const prep = prepare(schema, settings, params);
  if (prep.requestErrors) return { result: { errors: prep.requestErrors }, requestError: true };
  if (prep.operation.operation === 'subscription') {
    return { result: { errors: [{ message: 'Subscriptions need a WebSocket connection to /graphql (subprotocol graphql-transport-ws)', extensions: { code: 'SUBSCRIPTION_NOT_SUPPORTED_OVER_HTTP' } }] }, requestError: true, operation: prep.operation };
  }
  const result = await execute({ schema, document: prep.document, variableValues: params.variables, operationName: params.operationName, contextValue });
  if (!('data' in result)) return { result: { errors: (result.errors || []).map((e) => coded(e, 'BAD_USER_INPUT')) }, requestError: true, operation: prep.operation };
  return { result, requestError: false, operation: prep.operation };
}

module.exports = { prepare, run, readParams, parseForceErrors, depthOf, coded };
