'use strict';
// Load an OpenAPI 3.0 / 3.1 or Swagger 2.0 document from text or URL, convert 2.0 -> 3.0, bundle external refs.
const yaml = require('js-yaml');

class SpecError extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function parseText(text) {
  if (!text || !String(text).trim()) throw new SpecError('Spec is empty');
  try {
    return yaml.load(String(text), { json: true });
  } catch (e) {
    throw new SpecError(`Could not parse spec as YAML/JSON: ${e.message.split('\n')[0]}`);
  }
}

async function fetchText(url) {
  let u;
  try { u = new URL(url); } catch { throw new SpecError('Invalid spec URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new SpecError('Spec URL must be http(s)');
  const res = await fetch(u, { headers: { Accept: 'application/yaml, application/json;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new SpecError(`Fetching spec failed: HTTP ${res.status}`);
  return res.text();
}

async function convertSwagger2(doc) {
  const converter = require('swagger2openapi');
  const out = await converter.convertObj(doc, { patch: true, warnOnly: true, resolveInternal: false });
  return out.openapi;
}

async function loadSpec({ content, url }) {
  const notes = [];
  let text = content;
  if (!text && url) text = await fetchText(url);
  let doc = parseText(text);
  if (!doc || typeof doc !== 'object') throw new SpecError('Spec must be a YAML or JSON object');
  let converted = false;
  if (doc.swagger) {
    if (String(doc.swagger) !== '2.0') throw new SpecError(`Unsupported Swagger version ${doc.swagger}`);
    doc = await convertSwagger2(doc);
    converted = true;
    notes.push('Converted from Swagger 2.0 to OpenAPI 3.0 with swagger2openapi.');
  }
  const version = String(doc.openapi || '');
  if (!/^3\.[01]\./.test(version)) throw new SpecError(`Not an OpenAPI 3.0/3.1 or Swagger 2.0 document (openapi: "${version || 'missing'}")`);
  if (!doc.paths || typeof doc.paths !== 'object') throw new SpecError('Spec has no paths');

  // Bundle external $refs (relative refs resolve against the URL when loaded from one).
  const hasExternal = JSON.stringify(doc).match(/"\$ref":"(?!#)/);
  if (hasExternal) {
    try {
      const SwaggerParser = require('@apidevtools/swagger-parser');
      doc = url && !converted ? await SwaggerParser.bundle(url) : await SwaggerParser.bundle(JSON.parse(JSON.stringify(doc)));
      notes.push('External $refs were bundled into the document.');
    } catch (e) {
      notes.push(`Could not bundle external $refs: ${e.message}`);
    }
  }

  // Structural validation (non-fatal; surfaced in Spec lint).
  let structural = [];
  try {
    const SwaggerParser = require('@apidevtools/swagger-parser');
    await SwaggerParser.validate(JSON.parse(JSON.stringify(doc)), { resolve: { external: false }, validate: { spec: true, schema: true } });
  } catch (e) {
    const details = Array.isArray(e.details) ? e.details.slice(0, 20).map((d) => `${(d.path || []).join('.')}: ${d.message}`) : [];
    structural = details.length ? details : [String(e.message).split('\n').slice(0, 5).join(' ')];
  }

  return {
    doc,
    version: version.startsWith('3.1') ? '3.1' : '3.0',
    originalVersion: converted ? '2.0' : version,
    converted,
    notes,
    structural,
    title: doc.info?.title || 'Untitled API',
    apiVersion: doc.info?.version || '',
  };
}

module.exports = { loadSpec, parseText, SpecError };
