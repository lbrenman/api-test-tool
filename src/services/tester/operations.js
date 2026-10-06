'use strict';
// Flatten an OpenAPI document into a list of operations with resolved parameters and request bodies.
const { deref, escape } = require('./refs');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function listOperations(doc) {
  const ops = [];
  for (const [path, itemRef] of Object.entries(doc.paths || {})) {
    const item = deref(doc, itemRef) || {};
    const pathParams = (item.parameters || []).map((p) => deref(doc, p)).filter(Boolean);
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const own = (op.parameters || []).map((p) => deref(doc, p)).filter(Boolean);
      const merged = [...pathParams.filter((pp) => !own.some((o) => o.name === pp.name && o.in === pp.in)), ...own];
      ops.push({
        id: `${method.toUpperCase()} ${path}`,
        method,
        path,
        operationId: op.operationId || null,
        summary: op.summary || '',
        description: op.description || '',
        tags: op.tags || [],
        deprecated: !!op.deprecated,
        parameters: merged,
        requestBody: op.requestBody ? deref(doc, op.requestBody) : null,
        responses: op.responses || {},
        security: op.security !== undefined ? op.security : doc.security || [],
        pointer: `#/paths/${escape(path)}/${method}`,
        raw: op,
      });
    }
  }
  return ops;
}

module.exports = { listOperations, METHODS };
