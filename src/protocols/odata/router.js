'use strict';
// /odata/v4 — OData v4 (JSON format) over the shared mock data.
//
//   GET    /odata/v4                          service document (open)
//   GET    /odata/v4/$metadata                CSDL XML (open, like the WSDLs and /openapi.json)
//   GET    /odata/v4/Employees                collection: $filter $select $expand $orderby $top $skip $count $search,
//                                             server-driven paging (@odata.nextLink, Prefer: odata.maxpagesize)
//   GET    /odata/v4/Employees/$count         plain-text count (honours $filter / $search)
//   GET    /odata/v4/Employees(1)             entity ($select / $expand), ETag
//   GET    /odata/v4/Employees(1)/firstName   property (/$value for the raw value)
//   GET    /odata/v4/Employees(1)/department  navigation (collections take query options and /$count)
//   POST   /odata/v4/Employees                create (201 + Location; Prefer: return=minimal -> 204); @odata.bind
//   PATCH  /odata/v4/Employees(1)             update (merge; 204, or 200 with Prefer: return=representation)
//   PUT    /odata/v4/Employees(1)             replace
//   DELETE /odata/v4/Employees(1)             delete (204)
// Writes honour If-Match. Everything except the service document and $metadata goes through the shared
// protocol stack (required headers, rate limit, AUTH_MODE, chaos); errors use the OData error format.
const express = require('express');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify, JSON_TYPES } = require('../../middleware/body');
const { etagOf } = require('../../services/resources');
const { SETS, ENTITIES, member, shape, generateCsdl } = require('./model');
const { parseOptions, query, serialize, projection, keyPath } = require('./query');
require('./errors');

const METADATA_LEVELS = ['none', 'minimal', 'full'];

// ---- request helpers --------------------------------------------------------------------------

// Query options from the raw query string (URLSearchParams semantics, no nested-object parsing).
function rawOptions(req) {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
  const out = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    if (k.startsWith('$') && Object.hasOwn(out, k)) throw new HttpError(400, `The query option ${k} is given more than once`, { code: 'invalid-query-option' });
    if (!Object.hasOwn(out, k)) out[k] = v;
  }
  return out;
}

// odata.metadata level from $format or Accept; 406 when only non-JSON formats are acceptable.
function metadataLevel(req, raw) {
  const pick = (params) => {
    const m = /odata\.metadata=(\w+)/i.exec(params || '');
    if (!m) return 'minimal';
    if (!METADATA_LEVELS.includes(m[1].toLowerCase())) throw new HttpError(400, `odata.metadata must be one of ${METADATA_LEVELS.join(', ')}`, { code: 'invalid-format' });
    return m[1].toLowerCase();
  };
  if (raw.$format !== undefined) {
    const f = String(raw.$format);
    if (/^json$/i.test(f) || /^application\/json\b/i.test(f)) return pick(f);
    throw new HttpError(406, `$format=${f} is not supported; use json`, { code: 'not-acceptable' });
  }
  const accept = req.get('accept');
  if (!accept) return 'minimal';
  const ranges = accept.split(',').map((s) => s.trim());
  const json = ranges.find((r) => /^(application\/json|application\/\*|\*\/\*)/i.test(r));
  if (!json) throw new HttpError(406, `Only JSON is supported (Accept: ${accept})`, { code: 'not-acceptable' });
  return pick(json);
}

function contentType(level) {
  return `application/json;odata.metadata=${level};odata.streaming=true;IEEE754Compatible=false;charset=utf-8`;
}

function prefer(req) {
  const out = {};
  for (const part of String(req.get('prefer') || '').split(',')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k) out[k.toLowerCase()] = v === undefined ? true : v.replace(/^"|"$/g, '');
  }
  return out;
}

const plainEtag = (e) => String(e).trim().replace(/^W\//, '');
function checkIfMatch(req, typeName, doc) {
  const h = req.get('if-match');
  if (!h) return;
  if (h.trim() === '*') return;
  const current = etagOf(shape(typeName, doc));
  if (!h.split(',').map(plainEtag).includes(current)) {
    throw new HttpError(412, 'If-Match does not match the current ETag', { code: 'precondition-failed', errors: [{ field: 'header:If-Match', message: `current ETag is W/${current}` }] });
  }
}

// All four sets plus navigation lookups (lists are the service's cached arrays: read-only).
async function loadData(resources) {
  const lists = {};
  const byId = {};
  for (const [set, e] of Object.entries(SETS)) {
    lists[set] = await resources.all(e.resource);
    byId[set] = new Map(lists[set].map((d) => [d.id, d]));
  }
  const indexes = new Map();
  return {
    lists,
    byId,
    parent: (nav, doc) => byId[nav.target].get(doc[nav.fk]) || null,
    children: (nav, doc) => {
      const key = `${nav.target}.${nav.reverse}`;
      if (!indexes.has(key)) {
        const idx = new Map();
        for (const d of lists[nav.target]) {
          const p = d[nav.reverse];
          if (p == null) continue;
          if (!idx.has(p)) idx.set(p, []);
          idx.get(p).push(d);
        }
        indexes.set(key, idx);
      }
      return indexes.get(key).get(doc.id) || [];
    },
  };
}

// Request body -> ResourceService input. Annotations are dropped; nav@odata.bind sets the foreign key.
function toInput(typeName, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object', { code: 'invalid-body' });
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const bind = /^(\w+)@odata\.bind$/.exec(k);
    if (bind) {
      const nav = member(typeName, bind[1])?.nav;
      if (!nav) throw new HttpError(400, `Could not find a navigation property named '${bind[1]}' on type '${typeName}'`, { code: 'invalid-body' });
      if (nav.many) throw new HttpError(501, `Binding the collection ${bind[1]} is not supported; set ${SETS[nav.target].type}.${nav.reverse} instead`, { code: 'not-implemented' });
      const m = new RegExp(`(?:^|/)${nav.target}\\((?:id=)?(\\d+)\\)$`).exec(String(v ?? ''));
      if (!m) throw new HttpError(400, `${k} must be an entity reference like "${nav.target}(1)"`, { code: 'invalid-body', errors: [{ field: k, message: 'not an entity reference' }] });
      out[nav.fk] = Number(m[1]);
      continue;
    }
    if (k.startsWith('@') || k.includes('@')) continue; // instance annotations (@odata.type, …)
    const m = member(typeName, k);
    if (!m) throw new HttpError(400, `The property '${k}' does not exist on type 'ApiTestTool.${typeName}'`, { code: 'invalid-body', errors: [{ field: k, message: 'unknown property' }] });
    if (m.kind === 'nav') throw new HttpError(501, `Deep insert/update of ${k} is not supported; use ${k}@odata.bind`, { code: 'not-implemented' });
    out[k] = v;
  }
  return out;
}

// ---- router ------------------------------------------------------------------------------------

module.exports = function odataRouter(ctx) {
  const { settings, baseUrl, resources } = ctx;
  const r = express.Router();
  const csdl = generateCsdl();

  r.use((req, res, next) => {
    req.errorFormat = 'odata';
    res.setHeader('OData-Version', '4.0');
    if (!settings.get('odataEnabled')) return sendProblem(req, res, 404, { detail: 'The OData mock is disabled (ODATA_ENABLED=false)', code: 'odata-disabled' });
    next();
  });

  r.get('/', (req, res) => {
    const b = baseUrl(req);
    res.json({ versions: { v4: { serviceRoot: `${b}/odata/v4`, metadata: `${b}/odata/v4/$metadata` } }, entitySets: Object.keys(SETS), maxPageSize: settings.get('odataMaxPageSize') });
  });

  const stack = protocolStack(ctx, { format: 'odata', body: express.json({ limit: '2mb', type: JSON_TYPES, verify }) });

  r.use('/v4', (req, res, next) => {
    const p = req.path;
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const root = `${baseUrl(req)}/odata/v4`;
    if (p === '/' || p === '') {
      const level = metadataLevel(req, rawOptions(req));
      const doc = { ...(level !== 'none' ? { '@odata.context': `${root}/$metadata` } : {}), value: Object.entries(SETS).map(([name]) => ({ name, kind: 'EntitySet', url: name })) };
      return res.status(200).set('Content-Type', contentType(level)).send(Buffer.from(JSON.stringify(doc))); // Buffer: Express leaves the OData media type as written
    }
    if (p === '/$metadata') return res.status(200).set('Content-Type', 'application/xml; charset=utf-8').send(csdl);
    next();
  }, ...stack, async (req, res) => {
    const root = `${baseUrl(req)}/odata/v4`;
    const segs = req.path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    if (segs[0] === '$batch') throw new HttpError(501, '$batch is not supported yet; send the requests one by one', { code: 'not-implemented' });
    const m = /^([A-Za-z]\w*)(?:\((.*)\))?$/.exec(segs[0] || '');
    const set = m && SETS[m[1]];
    if (!set) throw new HttpError(404, `Resource not found for the segment '${segs[0]}'. Entity sets: ${Object.keys(SETS).join(', ')}`, { code: 'not-found' });
    const typeName = set.type;
    let key = null;
    if (m[2] !== undefined) {
      const km = /^(?:id=)?(\d+)$/.exec(m[2].trim());
      if (!km) throw new HttpError(400, `Invalid key ${m[2]}: ${set.set} is keyed by an Edm.Int32 id, e.g. ${set.set}(1)`, { code: 'invalid-key' });
      key = Number(km[1]);
    }
    const raw = rawOptions(req);
    const level = metadataLevel(req, raw);
    const pref = prefer(req);
    const send = (status, body, extraHeaders = {}) => {
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      if (body === undefined) return res.status(status).end();
      return res.status(status).set('Content-Type', contentType(level)).send(Buffer.from(JSON.stringify(body)));
    };
    const ctxUrl = (fragment) => (level === 'none' ? {} : { '@odata.context': `${root}/$metadata#${fragment}` });
    const data = await loadData(resources);
    const ser = { metadata: level, root };

    // Collection response with server-driven paging.
    const sendCollection = (list, targetType, contextPath, allowPaging = true) => {
      const options = parseOptions(raw, targetType);
      const matched = query(list, options, data);
      const maxPage = settings.get('odataMaxPageSize');
      const wanted = pref['odata.maxpagesize'] !== undefined ? Number(pref['odata.maxpagesize']) : null;
      const pageSize = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, maxPage) : maxPage;
      const skiptoken = raw.$skiptoken !== undefined ? Number(raw.$skiptoken) : 0;
      if (!Number.isInteger(skiptoken) || skiptoken < 0) throw new HttpError(400, 'Invalid $skiptoken', { code: 'invalid-query-option' });
      const start = (options.skip || 0) + skiptoken;
      const limit = Math.min(allowPaging ? pageSize : Infinity, options.top !== undefined ? Math.max(0, options.top - skiptoken) : Infinity);
      const page = matched.slice(start, start + limit);
      const more = start + page.length < matched.length && (options.top === undefined || skiptoken + page.length < options.top);
      const body = { ...ctxUrl(`${contextPath}${projection(options)}`) };
      if (options.count) body['@odata.count'] = matched.length;
      body.value = page.map((d) => serialize(targetType, d, options, data, ser));
      if (more) {
        const qs = new URLSearchParams(Object.entries(raw).filter(([k]) => k !== '$skiptoken'));
        qs.set('$skiptoken', String(skiptoken + page.length));
        body['@odata.nextLink'] = `${root}/${req.path.replace(/^\//, '')}?${qs.toString().replace(/\+/g, '%20')}`;
      }
      const headers = wanted ? { 'Preference-Applied': `odata.maxpagesize=${pageSize}` } : {};
      return send(200, body, headers);
    };
    const sendCount = (list, targetType) => {
      const options = parseOptions(raw, targetType);
      return res.status(200).type('text/plain; charset=utf-8').send(String(query(list, options, data).length));
    };
    const sendEntity = (status, doc, extra = {}) => {
      const options = parseOptions(raw, typeName);
      return send(status, { ...ctxUrl(`${set.set}${projection(options)}/$entity`), ...serialize(typeName, doc, options, data, ser) }, { ETag: `W/${etagOf(shape(typeName, doc))}`, ...extra });
    };

    // ---- /Set and /Set/$count
    if (key === null) {
      if (segs.length === 2 && segs[1] === '$count') {
        if (req.method !== 'GET') throw new HttpError(405, '$count is read-only', { code: 'method-not-allowed', headers: { Allow: 'GET' } });
        return sendCount(data.lists[set.set], typeName);
      }
      if (segs.length > 1) throw new HttpError(404, `Resource not found for the segment '${segs[1]}'. Address an entity with ${set.set}(id)`, { code: 'not-found' });
      if (req.method === 'GET') return sendCollection(data.lists[set.set], typeName, set.set);
      if (req.method === 'POST') {
        const created = await resources.create(set.resource, toInput(typeName, req.body));
        const location = `${root}/${keyPath(set.set, created.id)}`;
        if (pref.return === 'minimal') return send(204, undefined, { Location: location, 'OData-EntityId': location, 'Preference-Applied': 'return=minimal' });
        const fresh = await loadData(resources);
        Object.assign(data, fresh);
        return sendEntity(201, created, { Location: location });
      }
      throw new HttpError(405, `${req.method} is not allowed on an entity set`, { code: 'method-not-allowed', headers: { Allow: 'GET, POST' } });
    }

    // ---- /Set(key)…
    const doc = data.byId[set.set].get(key);
    if (!doc) throw new HttpError(404, `${typeName} with key ${key} not found`, { code: 'not-found' });

    if (segs.length === 1) {
      switch (req.method) {
        case 'GET':
          return sendEntity(200, doc);
        case 'PATCH':
        case 'PUT': {
          checkIfMatch(req, typeName, doc);
          const input = toInput(typeName, req.body);
          const updated = req.method === 'PATCH' ? await resources.patch(set.resource, doc, input) : await resources.replace(set.resource, doc, input);
          const etag = `W/${etagOf(shape(typeName, updated))}`;
          if (pref.return === 'representation') {
            Object.assign(data, await loadData(resources));
            return sendEntity(200, updated, { 'Preference-Applied': 'return=representation' });
          }
          return send(204, undefined, { ETag: etag });
        }
        case 'DELETE':
          checkIfMatch(req, typeName, doc);
          await resources.remove(set.resource, doc);
          return send(204);
        default:
          throw new HttpError(405, `${req.method} is not allowed on an entity`, { code: 'method-not-allowed', headers: { Allow: 'GET, PATCH, PUT, DELETE' } });
      }
    }

    if (req.method !== 'GET') throw new HttpError(405, `Only GET is supported on ${segs.slice(1).join('/')}`, { code: 'method-not-allowed', headers: { Allow: 'GET' } });
    const mem = member(typeName, segs[1]);
    if (!mem) throw new HttpError(404, `Could not find a property named '${segs[1]}' on type 'ApiTestTool.${typeName}'`, { code: 'not-found' });
    const base = `${keyPath(set.set, key)}/${segs[1]}`;

    if (mem.kind === 'prop') {
      const value = shape(typeName, doc)[segs[1]];
      if (segs[2] === '$value') {
        if (segs.length > 3 || mem.prop.coll || !mem.prop.type.startsWith('Edm.')) throw new HttpError(400, '/$value is only available for primitive properties', { code: 'invalid-path' });
        if (value === null) return send(204);
        return res.status(200).type('text/plain; charset=utf-8').send(String(value));
      }
      if (segs.length > 2) throw new HttpError(404, `Resource not found for the segment '${segs[2]}'`, { code: 'not-found' });
      if (value === null) return send(204);
      if (!mem.prop.coll && !mem.prop.type.startsWith('Edm.')) return send(200, { ...ctxUrl(base), ...value });
      return send(200, { ...ctxUrl(base), value });
    }

    const { nav } = mem;
    const target = SETS[nav.target];
    if (nav.many) {
      const list = data.children(nav, doc);
      if (segs[2] === '$count' && segs.length === 3) return sendCount(list, target.type);
      if (segs.length > 2) throw new HttpError(404, `Resource not found for the segment '${segs[2]}'; address related entities by their own set, e.g. ${nav.target}(1)`, { code: 'not-found' });
      return sendCollection(list, target.type, nav.target);
    }
    if (segs.length > 2) throw new HttpError(404, `Resource not found for the segment '${segs[2]}'`, { code: 'not-found' });
    const parent = data.parent(nav, doc);
    if (!parent) return send(204);
    const options = parseOptions(raw, target.type);
    return send(200, { ...ctxUrl(`${nav.target}${projection(options)}/$entity`), ...serialize(target.type, parent, options, data, ser) });
  });

  r.use((req) => { throw new HttpError(404, `No OData route ${req.method} ${req.originalUrl}. The service root is /odata/v4`, { code: 'route-not-found' }); });
  return r;
};

module.exports.ENTITIES = ENTITIES;
