/* API Test Tool dashboard — vanilla JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'html') el.innerHTML = v; // only used with trusted static strings
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind) {
    const t = h('div', { class: `toast ${kind || ''}`, role: 'status' }, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); } catch { toast('Copy failed — select and copy manually', 'err'); }
  }

  const fmtBytes = (n) => (n === null || n === undefined ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } };
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
  const pretty = (v) => { if (typeof v !== 'string') return JSON.stringify(v, null, 2); try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } };
  const statusClass = (s) => (s ? `status s${String(s)[0]}` : 'status');
  const method = (m) => h('span', { class: `method ${String(m).toLowerCase()}` }, String(m).toUpperCase());

  class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }

  async function api(methodName, path, body, { raw = false, headers = {} } = {}) {
    const opts = { method: methodName, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body !== undefined) opts.body = body;
    const res = await fetch(`/admin/api${path}`, opts);
    if (res.status === 401 && path !== '/login') { showLogin(); throw new ApiError('Login required', 401); }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.detail || data.error || data.message)) || `HTTP ${res.status}`;
      const extra = data && Array.isArray(data.errors) ? `: ${data.errors.map((e) => `${e.field} ${e.message}`).join('; ')}` : '';
      throw new ApiError(msg + extra, res.status, data);
    }
    return data;
  }

  function guard(fn) {
    return async (...args) => {
      try { return await fn(...args); } catch (e) { if (e.status !== 401) toast(e.message, 'err'); return undefined; }
    };
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('div', { class: 'small muted' }, hint) : null);
  }

  function tabs(items, onSelect, initial) {
    const bar = h('div', { class: 'tabs', role: 'tablist' });
    let current = initial || items[0].id;
    const render = () => {
      clear(bar);
      for (const it of items) {
        bar.appendChild(h('button', { class: it.id === current ? 'active' : '', role: 'tab', onclick: () => { current = it.id; render(); onSelect(it.id); } }, it.label));
      }
    };
    render();
    return bar;
  }

  function codeBlock(text, { maxHeight } = {}) {
    const pre = h('pre', maxHeight ? { style: { maxHeight } } : null, text);
    return pre;
  }

  function kv(obj) {
    const el = h('div', { class: 'kv' });
    for (const [k, v] of Object.entries(obj || {})) el.append(h('div', null, k), h('div', null, typeof v === 'object' ? JSON.stringify(v) : String(v)));
    return el;
  }

  // ---------------------------------------------------------------- theme
  function setTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { if (t) localStorage.setItem('att-theme', t); else localStorage.removeItem('att-theme'); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- shell & routing
  const PAGES = [
    ['overview', 'Overview'], ['settings', 'Settings'], ['data', 'Data'], ['inspector', 'Inspector'], ['files', 'Files'],
    ['auth', 'Auth'], ['chaos', 'Chaos'], ['headers', 'Headers'], ['openapi', 'OpenAPI'], ['tester', 'API Tester'],
    ['help', 'About & Help'],
  ];
  // One-line purpose of each page; shown in the Help guide and as the tooltip of each page's help link.
  const PAGE_HELP = {
    overview: { purpose: 'Your starting point: the URLs to give integrations, current auth mode, health, data counts and copy-ready curl commands.' },
    settings: { purpose: 'Every setting in one place. Environment variables set defaults; changes here override them and survive restarts. Badges show where each value comes from.' },
    data: { purpose: 'The seeded mock data (employees, products, departments, categories): counts, a preview, re-seed with different sizes, or clear it.' },
    inspector: { purpose: 'A webhook catcher. Anything sent to this server on a non-reserved path shows up here live, with headers, auth, body and the response that was returned.' },
    files: { purpose: 'The shared file pool used by every file protocol (multipart, raw, base64, tus, presigned, range, chunked). Upload, download, delete or regenerate samples.' },
    auth: { purpose: 'Choose how /v1 calls must authenticate (none, API key, Basic, Bearer, JWT, OAuth2, HMAC), see the credentials, manage OAuth clients and get test tokens.' },
    chaos: { purpose: 'Make the mock API misbehave on purpose: random errors, latency, timeouts, broken JSON and rate limits, globally or per route, so you can test client error handling.' },
    headers: { purpose: 'Headers added to every response, and headers every /v1 request must carry (missing ones return 400).' },
    openapi: { purpose: 'The OpenAPI 3.1 description of the mock API, regenerated live from the current settings. Import it into Fusion, Postman or any client.' },
    tester: { purpose: 'Test an API you built: load its OpenAPI spec, call your implementation, and check every response against the spec.' },
    help: { purpose: 'What this tool does and how to use each page.' },
  };
  let currentPage = 'overview';
  let cleanup = null;
  let navEl;
  let mainEl;

  function shell() {
    const root = clear($('#app'));
    navEl = h('nav', { class: 'nav', 'aria-label': 'Main' },
      h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'API Test Tool'),
      PAGES.map(([id, label]) => h('a', { href: `#/${id}`, dataset: { page: id } }, label, id === 'inspector' ? h('span', { class: 'live-dot', id: 'nav-live' }) : null)),
      h('div', { class: 'foot' },
        h('select', { 'aria-label': 'Theme', onchange: (e) => setTheme(e.target.value) },
          h('option', { value: '' }, 'Theme: system'), h('option', { value: 'light' }, 'Theme: light'), h('option', { value: 'dark' }, 'Theme: dark')),
        h('a', { href: '/docs', target: '_blank', rel: 'noopener' }, 'Swagger UI ↗'),
        h('button', { class: 'small', id: 'logout-btn', onclick: guard(async () => { await api('POST', '/logout'); location.reload(); }) }, 'Log out')));
    const sel = navEl.querySelector('select');
    sel.value = document.documentElement.dataset.theme || '';
    mainEl = h('main', { class: 'main' });
    root.append(h('div', { class: 'shell' }, navEl, mainEl));
    navEl.addEventListener('click', (e) => { if (e.target.closest('a[data-page]')) navEl.classList.remove('open'); });
  }

  function header(title, sub, ...actions) {
    return h('div', { class: 'topbar' },
      h('div', { class: 'row' }, h('button', { class: 'menu-btn small', onclick: () => navEl.classList.toggle('open'), 'aria-label': 'Menu' }, '☰'),
        h('div', null, h('h1', null, title), sub ? h('div', { class: 'muted' }, sub) : null)),
      h('div', { class: 'row' }, actions,
        currentPage !== 'help' ? h('a', { class: 'btn help-link', href: `#/help/${currentPage}`, title: PAGE_HELP[currentPage]?.purpose || 'Help' }, '? Help') : null));
  }

  async function route() {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
    const page = parts[0];
    currentPage = VIEWS[page] ? page : 'overview';
    for (const a of navEl.querySelectorAll('a[data-page]')) a.classList.toggle('active', a.dataset.page === currentPage);
    clear(mainEl);
    const fn = VIEWS[page] || VIEWS.overview;
    try {
      cleanup = (await fn(mainEl, parts.slice(1))) || null;
    } catch (e) {
      if (e.status !== 401) mainEl.append(h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('pre', null, e.message)));
    }
  }

  // ---------------------------------------------------------------- login
  function showLogin() {
    const root = clear($('#app'));
    const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const err = h('div', { class: 'small', style: { color: 'var(--err)' } });
    const submit = async (e) => {
      e.preventDefault();
      const r = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
      if (r.ok) location.reload(); else err.textContent = 'Invalid password';
    };
    root.append(h('form', { class: 'card login', onsubmit: submit },
      h('h1', null, 'API Test Tool'), h('p', { class: 'muted' }, 'Enter the admin password (ADMIN_PASSWORD).'),
      field('Password', pw), err, h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'primary', type: 'submit' }, 'Sign in'))));
    pw.focus();
  }

  // ---------------------------------------------------------------- settings cache
  let SETTINGS = null;
  async function loadSettings() { SETTINGS = (await api('GET', '/settings')).settings; return SETTINGS; }
  const sval = (key) => SETTINGS.find((s) => s.key === key)?.value;

  function settingInput(s) {
    let input;
    const disabled = s.restartRequired;
    if (s.type === 'bool') input = h('input', { type: 'checkbox', checked: !!s.value, disabled });
    else if (s.type === 'enum') { input = h('select', { disabled }, s.options.map((o) => h('option', { value: o }, o))); input.value = s.value; }
    else if (s.type === 'int' || s.type === 'number') input = h('input', { type: 'number', value: s.value, step: s.type === 'int' ? '1' : 'any', disabled });
    else if (s.type === 'json' || s.type === 'headerList' || s.type === 'requiredHeaders') input = h('textarea', { rows: 4, disabled }, JSON.stringify(s.value, null, 2));
    else input = h('input', { type: s.secret ? 'password' : 'text', value: s.value ?? '', disabled, autocomplete: 'off' });
    input.dataset.key = s.key;
    input.dataset.type = s.type;
    return input;
  }

  function readInput(input) {
    const t = input.dataset.type;
    if (t === 'bool') return input.checked;
    if (t === 'json' || t === 'headerList' || t === 'requiredHeaders') {
      try { return JSON.parse(input.value || (t === 'json' ? 'null' : '[]')); } catch { throw new Error(`${input.dataset.key}: invalid JSON`); }
    }
    return input.value;
  }

  function settingsForm(keys, { onSaved } = {}) {
    const wrap = h('div', { class: 'stack' });
    const inputs = [];
    for (const key of keys) {
      const s = SETTINGS.find((x) => x.key === key);
      if (!s) continue;
      const input = settingInput(s);
      inputs.push(input);
      const label = h('div', { class: 'row between' }, h('span', { class: 'mono small' }, `${s.key}`),
        h('span', { class: 'row' }, h('span', { class: `badge ${s.source}`, title: `Value source: ${s.source}` }, s.source),
          s.restartRequired ? h('span', { class: 'badge', title: 'Set via environment and restart' }, `env: ${s.env}`) : h('span', { class: 'muted small mono' }, s.env),
          s.source === 'override' ? h('button', { class: 'small', title: 'Reset to env default', onclick: guard(async () => { await api('POST', '/settings/reset', { key: s.key }); await loadSettings(); toast(`${s.key} reset`, 'ok'); if (onSaved) onSaved(); }) }, 'reset') : null));
      wrap.append(h('div', null, label, s.type === 'bool' ? h('label', { class: 'check' }, input, h('span', null, s.description || 'enabled')) : input,
        s.description && s.type !== 'bool' ? h('div', { class: 'small muted' }, s.description) : null));
    }
    const save = h('button', { class: 'primary', onclick: guard(async () => {
      const body = {};
      for (const i of inputs) if (!i.disabled) body[i.dataset.key] = readInput(i);
      await api('PUT', '/settings', body);
      await loadSettings();
      toast('Saved', 'ok');
      if (onSaved) onSaved();
    }) }, 'Save');
    wrap.append(h('div', { class: 'row' }, save));
    return wrap;
  }

  // ---------------------------------------------------------------- views
  const VIEWS = {};

  VIEWS.overview = async (el) => {
    const o = await api('GET', '/overview');
    const health = await fetch('/health').then((r) => r.json()).catch(() => null);
    el.append(header('Overview', o.baseUrl, h('a', { class: 'btn', href: '/docs', target: '_blank', rel: 'noopener' }, 'API docs ↗')));
    for (const w of o.warnings) el.append(h('div', { class: 'card', style: { borderLeft: '4px solid var(--warn)' } }, w));
    let dismissed = false;
    try { dismissed = localStorage.getItem('att-welcome-dismissed') === '1'; } catch { /* storage unavailable */ }
    if (!dismissed) {
      const welcome = h('div', { class: 'card welcome' },
        h('div', { class: 'row between' }, h('b', null, 'New here?'),
          h('button', { class: 'small', onclick: () => { try { localStorage.setItem('att-welcome-dismissed', '1'); } catch { /* ignore */ } welcome.remove(); } }, 'Dismiss')),
        h('p', { style: { margin: '6px 0 10px' } }, 'This tool does two jobs: it is a realistic API for your integrations to call (outgoing testing), and it checks an API you built against its OpenAPI spec (incoming testing).'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/help' }, 'Read the guide'),
          h('a', { class: 'btn', href: '#/help/quick-outgoing' }, 'Quick start: outgoing'), h('a', { class: 'btn', href: '#/help/quick-incoming' }, 'Quick start: incoming')));
      el.append(welcome);
    }
    el.append(h('div', { class: 'grid cols-4' },
      h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Auth mode'), h('b', null, o.authMode)),
      h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Date format'), h('b', null, o.dateFormat)),
      h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Chaos'), h('b', null, `${o.chaos.errorRate}%`), h('span', { class: 'small muted' }, `${o.chaos.errorTypes} · ${o.chaos.latency.join('-')} ms`)),
      h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Health'), h('b', { style: { color: health?.status === 'ok' ? 'var(--ok)' : 'var(--err)' } }, health?.status || 'unknown'), h('span', { class: 'small muted' }, `db ${o.storage.db} · files ${o.storage.files}`))));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', null, 'Endpoints'),
        h('table', null, h('tbody', null, Object.entries(o.urls).map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, v)), h('td', null, h('button', { class: 'small', onclick: () => copy(v) }, 'copy'))))))),
      h('div', { class: 'card' }, h('h2', null, 'Data'),
        kv({ ...o.counts, files: o.files, 'inspector captures': o.inspector, 'last seed': o.lastSeed ? `${fmtDate(o.lastSeed.at)} (seed ${o.lastSeed.seed})` : 'never' }))));
    el.append(h('div', { class: 'card' }, h('h2', null, 'Quick curls'), o.curls.map((c) => h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'nowrap' } }, h('pre', { style: { flex: '1' } }, c), h('button', { class: 'small', onclick: () => copy(c) }, 'copy')))));
  };

  VIEWS.settings = async (el) => {
    await loadSettings();
    const data = await api('GET', '/settings');
    el.append(header('Settings', 'Env sets defaults; dashboard changes override them and persist in the database.',
      h('button', { class: 'danger', onclick: guard(async () => { if (!confirm('Reset ALL dashboard overrides to env defaults?')) return; await api('POST', '/settings/reset', {}); toast('All overrides cleared', 'ok'); route(); }) }, 'Reset all to env defaults')));
    for (const section of data.sections) {
      const keys = SETTINGS.filter((s) => s.section === section).map((s) => s.key);
      const overrides = SETTINGS.filter((s) => s.section === section && s.source === 'override').length;
      el.append(h('details', { class: 'card', open: section === 'auth' || section === 'dates' ? true : null },
        h('summary', null, h('b', null, section), ' ', overrides ? h('span', { class: 'badge override' }, `${overrides} override${overrides > 1 ? 's' : ''}`) : null),
        h('div', { style: { marginTop: '12px' } }, settingsForm(keys, { onSaved: route }),
          h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'small', onclick: guard(async () => { await api('POST', '/settings/reset', { section }); toast(`${section} reset`, 'ok'); route(); }) }, `Reset "${section}" to env defaults`)))));
    }
  };

  VIEWS.data = async (el) => {
    await loadSettings();
    const counts = await api('GET', '/data/counts');
    const emp = h('input', { type: 'number', value: sval('seedEmployees'), min: 0 });
    const prod = h('input', { type: 'number', value: sval('seedProducts'), min: 0 });
    const seed = h('input', { type: 'number', value: sval('seedRandomSeed') });
    const files = h('input', { type: 'checkbox', checked: sval('seedSampleFiles') });
    const preview = h('pre', { style: { maxHeight: '480px' } }, 'Choose a resource to preview.');
    const which = h('select', { onchange: guard(async () => { preview.textContent = pretty(await api('GET', `/data/preview/${which.value}?limit=3`)); }) },
      ['employees', 'products', 'departments', 'categories'].map((n) => h('option', { value: n }, n)));
    el.append(header('Data', 'Deterministic Faker data with relational integrity.'));
    el.append(h('div', { class: 'grid cols-4' }, Object.entries(counts).map(([k, v]) => h('div', { class: 'card stat' }, h('span', { class: 'muted' }, k), h('b', null, v)))));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card stack' }, h('h2', null, 'Reset & re-seed'),
        h('div', { class: 'grid cols-3' }, field('Employees', emp), field('Products', prod), field('Random seed', seed)),
        h('label', { class: 'check' }, files, 'Regenerate sample files'),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: guard(async (e) => {
            e.target.disabled = true;
            try {
              const r = await api('POST', '/data/seed', { employees: emp.value, products: prod.value, seed: seed.value, sampleFiles: files.checked });
              toast(`Seeded ${r.employees} employees, ${r.products} products${r.sampleFiles ? `, ${r.sampleFiles} files` : ''}`, 'ok');
              route();
            } finally { e.target.disabled = false; }
          }) }, 'Reset & re-seed'),
          h('button', { class: 'danger', onclick: guard(async () => { if (!confirm('Delete all employees, products, departments and categories?')) return; await api('POST', '/data/clear'); toast('Cleared', 'ok'); route(); }) }, 'Clear all data'))),
      h('div', { class: 'card stack' }, h('h2', null, 'Preview'), field('Resource', which), preview)));
    which.dispatchEvent(new Event('change'));
  };

  // ---------------------------------------------------------------- inspector
  VIEWS.inspector = async (el, params) => {
    await loadSettings();
    let items = await api('GET', '/inspector?limit=500');
    let selected = params[0] || null;
    const listEl = h('div', { class: 'list' });
    const detailEl = h('div');
    const filterText = h('input', { type: 'text', placeholder: 'Filter path, header, body…', 'aria-label': 'Filter' });
    const filterMethod = h('select', { 'aria-label': 'Method' }, ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => h('option', { value: m }, m || 'All methods')));
    const live = h('span', { class: 'live-dot' });
    const count = h('span', { class: 'muted small' });

    const matches = (it) => {
      if (filterMethod.value && it.method !== filterMethod.value) return false;
      const q = filterText.value.trim().toLowerCase();
      if (!q) return true;
      return JSON.stringify(it).toLowerCase().includes(q);
    };
    const renderList = () => {
      clear(listEl);
      const shown = items.filter(matches);
      count.textContent = `${shown.length} of ${items.length}`;
      if (!shown.length) listEl.append(h('div', { class: 'empty' }, items.length ? 'No captures match the filter.' : 'No requests captured yet. Send anything to this base URL (other than /v1, /oauth, /admin, /dashboard, /docs, /openapi.*, /health).'));
      for (const it of shown) {
        listEl.append(h('div', { class: `list-item ${it.id === selected ? 'active' : ''}`, onclick: () => { selected = it.id; history.replaceState(null, '', `#/inspector/${it.id}`); renderList(); showDetail(it.id); } },
          method(it.method),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'path', title: it.path }, it.path + (it.query && Object.keys(it.query).length ? `?${new URLSearchParams(it.query)}` : '')),
            h('div', { class: 'small muted' }, `${fmtTime(it.ts)} · ${it.ip || ''} · ${fmtBytes(it.size)}${it.kind === 'v1' ? ' · /v1' : ''}${it.rule ? ` · ${it.rule}` : ''}`)),
          h('span', { class: statusClass(it.status) }, it.status ?? '…')));
      }
    };
    const showBody = (b, title) => {
      if (!b || b.kind === 'empty') return h('div', { class: 'muted small' }, `${title}: empty`);
      const parts = [h('div', { class: 'row between' }, h('b', null, `${title} · ${b.kind} · ${fmtBytes(b.size)}${b.truncated ? ' (truncated)' : ''}`))];
      if (b.kind === 'multipart' && b.multipart) {
        parts.push(h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Type'), h('th', null, 'Value / file'))),
          h('tbody', null, (b.multipart.parts || []).map((p, i) => h('tr', null, h('td', { class: 'mono' }, p.name), h('td', null, p.contentType || p.type),
            h('td', null, p.type === 'file' ? h('span', null, `${p.filename} (${fmtBytes(p.size)}) `, p.base64 ? h('a', { href: `/admin/api/inspector/${selected}/parts/${i}` }, 'download') : '(too large to keep)') : h('code', null, p.value)))))));
      } else if (b.kind === 'binary') {
        parts.push(h('pre', null, b.hex), h('a', { href: `/admin/api/inspector/${selected}/body` }, 'Download body'));
      } else if (b.kind === 'form') {
        parts.push(kv(b.fields));
      } else parts.push(codeBlock(b.pretty || b.text || ''));
      return h('div', { class: 'stack' }, parts);
    };
    const showDetail = guard(async (id) => {
      clear(detailEl);
      if (!id) { detailEl.append(h('div', { class: 'card empty' }, 'Select a request to see its details.')); return; }
      const e = await api('GET', `/inspector/${encodeURIComponent(id)}`);
      const pane = h('div');
      const replayTarget = h('input', { type: 'url', placeholder: 'Target base URL (blank = this server)' });
      const replayOut = h('div');
      const views = {
        request: () => h('div', { class: 'stack' },
          h('div', { class: 'kv' }, h('div', null, 'URL'), h('div', null, e.url), h('div', null, 'Client IP'), h('div', null, `${e.ip}${e.ips?.length ? ` (via ${e.ips.join(', ')})` : ''}`), h('div', null, 'HTTP'), h('div', null, e.httpVersion), h('div', null, 'Request id'), h('div', null, e.requestId || '')),
          e.query && Object.keys(e.query).length ? h('div', null, h('h3', null, 'Query'), kv(e.query)) : null,
          h('h3', null, 'Headers'), kv(e.headers),
          showBody(e.body, 'Body')),
        auth: () => (e.auth ? codeBlock(pretty(e.auth)) : h('div', { class: 'muted' }, 'No credentials detected.')),
        response: () => (e.response ? h('div', { class: 'stack' }, h('div', null, 'Status ', h('b', { class: statusClass(e.response.status) }, e.response.status), e.response.rule ? h('span', { class: 'badge' }, e.response.rule) : null, ` · ${e.durationMs ?? '?'} ms`),
          h('h3', null, 'Headers'), kv(e.response.headers), showBody(e.response.body, 'Body'),
          e.forward ? h('div', null, h('h3', null, 'Forwarded'), codeBlock(pretty({ url: e.forward.url, status: e.forward.status, error: e.forward.error, durationMs: e.forward.durationMs }))) : null) : h('div', { class: 'muted' }, 'Pending…')),
        curl: () => h('div', { class: 'stack' }, codeBlock(e.curl), h('button', { onclick: () => copy(e.curl) }, 'Copy curl')),
        replay: () => h('div', { class: 'stack' }, field('Replay to', replayTarget, 'Leave blank to replay against this server (same path). A full URL with a path replaces the path.'),
          h('button', { class: 'primary', onclick: guard(async () => {
            clear(replayOut).append(h('div', { class: 'muted' }, 'Sending…'));
            const r = await api('POST', `/inspector/${encodeURIComponent(e.id)}/replay`, { targetUrl: replayTarget.value || undefined });
            clear(replayOut).append(r.error ? h('div', { style: { color: 'var(--err)' } }, `${r.url}: ${r.error}`) : h('div', { class: 'stack' }, h('div', null, `${r.url} → `, h('b', { class: statusClass(r.status) }, r.status), ` in ${r.durationMs} ms`), kv(r.headers), showBody(r.body, 'Response body')));
          }) }, 'Replay'), replayOut),
      };
      const draw = (k) => { clear(pane).append(views[k]()); };
      detailEl.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'row' }, method(e.method), h('code', null, e.path)), h('span', { class: 'muted small' }, fmtDate(e.ts))),
        h('div', { style: { marginTop: '10px' } }, tabs([{ id: 'request', label: 'Request' }, { id: 'auth', label: 'Auth' }, { id: 'response', label: 'Response' }, { id: 'curl', label: 'curl' }, { id: 'replay', label: 'Replay' }], draw)),
        pane));
      draw('request');
    });

    // live stream
    const es = new EventSource('/admin/api/inspector/stream');
    es.onopen = () => { live.classList.add('on'); $('#nav-live')?.classList.add('on'); };
    es.onerror = () => { live.classList.remove('on'); $('#nav-live')?.classList.remove('on'); };
    es.addEventListener('request', (ev) => { const it = JSON.parse(ev.data); items.unshift(it); items = items.slice(0, sval('inspectorRetention') || 500); renderList(); });
    es.addEventListener('update', (ev) => {
      const it = JSON.parse(ev.data);
      const i = items.findIndex((x) => x.id === it.id);
      if (i >= 0) items[i] = it; else items.unshift(it);
      renderList();
      if (it.id === selected) showDetail(selected);
    });
    es.addEventListener('clear', () => { items = []; selected = null; renderList(); showDetail(null); });

    filterText.addEventListener('input', renderList);
    filterMethod.addEventListener('change', renderList);

    const fwdEnabled = h('input', { type: 'checkbox', checked: sval('inspectorForwardEnabled') });
    const fwdUrl = h('input', { type: 'url', value: sval('inspectorForwardUrl') || '', placeholder: 'https://example.com/webhooks' });

    el.append(header('Inspector', 'Every request to a non-reserved path is captured with its actual path.',
      live, count,
      h('a', { class: 'btn', href: '/admin/api/inspector/export' }, 'Export JSON'),
      h('button', { class: 'danger', onclick: guard(async () => { if (!confirm('Clear all captured requests?')) return; await api('DELETE', '/inspector'); }) }, 'Clear')));
    el.append(h('div', { class: 'card' }, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, filterMethod, filterText),
      h('details', { style: { marginTop: '10px' } }, h('summary', null, 'Default response, rules & forwarding'),
        h('div', { class: 'grid cols-2', style: { marginTop: '10px' } },
          h('div', null, h('h3', null, 'Default response'), settingsForm(['inspectorResponseStatus', 'inspectorResponseContentType', 'inspectorResponseBody', 'inspectorResponseHeaders', 'inspectorResponseDelayMs'])),
          h('div', null, h('h3', null, 'Path rules (first match wins)'), settingsForm(['inspectorRules']),
            h('div', { class: 'small muted' }, 'Rule: {"method":"POST","path":"/hooks/{name}","status":202,"contentType":"application/json","body":{"ok":true,"hook":"{{params.name}}"},"headers":[{"name":"X-Demo","value":"{{uuid}}"}],"delayMs":0}. Paths support *, ** and {param}; templates: {{uuid}} {{now}} {{id}} {{path}} {{params.x}} {{query.x}} {{body.x}} {{baseUrl}}.'),
            h('h3', null, 'Auto-forward'), h('label', { class: 'check' }, fwdEnabled, 'Forward every capture'), field('Forward URL (path is appended)', fwdUrl),
            h('button', { onclick: guard(async () => { await api('PUT', '/settings', { inspectorForwardEnabled: fwdEnabled.checked, inspectorForwardUrl: fwdUrl.value }); toast('Forwarding saved', 'ok'); }) }, 'Save forwarding'))))));
    el.append(h('div', { class: 'split' }, h('div', { class: 'card', style: { padding: '0' } }, listEl), detailEl));
    renderList();
    showDetail(selected);
    return () => es.close();
  };

  // ---------------------------------------------------------------- files
  VIEWS.files = async (el) => {
    const list = await api('GET', '/files');
    const input = h('input', { type: 'file', multiple: true });
    const tbody = h('tbody');
    for (const f of list) {
      tbody.append(h('tr', null,
        h('td', null, h('div', null, f.name), h('div', { class: 'small muted mono' }, f.id)),
        h('td', null, f.contentType), h('td', null, fmtBytes(f.size)), h('td', null, h('span', { class: 'badge' }, f.source)),
        h('td', { class: 'small muted' }, f.sha256 ? `${f.sha256.slice(0, 12)}…` : '—'),
        h('td', null, h('div', { class: 'row' },
          h('a', { class: 'btn small', href: `/admin/api/files/${encodeURIComponent(f.id)}/download` }, 'Download'),
          h('button', { class: 'small', onclick: () => copy(f.links.download) }, 'Copy URL'),
          h('button', { class: 'small danger', onclick: guard(async () => { if (!confirm(`Delete ${f.name}?`)) return; await api('DELETE', `/files/${encodeURIComponent(f.id)}`); route(); }) }, 'Delete')))));
    }
    el.append(header('Files', 'One shared pool for multipart, raw, base64, tus, presigned, range and chunked transfers.',
      h('button', { onclick: guard(async () => { const r = await api('POST', '/files/regenerate'); toast(`Regenerated ${r.generated} sample files`, 'ok'); route(); }) }, 'Regenerate samples')));
    el.append(h('div', { class: 'card row' }, input, h('button', { class: 'primary', onclick: guard(async () => {
      for (const file of input.files) {
        await api('POST', '/files/upload', file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
      }
      toast(`Uploaded ${input.files.length} file(s)`, 'ok');
      route();
    }) }, 'Upload')));
    el.append(h('div', { class: 'card table-wrap' }, list.length ? h('table', null, h('thead', null, h('tr', null, ['Name', 'Type', 'Size', 'Source', 'SHA-256', ''].map((x) => h('th', null, x)))), tbody) : h('div', { class: 'empty' }, 'No files yet.')));
  };

  // ---------------------------------------------------------------- auth
  VIEWS.auth = async (el) => {
    await loadSettings();
    const a = await api('GET', '/auth');
    const tokenOut = h('div');
    const clientSel = h('select', null, a.clients.map((c) => h('option', { value: c.clientId }, `${c.clientId} (${c.scopes.join(' ')})`)));
    const scope = h('input', { type: 'text', placeholder: 'scope (blank = all of the client)' });
    const newId = h('input', { type: 'text', placeholder: 'client id' });
    const newSecret = h('input', { type: 'text', placeholder: 'secret (blank = generate)' });
    const newScopes = h('input', { type: 'text', value: 'read write' });
    const newRedirects = h('input', { type: 'text', placeholder: 'redirect URIs (optional, space separated)' });
    const hmacMethod = h('select', null, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { value: m }, m)));
    const hmacPath = h('input', { type: 'text', value: '/v1/employees?limit=2' });
    const hmacBody = h('textarea', { rows: 3, placeholder: 'JSON body (exact bytes you will send)' });
    const hmacOut = h('div');

    el.append(header('Auth', `Active mode: ${a.mode}. Applies globally to /v1/*.`));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card stack' }, h('h2', null, 'Mode & credentials'), settingsForm(['authMode', 'apiKey', 'apiKeyName', 'apiKeyIn', 'basicUser', 'basicPass', 'bearerToken', 'jwtAlg', 'jwtIssuer', 'jwtAudience', 'hmacKeyId', 'hmacSecret', 'hmacMaxSkewSeconds'], { onSaved: route })),
      h('div', null,
        h('div', { class: 'card stack' }, h('h2', null, 'Get a test token'), field('Client', clientSel), field('Scope', scope),
          h('button', { class: 'primary', onclick: guard(async () => {
            const t = await api('POST', '/auth/test-token', { clientId: clientSel.value, scope: scope.value || undefined });
            clear(tokenOut).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, h('b', null, `expires in ${t.expires_in}s`), h('button', { class: 'small', onclick: () => copy(t.access_token) }, 'Copy token'), h('button', { class: 'small', onclick: () => copy(`Authorization: Bearer ${t.access_token}`) }, 'Copy header')),
              codeBlock(t.access_token), codeBlock(pretty(t.decoded))));
          }) }, 'Issue token'), tokenOut,
          h('div', { class: 'small muted' }, 'curl:'), codeBlock(`curl -s -u '${a.clients[0]?.clientId || 'demo-client'}:${a.clients[0]?.secret || 'demo-secret'}' -d grant_type=client_credentials -d scope="read write" '${a.oauth.tokenUrl}'`)),
        h('div', { class: 'card' }, h('h2', null, 'OAuth server'), kv({ token: a.oauth.tokenUrl, authorize: a.oauth.authorizeUrl, metadata: a.oauth.metadata, jwks: a.jwt.jwks, issuer: a.jwt.issuer, audience: a.jwt.audience, alg: a.jwt.alg, 'demo users': a.oauth.users.join(', ') })))));
    el.append(h('div', { class: 'card' }, h('h2', null, 'OAuth clients'),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Client id', 'Secret', 'Scopes', 'Redirect URIs', 'Source', ''].map((x) => h('th', null, x)))),
        h('tbody', null, a.clients.map((c) => h('tr', null, h('td', { class: 'mono' }, c.clientId), h('td', { class: 'mono' }, c.secret || '(public)'), h('td', null, c.scopes.join(' ')), h('td', { class: 'small' }, (c.redirectUris || []).join(' ') || 'any'),
          h('td', null, h('span', { class: 'badge' }, c.source)),
          h('td', null, c.source === 'dashboard' ? h('button', { class: 'small danger', onclick: guard(async () => { await api('DELETE', `/oauth/clients/${encodeURIComponent(c.clientId)}`); route(); }) }, 'Delete') : null)))))),
      h('h3', null, 'Add client'), h('div', { class: 'grid cols-4' }, newId, newSecret, newScopes, newRedirects),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { onclick: guard(async () => {
        const c = await api('POST', '/oauth/clients', { clientId: newId.value, secret: newSecret.value || undefined, scopes: newScopes.value, redirectUris: newRedirects.value });
        toast(`Client ${c.clientId} created (secret ${c.secret})`, 'ok');
        route();
      }) }, 'Add client'))));
    el.append(h('div', { class: 'card stack' }, h('h2', null, 'HMAC signer'),
      h('div', { class: 'small muted' }, 'Canonical string: METHOD \\n PATH+QUERY \\n X-Timestamp \\n hex(SHA-256(body)). Signature: base64(HMAC-SHA256(secret, canonical)).'),
      h('div', { class: 'grid cols-3' }, field('Method', hmacMethod), field('Path + query', hmacPath)), field('Body', hmacBody),
      h('button', { onclick: guard(async () => {
        const r = await api('POST', '/auth/hmac-sign', { method: hmacMethod.value, path: hmacPath.value, body: hmacBody.value || undefined });
        clear(hmacOut).append(h('div', { class: 'stack' }, h('div', { class: 'small muted' }, 'Canonical string (valid for the skew window):'), codeBlock(r.canonical), kv(r.headers),
          h('button', { class: 'small', onclick: () => copy(`curl -s '${location.origin}${hmacPath.value}' -X ${hmacMethod.value} -H 'Authorization: ${r.headers.Authorization}' -H 'X-Timestamp: ${r.headers['X-Timestamp']}'${hmacBody.value ? ` -H 'Content-Type: application/json' --data-binary '${hmacBody.value.replace(/'/g, "'\\''")}'` : ''}`) }, 'Copy curl')));
      }) }, 'Sign'), hmacOut));
  };

  // ---------------------------------------------------------------- chaos
  VIEWS.chaos = async (el) => {
    await loadSettings();
    el.append(header('Chaos', 'Random error and latency injection for /v1/*, plus deterministic forcing headers.'));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', null, 'Rates & latency'), settingsForm(['errorRate', 'errorTypes', 'latencyMinMs', 'latencyMaxMs', 'chaosTimeoutSeconds', 'chaosSlowDripMs', 'rateLimitRpm'])),
      h('div', null,
        h('div', { class: 'card' }, h('h2', null, 'Per-route overrides'), settingsForm(['chaosRouteOverrides']),
          h('div', { class: 'small muted' }, 'Example: [{"path":"/v1/products","errorRate":50,"errorTypes":"503,timeout"},{"path":"/v1/files","method":"POST","latencyMinMs":500,"latencyMaxMs":2000}]')),
        h('div', { class: 'card' }, h('h2', null, 'Forcing headers (always win)'),
          h('table', null, h('tbody', null,
            [['X-Force-Error: 503', 'problem+json with that status (any 4xx/5xx)'],
              ['X-Force-Error: timeout | reset', 'hang until the client gives up / drop the socket'],
              ['X-Force-Error: malformed-json | truncated-body | empty-body | wrong-content-type | slow-drip', 'corrupt the real response'],
              ['X-Force-Status: 202', 'override the status code (>= 400 returns a problem)'],
              ['X-Force-Latency: 2000', 'add latency in ms']].map(([a, b]) => h('tr', null, h('td', null, h('code', null, a)), h('td', { class: 'small' }, b))))),
          h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Injected responses carry X-Chaos-Injected: <type>.')))));
  };

  // ---------------------------------------------------------------- headers
  VIEWS.headers = async (el) => {
    await loadSettings();
    el.append(header('Headers', 'Custom response headers on every response; required request headers on /v1/*.'));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', null, 'Response headers'), settingsForm(['responseHeaders']), h('div', { class: 'small muted' }, 'JSON list: [{"name":"X-Env","value":"demo"}]. Env format: Name:Value;Name2:Value2')),
      h('div', { class: 'card' }, h('h2', null, 'Required request headers'), settingsForm(['requiredHeaders']), h('div', { class: 'small muted' }, 'JSON list: [{"name":"X-Tenant"},{"name":"X-Env","value":"demo"}]. Missing or wrong values return 400 problem+json. Env format: X-Tenant,X-Env=demo'))));
  };

  // ---------------------------------------------------------------- openapi
  VIEWS.openapi = async (el) => {
    const text = await fetch('/openapi.yaml').then((r) => r.text());
    el.append(header('OpenAPI', 'Generated live from the current settings (auth, date format, headers, chaos).',
      h('a', { class: 'btn', href: '/openapi.json', download: 'api-test-tool.openapi.json' }, 'Download JSON'),
      h('a', { class: 'btn', href: '/openapi.yaml', download: 'api-test-tool.openapi.yaml' }, 'Download YAML'),
      h('a', { class: 'btn primary', href: '/docs', target: '_blank', rel: 'noopener' }, 'Swagger UI ↗')));
    el.append(h('div', { class: 'card' }, codeBlock(text, { maxHeight: '75vh' })));
  };

  // ---------------------------------------------------------------- tester
  VIEWS.tester = async (el, params) => {
    if (params[0]) return testerSpec(el, params[0], params[1]);
    const [specs, samples] = await Promise.all([api('GET', '/tester/specs'), api('GET', '/tester/samples')]);
    const name = h('input', { type: 'text', placeholder: 'Name (optional)' });
    const paste = h('textarea', { rows: 8, placeholder: 'Paste OpenAPI 3.0 / 3.1 or Swagger 2.0 (YAML or JSON)…' });
    const url = h('input', { type: 'url', placeholder: 'https://…/openapi.yaml' });
    const file = h('input', { type: 'file', accept: '.yaml,.yml,.json' });
    const create = async (body) => {
      const r = await api('POST', '/tester/specs', body);
      toast(`Loaded ${r.name} (${r.originalVersion}${r.originalVersion === '2.0' ? ' → 3.0' : ''}) — lint: ${r.lint.error} errors, ${r.lint.warning} warnings`, r.lint.error ? 'err' : 'ok');
      location.hash = `#/tester/${r.id}`;
    };
    el.append(header('API Tester', 'Test an implementation against its OpenAPI spec: try operations, validate responses, run the whole contract.'));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card stack' }, h('h2', null, 'Add a spec'), field('Name', name),
        h('div', { class: 'row' }, file, h('button', { onclick: guard(async () => { if (!file.files[0]) return toast('Choose a file', 'err'); await create({ name: name.value || file.files[0].name.replace(/\.(ya?ml|json)$/i, ''), content: await file.files[0].text() }); }) }, 'Upload')),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, url, h('button', { onclick: guard(() => create({ name: name.value || undefined, url: url.value })) }, 'Load URL')),
        paste, h('button', { class: 'primary', onclick: guard(() => create({ name: name.value || undefined, content: paste.value })) }, 'Load pasted spec')),
      h('div', { class: 'card stack' }, h('h2', null, 'Bundled samples'),
        samples.map((s) => h('div', { class: 'row between' }, h('div', null, h('div', null, s.name), h('div', { class: 'small muted mono' }, s.url)),
          h('div', { class: 'row' },
            h('button', { class: 'small primary', onclick: guard(() => create({ sample: s.id === 'self' ? 'self' : s.file })) }, 'Load'),
            s.file ? h('button', { class: 'small', title: 'Load the same file through the URL loader', onclick: guard(() => create({ name: `${s.name} (via URL)`, url: `${location.origin}${s.url}` })) }, 'Load via URL') : null))))));
    el.append(h('div', { class: 'card table-wrap' }, h('h2', null, 'Specs'),
      specs.length ? h('table', null, h('thead', null, h('tr', null, ['Name', 'Version', 'Ops', 'Target', 'Last run', ''].map((x) => h('th', null, x)))),
        h('tbody', null, specs.map((s) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/tester/${s.id}`; } },
          h('td', null, h('div', null, s.name), h('div', { class: 'small muted' }, `${s.source?.type || ''}${s.converted ? ' · converted from 2.0' : ''}`)),
          h('td', null, s.version), h('td', null, s.operations), h('td', { class: 'small mono' }, s.baseUrl || '—'),
          h('td', null, s.lastRun ? h('span', null, h('span', { class: `badge ${s.lastRun.summary.failed ? 'fail' : 'pass'}` }, `${s.lastRun.summary.passed}/${s.lastRun.summary.total}`), ' ', h('span', { class: 'small muted' }, fmtDate(s.lastRun.at))) : '—'),
          h('td', null, h('button', { class: 'small danger', onclick: guard(async (e) => { e.stopPropagation(); if (!confirm(`Delete ${s.name} and its runs?`)) return; await api('DELETE', `/tester/specs/${s.id}`); route(); }) }, 'Delete'))))))
        : h('div', { class: 'empty' }, 'No specs yet — load the bundled Supplier Order sample to try it.')));
  };

  function checksView(checks) {
    return h('div', null, (checks || []).map((c) => h('div', { class: 'check-row' }, h('span', { class: `badge ${c.status === 'skip' ? '' : c.status}` }, c.status),
      h('div', { style: { minWidth: 0 } }, h('b', { class: 'mono small' }, c.name), ' ', c.message,
        c.errors ? h('ul', { class: 'small' }, c.errors.map((e) => h('li', null, h('code', null, e.pointer || '/'), ' ', e.message, e.hint ? h('div', { class: 'muted' }, e.hint) : null))) : null))));
  }

  function resultView(r) {
    if (!r) return h('div');
    const wrap = h('div', { class: 'stack' });
    const res = r.response;
    wrap.append(h('div', { class: 'row' }, h('span', { class: `badge ${r.outcome}` }, r.outcome || (r.error ? 'fail' : '')),
      res ? h('b', { class: statusClass(res.status) }, `HTTP ${res.status} ${res.statusText || ''}`) : h('b', { style: { color: 'var(--err)' } }, r.error),
      res ? h('span', { class: 'muted' }, `${res.durationMs} ms · ${fmtBytes(res.size)}`) : null));
    wrap.append(checksView(r.checks));
    const pane = h('div');
    const views = {
      response: () => (res ? h('div', { class: 'stack' }, kv(res.headers), res.body === '' ? h('div', { class: 'muted small' }, '(empty body)') : res.body !== null ? codeBlock(pretty(res.body)) : h('div', { class: 'muted' }, `[binary ${fmtBytes(res.size)}]`)) : h('div', { class: 'muted' }, r.error || '')),
      request: () => (r.request ? h('div', { class: 'stack' }, h('div', null, method(r.request.method), ' ', h('code', null, r.request.url)), kv(r.request.headers), r.request.body ? codeBlock(pretty(r.request.body)) : null) : h('div', { class: 'muted' }, 'Not sent')),
      token: () => (r.tokenExchange ? codeBlock(pretty(r.tokenExchange)) : h('div', { class: 'muted' }, 'No token request for this call.')),
    };
    wrap.append(tabs([{ id: 'response', label: 'Response' }, { id: 'request', label: 'Request' }, { id: 'token', label: 'Token exchange' }], (k) => clear(pane).append(views[k]())), pane);
    pane.append(views.response());
    return wrap;
  }

  async function testerSpec(el, specId, sub) {
    await loadSettings();
    let spec = await api('GET', `/tester/specs/${specId}`);
    const body = h('div');
    el.append(header(spec.name, `${spec.title} ${spec.apiVersion} · OpenAPI ${spec.version}${spec.converted ? ' (converted from Swagger 2.0)' : ''} · ${spec.operations.length} operations`,
      h('a', { class: 'btn', href: '#/tester' }, '← Specs'),
      spec.source?.type === 'url' || spec.source?.type === 'sample' ? h('button', { onclick: guard(async () => { await api('POST', `/tester/specs/${spec.id}/reload`); toast('Reloaded', 'ok'); route(); }) }, 'Reload') : null,
      h('a', { class: 'btn', href: `/admin/api/tester/specs/${spec.id}/document`, target: '_blank' }, 'View JSON')));
    const t = tabs([
      { id: 'target', label: 'Target' },
      { id: 'lint', label: `Spec lint${spec.lint.error ? ` (${spec.lint.error} errors)` : spec.lint.warning ? ` (${spec.lint.warning})` : ''}` },
      { id: 'ops', label: 'Try it' },
      { id: 'run', label: 'Run all' },
      { id: 'history', label: 'History' },
    ], (k) => { history.replaceState(null, '', `#/tester/${specId}/${k}`); draw(k); }, sub || 'target');
    el.append(t, body);

    async function refresh() { spec = await api('GET', `/tester/specs/${specId}`); }

    const draw = guard(async (k) => {
      clear(body);
      if (k === 'target') return drawTarget();
      if (k === 'lint') return drawLint();
      if (k === 'ops') return drawOps();
      if (k === 'run') return drawRun();
      if (k === 'history') return drawHistory();
    });

    function authEditor(current, profiles) {
      const wrap = h('div', { class: 'stack' });
      const sel = h('select', null, profiles.map((p, i) => h('option', { value: String(i) }, p.label)), h('option', { value: 'basic' }, 'HTTP Basic (manual)'), h('option', { value: 'bearer' }, 'Bearer token (manual)'));
      const fieldsEl = h('div', { class: 'stack' });
      let profile = { ...current };
      const idx = profiles.findIndex((p) => p.type === current.type && (p.scheme === current.scheme || !p.scheme));
      if (idx >= 0) sel.value = String(idx); else if (current.type === 'basic' || current.type === 'bearer') sel.value = current.type;
      const input = (key, label, type = 'text', hint) => {
        const i = h('input', { type, value: profile[key] ?? '', autocomplete: 'off', oninput: () => { profile[key] = i.value; } });
        return field(label, i, hint);
      };
      const renderFields = () => {
        clear(fieldsEl);
        const p = profile;
        if (p.type === 'apikey') fieldsEl.append(h('div', { class: 'grid cols-3' }, input('name', 'Name'), field('In', (() => { const s = h('select', { onchange: () => { p.in = s.value; } }, ['header', 'query', 'cookie'].map((x) => h('option', { value: x }, x))); s.value = p.in || 'header'; return s; })()), input('value', 'Value', 'password')));
        else if (p.type === 'basic') fieldsEl.append(h('div', { class: 'grid cols-2' }, input('username', 'Username'), input('password', 'Password', 'password')));
        else if (p.type === 'bearer') fieldsEl.append(input('token', 'Token', 'password'));
        else if (p.type === 'oauth2cc') {
          const out = h('div');
          fieldsEl.append(input('tokenUrl', 'Token URL', 'url', 'Overrides the spec\'s tokenUrl (often a placeholder).'),
            h('div', { class: 'grid cols-2' }, input('clientId', 'Client id'), input('clientSecret', 'Client secret', 'password')),
            h('div', { class: 'grid cols-2' }, input('scopes', 'Scopes (space separated)'),
              field('Client auth', (() => { const s = h('select', { onchange: () => { p.clientAuth = s.value; } }, h('option', { value: 'basic' }, 'HTTP Basic'), h('option', { value: 'body' }, 'Form body')); s.value = p.clientAuth || 'basic'; return s; })())),
            input('audience', 'Audience (optional)'),
            h('div', { class: 'row' }, h('button', { class: 'small', onclick: guard(async () => {
              const r = await fetch('/admin/api/tester/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth: profile }) }).then((x) => x.json());
              clear(out).append(h('div', { class: 'stack' }, h('span', { class: `badge ${r.ok ? 'pass' : 'fail'}` }, r.ok ? 'token OK' : r.error), codeBlock(pretty(r.exchange))));
            }) }, 'Test token request'), h('button', { class: 'small', onclick: guard(async () => { await api('POST', '/tester/token-cache/clear'); toast('Token cache cleared', 'ok'); }) }, 'Clear cached tokens')), out);
        }
      };
      sel.addEventListener('change', () => {
        if (sel.value === 'basic') profile = { type: 'basic', username: '', password: '' };
        else if (sel.value === 'bearer') profile = { type: 'bearer', token: '' };
        else profile = { ...profiles[Number(sel.value)] };
        delete profile.label;
        renderFields();
      });
      renderFields();
      wrap.append(field('Auth profile', sel), fieldsEl);
      wrap.get = () => { const p = { ...profile }; delete p.label; return p; };
      return wrap;
    }

    function drawTarget() {
      const base = h('input', { type: 'url', value: spec.target.baseUrl || '' });
      const headers = h('textarea', { rows: 4 }, JSON.stringify(spec.target.headers || {}, null, 2));
      const timeout = h('input', { type: 'number', value: spec.target.timeoutMs || 30000, min: 1000 });
      const lenient = h('input', { type: 'checkbox', checked: spec.options?.lenientAllOf });
      const nameIn = h('input', { type: 'text', value: spec.name });
      const auth = authEditor(spec.target.auth || { type: 'none' }, spec.profiles);
      const servers = (spec.doc.servers || []).map((s) => s.url);
      const mockOut = h('div');
      body.append(h('div', { class: 'grid cols-2' },
        h('div', { class: 'card stack' }, h('h2', null, 'Target'), field('Name', nameIn),
          field('Base URL override', base, servers.length ? `Spec servers: ${servers.join(', ')}` : 'The spec declares no servers.'),
          h('div', { class: 'row' }, servers.map((s) => h('button', { class: 'small', onclick: () => { base.value = s; } }, `use ${s}`)), h('button', { class: 'small', onclick: () => { base.value = location.origin; } }, 'use this tool')),
          auth,
          field('Default headers (JSON object)', headers, 'Sent with every request; {{uuid}} and {{now}} templates are expanded.'),
          field('Timeout (ms)', timeout),
          h('label', { class: 'check' }, lenient, 'Lenient allOf (flatten allOf before validating)'),
          h('button', { class: 'primary', onclick: guard(async () => {
            let hdrs;
            try { hdrs = JSON.parse(headers.value || '{}'); } catch { throw new Error('Default headers must be a JSON object'); }
            await api('PUT', `/tester/specs/${spec.id}`, { name: nameIn.value, target: { baseUrl: base.value, auth: auth.get(), headers: hdrs, timeoutMs: Number(timeout.value) || 30000 }, options: { lenientAllOf: lenient.checked } });
            await refresh();
            toast('Target saved', 'ok');
          }) }, 'Save target')),
        h('div', null,
          h('div', { class: 'card stack' }, h('h2', null, 'Mock from spec'),
            h('p', { class: 'muted small' }, 'Serve this spec\'s documented 2xx responses (examples first) from this tool under /mock/<name>, then run the contract against it. Useful before an implementation exists — and it shows how the spec\'s own examples fare against its schemas.'),
            h('div', { class: 'row' },
              h('button', { onclick: guard(async () => { const m = await api('POST', `/tester/specs/${spec.id}/mock`, { useAsTarget: true }); clear(mockOut).append(h('div', { class: 'small' }, `${m.count} rules installed; target set to `, h('code', null, m.url))); await refresh(); base.value = spec.target.baseUrl; }) }, 'Install mock & use as target'),
              h('button', { class: 'small danger', onclick: guard(async () => { const r = await api('DELETE', `/tester/specs/${spec.id}/mock`); toast(`Removed ${r.removed} rules`, 'ok'); }) }, 'Remove mock rules')), mockOut),
          spec.notes?.length ? h('div', { class: 'card' }, h('h2', null, 'Load notes'), h('ul', null, spec.notes.map((n) => h('li', null, n)))) : null)));
    }

    async function drawLint() {
      const lint = await api('GET', `/tester/specs/${spec.id}/lint`);
      body.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'badge fail' }, `${lint.counts.error} errors`), h('span', { class: 'badge warn' }, `${lint.counts.warning} warnings`), h('span', { class: 'badge info' }, `${lint.counts.info} info`)),
        lint.issues.length ? lint.issues.map((i) => h('div', { class: `issue ${i.severity}` }, h('div', { class: 'row' }, h('b', null, i.rule), h('code', { class: 'small muted' }, i.pointer)), h('div', null, i.message), i.fix ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('b', null, 'Fix: '), i.fix) : null))
          : h('div', { class: 'empty' }, 'No issues found.')));
    }

    function drawOps() {
      const listEl = h('div', { class: 'list' });
      const detail = h('div');
      let current = null;
      for (const op of spec.operations) {
        const item = h('div', { class: 'list-item', onclick: () => { for (const x of listEl.children) x.classList.remove('active'); item.classList.add('active'); current = op; showOp(op); } },
          method(op.method), h('div', { style: { minWidth: 0 } }, h('div', { class: 'path' }, op.path), h('div', { class: 'small muted' }, op.operationId || op.summary || '')), op.secured ? h('span', { class: 'small muted', title: 'secured' }, '🔒') : h('span'));
        listEl.append(item);
      }
      body.append(h('div', { class: 'split' }, h('div', { class: 'card', style: { padding: 0 } }, listEl), detail));
      detail.append(h('div', { class: 'card empty' }, 'Pick an operation.'));

      const showOp = guard(async (op, exampleName) => {
        const req = await api('GET', `/tester/specs/${spec.id}/request?op=${encodeURIComponent(op.id)}${exampleName ? `&example=${encodeURIComponent(exampleName)}` : ''}`);
        if (current !== op) return;
        clear(detail);
        const out = h('div');
        const files = await api('GET', '/files');
        const fileSelect = (value, onchange) => { const s = h('select', { onchange: () => onchange(s.value) }, files.map((f) => h('option', { value: f.id }, `${f.name} (${fmtBytes(f.size)})`))); s.value = value; return s; };
        const paramRows = req.params.map((p) => {
          const val = h('input', { type: 'text', value: p.value, oninput: () => { p.value = val.value; } });
          const en = h('input', { type: 'checkbox', checked: p.enabled, disabled: p.in === 'path', onchange: () => { p.enabled = en.checked; } });
          return h('tr', null, h('td', null, en), h('td', null, h('code', null, p.name), p.required ? h('span', { style: { color: 'var(--err)' } }, ' *') : null, h('div', { class: 'small muted' }, p.in)), h('td', null, val));
        });
        let bodyEditor = null;
        const bodySection = h('div', { class: 'stack' });
        if (req.multipart) {
          bodySection.append(h('h3', null, `Body · ${req.contentType}`),
            h('table', null, h('tbody', null, req.multipart.map((part) => h('tr', null, h('td', null, h('code', null, part.name)),
              h('td', null, part.kind === 'file'
                ? h('div', { class: 'row' }, fileSelect(part.fileId, (v) => { part.fileId = v; delete part.upload; }),
                  (() => { const fi = h('input', { type: 'file', onchange: async () => { const f = fi.files[0]; if (!f) return; const buf = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); part.upload = { filename: f.name, contentType: f.type, base64: btoa(bin) }; } }); return fi; })())
                : (() => { const i = h('input', { type: 'text', value: part.value, oninput: () => { part.value = i.value; } }); return i; })()))))));
        } else if (req.binary) {
          bodySection.append(h('h3', null, `Body · ${req.contentType}`), fileSelect(req.binary.fileId, (v) => { req.binary.fileId = v; }));
        } else if (req.contentType) {
          bodyEditor = h('textarea', { rows: 14 }, typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2));
          const exSel = req.examples.length ? h('select', { onchange: () => showOp(op, exSel.value) }, req.examples.map((e) => h('option', { value: e.name }, `${e.name}${e.summary ? ` — ${e.summary}` : ''}`))) : null;
          if (exSel && req.exampleName) exSel.value = req.exampleName;
          bodySection.append(h('div', { class: 'row between' }, h('h3', null, `Body · ${req.contentType}`), exSel ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Example'), exSel) : h('span', { class: 'small muted' }, `source: ${req.exampleName || 'generated'}`)), bodyEditor);
        }
        const send = h('button', { class: 'primary', onclick: guard(async () => {
          if (bodyEditor) {
            const txt = bodyEditor.value;
            if (/json/i.test(req.contentType)) { try { req.body = txt.trim() ? JSON.parse(txt) : null; } catch (e) { throw new Error(`Body is not valid JSON: ${e.message}`); } } else req.body = txt;
          }
          send.disabled = true;
          clear(out).append(h('div', { class: 'muted' }, 'Sending…'));
          try {
            const r = await api('POST', `/tester/specs/${spec.id}/send`, { opId: op.id, request: req });
            clear(out).append(resultView(r));
          } finally { send.disabled = false; }
        }) }, 'Send');
        detail.append(h('div', { class: 'card stack' },
          h('div', { class: 'row' }, method(op.method), h('code', null, op.path), op.operationId ? h('span', { class: 'muted small' }, op.operationId) : null),
          op.summary ? h('div', { class: 'muted' }, op.summary) : null,
          req.params.length ? h('div', null, h('h3', null, 'Parameters'), h('table', null, h('tbody', null, paramRows)), h('div', { class: 'small muted' }, 'Templates: {{uuid}} (fresh per send), {{now}}, {{timestamp}}.')) : null,
          bodySection,
          h('div', { class: 'row' }, send, h('span', { class: 'small muted' }, `→ ${spec.target.baseUrl || '(no base URL)'} · auth: ${spec.target.auth?.type || 'none'}`))),
        h('div', { class: 'card' }, out));
      });
    }

    function drawRun() {
      const negative = h('input', { type: 'checkbox' });
      const lenient = h('input', { type: 'checkbox', checked: spec.options?.lenientAllOf });
      const vars = h('textarea', { rows: 4, placeholder: '{"purchaseOrderId": "PO-4500123456"}' });
      const opsSel = h('select', { multiple: true, size: Math.min(8, spec.operations.length) }, spec.operations.map((o) => h('option', { value: o.id }, `${o.method.toUpperCase()} ${o.path}`)));
      const out = h('div');
      const runBtn = h('button', { class: 'primary', onclick: guard(async () => {
        let variables = {};
        if (vars.value.trim()) { try { variables = JSON.parse(vars.value); } catch { throw new Error('Variables must be a JSON object'); } }
        runBtn.disabled = true;
        clear(out).append(h('div', { class: 'card muted' }, 'Running…'));
        try {
          const run = await api('POST', `/tester/specs/${spec.id}/runs`, { negative: negative.checked, lenientAllOf: lenient.checked, variables, operationIds: [...opsSel.selectedOptions].map((o) => o.value) });
          clear(out).append(runView(run));
        } finally { runBtn.disabled = false; }
      }) }, 'Run all');
      body.append(h('div', { class: 'card stack' }, h('h2', null, 'Contract run'),
        h('div', { class: 'small muted' }, 'Order: collection POSTs (creates) → collection GETs (lists) → item operations → DELETEs. IDs are captured from Location headers and response bodies and fed into later path parameters.'),
        h('div', { class: 'row' }, h('label', { class: 'check' }, negative, 'Negative tests (no auth → 401, missing required field → 400/422, unknown id → 404)'), h('label', { class: 'check' }, lenient, 'Lenient allOf')),
        h('div', { class: 'grid cols-2' }, field('Variables (override captured values)', vars), field('Only these operations (none selected = all)', opsSel)),
        h('div', { class: 'row' }, runBtn, h('span', { class: 'small muted' }, `→ ${spec.target.baseUrl || '(no base URL)'} · auth: ${spec.target.auth?.type || 'none'}`))), out);
    }

    function runView(run) {
      const s = run.summary;
      return h('div', null,
        h('div', { class: 'card row' }, h('span', { class: 'badge pass' }, `${s.passed} passed`), h('span', { class: 'badge warn' }, `${s.warned} warnings`), h('span', { class: 'badge fail' }, `${s.failed} failed`),
          h('span', { class: 'muted small' }, `${s.total} steps · ${run.durationMs} ms`), h('span', { class: 'spacer' }),
          h('a', { class: 'btn small', href: `/admin/api/tester/runs/${run.id}/report.html`, target: '_blank' }, 'HTML report'),
          h('a', { class: 'btn small', href: `/admin/api/tester/runs/${run.id}/report.html?download=1` }, 'Download HTML'),
          h('a', { class: 'btn small', href: `/admin/api/tester/runs/${run.id}/export.json` }, 'Export JSON')),
        run.steps.map((st, i) => h('details', { class: 'card', open: st.outcome === 'fail' && i < 6 ? true : null },
          h('summary', { class: 'row' }, h('span', { class: `badge ${st.outcome}` }, st.outcome), h('span', { class: 'muted' }, `#${i + 1}`), method(st.opId.split(' ')[0]), h('code', null, st.opId.split(' ').slice(1).join(' ')),
            st.kind === 'negative' ? h('span', { class: 'badge' }, `negative: ${st.test}`) : null,
            st.response ? h('span', { class: statusClass(st.response.status) }, st.response.status) : h('span', { style: { color: 'var(--err)' } }, st.error)),
          h('div', { style: { marginTop: '10px' } }, resultView(st)))),
        Object.keys(run.variables || {}).length ? h('div', { class: 'card' }, h('h3', null, 'Variables after run'), kv(run.variables)) : null);
    }

    async function drawHistory() {
      const runs = await api('GET', `/tester/specs/${spec.id}/runs`);
      const out = h('div');
      body.append(h('div', { class: 'card table-wrap' }, runs.length ? h('table', null, h('thead', null, h('tr', null, ['Started', 'Target', 'Result', 'Options', ''].map((x) => h('th', null, x)))),
        h('tbody', null, runs.map((r) => h('tr', null, h('td', null, fmtDate(r.startedAt)), h('td', { class: 'small mono' }, r.baseUrl),
          h('td', null, h('span', { class: `badge ${r.summary.failed ? 'fail' : 'pass'}` }, `${r.summary.passed}/${r.summary.total} passed`)),
          h('td', { class: 'small' }, `${r.options.negative ? 'negative' : ''} ${r.options.lenientAllOf ? 'lenient' : ''}`),
          h('td', null, h('div', { class: 'row' },
            h('button', { class: 'small', onclick: guard(async () => { clear(out).append(runView(await api('GET', `/tester/runs/${r.id}`))); }) }, 'Open'),
            h('a', { class: 'btn small', href: `/admin/api/tester/runs/${r.id}/report.html`, target: '_blank' }, 'Report'),
            h('a', { class: 'btn small', href: `/admin/api/tester/runs/${r.id}/export.json` }, 'JSON'),
            h('button', { class: 'small danger', onclick: guard(async () => { await api('DELETE', `/tester/runs/${r.id}`); draw('history'); }) }, 'Delete')))))))
        : h('div', { class: 'empty' }, 'No runs yet.')), out);
    }

    draw(sub || 'target');
  }

  // ---------------------------------------------------------------- about & help
  VIEWS.help = async (el, params) => {
    const o = await api('GET', '/overview');
    const B = o.baseUrl;
    const code = (t) => h('code', null, t);
    const section = (id, title, ...body) => h('section', { class: 'card help-section', id: `help-${id}` }, h('h2', null, title), body);
    const steps = (...items) => h('ol', { class: 'help-steps' }, items.map((i) => h('li', null, i)));
    const link = (href, text) => h('a', { href }, text);

    const toc = [
      ['what', 'What this tool is'], ['quick-outgoing', 'Quick start: outgoing testing'], ['quick-incoming', 'Quick start: incoming testing'],
      ['urls', 'URLs and reserved paths'], ['pages', 'Page guide'], ['headers-cheat', 'Useful request headers'], ['more', 'More information'],
    ];

    el.append(header('About & Help', `API Test Tool ${o.version} · ${B}`));
    el.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', null, 'On this page:'),
      toc.map(([id, label]) => h('a', { class: 'btn small', href: `#/help/${id}` }, label)))));

    el.append(section('what', 'What this tool is',
      h('p', null, 'One server that helps you test an API platform (for example Amplify Fusion) in both directions:'),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'help-box' }, h('h3', null, '1. Outgoing testing — a mock API to call'),
          h('p', null, 'Point an integration at this server and it behaves like a realistic third-party API:'),
          h('ul', null,
            h('li', null, 'Seeded employees and products with every JSON type worth parsing (decimals as strings, nulls, nested objects, unicode).'),
            h('li', null, 'Seven pagination styles side by side, so you can test each one.'),
            h('li', null, 'Seven auth modes and a built-in OAuth 2.0 server.'),
            h('li', null, 'Files over every common HTTP protocol.'),
            h('li', null, 'Errors and slowness on demand (Chaos).'),
            h('li', null, 'An Inspector that catches webhooks and any other call your integration makes.'))),
        h('div', { class: 'help-box' }, h('h3', null, '2. Incoming testing — check an API you built'),
          h('p', null, 'Load the OpenAPI spec you implemented and the API Tester:'),
          h('ul', null,
            h('li', null, 'Lints the spec for problems that break validation.'),
            h('li', null, 'Builds sample requests from the spec, including its examples and regex patterns.'),
            h('li', null, 'Calls your implementation through this server (no CORS issues).'),
            h('li', null, 'Validates status codes, headers and bodies against the spec.'),
            h('li', null, 'Runs the whole contract with ID chaining and negative tests, and saves reports.'))))));

    el.append(section('quick-outgoing', 'Quick start: outgoing testing',
      steps(
        h('span', null, 'Give your integration the API base URL ', code(`${B}/v1`), '. Try ', code('GET /v1/employees?limit=5'), '.'),
        h('span', null, 'Choose an auth mode on the ', link('#/auth', 'Auth'), ' page (currently ', h('b', null, o.authMode), '). The page shows the credentials to configure, and "Get a test token" issues an OAuth/JWT token.'),
        h('span', null, 'Pick a pagination style by path, e.g. ', code('/v1/p/cursor/employees'), ' or ', code('/v1/p/link/products'), '. All seven are listed under ', link('#/help/urls', 'URLs and reserved paths'), '.'),
        h('span', null, 'Send webhooks or any unknown call to ', code(`${B}/<any-path>`), ' and watch them arrive on the ', link('#/inspector', 'Inspector'), ' page.'),
        h('span', null, 'Test error handling: add ', code('X-Force-Error: 503'), ' to one request, or set a random error rate on the ', link('#/chaos', 'Chaos'), ' page.'),
        h('span', null, 'Import the live spec from ', link('#/openapi', 'OpenAPI'), ' (', code(`${B}/openapi.json`), ') into Fusion or Postman to get every endpoint pre-defined.'))));

    el.append(section('quick-incoming', 'Quick start: incoming testing',
      steps(
        h('span', null, 'Open ', link('#/tester', 'API Tester'), ' and load your spec: upload, paste, or a URL. OpenAPI 3.0, 3.1 and Swagger 2.0 all work. To try it first, load the bundled Supplier Order sample.'),
        h('span', null, 'Read the ', h('b', null, 'Spec lint'), ' tab. It flags problems that make valid responses fail validation, such as allOf combined with additionalProperties: false, and placeholder server or token URLs.'),
        h('span', null, 'On the ', h('b', null, 'Target'), ' tab, set the base URL of your implementation and an auth profile (API key, OAuth2 client credentials with your token URL, Basic or Bearer). "Test token request" shows the full token exchange.'),
        h('span', null, 'Use ', h('b', null, 'Try it'), ' to send one operation at a time. The form is pre-filled from the spec; every response gets a list of pass/fail checks.'),
        h('span', null, 'Use ', h('b', null, 'Run all'), ' for the whole contract. IDs from Location headers and responses are reused in later calls; tick "Negative tests" to also check 401, 400/422 and 404 handling. Results are kept under ', h('b', null, 'History'), ' with HTML and JSON reports.'),
        h('span', null, 'No implementation yet? "Install mock & use as target" serves the spec\'s own examples from this server so you can rehearse the run.'))));

    el.append(section('urls', 'URLs and reserved paths',
      h('p', null, 'These paths belong to the tool. ', h('b', null, 'Every other path is captured by the Inspector.')),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
        [
          ['/v1/employees, /v1/products, /v1/departments, /v1/categories', 'Mock API with full CRUD (list, create, get, replace, patch, delete). Lists use offset pagination.'],
          ['/v1/p/{offset|page|cursor|keyset|link|hal|token}/{resource}', 'The same lists with each pagination style.'],
          ['/v1/departments/{id}/employees, /v1/categories/{id}/products', 'Nested collections.'],
          ['/v1/files/…', 'File protocols: multipart, raw, base64, tus, presign, download (range), chunked.'],
          ['/oauth/token, /oauth/authorize, /oauth/introspect, /oauth/revoke', 'Built-in OAuth 2.0 server.'],
          ['/.well-known/jwks.json, /.well-known/oauth-authorization-server', 'Signing keys and OAuth discovery.'],
          ['/openapi.json, /openapi.yaml, /docs', 'Live OpenAPI and Swagger UI.'],
          ['/health, /ready', 'Health and readiness checks.'],
          ['/samples/…', 'Bundled example specs for the API Tester.'],
          ['/dashboard, /admin/api/…', 'This dashboard and its API (password protected when ADMIN_PASSWORD is set).'],
          ['/mock/{spec}/…', 'Not reserved — created by "Mock from spec" as Inspector rules.'],
        ].map(([p, d]) => h('tr', null, h('td', null, code(p)), h('td', null, d))))))));

    el.append(section('pages', 'Page guide',
      PAGES.filter(([id]) => id !== 'help').map(([id, label]) => h('div', { class: 'help-page', id: `help-${id}` },
        h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, label), h('a', { class: 'btn small', href: `#/${id}` }, `Open ${label}`)),
        h('p', { style: { margin: '4px 0 0' } }, PAGE_HELP[id].purpose)))));

    el.append(section('headers-cheat', 'Useful request headers',
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
        [
          ['X-Force-Error: 503', 'Return that error (any 4xx/5xx), or a failure type: timeout, reset, malformed-json, truncated-body, empty-body, wrong-content-type, slow-drip.'],
          ['X-Force-Status: 202', 'Keep the real response but change its status code.'],
          ['X-Force-Latency: 2000', 'Add that many milliseconds of delay.'],
          ['Idempotency-Key: <uuid>', 'On POST: repeating the request returns the original response; reusing the key with a different body returns 409.'],
          ['If-Match: <etag>', 'On PUT/PATCH/DELETE: 412 if the resource changed since you read it.'],
          ['If-None-Match: <etag>', 'On GET: 304 if nothing changed.'],
          ['X-Request-Id / X-Correlation-Id', 'Echoed back (generated if missing) for tracing.'],
        ].map(([hd, d]) => h('tr', null, h('td', null, code(hd)), h('td', null, d))))))));

    el.append(section('more', 'More information',
      h('ul', null,
        h('li', null, h('a', { href: 'https://github.com/lbrenman/api-test-tool#readme', target: '_blank', rel: 'noopener' }, 'README on GitHub ↗'), ' — every setting, curl examples for each auth mode, deployment and troubleshooting.'),
        h('li', null, h('a', { href: '/docs', target: '_blank', rel: 'noopener' }, 'Swagger UI ↗'), ' — try every mock API endpoint in the browser.'),
        h('li', null, h('a', { href: '/openapi.json', target: '_blank', rel: 'noopener' }, 'openapi.json ↗'), ' and ', h('a', { href: '/health', target: '_blank', rel: 'noopener' }, 'health ↗'), '.'),
        h('li', null, 'Postman: the repo\'s ', code('postman/'), ' folder has a collection covering every feature; set its ', code('authMode'), ' variable to match the Auth page.'))));

    // Jump to a section: #/help/<section-or-page>
    const target = params[0] && document.getElementById(`help-${params[0]}`);
    if (target) {
      target.classList.add('flash');
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    } else window.scrollTo(0, 0);
  };

  // ---------------------------------------------------------------- boot
  async function start() {
    const s = await fetch('/admin/api/session').then((r) => r.json()).catch(() => ({ authenticated: false, passwordRequired: true }));
    if (!s.authenticated) { showLogin(); return; }
    shell();
    if (!s.passwordRequired) $('#logout-btn').classList.add('hidden');
    window.addEventListener('hashchange', route);
    route();
  }
  start();
})();
