'use strict';
// "Spec lint": practical problems that break testing or code generation, not style nits.
const { deref, get, escape } = require('./refs');
const { SpecValidator } = require('./validate');
const { listOperations } = require('./operations');

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$|\.invalid$/i;

function hostOf(url) {
  try { return new URL(url, 'http://relative.invalid').hostname; } catch { return ''; }
}

function walk(node, pointer, fn, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  fn(node, pointer);
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${pointer}/${i}`, fn, seen));
  else for (const [k, v] of Object.entries(node)) walk(v, `${pointer}/${escape(k)}`, fn, seen);
}

function lintSpec(spec) {
  const { doc, version } = spec;
  const issues = [];
  const add = (severity, rule, pointer, message, fix) => issues.push({ severity, rule, pointer, message, fix });

  for (const s of spec.structural || []) add('warning', 'structural', '#', `OpenAPI structural validation: ${s}`);

  // 1. allOf + additionalProperties:false trap
  walk(doc, '#', (node, pointer) => {
    if (!Array.isArray(node.allOf) || node.allOf.length < 2) return;
    const members = node.allOf.map((m, i) => ({ i, ref: m.$ref, schema: deref(doc, m) || {} }));
    const adding = members.filter((m) => m.schema.properties && Object.keys(m.schema.properties).length);
    for (const m of members) {
      if (m.schema.additionalProperties === false && adding.some((o) => o.i !== m.i)) {
        const others = adding.filter((o) => o.i !== m.i).flatMap((o) => Object.keys(o.schema.properties)).slice(0, 6);
        const name = m.ref ? m.ref.split('/').pop() : `allOf[${m.i}]`;
        const owner = pointer.split('/').pop();
        add('error', 'allof-additional-properties', `${pointer}/allOf/${m.i}`,
          `${owner} composes ${name} with allOf, but ${name} has additionalProperties: false. Every valid ${owner} instance fails validation because properties from the other members (${others.join(', ')}${others.length === 6 ? ', …' : ''}) are "additional" to ${name}.`,
          version === '3.1'
            ? `Remove additionalProperties: false from ${name} and put unevaluatedProperties: false on ${owner} (JSON Schema 2020-12 sees through allOf). Use the "lenient allOf" toggle to validate as intended meanwhile.`
            : `OAS 3.0 has no unevaluatedProperties: remove additionalProperties: false from ${name}, or define ${owner} without allOf. Use the "lenient allOf" toggle to validate as intended meanwhile.`);
      }
    }
  });

  // 2. Placeholder servers
  const servers = doc.servers || [];
  if (!servers.length) add('warning', 'no-servers', '#/servers', 'No servers are declared; set a base URL override for the target.');
  servers.forEach((s, i) => {
    const h = hostOf(s.url);
    if (!/^https?:\/\//i.test(s.url || '')) add('info', 'relative-server', `#/servers/${i}`, `Server "${s.url}" is relative; a base URL override is required.`);
    else if (PLACEHOLDER_HOST.test(h)) add('warning', 'placeholder-server', `#/servers/${i}`, `Server ${s.url} uses a placeholder host (${h}); set a base URL override for the target.`);
  });

  // 3. Security schemes
  const schemes = doc.components?.securitySchemes || {};
  for (const [name, sRef] of Object.entries(schemes)) {
    const s = deref(doc, sRef) || {};
    if (s.type === 'oauth2') {
      for (const [flowName, flow] of Object.entries(s.flows || {})) {
        for (const k of ['tokenUrl', 'authorizationUrl', 'refreshUrl']) {
          if (flow[k] && PLACEHOLDER_HOST.test(hostOf(flow[k]))) {
            add('warning', 'placeholder-token-url', `#/components/securitySchemes/${escape(name)}/flows/${flowName}/${k}`, `${name} ${flowName}.${k} (${flow[k]}) is a placeholder; override the token URL in the target auth profile.`);
          }
        }
      }
    }
  }
  const checkSecurity = (reqs, pointer) => {
    for (const req of reqs || []) for (const n of Object.keys(req)) {
      if (!schemes[n]) add('error', 'undefined-security-scheme', pointer, `Security requirement references "${n}", which is not defined in components.securitySchemes.`);
    }
  };
  checkSecurity(doc.security, '#/security');

  // 4. Operations
  const ops = listOperations(doc);
  const ids = new Map();
  for (const op of ops) {
    const p = op.pointer;
    if (!op.operationId) add('warning', 'missing-operation-id', p, `${op.method.toUpperCase()} ${op.path} has no operationId.`);
    else if (ids.has(op.operationId)) add('error', 'duplicate-operation-id', p, `operationId "${op.operationId}" is also used by ${ids.get(op.operationId)}.`);
    else ids.set(op.operationId, `${op.method.toUpperCase()} ${op.path}`);
    checkSecurity(op.raw.security, `${p}/security`);

    const templ = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const t of templ) {
      if (!op.parameters.some((x) => x.in === 'path' && x.name === t)) add('error', 'undeclared-path-param', p, `Path parameter {${t}} is not declared for ${op.method.toUpperCase()} ${op.path}.`);
    }
    for (const prm of op.parameters.filter((x) => x.in === 'path')) {
      if (!templ.includes(prm.name)) add('error', 'unused-path-param', p, `Path parameter "${prm.name}" does not appear in ${op.path}.`);
      if (prm.required !== true) add('error', 'path-param-not-required', p, `Path parameter "${prm.name}" must have required: true.`);
    }
    const codes = Object.keys(op.responses || {});
    if (!codes.length) add('error', 'no-responses', p, `${op.method.toUpperCase()} ${op.path} documents no responses.`);
    if (codes.length && !codes.some((c) => /^[45]/.test(c) || c === 'default')) add('info', 'no-error-responses', p, `${op.method.toUpperCase()} ${op.path} documents no 4xx/5xx responses.`);
    const r201 = deref(doc, op.responses?.['201']);
    if (r201 && !Object.keys(r201.headers || {}).some((h) => h.toLowerCase() === 'location')) add('info', 'created-without-location', `${p}/responses/201`, `${op.method.toUpperCase()} ${op.path} returns 201 without a documented Location header.`);
    if (op.method === 'get' && op.requestBody) add('warning', 'get-with-body', p, `GET ${op.path} declares a request body.`);
    const idem = op.parameters.find((x) => x.in === 'header' && /^idempotency-key$/i.test(x.name));
    if (idem?.required) add('info', 'idempotency-key-required', p, `${op.method.toUpperCase()} ${op.path} requires Idempotency-Key; the tester fills a fresh UUID per request.`);
  }

  // 5. Examples that don't validate against their own schemas (strict validation).
  let validator;
  try { validator = new SpecValidator(doc, { version }); } catch { validator = null; }
  if (validator) {
    const check = (schemaPointer, value, where, label) => {
      const errs = validator.validate(schemaPointer, value);
      if (errs.length) {
        add('warning', 'invalid-example', where, `${label} does not validate against its schema: ${errs.slice(0, 3).map((e) => e.message).join('; ')}${errs.length > 3 ? ` (+${errs.length - 3} more)` : ''}`, errs.some((e) => e.hint) ? 'Likely caused by the allOf + additionalProperties:false issue above.' : undefined);
      }
    };
    for (const op of ops) {
      const sections = [];
      if (op.requestBody) sections.push({ base: `${op.pointer}/requestBody`, label: 'request' });
      for (const code of Object.keys(op.responses || {})) sections.push({ base: `${op.pointer}/responses/${code}`, label: `response ${code}` });
      for (const s of sections) {
        let container = get(doc, s.base);
        let base = s.base;
        while (container && container.$ref) { base = container.$ref; container = get(doc, base); }
        for (const [media, mo] of Object.entries(container?.content || {})) {
          if (!/json/.test(media) || !mo.schema) continue;
          const schemaPtr = `${base}/content/${escape(media)}/schema`;
          for (const [name, exRef] of Object.entries(mo.examples || {})) {
            const ex = deref(doc, exRef);
            if (ex && ex.value !== undefined) check(schemaPtr, ex.value, `${base}/content/${escape(media)}/examples/${escape(name)}`, `${op.method.toUpperCase()} ${op.path} ${s.label} example "${name}"`);
          }
          if (mo.example !== undefined) check(schemaPtr, mo.example, `${base}/content/${escape(media)}/example`, `${op.method.toUpperCase()} ${op.path} ${s.label} example`);
        }
      }
    }
  }

  // Deduplicate (shared response components produce repeats).
  const seen = new Set();
  const out = issues.filter((i) => { const k = `${i.rule}|${i.pointer}|${i.message}`; return seen.has(k) ? false : seen.add(k); });
  const order = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    issues: out,
    counts: { error: out.filter((i) => i.severity === 'error').length, warning: out.filter((i) => i.severity === 'warning').length, info: out.filter((i) => i.severity === 'info').length },
  };
}

module.exports = { lintSpec };
