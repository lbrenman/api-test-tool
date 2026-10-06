'use strict';
// Seven pagination schemes. Each returns { body, headers }.
const { HttpError } = require('../util/problem');

const SCHEMES = ['offset', 'page', 'cursor', 'keyset', 'link', 'hal', 'token'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function int(v, name, { min = 0, def } = {}) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${name} must be an integer >= ${min}`, { errors: [{ field: name, message: `must be an integer >= ${min}` }] });
  return n;
}

function limitOf(v, name) {
  const n = int(v, name, { min: 1, def: DEFAULT_LIMIT });
  if (n > MAX_LIMIT) throw new HttpError(400, `${name} must be <= ${MAX_LIMIT}`, { errors: [{ field: name, message: `must be <= ${MAX_LIMIT}` }] });
  return n;
}

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function dec(token, name) {
  try {
    const o = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (!o || typeof o.o !== 'number' || o.o < 0) throw new Error('bad');
    return o;
  } catch {
    throw new HttpError(400, `Invalid ${name}`, { errors: [{ field: name, message: 'not a valid token' }] });
  }
}

function urlWith(req, baseUrl, params) {
  const u = new URL(req.originalUrl, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// items: already filtered + sorted internal docs. render: (slice) => output docs.
function paginate(scheme, req, items, { render, baseUrl, name }) {
  const q = req.query;
  const total = items.length;
  const base = baseUrl(req);

  switch (scheme) {
    case 'offset': {
      const offset = int(q.offset, 'offset', { def: 0 });
      const limit = limitOf(q.limit, 'limit');
      return { body: { data: render(items.slice(offset, offset + limit)), meta: { offset, limit, total } }, headers: {} };
    }
    case 'page': {
      const page = int(q.page, 'page', { min: 1, def: 1 });
      const size = limitOf(q.size, 'size');
      const totalPages = Math.max(1, Math.ceil(total / size));
      const start = (page - 1) * size;
      return { body: { data: render(items.slice(start, start + size)), meta: { page, size, totalPages, totalItems: total } }, headers: {} };
    }
    case 'cursor': {
      const limit = limitOf(q.limit, 'limit');
      const offset = q.cursor ? dec(q.cursor, 'cursor').o : 0;
      const next = offset + limit < total ? enc({ o: offset + limit }) : null;
      const prev = offset > 0 ? enc({ o: Math.max(0, offset - limit) }) : null;
      return { body: { data: render(items.slice(offset, offset + limit)), nextCursor: next, prevCursor: prev }, headers: {} };
    }
    case 'keyset': {
      const limit = limitOf(q.limit, 'limit');
      const sorted = items.slice().sort((a, b) => a.id - b.id);
      let slice;
      let hasMore;
      if (q.before_id !== undefined && q.before_id !== '') {
        const before = int(q.before_id, 'before_id');
        const older = sorted.filter((d) => d.id < before);
        slice = older.slice(Math.max(0, older.length - limit));
        hasMore = older.length > limit;
      } else {
        const after = int(q.after_id, 'after_id', { def: 0 });
        const newer = sorted.filter((d) => d.id > after);
        slice = newer.slice(0, limit);
        hasMore = newer.length > limit;
      }
      return {
        body: { data: render(slice), hasMore, firstId: slice.length ? slice[0].id : null, lastId: slice.length ? slice[slice.length - 1].id : null },
        headers: {},
      };
    }
    case 'link': {
      const page = int(q.page, 'page', { min: 1, def: 1 });
      const perPage = limitOf(q.per_page, 'per_page');
      const last = Math.max(1, Math.ceil(total / perPage));
      const links = [`<${urlWith(req, base, { page: 1, per_page: perPage })}>; rel="first"`];
      if (page > 1) links.push(`<${urlWith(req, base, { page: Math.min(page - 1, last), per_page: perPage })}>; rel="prev"`);
      if (page < last) links.push(`<${urlWith(req, base, { page: page + 1, per_page: perPage })}>; rel="next"`);
      links.push(`<${urlWith(req, base, { page: last, per_page: perPage })}>; rel="last"`);
      const start = (page - 1) * perPage;
      return {
        body: render(items.slice(start, start + perPage)),
        headers: { Link: links.join(', '), 'X-Total-Count': String(total) },
      };
    }
    case 'hal': {
      const page = int(q.page, 'page', { min: 1, def: 1 });
      const size = limitOf(q.size, 'size');
      const totalPages = Math.max(1, Math.ceil(total / size));
      const start = (page - 1) * size;
      const href = (p) => ({ href: urlWith(req, base, { page: p, size }) });
      const links = { self: href(page), first: href(1), last: href(totalPages) };
      if (page > 1) links.prev = href(Math.min(page - 1, totalPages));
      if (page < totalPages) links.next = href(page + 1);
      return {
        body: {
          _embedded: { [name]: render(items.slice(start, start + size)) },
          _links: links,
          page: { size, totalElements: total, totalPages, number: page },
        },
        headers: { 'Content-Type': 'application/hal+json; charset=utf-8' },
      };
    }
    case 'token': {
      const pageSize = limitOf(q.pageSize, 'pageSize');
      const offset = q.pageToken ? dec(q.pageToken, 'pageToken').o : 0;
      const next = offset + pageSize < total ? enc({ o: offset + pageSize }) : null;
      return { body: { items: render(items.slice(offset, offset + pageSize)), nextPageToken: next }, headers: {} };
    }
    default:
      throw new HttpError(404, `Unknown pagination scheme "${scheme}". Use one of: ${SCHEMES.join(', ')}`);
  }
}

module.exports = { paginate, SCHEMES, DEFAULT_LIMIT, MAX_LIMIT };
