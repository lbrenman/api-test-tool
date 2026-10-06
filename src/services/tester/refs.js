'use strict';
// JSON Pointer / $ref helpers for working on a bundled (not dereferenced) OpenAPI document.

function unescape(s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); }
function escape(s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }

function get(doc, pointer) {
  if (!pointer || pointer === '#' || pointer === '') return doc;
  const p = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  let cur = doc;
  for (const raw of p.split('/').slice(1)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[unescape(decodeURIComponent(raw))];
  }
  return cur;
}

// Follow $ref chains (local refs only). Returns { node, pointer }.
function resolve(doc, node, pointer = null, depth = 0) {
  let cur = node;
  let ptr = pointer;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && depth < 50) {
    if (!cur.$ref.startsWith('#')) return { node: cur, pointer: ptr, external: true };
    ptr = cur.$ref;
    cur = get(doc, cur.$ref);
    depth++;
  }
  return { node: cur, pointer: ptr };
}

function deref(doc, node) { return resolve(doc, node).node; }

// Walk a path of keys from a pointer, following $refs at every step; returns the final pointer.
function locate(doc, startPointer, keys) {
  let { node, pointer } = resolve(doc, get(doc, startPointer), startPointer);
  for (const k of keys) {
    if (!node || typeof node !== 'object') return null;
    pointer = `${pointer}/${escape(k)}`;
    ({ node, pointer } = resolve(doc, node[k], pointer));
  }
  return node === undefined ? null : pointer;
}

module.exports = { get, resolve, deref, locate, escape, unescape };
