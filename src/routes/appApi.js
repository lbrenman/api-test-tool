'use strict';
// /admin/api/app/* — backend for the business-style "back office" app at /app.
// Reads and writes the same mock data as /v1, but bypasses /v1 auth, chaos, rate limits and required headers so the
// app always works. Timestamps are always ISO 8601 (UTC) here, whatever DATE_FORMAT is set to for /v1.
const express = require('express');
const { NAMES } = require('../services/resources');
const { applyQuery } = require('../services/query');
const { HttpError } = require('../util/problem');

// Fixed demo exchange rates, used only to total multi-currency product values in one currency.
const FX_TO_USD = { USD: 1, EUR: 1.08, GBP: 1.27, JPY: 0.0067, CAD: 0.73 };
const LOW_STOCK = 10;
const SINGLE = { employees: 'Employee', products: 'Product', departments: 'Department', categories: 'Category' };

const fullName = (e) => `${e.firstName} ${e.lastName}`.trim();
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const usd = (p) => (Number(p.price) || 0) * (FX_TO_USD[p.currency] ?? 1);
const stockStatus = (p) => (p.discontinuedAt ? 'discontinued' : !p.inStock || !p.stockQty ? 'out' : p.stockQty < LOW_STOCK ? 'low' : 'in');

module.exports = function appApiRouter(ctx) {
  const r = express.Router();
  const { resources } = ctx;

  function resourceParam(req) {
    const name = req.params.resource;
    if (!NAMES.includes(name)) throw new HttpError(404, `Unknown resource "${name}"`, { code: 'unknown-resource' });
    return name;
  }

  async function loadAll() {
    const [employees, products, departments, categories] = await Promise.all(NAMES.map((n) => resources.all(n)));
    return { employees, products, departments, categories };
  }

  // Rendered rows plus computed columns the app shows and sorts on.
  async function rows(name) {
    const all = await loadAll();
    const base = await resources.render(name, all[name]);
    if (name === 'employees') {
      const byId = new Map(all.employees.map((e) => [e.id, e]));
      return base.map((e) => ({ ...e, fullName: fullName(e), managerName: e.managerId && byId.has(e.managerId) ? fullName(byId.get(e.managerId)) : null }));
    }
    if (name === 'products') return base.map((p) => ({ ...p, stockStatus: stockStatus(p), priceUsd: round(usd(p)) }));
    if (name === 'departments') {
      return base.map((d) => {
        const staff = all.employees.filter((e) => e.departmentId === d.id);
        const active = staff.filter((e) => e.isActive);
        return { ...d, employeeCount: staff.length, activeCount: active.length, avgSalary: round(avg(active.map((e) => e.salary)), 0) };
      });
    }
    return base.map((c) => {
      const items = all.products.filter((p) => p.categoryId === c.id);
      return {
        ...c, productCount: items.length,
        stockUnits: items.reduce((a, p) => a + (p.stockQty || 0), 0),
        inventoryValueUsd: round(items.reduce((a, p) => a + usd(p) * (p.stockQty || 0), 0), 0),
      };
    });
  }

  async function oneRow(name, id) {
    const row = (await rows(name)).find((x) => x.id === Number(id));
    if (!row) throw new HttpError(404, `${SINGLE[name]} ${id} not found`, { code: 'not-found' });
    return row;
  }

  // ---- KPIs and chart series for the home page
  r.get('/summary', async (req, res) => {
    const { employees, products, departments, categories } = await loadAll();
    const active = employees.filter((e) => e.isActive);
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const rated = employees.filter((e) => typeof e.performanceRating === 'number');
    const live = products.filter((p) => !p.discontinuedAt);
    const statusCounts = { in: 0, low: 0, out: 0, discontinued: 0 };
    for (const p of products) statusCounts[stockStatus(p)] += 1;

    const hiresByYear = {};
    for (const e of employees) { const y = String(e.hireDate || '').slice(0, 4); if (y) hiresByYear[y] = (hiresByYear[y] || 0) + 1; }
    const levels = [...new Set(employees.map((e) => e.level))].sort();

    const recent = [
      ...employees.map((e) => ({ resource: 'employees', id: e.id, label: fullName(e), detail: e.title, updatedAt: e.updatedAt, createdAt: e.createdAt })),
      ...products.map((p) => ({ resource: 'products', id: p.id, label: p.name, detail: p.sku, updatedAt: p.updatedAt, createdAt: p.createdAt })),
      ...departments.map((d) => ({ resource: 'departments', id: d.id, label: d.name, detail: d.code, updatedAt: d.updatedAt, createdAt: d.createdAt })),
      ...categories.map((c) => ({ resource: 'categories', id: c.id, label: c.name, detail: c.code, updatedAt: c.updatedAt, createdAt: c.createdAt })),
    ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8)
      .map((x) => ({ ...x, change: x.createdAt === x.updatedAt ? 'created' : 'updated' }));

    res.json({
      generatedAt: new Date().toISOString(),
      currency: 'USD',
      fxNote: 'Product values in other currencies are converted with fixed demo rates.',
      people: {
        headcount: employees.length,
        active: active.length,
        activePct: employees.length ? round((active.length / employees.length) * 100, 1) : 0,
        avgSalary: round(avg(active.map((e) => e.salary)), 0),
        annualPayroll: round(active.reduce((a, e) => a + (e.salary || 0), 0), 0),
        avgRating: round(avg(rated.map((e) => e.performanceRating)), 2),
        hiresLast12Months: employees.filter((e) => e.hireDate >= yearAgo).length,
        departments: departments.length,
      },
      catalog: {
        products: products.length,
        live: live.length,
        inStockPct: products.length ? round((statusCounts.in / products.length) * 100, 1) : 0,
        lowStock: statusCounts.low,
        outOfStock: statusCounts.out,
        discontinued: statusCounts.discontinued,
        inventoryValueUsd: round(live.reduce((a, p) => a + usd(p) * (p.stockQty || 0), 0), 0),
        avgRating: round(avg(products.filter((p) => typeof p.rating === 'number').map((p) => p.rating)), 2),
        categories: categories.length,
      },
      charts: {
        headcountByDepartment: departments.map((d) => ({ id: d.id, label: d.name, value: employees.filter((e) => e.departmentId === d.id).length })).sort((a, b) => b.value - a.value),
        avgSalaryByLevel: levels.map((l) => ({ label: l, value: round(avg(active.filter((e) => e.level === l).map((e) => e.salary)), 0) || 0 })),
        hiresByYear: Object.keys(hiresByYear).sort().map((y) => ({ label: y, value: hiresByYear[y] })),
        productsByCategory: categories.map((c) => ({ id: c.id, label: c.name, value: products.filter((p) => p.categoryId === c.id).length })).sort((a, b) => b.value - a.value),
        stockStatus: [
          { key: 'in', label: 'In stock', value: statusCounts.in },
          { key: 'low', label: `Low (under ${LOW_STOCK})`, value: statusCounts.low },
          { key: 'out', label: 'Out of stock', value: statusCounts.out },
          { key: 'discontinued', label: 'Discontinued', value: statusCounts.discontinued },
        ],
      },
      recent,
    });
  });

  // ---- options for selects (departments, categories, managers)
  r.get('/lookups', async (req, res) => {
    const { employees, departments, categories } = await loadAll();
    const pick = (x) => ({ id: x.id, name: x.name, code: x.code });
    res.json({
      departments: departments.map(pick).sort((a, b) => a.name.localeCompare(b.name)),
      categories: categories.map(pick).sort((a, b) => a.name.localeCompare(b.name)),
      employees: employees.map((e) => ({ id: e.id, name: fullName(e), title: e.title, isActive: e.isActive })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  // ---- records: list (search, filters, sort, page), read, create, update (merge patch), delete
  r.get('/records/:resource', async (req, res) => {
    const name = resourceParam(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 25));
    const filtered = applyQuery(await rows(name), req.query, { parseDate: ctx.dates.parseValue });
    const total = filtered.length;
    res.json({ items: filtered.slice((page - 1) * size, page * size), total, page, size, pages: Math.max(1, Math.ceil(total / size)) });
  });

  r.get('/records/:resource/:id', async (req, res) => {
    const name = resourceParam(req);
    const row = await oneRow(name, req.params.id);
    const related = {};
    if (name === 'employees') {
      const people = await rows('employees');
      related.directReports = people.filter((e) => e.managerId === row.id).map((e) => ({ id: e.id, name: e.fullName, title: e.title, isActive: e.isActive }));
    } else if (name === 'departments') {
      related.employees = (await rows('employees')).filter((e) => e.departmentId === row.id)
        .map((e) => ({ id: e.id, name: e.fullName, title: e.title, level: e.level, isActive: e.isActive })).sort((a, b) => a.name.localeCompare(b.name));
    } else if (name === 'categories') {
      related.products = (await rows('products')).filter((p) => p.categoryId === row.id)
        .map((p) => ({ id: p.id, name: p.name, sku: p.sku, stockStatus: p.stockStatus, stockQty: p.stockQty })).sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ record: row, related });
  });

  r.post('/records/:resource', async (req, res) => {
    const name = resourceParam(req);
    const doc = await resources.create(name, req.body);
    res.status(201).json(await oneRow(name, doc.id));
  });

  r.patch('/records/:resource/:id', async (req, res) => {
    const name = resourceParam(req);
    const doc = await resources.get(name, req.params.id);
    if (!doc) throw new HttpError(404, `${SINGLE[name]} ${req.params.id} not found`, { code: 'not-found' });
    await resources.patch(name, doc, req.body);
    res.json(await oneRow(name, doc.id));
  });

  r.delete('/records/:resource/:id', async (req, res) => {
    const name = resourceParam(req);
    const doc = await resources.get(name, req.params.id);
    if (!doc) throw new HttpError(404, `${SINGLE[name]} ${req.params.id} not found`, { code: 'not-found' });
    await resources.remove(name, doc);
    res.status(204).end();
  });

  return r;
};
