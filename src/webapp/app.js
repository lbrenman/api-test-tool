/* Acme Back Office — a business-style app over the mock data (employees, products, departments, categories).
 * Talks to /admin/api/app/* (dashboard password; bypasses /v1 auth, chaos and rate limits). Vanilla JS, no build step.
 */
(function () {
  'use strict';

  const API = '/admin/api';
  const root = document.getElementById('root');

  // ------------------------------------------------------------------ helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.detail || body?.error || `Request failed (HTTP ${status})`);
      this.status = status;
      this.body = body;
    }
  }

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (res.status === 401 && path !== '/login') { showLogin(); throw new ApiError(401, data); }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  const nf = new Intl.NumberFormat(undefined);
  const pct = (v) => (v === null || v === undefined ? '—' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v)}%`);
  const money = (v, cur = 'USD', compact = false) => {
    if (v === null || v === undefined || v === '') return '—';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: compact || cur === 'JPY' ? 0 : 2, notation: compact ? 'compact' : 'standard' }).format(v);
    } catch { return `${v} ${cur}`; }
  };
  const num = (v) => (v === null || v === undefined || v === '' ? '—' : nf.format(v));
  const day = (v) => {
    if (!v) return '—';
    const d = new Date(String(v).length === 10 ? `${v}T00:00:00` : v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const ago = (v) => {
    const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return 'just now';
    const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
    let u = units[0];
    for (const x of units) if (s >= x[0]) u = x;
    const n = Math.floor(s / u[0]);
    return `${n} ${u[1]}${n === 1 ? '' : 's'} ago`;
  };
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  const rating = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)} / 5`);

  function toast(msg, kind) {
    let box = document.querySelector('.toasts');
    if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
    const t = h('div', { class: `toast${kind === 'err' ? ' err' : ''}` }, msg);
    box.append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
  }

  function confirmDialog({ title, body, action }) {
    return new Promise((resolve) => {
      const d = h('dialog', { 'aria-labelledby': 'dlg-title' },
        h('div', { class: 'd-body' }, h('h2', { id: 'dlg-title' }, title), h('p', null, body)),
        h('div', { class: 'd-foot' },
          h('button', { type: 'button', onclick: () => d.close('cancel') }, 'Cancel'),
          h('button', { type: 'button', class: 'danger solid', onclick: () => d.close('ok') }, action)));
      d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
      document.body.append(d);
      d.showModal();
    });
  }

  // Shared hover tooltip for chart marks.
  const tip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  function hoverTip(el, text) {
    el.addEventListener('pointerenter', () => { tip.textContent = text; tip.hidden = false; });
    el.addEventListener('pointermove', (e) => { tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`; });
    el.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  // ------------------------------------------------------------------ resource definitions
  const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
  const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
  const STOCK = {
    in: { label: 'In stock', cls: 'good' }, low: { label: 'Low stock', cls: 'warn' },
    out: { label: 'Out of stock', cls: 'bad' }, discontinued: { label: 'Discontinued', cls: 'idle' },
  };
  const statusPill = (active) => h('span', { class: `pill ${active ? 'good' : 'idle'}` }, active ? 'Active' : 'Inactive');
  const stockPill = (s) => h('span', { class: `pill ${STOCK[s]?.cls || 'idle'}` }, STOCK[s]?.label || s);

  let LOOKUPS = { departments: [], categories: [], employees: [] };
  async function loadLookups() { LOOKUPS = await api('GET', '/app/lookups'); }
  const opts = (list, { blank } = {}) => [...(blank ? [{ value: '', label: blank }] : []), ...list];

  const RES = {
    employees: {
      title: 'People', one: 'employee', One: 'Employee', defaultSort: 'lastName',
      label: (r) => r.fullName || `${r.firstName} ${r.lastName}`,
      intro: 'Everyone on the payroll, their team and their status.',
      columns: [
        { key: 'lastName', label: 'Name', cell: (r) => h('div', { class: 'who' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(r.fullName)), h('div', null, h('b', null, r.fullName), h('span', null, r.email))) },
        { key: 'title', label: 'Title', cell: (r) => r.title || '—' },
        { key: 'department.name', label: 'Department', cell: (r) => r.department?.name || '—' },
        { key: 'level', label: 'Level' },
        { key: 'isActive', label: 'Status', cell: (r) => statusPill(r.isActive) },
        { key: 'salary', label: 'Salary', num: true, cell: (r) => money(r.salary, 'USD', false).replace(/\.00$/, '') },
        { key: 'hireDate', label: 'Hired', cell: (r) => day(r.hireDate) },
      ],
      filters: () => [
        { key: 'departmentId', label: 'Department', options: opts(LOOKUPS.departments.map((d) => ({ value: d.id, label: d.name })), { blank: 'All departments' }) },
        { key: 'isActive', label: 'Status', options: [{ value: '', label: 'Any status' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
        { key: 'level', label: 'Level', options: opts(LEVELS.map((l) => ({ value: l, label: l })), { blank: 'All levels' }) },
      ],
      form: () => [
        { section: 'Person' },
        { key: 'firstName', label: 'First name', required: true },
        { key: 'lastName', label: 'Last name', required: true },
        { key: 'email', label: 'Work email', type: 'email', required: true },
        { key: 'title', label: 'Job title' },
        { section: 'Role' },
        { key: 'departmentId', label: 'Department', type: 'select', int: true, required: true, options: opts(LOOKUPS.departments.map((d) => ({ value: d.id, label: d.name })), { blank: 'Choose a department' }) },
        { key: 'managerId', label: 'Manager', type: 'select', int: true, nullable: true, options: opts(LOOKUPS.employees.map((e) => ({ value: e.id, label: e.title ? `${e.name} · ${e.title}` : e.name })), { blank: 'No manager' }) },
        { key: 'level', label: 'Level', type: 'select', options: LEVELS.map((l) => ({ value: l, label: l })) },
        { key: 'hireDate', label: 'Hire date', type: 'date' },
        { key: 'salary', label: 'Annual salary (USD)', type: 'number', step: '0.01', min: 0 },
        { key: 'performanceRating', label: 'Performance rating', type: 'number', step: '0.1', min: 0, max: 5, nullable: true, hint: '0 to 5. Leave empty if not rated yet.' },
        { key: 'isActive', label: 'Currently employed', type: 'checkbox' },
        { key: 'skills', label: 'Skills', type: 'list', full: true, hint: 'Separate with commas.' },
        { section: 'Location' },
        { key: 'address.street', label: 'Street' },
        { key: 'address.city', label: 'City' },
        { key: 'address.region', label: 'State or region' },
        { key: 'address.postalCode', label: 'Postal code' },
        { key: 'address.countryCode', label: 'Country code', hint: 'Two letters, e.g. US', upper: true },
      ],
    },
    products: {
      title: 'Products', one: 'product', One: 'Product', defaultSort: 'name',
      label: (r) => r.name,
      intro: 'The catalog: pricing, stock levels and ratings.',
      columns: [
        { key: 'name', label: 'Product', cell: (r) => h('div', { class: 'who' }, h('div', null, h('b', null, r.name), h('span', null, r.sku))) },
        { key: 'category.name', label: 'Category', cell: (r) => r.category?.name || '—' },
        { key: 'priceUsd', label: 'Price', num: true, cell: (r) => money(r.price, r.currency) },
        { key: 'stockQty', label: 'Units', num: true, cell: (r) => num(r.stockQty) },
        { key: 'stockStatus', label: 'Stock', cell: (r) => stockPill(r.stockStatus) },
        { key: 'rating', label: 'Rating', num: true, cell: (r) => rating(r.rating) },
        { key: 'releaseDate', label: 'Released', cell: (r) => day(r.releaseDate) },
      ],
      filters: () => [
        { key: 'categoryId', label: 'Category', options: opts(LOOKUPS.categories.map((c) => ({ value: c.id, label: c.name })), { blank: 'All categories' }) },
        { key: 'stockStatus', label: 'Stock', options: [{ value: '', label: 'Any stock level' }, ...Object.entries(STOCK).map(([value, s]) => ({ value, label: s.label }))] },
        { key: 'currency', label: 'Currency', options: opts(CURRENCIES.map((c) => ({ value: c, label: c })), { blank: 'All currencies' }) },
      ],
      form: () => [
        { section: 'Product' },
        { key: 'name', label: 'Name', required: true },
        { key: 'sku', label: 'SKU', required: true, upper: true, hint: 'Capital letters, digits and dashes.' },
        { key: 'categoryId', label: 'Category', type: 'select', int: true, required: true, options: opts(LOOKUPS.categories.map((c) => ({ value: c.id, label: c.name })), { blank: 'Choose a category' }) },
        { key: 'releaseDate', label: 'Release date', type: 'date' },
        { key: 'description', label: 'Description', type: 'textarea', full: true },
        { section: 'Price and stock' },
        { key: 'price', label: 'Price', type: 'number', step: '0.01', min: 0, required: true },
        { key: 'currency', label: 'Currency', type: 'select', required: true, options: CURRENCIES.map((c) => ({ value: c, label: c })) },
        { key: 'stockQty', label: 'Units in stock', type: 'number', step: '1', min: 0, int: true },
        { key: 'weightKg', label: 'Weight (kg)', type: 'number', step: '0.01', min: 0 },
        { key: 'inStock', label: 'Available to order', type: 'checkbox' },
        { key: 'discontinuedAt', label: 'Discontinued on', type: 'date', nullable: true, timestamp: true, hint: 'Leave empty while the product is on sale.' },
        { key: 'rating', label: 'Customer rating', type: 'number', step: '0.1', min: 0, max: 5, nullable: true },
        { key: 'tags', label: 'Tags', type: 'list', full: true, hint: 'Separate with commas.' },
      ],
    },
    departments: {
      title: 'Departments', one: 'department', One: 'Department', defaultSort: 'name',
      label: (r) => r.name,
      intro: 'Teams, their size and average pay.',
      columns: [
        { key: 'name', label: 'Department', cell: (r) => h('b', null, r.name) },
        { key: 'code', label: 'Code', cell: (r) => h('span', { class: 'tag' }, r.code) },
        { key: 'employeeCount', label: 'People', num: true, cell: (r) => num(r.employeeCount) },
        { key: 'activeCount', label: 'Active', num: true, cell: (r) => num(r.activeCount) },
        { key: 'avgSalary', label: 'Average salary', num: true, cell: (r) => money(r.avgSalary, 'USD', false).replace(/\.00$/, '') },
      ],
      filters: () => [],
      form: () => [
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Code', required: true, upper: true, hint: '2–16 capital letters, digits or dashes.' },
      ],
    },
    categories: {
      title: 'Categories', one: 'category', One: 'Category', defaultSort: 'name',
      label: (r) => r.name,
      intro: 'Product groupings and the stock they hold.',
      columns: [
        { key: 'name', label: 'Category', cell: (r) => h('b', null, r.name) },
        { key: 'code', label: 'Code', cell: (r) => h('span', { class: 'tag' }, r.code) },
        { key: 'productCount', label: 'Products', num: true, cell: (r) => num(r.productCount) },
        { key: 'stockUnits', label: 'Units in stock', num: true, cell: (r) => num(r.stockUnits) },
        { key: 'inventoryValueUsd', label: 'Stock value (USD)', num: true, cell: (r) => money(r.inventoryValueUsd, 'USD', true) },
      ],
      filters: () => [],
      form: () => [
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Code', required: true, upper: true, hint: '2–16 capital letters, digits or dashes.' },
      ],
    },
  };

  // ------------------------------------------------------------------ shell
  let SESSION = { passwordRequired: false };
  let mainEl = null;
  let railEl = null;
  let COUNTS = {};

  function navLink(href, label, page, count) {
    return h('a', { href, 'data-page': page }, h('span', null, label), count !== undefined ? h('span', { class: 'count' }, num(count)) : null);
  }

  function renderShell() {
    clear(root);
    const theme = h('select', { 'aria-label': 'Theme', onchange: (e) => {
      const v = e.target.value;
      if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
      try { if (v) localStorage.setItem('att-app-theme', v); else localStorage.removeItem('att-app-theme'); } catch { /* storage unavailable */ }
    } }, h('option', { value: '' }, 'System theme'), h('option', { value: 'light' }, 'Light'), h('option', { value: 'dark' }, 'Dark'));
    theme.value = document.documentElement.dataset.theme || '';
    railEl = h('nav', { class: 'rail', 'aria-label': 'Main' },
      h('a', { class: 'brand', href: '#/' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, 'A'), h('div', null, h('b', null, 'Acme Back Office'), h('span', null, 'Operations console'))),
      h('div', { class: 'nav' }, navLink('#/', 'Home', 'home')),
      h('div', { class: 'nav-group' }, 'Workforce'),
      h('div', { class: 'nav' }, navLink('#/employees', 'People', 'employees', COUNTS.employees), navLink('#/departments', 'Departments', 'departments', COUNTS.departments)),
      h('div', { class: 'nav-group' }, 'Catalog'),
      h('div', { class: 'nav' }, navLink('#/products', 'Products', 'products', COUNTS.products), navLink('#/categories', 'Categories', 'categories', COUNTS.categories)),
      h('div', { class: 'rail-foot' },
        theme,
        h('a', { href: '/dashboard', target: '_blank', rel: 'noopener' }, 'Developer dashboard ↗'),
        SESSION.passwordRequired ? h('button', { type: 'button', class: 'link', onclick: async () => { await api('POST', '/logout'); showLogin(); } }, 'Sign out') : null));
    railEl.addEventListener('click', (e) => { if (e.target.closest('a')) railEl.classList.remove('open'); });
    mainEl = h('main', { class: 'main', id: 'main', tabindex: '-1' });
    root.append(
      h('div', { class: 'mobile-bar' }, h('button', { type: 'button', 'aria-label': 'Open menu', onclick: () => railEl.classList.toggle('open') }, '☰'), h('b', null, 'Acme Back Office')),
      h('div', { class: 'shell' }, railEl, mainEl));
  }

  function markNav(page) {
    for (const a of railEl.querySelectorAll('a[data-page]')) a.classList.toggle('active', a.dataset.page === page);
  }

  function showLogin(error) {
    clear(root);
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'pw' });
    const err = h('div', { class: 'form-error', hidden: !error, style: { margin: 0 } }, error || '');
    const submit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/login', { password: pw.value });
        start();
      } catch (ex) {
        err.textContent = ex.status === 401 ? 'That password is not right. Use the dashboard password (ADMIN_PASSWORD).' : ex.message;
        err.hidden = false;
        pw.select();
      }
    };
    root.append(h('div', { class: 'login' },
      h('div', { class: 'brand', style: { justifyContent: 'center' } }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, 'A'), h('div', null, h('b', null, 'Acme Back Office'), h('span', null, 'Operations console'))),
      h('form', { class: 'panel', onsubmit: submit },
        h('h1', { style: { fontSize: '20px' } }, 'Sign in'),
        h('label', { class: 'field', for: 'pw' }, h('span', null, 'Password'), pw, h('span', { class: 'hint' }, 'The same password as the developer dashboard.')),
        err,
        h('button', { class: 'primary', type: 'submit' }, 'Sign in'))));
    pw.focus();
  }

  // ------------------------------------------------------------------ routing
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
  }

  async function route() {
    if (!mainEl) return;
    tip.hidden = true;
    const { parts, query } = parseHash();
    const [res, id, action] = parts;
    clear(mainEl);
    mainEl.append(h('div', { class: 'loading' }, 'Loading…'));
    try {
      let node;
      if (!res) { markNav('home'); node = await homePage(); }
      else if (!RES[res]) { markNav(''); node = notFound(); }
      else {
        markNav(res);
        if (!id) node = await listPage(res, query);
        else if (id === 'new') node = await formPage(res, null);
        else if (action === 'edit') node = await formPage(res, id);
        else node = await recordPage(res, id);
      }
      clear(mainEl).append(node);
      document.title = `${mainEl.querySelector('h1')?.textContent || 'Home'} · Acme Back Office`;
    } catch (e) {
      if (e.status === 401) return;
      clear(mainEl).append(h('div', { class: 'panel empty' }, h('b', null, e.status === 404 ? 'Not found' : 'Something went wrong'), e.message,
        h('p', null, h('a', { href: res ? `#/${res}` : '#/' }, res ? `Back to ${RES[res]?.title || 'home'}` : 'Back to home'))));
    }
  }

  function notFound() {
    return h('div', { class: 'panel empty' }, h('b', null, 'Page not found'), h('a', { href: '#/' }, 'Go to home'));
  }

  function pageHead(title, sub, actions, crumbs) {
    return h('div', { class: 'page-head' },
      h('div', null, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', null, title), sub ? h('p', null, sub) : null),
      actions ? h('div', { class: 'actions' }, actions) : null);
  }

  // ------------------------------------------------------------------ home
  function barList(items, { format = num, hrefFor } = {}) {
    const max = Math.max(1, ...items.map((i) => i.value));
    return h('div', { class: 'bars' }, items.map((i) => {
      const row = h(hrefFor ? 'a' : 'div', { class: 'bar-row', href: hrefFor ? hrefFor(i) : null, style: hrefFor ? { color: 'inherit', textDecoration: 'none' } : null },
        h('span', { class: 'name' }, i.label),
        h('div', { class: 'bar-track', 'aria-hidden': 'true' }, h('div', { class: 'bar-fill', style: { width: `${(i.value / max) * 100}%` } })),
        h('span', { class: 'val' }, format(i.value)));
      hoverTip(row, `${i.label}: ${format(i.value)}`);
      return row;
    }));
  }

  function columnChart(items, { format = num, unit = '' } = {}) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const showTop = items.length <= 14;
    return h('div', null,
      h('div', { class: 'cols', role: 'img', 'aria-label': items.map((i) => `${i.label}: ${format(i.value)}${unit}`).join(', ') }, items.map((i) => {
        const col = h('div', { class: 'col' },
          showTop ? h('span', { class: 'top', style: { bottom: `${(i.value / max) * 100}%` } }, format(i.value)) : null,
          h('div', { class: 'col-fill', style: { height: `${(i.value / max) * 100}%` } }));
        hoverTip(col, `${i.label}: ${format(i.value)}${unit}`);
        return col;
      })),
      h('div', { class: 'col-labels', 'aria-hidden': 'true' }, items.map((i, n) => h('span', null, items.length > 10 && n % 2 ? '' : i.label))));
  }

  function stockSplit(items) {
    const total = items.reduce((a, i) => a + i.value, 0) || 1;
    const shown = items.filter((i) => i.value > 0);
    const bar = h('div', { class: 'split', role: 'img', 'aria-label': items.map((i) => `${i.label}: ${i.value}`).join(', ') },
      shown.map((i) => {
        const seg = h('div', { class: `st-${i.key}`, style: { flex: `${i.value} 0 0` } });
        hoverTip(seg, `${i.label}: ${num(i.value)} (${pct((i.value / total) * 100)})`);
        return seg;
      }));
    const legend = h('div', { class: 'legend' }, items.map((i) => h('a', { href: `#/products?stockStatus=${i.key}`, style: { color: 'inherit', display: 'flex', alignItems: 'center', gap: '8px' } },
      h('i', { class: `st-${i.key}`, 'aria-hidden': 'true' }), h('span', null, i.label), h('b', null, num(i.value)))));
    return h('div', null, bar, legend);
  }

  function kpi(label, value, sub, href) {
    return h('div', { class: 'kpi' },
      h('div', { class: 'label' }, label),
      href ? h('a', { class: 'value', href }, value) : h('div', { class: 'value' }, value),
      sub ? h('div', { class: 'sub' }, sub) : null);
  }

  async function homePage() {
    const s = await api('GET', '/app/summary');
    COUNTS = { employees: s.people.headcount, departments: s.people.departments, products: s.catalog.products, categories: s.catalog.categories };
    for (const a of railEl.querySelectorAll('a[data-page]')) {
      const c = a.querySelector('.count');
      if (c && COUNTS[a.dataset.page] !== undefined) c.textContent = num(COUNTS[a.dataset.page]);
    }
    const p = s.people;
    const c = s.catalog;
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    return h('div', { class: 'stack' },
      pageHead('Overview', `${today}. Where the workforce and the catalog stand right now.`,
        [h('a', { class: 'btn', href: '#/employees/new' }, 'Add employee'), h('a', { class: 'btn primary', href: '#/products/new' }, 'Add product')]),
      h('section', { class: 'panel', 'aria-label': 'Key figures' },
        h('div', { class: 'ledger' },
          h('div', { class: 'ledger-title' }, h('h2', null, 'Workforce'), h('a', { class: 'small', href: '#/employees' }, 'View people')),
          kpi('Headcount', num(p.headcount), `${num(p.active)} active (${pct(p.activePct)})`, '#/employees'),
          kpi('Annual payroll', money(p.annualPayroll, 'USD', true), 'Active employees'),
          kpi('Average salary', money(p.avgSalary, 'USD', true), `Across ${num(p.departments)} departments`),
          kpi('Hired in the last 12 months', num(p.hiresLast12Months), p.avgRating ? `Average rating ${rating(p.avgRating)}` : null)),
        h('div', { class: 'ledger' },
          h('div', { class: 'ledger-title' }, h('h2', null, 'Catalog'), h('a', { class: 'small', href: '#/products' }, 'View products')),
          kpi('Products', num(c.products), `${num(c.live)} on sale in ${num(c.categories)} categories`, '#/products'),
          kpi('Stock value', money(c.inventoryValueUsd, 'USD', true), 'Products on sale, in USD'),
          kpi('In stock', pct(c.inStockPct), `${num(c.lowStock)} running low`, '#/products?stockStatus=low'),
          kpi('Out of stock', num(c.outOfStock), `${num(c.discontinued)} discontinued`, '#/products?stockStatus=out'))),
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'People by department'), h('span', { class: 'small muted' }, 'Headcount')),
          h('div', { class: 'panel-body' }, barList(s.charts.headcountByDepartment, { hrefFor: (i) => `#/departments/${i.id}` }))),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Products by category'), h('span', { class: 'small muted' }, 'Count')),
          h('div', { class: 'panel-body' }, barList(s.charts.productsByCategory, { hrefFor: (i) => `#/categories/${i.id}` })))),
      h('div', { class: 'grid-3' },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Hires by year')),
          h('div', { class: 'panel-body' }, columnChart(s.charts.hiresByYear, { unit: ' hires' }))),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Average salary by level')),
          h('div', { class: 'panel-body' }, columnChart(s.charts.avgSalaryByLevel, { format: (v) => money(v, 'USD', true) }))),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Stock health')),
          h('div', { class: 'panel-body' }, h('div', { class: 'small muted' }, `${num(c.products)} products`), stockSplit(s.charts.stockStatus)))),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Recent changes'), h('span', { class: 'small muted' }, 'Includes changes made through the API')),
        h('div', { class: 'panel-body' }, s.recent.length ? h('ul', { class: 'recent' }, s.recent.map((r) => h('li', null,
          h('div', null, h('a', { href: `#/${r.resource}/${r.id}` }, r.label), h('div', { class: 'small muted' }, `${RES[r.resource].One} ${r.change}${r.detail ? ` · ${r.detail}` : ''}`)),
          h('div', { class: 'when', title: new Date(r.updatedAt).toLocaleString() }, ago(r.updatedAt))))) : h('p', { class: 'muted' }, 'No records yet.'))),
      h('p', { class: 'small muted' }, s.fxNote));
  }

  // ------------------------------------------------------------------ list page
  async function listPage(name, query) {
    const def = RES[name];
    const state = {
      q: query.get('q') || '', sort: query.get('sort') || def.defaultSort, page: Number(query.get('page')) || 1,
      filters: Object.fromEntries(def.filters().map((f) => [f.key, query.get(f.key) || ''])),
    };
    const params = new URLSearchParams({ sort: state.sort, page: String(state.page), size: '25' });
    if (state.q) params.set('q', state.q);
    for (const [k, v] of Object.entries(state.filters)) if (v) params.set(k, v);
    const data = await api('GET', `/app/records/${name}?${params}`);

    const go = (patch) => {
      const next = { ...state, ...patch, filters: { ...state.filters, ...(patch.filters || {}) } };
      const qs = new URLSearchParams();
      if (next.q) qs.set('q', next.q);
      if (next.sort && next.sort !== def.defaultSort) qs.set('sort', next.sort);
      if (next.page > 1) qs.set('page', String(next.page));
      for (const [k, v] of Object.entries(next.filters)) if (v) qs.set(k, v);
      location.hash = `#/${name}${qs.toString() ? `?${qs}` : ''}`;
    };

    let searchTimer = null;
    const search = h('input', { type: 'search', value: state.q, placeholder: `Search ${def.title.toLowerCase()}`, 'aria-label': `Search ${def.title.toLowerCase()}`,
      oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => go({ q: e.target.value.trim(), page: 1 }), 350); } });
    const filterEls = def.filters().map((f) => {
      const sel = h('select', { 'aria-label': f.label, onchange: (e) => go({ filters: { [f.key]: e.target.value }, page: 1 }) },
        f.options.map((o) => h('option', { value: o.value }, o.label)));
      sel.value = state.filters[f.key];
      return sel;
    });
    const anyFilter = state.q || Object.values(state.filters).some(Boolean);

    const sortKey = state.sort.replace(/^-/, '');
    const desc = state.sort.startsWith('-');
    const thead = h('thead', null, h('tr', null, def.columns.map((col) => {
      const active = sortKey === col.key;
      return h('th', { class: col.num ? 'num' : null, scope: 'col' },
        h('button', { type: 'button', class: 'sort', 'aria-sort': active ? (desc ? 'descending' : 'ascending') : null,
          onclick: () => go({ sort: active && !desc ? `-${col.key}` : col.key, page: 1 }) },
        col.label, active ? (desc ? ' ↓' : ' ↑') : ''));
    })));
    const tbody = h('tbody', null, data.items.map((r) => {
      const href = `#/${name}/${r.id}`;
      return h('tr', { onclick: (e) => { if (!e.target.closest('a')) location.hash = href; } },
        def.columns.map((col, i) => {
          const val = col.cell ? col.cell(r) : (r[col.key] ?? '—');
          return h('td', { class: col.num ? 'num' : null }, i === 0 ? h('a', { href, style: { color: 'inherit', textDecoration: 'none' } }, val) : val);
        }));
    }));

    const from = data.total ? (data.page - 1) * data.size + 1 : 0;
    const to = Math.min(data.total, data.page * data.size);
    return h('div', null,
      pageHead(def.title, def.intro, [h('a', { class: 'btn primary', href: `#/${name}/new` }, `Add ${def.one}`)]),
      h('section', { class: 'panel' },
        h('div', { class: 'toolbar' }, h('label', { class: 'search' }, h('span', { html: SEARCH_ICON }), search), filterEls,
          anyFilter ? h('button', { type: 'button', class: 'link', onclick: () => { location.hash = `#/${name}`; } }, 'Clear filters') : null),
        data.items.length
          ? h('div', { class: 'table-wrap' }, h('table', null, thead, tbody))
          : h('div', { class: 'empty' }, h('b', null, anyFilter ? `No ${def.title.toLowerCase()} match these filters` : `No ${def.title.toLowerCase()} yet`),
            anyFilter ? 'Try a different search, or clear the filters.' : h('a', { href: `#/${name}/new` }, `Add the first ${def.one}`)),
        h('div', { class: 'pager' },
          h('span', null, data.total ? `${num(from)}–${num(to)} of ${num(data.total)}` : '0 results'),
          h('div', { class: 'actions' },
            h('button', { type: 'button', disabled: data.page <= 1, onclick: () => go({ page: data.page - 1 }) }, 'Previous'),
            h('span', { style: { alignSelf: 'center' } }, `Page ${data.page} of ${data.pages}`),
            h('button', { type: 'button', disabled: data.page >= data.pages, onclick: () => go({ page: data.page + 1 }) }, 'Next')))));
  }

  // ------------------------------------------------------------------ record page
  function facts(pairs) {
    return h('dl', { class: 'facts' }, pairs.filter(Boolean).map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v))));
  }

  async function deleteRecord(name, rec) {
    const def = RES[name];
    const ok = await confirmDialog({
      title: `Delete ${def.label(rec)}?`,
      body: name === 'employees' ? 'Their direct reports will be left without a manager. This cannot be undone.' : 'This cannot be undone.',
      action: `Delete ${def.one}`,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/app/records/${name}/${rec.id}`);
      toast(`Deleted ${def.label(rec)}`);
      await loadLookups();
      location.hash = `#/${name}`;
    } catch (e) {
      toast(e.status === 409 ? `${e.message}. Move or delete them first.` : e.message, 'err');
    }
  }

  async function recordPage(name, id) {
    const def = RES[name];
    const { record: r, related } = await api('GET', `/app/records/${name}/${id}`);
    const head = (title, metaBits, avatarText) => h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: `#/${name}` }, def.title)),
        h('div', { class: 'record-head' }, avatarText ? h('div', { class: 'avatar lg', 'aria-hidden': 'true' }, avatarText) : null,
          h('div', null, h('h1', null, title), h('div', { class: 'meta' }, metaBits)))),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: `#/${name}/${r.id}/edit` }, 'Edit'),
        h('button', { type: 'button', class: 'danger', onclick: () => deleteRecord(name, r) }, 'Delete')));
    const stamp = h('div', { class: 'stamp' }, `Created ${day(r.createdAt)} · Last updated ${ago(r.updatedAt)} · Record #${r.id}`);

    if (name === 'employees') {
      const a = r.address || {};
      const where = [a.street, [a.city, a.region].filter(Boolean).join(', '), [a.postalCode, a.countryCode].filter(Boolean).join(' ')].filter(Boolean);
      return h('div', { class: 'stack' },
        head(r.fullName, [r.title || null, statusPill(r.isActive)], initials(r.fullName)),
        h('div', { class: 'grid-2' },
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Role')), h('div', { class: 'panel-body' }, facts([
            ['Department', r.department ? h('a', { href: `#/departments/${r.department.id}` }, r.department.name) : null],
            ['Manager', r.managerId ? h('a', { href: `#/employees/${r.managerId}` }, r.managerName || `#${r.managerId}`) : 'None'],
            ['Level', r.level], ['Employee number', r.employeeNumber],
            ['Annual salary', money(r.salary)], ['Performance rating', rating(r.performanceRating)],
            ['Hire date', day(r.hireDate)], ['Status', r.isActive ? 'Active' : 'Inactive'],
          ]), stamp)),
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Contact')), h('div', { class: 'panel-body' }, facts([
            ['Email', h('a', { href: `mailto:${r.email}` }, r.email)],
            ['Phone', (r.phoneNumbers || []).length ? h('div', null, r.phoneNumbers.map((p) => h('div', null, `${p.number} `, h('span', { class: 'muted small' }, p.type)))) : null],
            ['Address', where.length ? h('div', null, where.map((l) => h('div', null, l))) : null],
          ])))),
        h('div', { class: 'grid-2' },
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Skills and certifications')), h('div', { class: 'panel-body' },
            (r.skills || []).length ? h('div', null, r.skills.map((s) => h('span', { class: 'tag' }, s))) : h('p', { class: 'muted' }, 'No skills listed.'),
            (r.certifications || []).length ? h('ul', { class: 'list-plain', style: { marginTop: '10px' } }, r.certifications.map((c) => h('li', null, h('span', null, c.name),
              h('span', { class: 'small muted' }, c.expiresAt ? `Expires ${day(c.expiresAt)}` : `Issued ${day(c.issuedAt)}`)))) : null)),
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Direct reports'), h('span', { class: 'small muted' }, num(related.directReports.length))), h('div', { class: 'panel-body' },
            related.directReports.length ? h('ul', { class: 'list-plain' }, related.directReports.map((e) => h('li', null,
              h('a', { href: `#/employees/${e.id}` }, e.name), h('span', { class: 'small muted' }, e.title || '')))) : h('p', { class: 'muted' }, 'Nobody reports to this person.')))));
    }

    if (name === 'products') {
      const d = r.dimensions || {};
      return h('div', { class: 'stack' },
        head(r.name, [r.sku, stockPill(r.stockStatus)]),
        h('div', { class: 'grid-2' },
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Details')), h('div', { class: 'panel-body' },
            r.description ? h('p', { style: { marginTop: 0 } }, r.description) : null,
            facts([
              ['Category', r.category ? h('a', { href: `#/categories/${r.category.id}` }, r.category.name) : null],
              ['Released', day(r.releaseDate)],
              ['Weight', r.weightKg ? `${r.weightKg} kg` : null],
              ['Dimensions', d.l ? `${d.l} × ${d.w} × ${d.h} ${d.unit || ''}` : null],
              ['Customer rating', rating(r.rating)],
              ['Discontinued', r.discontinuedAt ? day(r.discontinuedAt) : 'No'],
            ]),
            (r.tags || []).length ? h('div', { style: { marginTop: '12px' } }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null, stamp)),
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Price and stock')), h('div', { class: 'panel-body' },
            facts([
              ['Price', money(r.price, r.currency)], ['Price in USD', r.currency === 'USD' ? null : money(r.priceUsd)],
              ['Units in stock', num(r.stockQty)], ['Available to order', r.inStock ? 'Yes' : 'No'],
              ['Stock value', money((r.price || 0) * (r.stockQty || 0), r.currency)],
            ]),
            (r.variants || []).length ? h('div', { style: { marginTop: '14px' } }, h('h3', null, 'Variants'),
              h('ul', { class: 'list-plain' }, r.variants.map((v) => h('li', null, h('span', null, [v.color, v.size].filter(Boolean).join(' · ') || v.sku, ' ', h('span', { class: 'small muted' }, v.sku)),
                h('span', { class: 'small' }, v.priceDelta ? `${v.priceDelta > 0 ? '+' : ''}${money(v.priceDelta, r.currency)}` : 'Same price'))))) : null))));
    }

    // departments, categories
    const isDept = name === 'departments';
    const items = isDept ? related.employees : related.products;
    return h('div', { class: 'stack' },
      head(r.name, [h('span', { class: 'tag' }, r.code)]),
      h('section', { class: 'panel' }, h('div', { class: 'ledger' },
        h('div', { class: 'ledger-title' }, h('h2', null, 'At a glance')),
        ...(isDept ? [
          kpi('People', num(r.employeeCount), null, `#/employees?departmentId=${r.id}`),
          kpi('Active', num(r.activeCount), r.employeeCount ? pct((r.activeCount / r.employeeCount) * 100) : null),
          kpi('Average salary', money(r.avgSalary, 'USD', true), 'Active employees'),
          kpi('Created', day(r.createdAt), `Updated ${ago(r.updatedAt)}`),
        ] : [
          kpi('Products', num(r.productCount), null, `#/products?categoryId=${r.id}`),
          kpi('Units in stock', num(r.stockUnits)),
          kpi('Stock value', money(r.inventoryValueUsd, 'USD', true), 'In USD'),
          kpi('Created', day(r.createdAt), `Updated ${ago(r.updatedAt)}`),
        ]))),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, isDept ? 'People in this department' : 'Products in this category'),
          h('a', { class: 'small', href: isDept ? `#/employees/new?departmentId=${r.id}` : `#/products/new?categoryId=${r.id}` }, isDept ? 'Add employee' : 'Add product')),
        h('div', { class: 'panel-body' }, items.length ? h('ul', { class: 'list-plain' }, items.map((x) => h('li', null,
          h('span', null, h('a', { href: `#/${isDept ? 'employees' : 'products'}/${x.id}` }, x.name), ' ', h('span', { class: 'small muted' }, isDept ? (x.title || '') : x.sku)),
          isDept ? statusPill(x.isActive) : stockPill(x.stockStatus)))) : h('p', { class: 'muted' }, isDept ? 'No one is in this department yet.' : 'No products in this category yet.'))));
  }

  // ------------------------------------------------------------------ create / edit form
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {}; cur = cur[k]; });
    cur[keys[keys.length - 1]] = value;
  }

  function inputFor(f, value) {
    const id = `f-${f.key.replace(/\./g, '-')}`;
    let el;
    if (f.type === 'select') {
      el = h('select', { id, name: f.key, required: f.required }, f.options.map((o) => h('option', { value: o.value }, o.label)));
      el.value = value === null || value === undefined ? '' : String(value);
      if (el.value === '' && !f.options.some((o) => o.value === '') && f.options[0]) el.value = String(f.options[0].value);
    } else if (f.type === 'textarea') {
      el = h('textarea', { id, name: f.key, rows: 4 });
      el.value = value || '';
    } else if (f.type === 'checkbox') {
      el = h('input', { id, name: f.key, type: 'checkbox' });
      el.checked = !!value;
    } else if (f.type === 'list') {
      el = h('input', { id, name: f.key, type: 'text' });
      el.value = Array.isArray(value) ? value.join(', ') : '';
    } else {
      el = h('input', { id, name: f.key, type: f.type || 'text', required: f.required, step: f.step, min: f.min, max: f.max });
      const v = f.timestamp && value ? String(value).slice(0, 10) : value;
      el.value = v === null || v === undefined ? '' : String(v);
    }
    if (f.upper) el.addEventListener('input', () => { const p = el.selectionStart; el.value = el.value.toUpperCase(); el.setSelectionRange?.(p, p); });
    return el;
  }

  function readValue(f, el) {
    if (f.type === 'checkbox') return el.checked;
    if (f.type === 'list') return el.value.split(',').map((s) => s.trim()).filter(Boolean);
    const raw = el.value.trim();
    if (raw === '') return f.nullable ? null : undefined;
    if (f.timestamp) return `${raw}T00:00:00.000Z`;
    if (f.type === 'number' || f.int) return f.int ? parseInt(raw, 10) : Number(raw);
    return raw;
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  async function formPage(name, id) {
    const def = RES[name];
    await loadLookups();
    const fields = def.form();
    let rec = null;
    if (id) rec = (await api('GET', `/app/records/${name}/${id}`)).record;
    const preset = new URLSearchParams(location.hash.split('?')[1] || '');
    const defaults = { isActive: true, inStock: true, level: 'L1', currency: 'USD', stockQty: 0, hireDate: new Date().toISOString().slice(0, 10) };

    const controls = new Map();
    const formEl = h('div', { class: 'form panel-body' });
    for (const f of fields) {
      if (f.section) { formEl.append(h('div', { class: 'form-section' }, h('h3', null, f.section))); continue; }
      const start = rec ? getPath(rec, f.key) : (preset.get(f.key) ?? defaults[f.key]);
      const el = inputFor(f, start);
      const err = h('span', { class: 'err', hidden: true, id: `${el.id}-err` });
      el.setAttribute('aria-describedby', `${el.id}-err`);
      const wrap = h('label', { class: `field${f.type === 'checkbox' ? ' check' : ''}${f.full || f.type === 'textarea' ? ' full' : ''}`, for: el.id },
        h('span', null, f.label, f.required ? h('em', { 'aria-hidden': 'true' }, '*') : null), el, f.hint && f.type !== 'checkbox' ? h('span', { class: 'hint' }, f.hint) : null, err);
      controls.set(f.key, { f, el, wrap, err, start: rec ? getPath(rec, f.key) : undefined });
      formEl.append(wrap);
    }
    const formErr = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'primary' }, id ? 'Save changes' : `Add ${def.one}`);

    const clearErrors = () => { formErr.hidden = true; for (const c of controls.values()) { c.wrap.classList.remove('invalid'); c.err.hidden = true; } };
    const showErrors = (e) => {
      const list = e.body?.errors || [];
      let placed = 0;
      for (const x of list) {
        const field = String(x.field || '').replace(/^body\./, '');
        const c = controls.get(field) || [...controls.values()].find((cc) => field.startsWith(`${cc.f.key}.`) || field.startsWith(`${cc.f.key}[`));
        if (c) {
          c.wrap.classList.add('invalid');
          c.err.textContent = x.message.charAt(0).toUpperCase() + x.message.slice(1);
          c.err.hidden = false;
          placed += 1;
        }
      }
      const unplaced = list.filter((x) => !controls.has(String(x.field || '')) && ![...controls.keys()].some((k) => String(x.field || '').startsWith(`${k}.`)));
      formErr.textContent = placed ? `Fix the highlighted ${placed === 1 ? 'field' : 'fields'} and try again.${unplaced.length ? ` ${unplaced.map((u) => `${u.field}: ${u.message}`).join('; ')}` : ''}` : e.message;
      formErr.hidden = false;
      (mainEl.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea') || formErr).focus?.();
    };

    const submit = async (ev) => {
      ev.preventDefault();
      clearErrors();
      const body = {};
      for (const { f, el, start } of controls.values()) {
        const v = readValue(f, el);
        const was = f.timestamp && start ? `${String(start).slice(0, 10)}T00:00:00.000Z` : start;
        if (id) { if (!same(v === undefined ? null : v, was === undefined ? null : was)) setPath(body, f.key, v === undefined ? null : v); }
        else if (v !== undefined && !(f.nullable && v === null) && !(Array.isArray(v) && !v.length)) setPath(body, f.key, v);
      }
      if (id && !Object.keys(body).length) { toast('No changes to save'); location.hash = `#/${name}/${id}`; return; }
      saveBtn.disabled = true;
      try {
        const out = id ? await api('PATCH', `/app/records/${name}/${id}`, body) : await api('POST', `/app/records/${name}`, body);
        toast(id ? `Saved ${def.label(out)}` : `Added ${def.label(out)}`);
        await loadLookups();
        location.hash = `#/${name}/${out.id}`;
      } catch (e) {
        if (e.status !== 401) showErrors(e);
      } finally { saveBtn.disabled = false; }
    };

    const cancelHref = id ? `#/${name}/${id}` : `#/${name}`;
    return h('div', null,
      pageHead(id ? `Edit ${def.label(rec)}` : `Add ${def.one}`, id ? null : `Fields marked * are required.`, null,
        h('span', null, h('a', { href: `#/${name}` }, def.title), id ? [' / ', h('a', { href: cancelHref }, def.label(rec))] : null)),
      h('form', { class: 'panel', onsubmit: submit, novalidate: true },
        formErr,
        formEl,
        h('div', { class: 'form-foot' }, h('a', { class: 'btn', href: cancelHref }, 'Cancel'), saveBtn)));
  }

  // ------------------------------------------------------------------ start
  async function start() {
    try {
      SESSION = await api('GET', '/session');
    } catch { SESSION = { authenticated: false, passwordRequired: true }; }
    if (!SESSION.authenticated) { showLogin(); return; }
    try { await loadLookups(); } catch { /* shown on first page load */ }
    renderShell();
    route();
  }

  window.addEventListener('hashchange', route);
  start();
})();
