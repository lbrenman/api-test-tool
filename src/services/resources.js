'use strict';
// CRUD service for the mock resources with validation, relational checks, ETags and an in-process cache.
const crypto = require('node:crypto');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { INPUT } = require('./schemas');
const { HttpError } = require('../util/problem');

const NAMES = ['employees', 'products', 'departments', 'categories'];
const SINGULAR = { employees: 'employee', products: 'product', departments: 'department', categories: 'category' };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators = Object.fromEntries(NAMES.map((n) => [n, ajv.compile(INPUT[n])]));

function ajvErrors(errors) {
  return (errors || []).map((e) => {
    let field = e.instancePath.replace(/^\//, '').replace(/\//g, '.');
    if (e.keyword === 'required') field = field ? `${field}.${e.params.missingProperty}` : e.params.missingProperty;
    if (e.keyword === 'additionalProperties') field = field ? `${field}.${e.params.additionalProperty}` : e.params.additionalProperty;
    const message = e.keyword === 'additionalProperties' ? 'is not an allowed field' : e.message;
    return { field: field || '(body)', message };
  });
}

function etagOf(doc) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(doc)).digest('hex').slice(0, 20)}"`;
}

// RFC 7396 JSON Merge Patch
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const READONLY = ['id', 'uuid', 'createdAt', 'updatedAt', 'department', 'category'];

class ResourceService {
  // events (optional EventEmitter): emits 'change' { type: created|updated|deleted, resource, id, at, data? }
  // for the live change feeds (/ws/changes, /sse/changes).
  constructor(repo, dates, events = null) {
    this.repo = repo;
    this.dates = dates;
    this.events = events;
    this.cache = new Map();
  }

  changed(type, name, doc) {
    if (!this.events) return;
    try {
      this.events.emit('change', { type, resource: name, id: doc.id, at: new Date().toISOString(), ...(type === 'deleted' ? {} : { data: doc }) });
    } catch { /* a listener must never break a write */ }
  }

  invalidate(name) {
    if (name) this.cache.delete(name); else this.cache.clear();
  }

  async all(name) {
    if (!this.cache.has(name)) {
      const docs = await this.repo.list(name);
      docs.sort((a, b) => a.id - b.id);
      this.cache.set(name, docs);
    }
    return this.cache.get(name);
  }

  async get(name, id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) return null;
    return (await this.all(name)).find((d) => d.id === n) || null;
  }

  async counts() {
    const out = {};
    for (const n of NAMES) out[n] = (await this.all(n)).length;
    return out;
  }

  // Attach nested summaries for output.
  async render(name, docs) {
    if (name === 'employees') {
      const deps = new Map((await this.all('departments')).map((d) => [d.id, { id: d.id, name: d.name, code: d.code }]));
      return docs.map((d) => ({ ...d, department: deps.get(d.departmentId) || null }));
    }
    if (name === 'products') {
      const cats = new Map((await this.all('categories')).map((c) => [c.id, { id: c.id, name: c.name, code: c.code }]));
      return docs.map((d) => ({ ...d, category: cats.get(d.categoryId) || null }));
    }
    return docs;
  }

  validate(name, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'Request body must be a JSON object');
    }
    if (!validators[name](body)) {
      throw new HttpError(422, `${SINGULAR[name]} failed validation`, { errors: ajvErrors(validators[name].errors), code: 'validation-failed' });
    }
    const errs = [];
    const parsed = this.dates.parseDoc(body, errs);
    if (errs.length) throw new HttpError(422, 'Invalid timestamp value', { errors: errs, code: 'validation-failed' });
    return parsed;
  }

  async checkRefs(name, doc) {
    const errors = [];
    if (name === 'employees') {
      if (!(await this.get('departments', doc.departmentId))) errors.push({ field: 'departmentId', message: `department ${doc.departmentId} does not exist` });
      if (doc.managerId != null) {
        if (!(await this.get('employees', doc.managerId))) errors.push({ field: 'managerId', message: `employee ${doc.managerId} does not exist` });
        else if (doc.id && doc.managerId === doc.id) errors.push({ field: 'managerId', message: 'an employee cannot manage themselves' });
      }
    }
    if (name === 'products' && !(await this.get('categories', doc.categoryId))) {
      errors.push({ field: 'categoryId', message: `category ${doc.categoryId} does not exist` });
    }
    if (errors.length) throw new HttpError(422, 'Referenced resource not found', { errors, code: 'reference-not-found' });
  }

  normalize(name, input, existing) {
    const doc = { ...input };
    for (const k of READONLY) delete doc[k];
    if (name === 'employees') {
      if (doc.salary !== undefined && doc.salaryDecimal === undefined) doc.salaryDecimal = Number(doc.salary).toFixed(2);
      if (doc.salaryDecimal !== undefined && doc.salary === undefined) doc.salary = parseFloat(doc.salaryDecimal);
      return {
        employeeNumber: existing?.employeeNumber,
        title: '', level: 'L1', isActive: true, salary: 0, salaryDecimal: '0.00', performanceRating: null,
        managerId: null, skills: [], certifications: [], address: {}, phoneNumbers: [], hireDate: new Date().toISOString().slice(0, 10),
        metadata: {}, avatarFileId: null,
        ...doc,
      };
    }
    if (name === 'products') {
      if (doc.price !== undefined && doc.priceDecimal === undefined) doc.priceDecimal = Number(doc.price).toFixed(2);
      if (doc.priceDecimal !== undefined && doc.price === undefined) doc.price = parseFloat(doc.priceDecimal);
      return {
        description: '', inStock: true, stockQty: 0, weightKg: 0, dimensions: { l: 0, w: 0, h: 0, unit: 'cm' },
        tags: [], variants: [], rating: null, releaseDate: new Date().toISOString().slice(0, 10), discontinuedAt: null, imageFileIds: [],
        ...doc,
      };
    }
    return doc;
  }

  async create(name, body) {
    const input = this.validate(name, body);
    const id = await this.repo.nextId(name);
    const now = new Date().toISOString();
    const base = this.normalize(name, input);
    const doc = { id, uuid: crypto.randomUUID(), ...base, createdAt: now, updatedAt: now };
    if (name === 'employees' && !doc.employeeNumber) doc.employeeNumber = `EMP-${String(id).padStart(6, '0')}`;
    await this.checkRefs(name, doc);
    await this.repo.put(name, id, doc);
    this.invalidate(name);
    this.changed('created', name, doc);
    return doc;
  }

  async replace(name, existing, body) {
    const input = this.validate(name, body);
    const base = this.normalize(name, input, existing);
    const doc = {
      id: existing.id, uuid: existing.uuid, ...base,
      createdAt: existing.createdAt, updatedAt: new Date().toISOString(),
    };
    if (name === 'employees' && !doc.employeeNumber) doc.employeeNumber = existing.employeeNumber;
    await this.checkRefs(name, doc);
    await this.repo.put(name, doc.id, doc);
    this.invalidate(name);
    this.changed('updated', name, doc);
    return doc;
  }

  async patch(name, existing, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Merge patch must be a JSON object');
    const current = { ...existing };
    for (const k of READONLY) delete current[k];
    // Keep the float and decimal-string twins in sync when only one is patched.
    if ('salary' in patch && !('salaryDecimal' in patch)) delete current.salaryDecimal;
    if ('salaryDecimal' in patch && !('salary' in patch)) delete current.salary;
    if ('price' in patch && !('priceDecimal' in patch)) delete current.priceDecimal;
    if ('priceDecimal' in patch && !('price' in patch)) current.price = parseFloat(patch.priceDecimal);
    const merged = mergePatch(current, patch);
    // Merge patch sets missing nullables back to null rather than deleting required-by-shape fields.
    return this.replace(name, existing, merged);
  }

  async remove(name, existing) {
    if (name === 'departments' && (await this.all('employees')).some((e) => e.departmentId === existing.id)) {
      throw new HttpError(409, `Department ${existing.id} still has employees`, { code: 'resource-in-use' });
    }
    if (name === 'categories' && (await this.all('products')).some((p) => p.categoryId === existing.id)) {
      throw new HttpError(409, `Category ${existing.id} still has products`, { code: 'resource-in-use' });
    }
    if (name === 'employees') {
      // Detach direct reports.
      const reports = (await this.all('employees')).filter((e) => e.managerId === existing.id);
      for (const r of reports) await this.repo.put('employees', r.id, { ...r, managerId: null, updatedAt: new Date().toISOString() });
    }
    await this.repo.del(name, existing.id);
    this.invalidate(name);
    this.changed('deleted', name, existing);
  }
}

module.exports = { ResourceService, NAMES, SINGULAR, etagOf, mergePatch, ajvErrors };
