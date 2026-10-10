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
  const pretty = (v) => {
    if (typeof v !== 'string') return JSON.stringify(v, null, 2);
    if (/^\s*</.test(v)) return prettyXml(v.trim());
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  };
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

  // ---------------------------------------------------------------- component guides (tooltips)
  // Each main component gets a "?" button. Hover, focus or tap it to see the steps to use the component
  // and curl commands built from the resolved base URL and the auth mode that is active right now.
  // The guides only read the configuration (env or dashboard override); they never change it.
  let CURL = null;
  let PASSWORD_REQUIRED = false;

  async function loadCurlCtx() {
    const [a] = await Promise.all([api('GET', '/auth'), SETTINGS ? Promise.resolve() : loadSettings()]);
    const base = a.oauth.tokenUrl.replace(/\/oauth\/token$/, '');
    const client = a.clients.find((c) => c.secret) || a.clients[0];
    CURL = window.ATT_GUIDES.makeCurl({
      base,
      mode: a.mode,
      apiKey: a.apiKey,
      basic: a.basic,
      bearer: a.bearer,
      hmac: { keyId: a.hmac.keyId, secret: a.hmac.secret },
      s3: a.s3 ? { bucket: a.s3.bucket, region: a.s3.region, accessKeyId: a.s3.accessKeyId, secretAccessKey: a.s3.secretAccessKey } : null,
      tokenUrl: a.oauth.tokenUrl,
      client: client ? { clientId: client.clientId, secret: client.secret || '' } : null,
      required: (sval('requiredHeaders') || []).map((r) => ({ name: r.name, value: r.value })),
      adminPasswordRequired: PASSWORD_REQUIRED,
    });
    return CURL;
  }

  const inlineCode = (text) => String(text).split('`').map((part, i) => (i % 2 ? h('code', null, part) : part));

  let openTip = null;
  function closeTip() {
    if (!openTip) return;
    openTip.pop.remove();
    openTip.btn.setAttribute('aria-expanded', 'false');
    openTip.btn.classList.remove('open');
    openTip = null;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openTip) { const b = openTip.btn; closeTip(); b.focus(); } });
  document.addEventListener('pointerdown', (e) => {
    if (openTip && !openTip.pop.contains(e.target) && !openTip.btn.contains(e.target)) closeTip();
  });
  window.addEventListener('resize', () => openTip?.place());
  document.addEventListener('scroll', () => openTip?.place(), true);
  window.addEventListener('hashchange', closeTip);

  /** A "?" button that opens the guide for one component. extra: values for the examples (spec id, file id…). */
  function tip(id, extra) {
    const btn = h('button', { type: 'button', class: 'tip-btn', 'aria-label': 'How to use this', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, '?');
    let hoverTimer = null;
    let pinned = false;

    const render = () => {
      if (!CURL || !window.ATT_GUIDES) return h('div', { class: 'tip-pop', role: 'dialog' }, 'Guide unavailable — reload the page.');
      const g = window.ATT_GUIDES.build(CURL, typeof extra === 'function' ? extra() : extra || {})[id];
      if (!g) return h('div', { class: 'tip-pop', role: 'dialog' }, 'No guide for this component.');
      return h('div', { class: 'tip-pop', role: 'dialog', 'aria-label': `How to use ${g.title}` },
        h('div', { class: 'row between tip-head' }, h('b', null, g.title), h('button', { class: 'small', type: 'button', 'aria-label': 'Close', onclick: () => { closeTip(); btn.focus(); } }, '✕')),
        h('p', { class: 'tip-purpose' }, inlineCode(g.purpose)),
        h('div', { class: 'tip-label' }, 'Steps'),
        h('ol', { class: 'tip-steps' }, g.steps.map((st) => h('li', null, inlineCode(st)))),
        g.curls?.length ? h('div', { class: 'tip-label' }, 'Try it with curl') : null,
        (g.curls || []).map(([label, cmd]) => h('div', { class: 'tip-curl' },
          h('div', { class: 'row between' }, h('span', { class: 'small' }, label), h('button', { class: 'small', type: 'button', onclick: () => copy(cmd) }, 'Copy')),
          h('pre', null, cmd))),
        h('div', { class: 'tip-foot small muted' }, 'Auth in these examples: ', h('b', null, CURL.mode), ` — ${CURL.authLabel}. It follows AUTH_MODE or the override on the `, h('a', { href: '#/auth' }, 'Auth'), ' page.'));
    };

    const open = () => {
      if (openTip?.btn === btn) return;
      closeTip();
      const pop = render();
      document.body.appendChild(pop);
      const place = () => {
        const r = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const width = Math.min(560, vw - 24);
        pop.style.width = `${width}px`;
        pop.style.left = `${Math.max(12, Math.min(r.left, vw - width - 12))}px`;
        const below = vh - r.bottom - 18;
        const above = r.top - 18;
        if (below >= 260 || below >= above) {
          pop.style.top = `${r.bottom + 6}px`; pop.style.bottom = ''; pop.style.maxHeight = `${Math.max(160, below)}px`;
        } else {
          pop.style.top = ''; pop.style.bottom = `${vh - r.top + 6}px`; pop.style.maxHeight = `${Math.max(160, above)}px`;
        }
      };
      place();
      openTip = { btn, pop, place };
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('open');
      pop.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
      pop.addEventListener('mouseleave', () => { if (!pinned) hoverTimer = setTimeout(() => { if (openTip?.btn === btn) closeTip(); }, 250); });
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault(); // inside <summary> this would toggle the <details>
      if (openTip?.btn === btn && pinned) { pinned = false; closeTip(); return; }
      pinned = true;
      open();
    });
    btn.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); if (!openTip || openTip.btn !== btn) { pinned = false; hoverTimer = setTimeout(open, 200); } });
    btn.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); if (!pinned) hoverTimer = setTimeout(() => { if (openTip?.btn === btn) closeTip(); }, 250); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); } });
    return btn;
  }

  /** A card heading with its guide button. */
  const titled = (text, id, extra) => h('h2', { class: 'with-tip' }, text, tip(id, extra));

  // ---------------------------------------------------------------- theme
  function setTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { if (t) localStorage.setItem('att-theme', t); else localStorage.removeItem('att-theme'); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- shell & routing
  const PAGES = [
    ['overview', 'Overview'], ['settings', 'Settings'], ['data', 'Data'], ['inspector', 'Inspector'], ['webhooks', 'Webhooks'], ['files', 'Files'],
    ['auth', 'Auth'], ['chaos', 'Chaos'], ['headers', 'Headers'], ['protocols', 'Protocols'], ['openapi', 'OpenAPI'], ['tester', 'API Tester'],
    ['help', 'About & Help'],
  ];
  // One-line purpose of each page; shown in the Help guide and as the tooltip of each page's help link.
  const PAGE_HELP = {
    overview: { purpose: 'Your starting point: the URLs to give integrations, current auth mode, health, data counts and copy-ready curl commands.' },
    settings: { purpose: 'Every setting in one place. Environment variables set defaults; changes here override them and survive restarts. Badges show where each value comes from.' },
    data: { purpose: 'The seeded mock data (employees, products, departments, categories): counts, a preview, re-seed with different sizes, or clear it.' },
    inspector: { purpose: 'Every call made to this server shows up here live, with headers, auth, body and the response that was returned: webhooks and other calls to unreserved paths, plus mock API (/v1), SOAP (/soap) and OAuth (/oauth) calls. Filter by source, or switch API recording off with the checkbox at the top of the page.' },
    webhooks: { purpose: 'Outgoing webhooks: when an employee, product, department or category is created, updated or deleted, or a file is uploaded, downloaded or deleted (through any protocol), POST its type and id to URLs you choose. Stored in the database, so they survive restarts; every delivery is logged with the response.' },
    files: { purpose: 'The shared file pool used by every file protocol (multipart, raw, base64, tus, presigned, range, chunked). Upload, download, delete or regenerate samples.' },
    auth: { purpose: 'Choose how /v1 calls must authenticate (none, API key, Basic, Bearer, JWT, OAuth2, HMAC), see the credentials, manage OAuth clients and get test tokens.' },
    chaos: { purpose: 'Make the mock API misbehave on purpose: random errors, latency, timeouts, broken JSON and rate limits, globally or per route, so you can test client error handling.' },
    headers: { purpose: 'Headers added to every response, and headers every /v1 request must carry (missing ones return 400).' },
    protocols: { purpose: 'The same mock data over other protocols: SOAP 1.1/1.2 services with live WSDLs, WebSocket channels (echo, JSON-RPC, live change feed) with an AsyncAPI document and a live console, Server-Sent Events streams (change feed with replay, ticks, LLM-style streaming) with a live viewer, GraphQL (queries, mutations, subscriptions), OData v4, and the file pool as an S3-compatible bucket (AWS Signature V4), each with a console. Auth (the S3 API uses its own keys), chaos, rate limits and required headers apply as on /v1.' },
    openapi: { purpose: 'Two live OpenAPI 3.1 specs: the Mock Data API (/openapi.json) for integrations to import, and the Admin API (/admin/api/openapi.json) for scripting the tool itself.' },
    tester: { purpose: 'Test an API you built: load its OpenAPI spec (REST), WSDL (SOAP) or AsyncAPI document (WebSocket), call your implementation, and check every response or message against the contract.' },
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
      SETTINGS = null;
      await loadCurlCtx().catch((e) => { if (e.status === 401) throw e; });
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
    el.append(header('Overview', o.baseUrl, h('a', { class: 'btn', href: '/app/', target: '_blank', rel: 'noopener', title: 'Business-style view of the mock data: KPIs, browse, create, edit and delete records' }, 'Back office app ↗'), h('a', { class: 'btn', href: '/docs', target: '_blank', rel: 'noopener' }, 'API docs ↗')));
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
      h('div', { class: 'card' }, titled('Endpoints', 'overview.endpoints'),
        h('table', null, h('tbody', null, Object.entries(o.urls).map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, v)), h('td', null, h('button', { class: 'small', onclick: () => copy(v) }, 'copy'))))))),
      h('div', { class: 'card' }, titled('Data', 'overview.data'),
        kv({ ...o.counts, files: o.files, 'inspector captures': o.inspector, 'last seed': o.lastSeed ? `${fmtDate(o.lastSeed.at)} (seed ${o.lastSeed.seed})` : 'never' }))));
    const quick = CURL ? window.ATT_GUIDES.build(CURL)['overview.curls'].curls.map(([, cmd]) => cmd) : o.curls;
    el.append(h('div', { class: 'card' }, titled('Quick curls', 'overview.curls'), h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `Built for the active auth mode (${o.authMode}) and any required headers.`), quick.map((c) => h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'nowrap' } }, h('pre', { style: { flex: '1' } }, c), h('button', { class: 'small', onclick: () => copy(c) }, 'copy')))));
  };

  VIEWS.settings = async (el) => {
    await loadSettings();
    const data = await api('GET', '/settings');
    el.append(header('Settings', 'Env sets defaults; dashboard changes override them and persist in the database.',
      tip('settings'),
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
      h('div', { class: 'card stack' }, titled('Reset & re-seed', 'data.seed'),
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
      h('div', { class: 'card stack' }, titled('Preview & API access', 'data.preview'), field('Resource', which), preview)));
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
    const filterSource = h('select', { 'aria-label': 'Source' },
      [['', 'All sources'], ['catch-all', 'Webhooks / other paths'], ['v1', 'Mock API (/v1)'], ['soap', 'SOAP (/soap)'], ['ws', 'WebSocket (/ws)'], ['sse', 'SSE (/sse)'], ['graphql', 'GraphQL (/graphql)'], ['odata', 'OData (/odata)'], ['s3', 'S3 API (/<bucket>)'], ['oauth', 'OAuth (/oauth)']].map(([v, l]) => h('option', { value: v }, l)));
    const live = h('span', { class: 'live-dot' });
    const count = h('span', { class: 'muted small' });
    const logAll = h('input', { type: 'checkbox', checked: !!sval('inspectorLogAll') });
    logAll.addEventListener('change', guard(async () => {
      await api('PUT', '/settings', { inspectorLogAll: logAll.checked });
      await loadSettings(true);
      toast(logAll.checked ? 'Recording /v1 and /oauth calls' : 'Only webhooks / other paths are recorded now', 'ok');
    }));
    const SOURCE_LABEL = { v1: '/v1', oauth: 'OAuth' };

    const matches = (it) => {
      if (filterMethod.value && it.method !== filterMethod.value) return false;
      if (filterSource.value && (it.kind || 'catch-all') !== filterSource.value) return false;
      const q = filterText.value.trim().toLowerCase();
      if (!q) return true;
      return JSON.stringify(it).toLowerCase().includes(q);
    };
    // Delete one capture. The SSE 'delete' event updates every open dashboard; dropping it locally keeps this one snappy.
    const dropLocal = (id) => {
      items = items.filter((x) => x.id !== id);
      if (selected === id) { selected = null; history.replaceState(null, '', '#/inspector'); showDetail(null); }
      renderList();
    };
    const removeCapture = guard(async (id) => {
      await api('DELETE', `/inspector/${encodeURIComponent(id)}`);
      dropLocal(id);
      toast('Capture deleted', 'ok');
    });
    const renderList = () => {
      clear(listEl);
      const shown = items.filter(matches);
      count.textContent = `${shown.length} of ${items.length}`;
      if (!shown.length) listEl.append(h('div', { class: 'empty' }, items.length ? 'No captures match the filter.' : `No requests captured yet. Send a webhook to any unreserved path (e.g. ${location.origin}/hooks/test)${logAll.checked ? ' or call the mock API under /v1' : ''}.`));
      for (const it of shown) {
        listEl.append(h('div', { class: `list-item ${it.id === selected ? 'active' : ''}`, onclick: () => { selected = it.id; history.replaceState(null, '', `#/inspector/${it.id}`); renderList(); showDetail(it.id); } },
          method(it.method),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'path', title: it.path }, it.path + (it.query && Object.keys(it.query).length ? `?${new URLSearchParams(it.query)}` : '')),
            h('div', { class: 'small muted' }, `${fmtTime(it.ts)} · ${it.ip || ''} · ${fmtBytes(it.size)}${it.durationMs != null ? ` · ${it.durationMs} ms` : ''}${it.rule ? ` · ${it.rule}` : ''}`)),
          h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } },
            SOURCE_LABEL[it.kind] ? h('span', { class: 'badge' }, SOURCE_LABEL[it.kind]) : null,
            h('span', { class: statusClass(it.aborted ? null : it.status), title: it.aborted ? 'The connection closed before the response finished' : '' }, it.aborted ? `${it.status ?? ''} dropped`.trim() : (it.status ?? '…')),
            h('button', { class: 'icon-btn del', title: 'Delete this capture', 'aria-label': 'Delete this capture', onclick: (ev) => { ev.stopPropagation(); removeCapture(it.id); } }, '×'))));
      }
    };
    const showBody = (b, title) => {
      if (!b || b.kind === 'empty') return h('div', { class: 'muted small' }, `${title}: empty`);
      if (b.kind === 'streamed') return h('div', { class: 'muted small' }, `${title}: ${b.size ? fmtBytes(b.size) : 'chunked'} streamed to the file store (not kept by the Inspector)`);
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
        response: () => (e.response ? h('div', { class: 'stack' }, h('div', null, 'Status ', h('b', { class: statusClass(e.response.status) }, e.response.status ?? 'none'), e.response.rule ? h('span', { class: 'badge' }, e.response.rule) : null, ` · ${e.durationMs ?? '?'} ms`),
          e.response.aborted ? h('div', { class: 'help-box' }, 'The connection closed before the response finished (chaos drop/timeout, or the client gave up). What was sent so far is shown below.') : null,
          h('h3', null, 'Headers'), kv(e.response.headers), showBody(e.response.body, 'Body'),
          e.forward ? h('div', null, h('h3', null, 'Forwarded'), codeBlock(pretty({ url: e.forward.url, status: e.forward.status, error: e.forward.error, durationMs: e.forward.durationMs }))) : null) : h('div', { class: 'muted' }, 'Pending…')),
        curl: () => h('div', { class: 'stack' }, codeBlock(e.curl), h('button', { onclick: () => copy(e.curl) }, 'Copy curl')),
        replay: () => h('div', { class: 'stack' }, h('div', { class: 'row' }, tip('inspector.replay', { captureId: e.id }), h('span', { class: 'small muted' }, 'How to replay')), field('Replay to', replayTarget, 'Leave blank to replay against this server (same path). A full URL with a path replaces the path.'),
          h('button', { class: 'primary', onclick: guard(async () => {
            clear(replayOut).append(h('div', { class: 'muted' }, 'Sending…'));
            const r = await api('POST', `/inspector/${encodeURIComponent(e.id)}/replay`, { targetUrl: replayTarget.value || undefined });
            clear(replayOut).append(r.error ? h('div', { style: { color: 'var(--err)' } }, `${r.url}: ${r.error}`) : h('div', { class: 'stack' }, h('div', null, `${r.url} → `, h('b', { class: statusClass(r.status) }, r.status), ` in ${r.durationMs} ms`), kv(r.headers), showBody(r.body, 'Response body')));
          }) }, 'Replay'), replayOut),
      };
      const draw = (k) => { clear(pane).append(views[k]()); };
      detailEl.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'row' }, method(e.method), h('code', null, e.path)),
          h('div', { class: 'row' }, h('span', { class: 'muted small' }, fmtDate(e.ts)), h('button', { class: 'danger small', onclick: () => removeCapture(e.id) }, 'Delete'))),
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
    es.addEventListener('delete', (ev) => { const { id } = JSON.parse(ev.data); if (items.some((x) => x.id === id) || selected === id) dropLocal(id); });
    es.addEventListener('clear', () => { items = []; selected = null; renderList(); showDetail(null); });

    filterText.addEventListener('input', renderList);
    filterMethod.addEventListener('change', renderList);
    filterSource.addEventListener('change', renderList);

    const fwdEnabled = h('input', { type: 'checkbox', checked: sval('inspectorForwardEnabled') });
    const fwdUrl = h('input', { type: 'url', value: sval('inspectorForwardUrl') || '', placeholder: 'https://example.com/webhooks' });

    el.append(header('Inspector', 'Every call to this server, live: webhooks to any unreserved path, plus mock API (/v1) and OAuth calls.',
      live, count,
      h('label', { class: 'check', title: 'INSPECTOR_LOG_ALL' }, logAll, 'Record /v1 & /oauth'),
      h('a', { class: 'btn', href: '/admin/api/inspector/export' }, 'Export JSON'),
      h('button', { class: 'danger', onclick: guard(async () => { if (!confirm('Clear all captured requests?')) return; await api('DELETE', '/inspector'); }) }, 'Clear')));
    el.append(h('div', { class: 'card' }, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, tip('inspector.capture'), filterSource, filterMethod, filterText),
      h('details', { style: { marginTop: '10px' } }, h('summary', null, 'Default response, rules & forwarding'),
        h('div', { class: 'grid cols-2', style: { marginTop: '10px' } },
          h('div', null, h('h3', { class: 'with-tip' }, 'Default response', tip('inspector.rules')), settingsForm(['inspectorResponseStatus', 'inspectorResponseContentType', 'inspectorResponseBody', 'inspectorResponseHeaders', 'inspectorResponseDelayMs'])),
          h('div', null, h('h3', { class: 'with-tip' }, 'Path rules (first match wins)', tip('inspector.rules')), settingsForm(['inspectorRules']),
            h('div', { class: 'small muted' }, 'Rule: {"method":"POST","path":"/hooks/{name}","status":202,"contentType":"application/json","body":{"ok":true,"hook":"{{params.name}}"},"headers":[{"name":"X-Demo","value":"{{uuid}}"}],"delayMs":0}. Paths support *, ** and {param}; templates: {{uuid}} {{now}} {{id}} {{path}} {{params.x}} {{query.x}} {{body.x}} {{baseUrl}}.'),
            h('h3', { class: 'with-tip' }, 'Auto-forward', tip('inspector.forward')), h('label', { class: 'check' }, fwdEnabled, 'Forward every capture'), field('Forward URL (path is appended)', fwdUrl),
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
    const fileExtra = list[0] ? { fileId: list[0].id, fileName: list[0].name } : {};
    el.append(h('div', { class: 'card row' }, tip('files.upload', fileExtra), input, h('button', { class: 'primary', onclick: guard(async () => {
      for (const file of input.files) {
        await api('POST', '/files/upload', file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
      }
      toast(`Uploaded ${input.files.length} file(s)`, 'ok');
      route();
    }) }, 'Upload')));
    el.append(h('div', { class: 'card table-wrap' }, titled('File pool', 'files.download', fileExtra), list.length ? h('table', null, h('thead', null, h('tr', null, ['Name', 'Type', 'Size', 'Source', 'SHA-256', ''].map((x) => h('th', null, x)))), tbody) : h('div', { class: 'empty' }, 'No files yet.')));
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
      h('div', { class: 'card stack' }, titled('Mode & credentials', 'auth.mode'), settingsForm(['authMode', 'apiKey', 'apiKeyName', 'apiKeyIn', 'basicUser', 'basicPass', 'bearerToken', 'jwtAlg', 'jwtIssuer', 'jwtAudience', 'hmacKeyId', 'hmacSecret', 'hmacMaxSkewSeconds'], { onSaved: route })),
      h('div', null,
        h('div', { class: 'card stack' }, titled('Get a test token', 'auth.token'), field('Client', clientSel), field('Scope', scope),
          h('button', { class: 'primary', onclick: guard(async () => {
            const t = await api('POST', '/auth/test-token', { clientId: clientSel.value, scope: scope.value || undefined });
            clear(tokenOut).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, h('b', null, `expires in ${t.expires_in}s`), h('button', { class: 'small', onclick: () => copy(t.access_token) }, 'Copy token'), h('button', { class: 'small', onclick: () => copy(`Authorization: Bearer ${t.access_token}`) }, 'Copy header')),
              codeBlock(t.access_token), codeBlock(pretty(t.decoded))));
          }) }, 'Issue token'), tokenOut,
          h('div', { class: 'small muted' }, 'curl:'), codeBlock(`curl -s -u '${a.clients[0]?.clientId || 'demo-client'}:${a.clients[0]?.secret || 'demo-secret'}' -d grant_type=client_credentials -d scope="read write" '${a.oauth.tokenUrl}'`)),
        h('div', { class: 'card' }, titled('OAuth server', 'auth.server'), kv({ token: a.oauth.tokenUrl, authorize: a.oauth.authorizeUrl, metadata: a.oauth.metadata, jwks: a.jwt.jwks, issuer: a.jwt.issuer, audience: a.jwt.audience, alg: a.jwt.alg, 'demo users': a.oauth.users.join(', ') })))));
    el.append(h('div', { class: 'card' }, titled('OAuth clients', 'auth.clients'),
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
    el.append(h('div', { class: 'card stack' }, titled('HMAC signer', 'auth.hmac'),
      h('div', { class: 'small muted' }, 'Canonical string: METHOD \\n PATH+QUERY \\n X-Timestamp \\n hex(SHA-256(body)). Signature: base64(HMAC-SHA256(secret, canonical)).'),
      h('div', { class: 'grid cols-3' }, field('Method', hmacMethod), field('Path + query', hmacPath)), field('Body', hmacBody),
      h('button', { onclick: guard(async () => {
        const r = await api('POST', '/auth/hmac-sign', { method: hmacMethod.value, path: hmacPath.value, body: hmacBody.value || undefined });
        clear(hmacOut).append(h('div', { class: 'stack' }, h('div', { class: 'small muted' }, 'Canonical string (valid for the skew window):'), codeBlock(r.canonical), kv(r.headers),
          h('button', { class: 'small', onclick: () => copy(`curl -s '${location.origin}${hmacPath.value}' -X ${hmacMethod.value} -H 'Authorization: ${r.headers.Authorization}' -H 'X-Timestamp: ${r.headers['X-Timestamp']}'${hmacBody.value ? ` -H 'Content-Type: application/json' --data-binary '${hmacBody.value.replace(/'/g, "'\\''")}'` : ''}`) }, 'Copy curl')));
      }) }, 'Sign'), hmacOut));
  };

  // ---------------------------------------------------------------- webhooks
  VIEWS.webhooks = async (el) => {
    await loadSettings();
    const RES = ['employees', 'products', 'departments', 'categories'];
    const EVS = ['created', 'updated', 'deleted', 'uploaded', 'downloaded'];
    const data = await api('GET', '/webhooks');
    const hooks = data.items;
    el.append(header('Webhooks', 'POST to your URLs when mock data is created, updated or deleted, or a file is uploaded, downloaded or deleted, through any protocol.'));
    if (!data.enabled) el.append(h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, h('b', null, 'Deliveries are paused'), ' — webhooksEnabled is off in the settings below. Definitions are kept.'));

    // ---- form (add or edit)
    let editing = null;
    const name = h('input', { type: 'text', placeholder: 'e.g. New employees to my integration' });
    const url = h('input', { type: 'text', class: 'mono', placeholder: 'https://your-integration.example.com/hooks/employees' });
    const allRes = h('input', { type: 'checkbox', checked: true });
    const resBoxes = Object.fromEntries(RES.map((r) => [r, h('input', { type: 'checkbox' })]));
    const filesBox = h('input', { type: 'checkbox' });
    const DEFAULT_EVS = ['created', 'updated'];
    const evBoxes = Object.fromEntries(EVS.map((e) => [e, h('input', { type: 'checkbox', checked: DEFAULT_EVS.includes(e) })]));
    const includeData = h('input', { type: 'checkbox' });
    const enabled = h('input', { type: 'checkbox', checked: true });
    const secret = h('input', { type: 'text', class: 'mono', placeholder: 'optional: signs each delivery (X-Webhook-Signature)' });
    const headersIn = h('textarea', { rows: 3, class: 'mono', spellcheck: 'false', placeholder: 'optional, one per line:\nX-API-Key: your-integration-key' });
    const formTitle = h('span', null, 'Add a webhook');
    const saveBtn = h('button', { class: 'primary' }, 'Add webhook');
    const cancelBtn = h('button', { style: { display: 'none' } }, 'Cancel edit');
    const syncRes = () => { for (const b of Object.values(resBoxes)) b.disabled = allRes.checked; };
    allRes.addEventListener('change', syncRes);
    syncRes();
    const check = (box, label) => h('label', { class: 'check' }, box, h('span', null, label));
    const reset = () => {
      editing = null;
      name.value = ''; url.value = ''; secret.value = ''; headersIn.value = '';
      allRes.checked = true; filesBox.checked = false; for (const b of Object.values(resBoxes)) b.checked = false;
      for (const [e, b] of Object.entries(evBoxes)) b.checked = DEFAULT_EVS.includes(e);
      includeData.checked = false; enabled.checked = true;
      secret.placeholder = 'optional: signs each delivery (X-Webhook-Signature)';
      formTitle.textContent = 'Add a webhook'; saveBtn.textContent = 'Add webhook'; cancelBtn.style.display = 'none';
      syncRes();
    };
    const edit = (hk) => {
      editing = hk;
      name.value = hk.name || ''; url.value = hk.url;
      allRes.checked = hk.resources.includes('*');
      for (const [r, b] of Object.entries(resBoxes)) b.checked = hk.resources.includes(r);
      filesBox.checked = hk.resources.includes('files');
      for (const [e, b] of Object.entries(evBoxes)) b.checked = hk.events.includes(e);
      includeData.checked = hk.includeData; enabled.checked = hk.enabled;
      secret.value = '';
      secret.placeholder = hk.hasSecret ? 'a secret is set — leave blank to keep it, type a new one to replace it' : 'optional: signs each delivery (X-Webhook-Signature)';
      headersIn.value = Object.entries(hk.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
      formTitle.textContent = `Edit “${hk.name}”`; saveBtn.textContent = 'Save changes'; cancelBtn.style.display = '';
      syncRes();
      formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    cancelBtn.addEventListener('click', reset);
    saveBtn.addEventListener('click', guard(async () => {
      const headers = {};
      for (const line of headersIn.value.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const i = line.indexOf(':');
        if (i < 1) throw new Error(`Header line "${line}" needs the form Name: value`);
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const body = {
        name: name.value.trim() || undefined,
        url: url.value.trim(),
        resources: [...(allRes.checked ? ['*'] : RES.filter((r) => resBoxes[r].checked)), ...(filesBox.checked ? ['files'] : [])],
        events: EVS.filter((e) => evBoxes[e].checked),
        includeData: includeData.checked,
        enabled: enabled.checked,
        headers,
      };
      if (secret.value) body.secret = secret.value;
      if (editing) { await api('PATCH', `/webhooks/${editing.id}`, body); toast('Webhook saved', 'ok'); }
      else { await api('POST', '/webhooks', body); toast('Webhook added', 'ok'); }
      route();
    }));
    const formCard = h('div', { class: 'card stack' }, titled(formTitle, 'webhooks.form'),
      h('div', { class: 'grid cols-2' }, field('Name', name), field('URL (receives a POST)', url)),
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => { url.value = `${location.origin}/hooks/webhook-test`; } }, 'Use this tool\'s inspector as the receiver'),
        h('span', { class: 'small muted' }, 'Handy for a first look: deliveries then appear on the Inspector page.')),
      h('div', { class: 'grid cols-2' },
        h('div', null, h('div', { class: 'small muted' }, 'Data resources'), h('div', { class: 'row' }, check(allRes, 'All'), RES.map((r) => check(resBoxes[r], r))),
          h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'File pool'), h('div', { class: 'row' }, check(filesBox, 'files'))),
        h('div', null, h('div', { class: 'small muted' }, 'Events'), h('div', { class: 'row' }, EVS.map((e) => check(evBoxes[e], e))),
          h('div', { class: 'small muted' }, 'created and updated apply to data, uploaded and downloaded to files, deleted to both.'))),
      h('div', { class: 'row' }, check(includeData, 'Include the record as "data"'), check(enabled, 'Enabled')),
      h('div', { class: 'grid cols-2' }, field('Signing secret', secret), field('Extra headers', headersIn)),
      h('div', { class: 'row' }, saveBtn, cancelBtn));

    // ---- list
    const lastBadge = (d) => (!d ? h('span', { class: 'muted small' }, 'never')
      : h('span', { title: `${d.event} · ${fmtDate(d.at)}${d.error ? ` · ${d.error}` : ''}` }, h('span', { class: d.ok ? 'badge pass' : 'badge fail' }, d.status ?? 'error'), h('span', { class: 'small muted' }, ` ${fmtDate(d.at)}`)));
    const listCard = h('div', { class: 'card' }, titled('Webhooks', 'webhooks.list'),
      !hooks.length ? h('p', { class: 'muted' }, 'No webhooks yet. Add one below.')
        : h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Name', 'On', 'Resources', 'Events', 'URL', 'Last delivery', ''].map((x) => h('th', null, x)))),
          h('tbody', null, hooks.map((hk) => h('tr', null,
            h('td', null, h('b', null, hk.name), hk.hasSecret ? h('div', { class: 'small muted' }, 'signed') : null),
            h('td', null, h('input', { type: 'checkbox', checked: hk.enabled, 'aria-label': 'Enabled', onchange: guard(async (e) => { await api('PATCH', `/webhooks/${hk.id}`, { enabled: e.target.checked }); toast(e.target.checked ? 'Enabled' : 'Disabled', 'ok'); }) })),
            h('td', null, hk.resources.map((r) => (r === '*' ? 'all data' : r)).join(', ')),
            h('td', null, hk.events.join(', '), hk.includeData ? h('div', { class: 'small muted' }, '+ data') : null),
            h('td', { class: 'mono small', style: { wordBreak: 'break-all', minWidth: '180px' } }, hk.url),
            h('td', null, lastBadge(hk.lastDelivery)),
            h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
              h('button', { class: 'small', onclick: guard(async () => { const d = await api('POST', `/webhooks/${hk.id}/test`, {}); toast(d.ok ? `Test delivered: ${d.status}` : `Test failed: ${d.status ?? d.error}`, d.ok ? 'ok' : 'err'); route(); }) }, 'Test'),
              h('button', { class: 'small', onclick: () => edit(hk) }, 'Edit'),
              h('button', { class: 'small danger', onclick: guard(async () => { if (!window.confirm(`Delete webhook “${hk.name}”?`)) return; await api('DELETE', `/webhooks/${hk.id}`); route(); }) }, 'Delete')))))))));

    el.append(listCard);
    el.append(h('div', { class: 'grid cols-2' }, formCard,
      h('div', { class: 'card' }, titled('Webhook settings', 'webhooks.settings'), settingsForm(['webhooksEnabled', 'webhookTimeoutMs', 'webhookDeliveryRetention'], { onSaved: () => route() }),
        h('h3', null, 'What your URL receives'),
        codeBlock(`POST <your URL>\nContent-Type: application/json\nX-Webhook-Event: employees.created\nX-Webhook-Delivery: dlv_…\nX-Webhook-Timestamp: 1767225600\nX-Webhook-Signature: sha256=…   (with a secret)\n\n${JSON.stringify({ id: 'dlv_…', event: 'employees.created', type: 'created', resource: 'employees', resourceId: 42, href: `${location.origin}/v1/employees/42`, occurredAt: '2026-01-01T00:00:00.000Z', webhookId: 'wh_…' }, null, 2)}`),
        h('div', { class: 'small muted' }, 'A file event (resource "files") also says how it happened and describes the file:'),
        codeBlock(JSON.stringify({ event: 'files.downloaded', resource: 'files', resourceId: 'f_Xq3…', href: `${location.origin}/v1/files/f_Xq3…`, via: 'download', file: { name: 'report.pdf', contentType: 'application/pdf', size: 48213 }, status: 206, range: 'bytes 0-1023/48213', bytes: 1024 }, null, 2)))));

    // ---- deliveries
    const filter = h('select', { 'aria-label': 'Webhook' }, h('option', { value: '' }, 'All webhooks'), hooks.map((hk) => h('option', { value: hk.id }, hk.name)));
    const tbody = h('tbody');
    const detail = h('div', { class: 'stack' });
    const loadDeliveries = async () => {
      const q = filter.value ? `?webhookId=${encodeURIComponent(filter.value)}` : '';
      const { items } = await api('GET', `/webhooks/deliveries${q}`);
      clear(tbody).append(...(items.length ? items : [null]).map((d) => (!d ? h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No deliveries yet. Change a record, or press Test on a webhook.'))
        : h('tr', null,
          h('td', { class: 'small' }, fmtDate(d.at)),
          h('td', null, d.webhookName, d.test ? h('span', { class: 'badge' }, 'test') : null, d.redeliveryOf ? h('span', { class: 'badge' }, 'resent') : null),
          h('td', { class: 'mono small' }, d.event),
          h('td', null, String(d.resourceId)),
          h('td', null, h('span', { class: d.ok ? 'badge pass' : 'badge fail', title: d.error || '' }, d.status ?? 'error')),
          h('td', { class: 'small muted' }, `${d.durationMs} ms`),
          h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
            h('button', { class: 'small', onclick: () => clear(detail).append(
              h('div', { class: 'row between' }, h('b', null, `${d.event} → ${d.url}`), h('button', { class: 'small', onclick: () => clear(detail) }, 'Close')),
              d.error ? h('div', { style: { color: 'var(--err)' } }, d.error) : null,
              h('h3', null, 'Request headers'), kv(d.request.headers),
              h('h3', null, 'Request body'), codeBlock(JSON.stringify(d.request.body, null, 2)),
              d.response ? h('div', null, h('h3', null, `Response ${d.status}`), kv(d.response.headers), codeBlock(d.response.body || '(empty)', { maxHeight: '240px' })) : null) }, 'Details'),
            h('button', { class: 'small', onclick: guard(async () => { const r = await api('POST', `/webhooks/deliveries/${d.id}/redeliver`); toast(r.ok ? `Resent: ${r.status}` : `Resend failed: ${r.status ?? r.error}`, r.ok ? 'ok' : 'err'); loadDeliveries(); }) }, 'Resend')))))));
    };
    filter.addEventListener('change', guard(loadDeliveries));
    el.append(h('div', { class: 'card stack' }, titled('Deliveries', 'webhooks.deliveries'),
      h('div', { class: 'row' }, field('Show', filter), h('button', { class: 'small', onclick: guard(loadDeliveries) }, 'Refresh'),
        h('button', { class: 'small danger', onclick: guard(async () => { await api('DELETE', '/webhooks/deliveries'); loadDeliveries(); }) }, 'Clear log'),
        h('span', { class: 'small muted' }, 'Refreshes every 5 seconds while this page is open. One attempt per event; failed deliveries are not retried automatically.')),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Time', 'Webhook', 'Event', 'Id', 'Status', 'Time taken', ''].map((x) => h('th', null, x)))), tbody)),
      detail));
    await loadDeliveries();
    const timer = setInterval(() => { loadDeliveries().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  };

  // ---------------------------------------------------------------- chaos
  VIEWS.chaos = async (el) => {
    await loadSettings();
    el.append(header('Chaos', 'Random error and latency injection for /v1/*, plus deterministic forcing headers.'));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('Rates & latency', 'chaos.rates'), settingsForm(['errorRate', 'errorTypes', 'latencyMinMs', 'latencyMaxMs', 'chaosTimeoutSeconds', 'chaosSlowDripMs', 'rateLimitRpm'])),
      h('div', null,
        h('div', { class: 'card' }, titled('Per-route overrides', 'chaos.routes'), settingsForm(['chaosRouteOverrides']),
          h('div', { class: 'small muted' }, 'Example: [{"path":"/v1/products","errorRate":50,"errorTypes":"503,timeout"},{"path":"/v1/files","method":"POST","latencyMinMs":500,"latencyMaxMs":2000}]')),
        h('div', { class: 'card' }, titled('Forcing headers (always win)', 'chaos.force'),
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
      h('div', { class: 'card' }, titled('Response headers', 'headers.response'), settingsForm(['responseHeaders']), h('div', { class: 'small muted' }, 'JSON list: [{"name":"X-Env","value":"demo"}]. Env format: Name:Value;Name2:Value2')),
      h('div', { class: 'card' }, titled('Required request headers', 'headers.required'), settingsForm(['requiredHeaders']), h('div', { class: 'small muted' }, 'JSON list: [{"name":"X-Tenant"},{"name":"X-Env","value":"demo"}]. Missing or wrong values return 400 problem+json. Env format: X-Tenant,X-Env=demo'))));
  };

  // ---------------------------------------------------------------- protocols
  // Indent XML for display (responses are single-line).
  function prettyXml(xml) {
    let depth = 0;
    return String(xml).replace(/>\s*</g, '>\n<').split('\n').map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line)) depth += 1;
      return out;
    }).join('\n');
  }

  // Credentials for a call from the browser, following the active auth mode (as the guides do for curl).
  async function protocolAuthHeaders(methodName, path, bodyText) {
    const c = CURL?.ctx;
    const hdrs = {};
    if (!c) return hdrs;
    for (const r of c.required || []) hdrs[r.name] = r.value ?? 'test';
    switch (c.mode) {
      case 'apikey':
        if (c.apiKey.in === 'header') hdrs[c.apiKey.name] = c.apiKey.value;
        break;
      case 'basic': hdrs.Authorization = `Basic ${btoa(`${c.basic.user}:${c.basic.pass}`)}`; break;
      case 'bearer': hdrs.Authorization = `Bearer ${c.bearer}`; break;
      case 'jwt':
      case 'oauth2': {
        const cl = c.client || { clientId: 'demo-client', secret: 'demo-secret' };
        const r = await fetch('/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${cl.clientId}:${cl.secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=read%20write' });
        const tok = await r.json().catch(() => ({}));
        if (!tok.access_token) throw new Error(`Token request failed (${r.status})`);
        hdrs.Authorization = `Bearer ${tok.access_token}`;
        break;
      }
      case 'hmac': {
        if (!window.crypto?.subtle) throw new Error('HMAC signing needs a secure context (https or localhost); use the curl from the guide instead');
        const enc = new TextEncoder();
        const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const ts = String(Math.floor(Date.now() / 1000));
        const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(bodyText || '')));
        const key = await crypto.subtle.importKey('raw', enc.encode(c.hmac.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode([methodName, path, ts, bodyHash].join('\n')));
        hdrs.Authorization = `HMAC ${c.hmac.keyId}:${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
        hdrs['X-Timestamp'] = ts;
        break;
      }
      default: break;
    }
    return hdrs;
  }

  VIEWS.protocols = async (el) => {
    await loadSettings();
    el.append(header('Protocols', 'The same mock data over other protocols, and the file pool as an S3 bucket. Auth, chaos, rate limits and required headers work as on /v1 (the S3 API signs with its own keys).'));
    const soapOn = !!sval('soapEnabled');
    const listing = soapOn ? await fetch('/soap', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    const services = listing?.services || [];

    const servicesCard = h('div', { class: 'card' }, titled('SOAP services', 'protocols.soap'),
      !soapOn ? h('p', { class: 'muted' }, 'The SOAP mock is off. Turn on soapEnabled in the settings next to this card.')
        : h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', null, 'Endpoint'), h('th', null, 'WSDL'), h('th', null, 'Operations'))),
          h('tbody', null, services.map((sv) => h('tr', null,
            h('td', null, h('b', null, sv.name), h('div', { class: 'small muted' }, sv.title)),
            h('td', null, h('code', null, sv.endpoint), ' ', h('button', { class: 'small', onclick: () => copy(sv.endpoint) }, 'copy')),
            h('td', null, h('a', { href: sv.wsdl, target: '_blank', rel: 'noopener' }, 'open ↗'), ' ', h('button', { class: 'small', onclick: () => copy(sv.wsdl) }, 'copy')),
            h('td', null, h('span', { title: sv.operations.map((o) => o.name).join(', ') }, String(sv.operations.length)))))))),
      soapOn ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'SOAP 1.1: text/xml + SOAPAction header. SOAP 1.2: application/soap+xml; action="…". Faults carry an f:faultDetail with status, code, requestId and field errors.') : null);

    const settingsCard = h('div', { class: 'card' }, titled('SOAP settings', 'protocols.soap-settings'),
      settingsForm(['soapEnabled', 'soapWsse', 'soapActionCheck'], { onSaved: () => route() }));
    el.append(h('div', { class: 'grid cols-2' }, servicesCard, settingsCard));

    if (services.length) soapTry(el, services);
    const wsCleanup = await wsSection(el);
    const sseCleanup = await sseSection(el);
    graphqlSection(el);
    odataSection(el);
    await s3Section(el);
    return () => { wsCleanup?.(); sseCleanup?.(); }; // close the live consoles when leaving the page
  };

  // ---- S3-compatible API: connection details, settings and a console that signs requests in the browser.
  const textEnc = new TextEncoder();
  const awsEncode = (str) => encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function sha256Hex(text) { return toHex(await crypto.subtle.digest('SHA-256', textEnc.encode(text))); }
  async function hmacSha256(key, data) {
    const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? textEnc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, textEnc.encode(data));
  }
  // AWS Signature V4 for a GET/HEAD with no body, as an S3 SDK would sign it.
  async function s3SignedHeaders(method, path, pairs, c) {
    const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amz.slice(0, 8);
    const payload = await sha256Hex('');
    const query = pairs.map(([k, v]) => [awsEncode(k), awsEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const canonical = [method, path, query, `host:${location.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amz}\n`, 'host;x-amz-content-sha256;x-amz-date', payload].join('\n');
    const scope = `${date}/${c.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonical)].join('\n');
    let key = await hmacSha256(`AWS4${c.secretAccessKey}`, date);
    for (const part of [c.region, 's3', 'aws4_request']) key = await hmacSha256(key, part);
    const sig = toHex(await hmacSha256(key, sts));
    return { query, headers: { 'x-amz-date': amz, 'x-amz-content-sha256': payload, Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}` } };
  }

  async function s3Section(el) {
    const on = !!sval('s3ApiEnabled');
    const a = await api('GET', '/auth').catch(() => null);
    const c = a?.s3 || { endpoint: location.origin, bucket: sval('s3ApiBucket'), region: sval('s3ApiRegion'), accessKeyId: sval('s3ApiAccessKeyId'), secretAccessKey: sval('s3ApiSecretAccessKey') };
    const secretEl = h('code', null, '••••••••');
    let shown = false;
    const rows = [
      ['Endpoint', h('span', null, h('code', null, c.endpoint), ' ', h('button', { class: 'small', onclick: () => copy(c.endpoint) }, 'copy'))],
      ['Bucket', h('span', null, h('code', null, c.bucket), ' ', h('button', { class: 'small', onclick: () => copy(c.bucket) }, 'copy'))],
      ['Region', h('span', null, h('code', null, c.region), ' ', h('button', { class: 'small', onclick: () => copy(c.region) }, 'copy'))],
      ['Access key ID', h('span', null, h('code', null, c.accessKeyId), ' ', h('button', { class: 'small', onclick: () => copy(c.accessKeyId) }, 'copy'))],
      ['Secret access key', h('span', null, secretEl, ' ', h('button', { class: 'small', onclick: (e) => { shown = !shown; secretEl.textContent = shown ? c.secretAccessKey : '••••••••'; e.target.textContent = shown ? 'hide' : 'show'; } }, 'show'), ' ', h('button', { class: 'small', onclick: () => copy(c.secretAccessKey) }, 'copy'))],
      ['Addressing', h('span', null, 'path-style ', h('span', { class: 'small muted' }, `(${c.endpoint}/${c.bucket}/<key>)`))],
    ];
    const demo = c.accessKeyId === 'demo-access-key' || c.secretAccessKey === 'demo-secret-key';
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('S3-compatible API', 'protocols.s3'),
        !on ? h('p', { class: 'muted' }, 'The S3 API is off. Turn on s3ApiEnabled in the settings next to this card.')
          : h('div', { class: 'stack' },
            h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('div', null, k), h('div', null, v)])),
            demo ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, 'Still using the demo keys: change them in the settings before you share this URL.') : null,
            h('div', { class: 'small muted' }, 'The whole file pool is one bucket, keyed by file name; it works the same with local storage or S3 behind the tool. Requests are signed with AWS Signature V4 (header or presigned URL) instead of the active auth mode. Lists, get/head with Range, put (incl. streaming and checksums), copy, delete, multipart uploads; errors in the S3 XML format.'))),
      h('div', { class: 'card' }, titled('S3 API settings', 'protocols.s3-settings'),
        settingsForm(['s3ApiEnabled', 's3ApiBucket', 's3ApiRegion', 's3ApiAccessKeyId', 's3ApiSecretAccessKey'], { onSaved: () => { loadCurlCtx().catch(() => {}); route(); } }))));
    if (!on) return;

    const op = h('select', { 'aria-label': 'Operation' }, [['list', 'List objects'], ['head', 'HEAD object'], ['get', 'GET object']].map(([v, l]) => h('option', { value: v }, l)));
    const prefixIn = h('input', { type: 'text', class: 'mono', placeholder: 'prefix (optional)', 'aria-label': 'Prefix' });
    const delimIn = h('input', { type: 'text', class: 'mono', value: '/', style: { maxWidth: '80px' }, 'aria-label': 'Delimiter' });
    const keyIn = h('input', { type: 'text', class: 'mono', value: 'employees.csv', 'aria-label': 'Key' });
    const out = h('div', { class: 'stack' });
    const listFields = h('div', { class: 'row' }, field('Prefix', prefixIn), field('Delimiter', delimIn));
    const keyFields = h('div', { class: 'row' }, field('Key', keyIn));
    const sync = () => { listFields.hidden = op.value !== 'list'; keyFields.hidden = op.value === 'list'; };
    op.addEventListener('change', sync);
    sync();
    const send = guard(async (token) => {
      if (!window.crypto?.subtle) throw new Error('Signing needs a secure page (https or localhost); use the curl examples in the guide instead.');
      const listing = op.value === 'list';
      const method = op.value === 'head' ? 'HEAD' : 'GET';
      const path = listing ? `/${awsEncode(c.bucket)}` : `/${awsEncode(c.bucket)}/${keyIn.value.split('/').map(awsEncode).join('/')}`;
      const pairs = listing ? [['list-type', '2'], ['max-keys', '50'], ...(prefixIn.value ? [['prefix', prefixIn.value]] : []), ...(delimIn.value ? [['delimiter', delimIn.value]] : []), ...(typeof token === 'string' ? [['continuation-token', token]] : [])] : [];
      const signed = await s3SignedHeaders(method, path, pairs, c);
      const started = performance.now();
      const res = await fetch(`${path}${signed.query ? `?${signed.query}` : ''}`, { method, headers: signed.headers, credentials: 'omit' });
      const text = method === 'HEAD' ? '' : await res.text();
      const ms = Math.round(performance.now() - started);
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text)?.[1];
      const count = /<KeyCount>(\d+)<\/KeyCount>/.exec(text)?.[1];
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      const shownHeaders = ['content-type', 'content-length', 'etag', 'last-modified', 'x-amz-request-id', 'x-amz-bucket-region', 'x-chaos-injected', 'retry-after'];
      clear(out).append(
        h('div', { class: 'row' }, h('span', { class: statusClass(res.status) }, String(res.status)), h('span', { class: 'muted small' }, `${ms} ms · ${fmtBytes(text.length)}`),
          count !== undefined ? h('span', { class: 'badge' }, `${count} entr${count === '1' ? 'y' : 'ies'}`) : null,
          code ? h('span', { class: 'badge warn' }, code) : null,
          next ? h('button', { class: 'small', onclick: () => send(next) }, 'Next page →') : null),
        h('div', { class: 'small muted mono' }, `${method} ${decodeURIComponent(path)}${signed.query ? `?${decodeURIComponent(signed.query)}` : ''}`),
        kv(Object.fromEntries(shownHeaders.filter((k) => res.headers.get(k)).map((k) => [k, res.headers.get(k)]))),
        text ? h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Response'), h('button', { class: 'small', onclick: () => copy(text) }, 'copy')) : null,
        text ? codeBlock(/^\s*</.test(text) ? prettyXml(text.trim()) : text.slice(0, 20000), { maxHeight: '480px' }) : null);
    });
    el.append(h('div', { class: 'card stack' }, titled('Try the S3 API', 'protocols.s3-try'),
      h('div', { class: 'row' }, field('Operation', op)), listFields, keyFields,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: send }, 'Send'),
        h('span', { class: 'small muted' }, 'Signed in your browser with AWS Signature V4 and the keys above. Uploads and deletes are in the guide\'s curl and AWS CLI examples.')),
      out));
  }

  // OData v4 service, settings and a query console (GET from the browser with the active auth).
  function odataSection(el) {
    const on = !!sval('odataEnabled');
    const root = `${location.origin}/odata/v4`;
    const links = [['Service root', root, true], ['$metadata (CSDL)', `${root}/$metadata`, true]];
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('OData v4', 'protocols.odata'),
        !on ? h('p', { class: 'muted' }, 'The OData mock is off. Turn on odataEnabled in the settings next to this card.')
          : h('div', { class: 'stack' },
            h('div', { class: 'kv' }, links.flatMap(([k, url]) => [h('div', null, k), h('div', null, h('code', null, url), ' ', h('button', { class: 'small', onclick: () => copy(url) }, 'copy'), ' ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'open ↗'))])),
            h('div', { class: 'small muted' }, 'Entity sets Employees, Products, Departments and Categories with $filter, $select, $expand, $orderby, $top, $skip, $count and $search, @odata.nextLink paging, navigation, and create/update/delete with @odata.bind and If-Match. Errors use the OData error format with the real HTTP status.'))),
      h('div', { class: 'card' }, titled('OData settings', 'protocols.odata-settings'),
        settingsForm(['odataEnabled', 'odataMaxPageSize'], { onSaved: () => route() }))));
    if (!on) return;

    const SAMPLES = {
      'Filter + select + count': ['Employees', "$filter=level eq 'L3' and salary gt 90000&$select=firstName,lastName,salary&$orderby=salary desc&$count=true&$top=5"],
      'Expand navigation': ['Departments(1)', '$expand=employees($select=firstName,lastName;$top=3;$count=true)'],
      'Lambda (any)': ['Products', "$filter=tags/any(t: t eq 'new')&$select=name,tags&$top=5"],
      'String functions': ['Employees', "$filter=startswith(tolower(lastName),'a')&$select=firstName,lastName"],
      'Count only': ['Products/$count', '$filter=inStock eq true'],
      'Property value': ['Employees(1)/email/$value', ''],
      'Bad property (400)': ['Employees', '$filter=colour eq 1'],
    };
    const sample = h('select', { 'aria-label': 'Sample' }, Object.keys(SAMPLES).map((k) => h('option', { value: k }, k)));
    const pathIn = h('input', { type: 'text', class: 'mono', style: { maxWidth: '260px' }, 'aria-label': 'Resource path' });
    const queryIn = h('input', { type: 'text', class: 'mono', 'aria-label': 'Query options' });
    const level = h('select', { 'aria-label': 'Metadata' }, ['minimal', 'full', 'none'].map((v) => h('option', { value: v }, v)));
    const pageSize = h('input', { type: 'number', min: '1', placeholder: 'server', style: { maxWidth: '100px' } });
    const out = h('div', { class: 'stack' });
    const load = () => { [pathIn.value, queryIn.value] = SAMPLES[sample.value]; };
    sample.addEventListener('change', load);
    load();

    const send = guard(async (urlOverride) => {
      let path;
      if (typeof urlOverride === 'string') path = urlOverride;
      else {
        const qs = queryIn.value.trim().split('&').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i < 0 ? encodeURIComponent(kv) : `${kv.slice(0, i)}=${encodeURIComponent(kv.slice(i + 1))}`; }).join('&');
        path = `/odata/v4/${pathIn.value.trim().replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
      }
      const hdrs = { Accept: `application/json;odata.metadata=${level.value}`, ...(await protocolAuthHeaders('GET', path, '')) };
      if (pageSize.value) hdrs.Prefer = `odata.maxpagesize=${pageSize.value}`;
      const url = CURL?.ctx?.mode === 'apikey' && CURL.ctx.apiKey.in === 'query' ? `${path}${path.includes('?') ? '&' : '?'}${encodeURIComponent(CURL.ctx.apiKey.name)}=${encodeURIComponent(CURL.ctx.apiKey.value)}` : path;
      const started = performance.now();
      const res = await fetch(url, { headers: hdrs, credentials: 'omit' });
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      let json = null;
      try { json = JSON.parse(text); } catch { /* $count, $value, chaos */ }
      const next = json?.['@odata.nextLink'];
      const shown = ['content-type', 'odata-version', 'etag', 'preference-applied', 'x-chaos-injected', 'www-authenticate', 'retry-after', 'x-request-id'];
      clear(out).append(
        h('div', { class: 'row' }, h('span', { class: statusClass(res.status) }, String(res.status)), h('span', { class: 'muted small' }, `${ms} ms · ${fmtBytes(text.length)}`),
          Array.isArray(json?.value) ? h('span', { class: 'badge' }, `${json.value.length} item${json.value.length === 1 ? '' : 's'}${json['@odata.count'] !== undefined ? ` of ${json['@odata.count']}` : ''}`) : null,
          json?.error ? h('span', { class: 'badge warn' }, json.error.code) : null,
          next ? h('button', { class: 'small', onclick: () => { const u = new URL(next); send(u.pathname + u.search); } }, 'Next page →') : null),
        h('div', { class: 'small muted mono' }, `GET ${decodeURIComponent(path)}`),
        kv(Object.fromEntries(shown.filter((k) => res.headers.get(k)).map((k) => [k, res.headers.get(k)]))),
        h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Response'), h('button', { class: 'small', onclick: () => copy(text) }, 'copy')),
        codeBlock(json ? JSON.stringify(json, null, 2) : text, { maxHeight: '480px' }));
    });

    el.append(h('div', { class: 'card stack' }, titled('Try an OData query', 'protocols.odata-try'),
      h('div', { class: 'row' }, field('Sample', sample), field('Resource path', pathIn), field('Metadata', level), field('Prefer odata.maxpagesize', pageSize)),
      field('Query options (unencoded, & separated)', queryIn),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: send }, 'Send'), h('button', { onclick: load }, 'Reset sample'),
        h('span', { class: 'small muted' }, `Sent from your browser with the active auth mode (${CURL?.mode || 'none'}). Writes (POST, PATCH, PUT, DELETE) are in the guide's curl examples.`)),
      out));
  }

  // GraphQL endpoint, settings and a query console (POST /graphql from the browser with the active auth).
  function graphqlSection(el) {
    const on = !!sval('graphqlEnabled');
    const base = location.origin;
    const links = [
      ['Endpoint', `${base}/graphql`, null],
      ['Schema (SDL)', `${base}/graphql/schema.graphql`, true],
      ['GraphiQL', `${base}/graphql`, true],
      ['Subscriptions', `${base.replace(/^http/, 'ws')}/graphql`, null],
    ];
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('GraphQL', 'protocols.graphql'),
        !on ? h('p', { class: 'muted' }, 'The GraphQL mock is off. Turn on graphqlEnabled in the settings next to this card.')
          : h('div', { class: 'stack' },
            h('div', { class: 'kv' }, links.flatMap(([k, url, open]) => [h('div', null, k), h('div', null, h('code', null, url), ' ', h('button', { class: 'small', onclick: () => copy(url) }, 'copy'),
              open ? h('span', null, ' ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'open ↗')) : null)])),
            h('div', { class: 'small muted' }, 'Queries with offset pages and Relay connections, CRUD mutations, and a changes subscription (graphql-transport-ws). Field errors come back as HTTP 200 with partial data and errors[].extensions.code; auth, rate-limit and chaos errors keep their HTTP status.'))),
      h('div', { class: 'card' }, titled('GraphQL settings', 'protocols.graphql-settings'),
        settingsForm(['graphqlEnabled', 'graphqlIntrospection', 'graphqlMaxDepth'], { onSaved: () => route() }))));
    if (!on) return;

    const SAMPLES = {
      'List employees': ['query Employees($limit: Int = 5) {\n  employees(limit: $limit, sort: "lastName") {\n    total\n    items { id fullName title level department { name } }\n  }\n}', '{ "limit": 5 }'],
      'Relay connection': ['query Products($after: String) {\n  productsConnection(first: 3, after: $after) {\n    totalCount\n    pageInfo { hasNextPage endCursor }\n    edges { cursor node { id name price category { name } } }\n  }\n}', '{}'],
      'Filter': ['{\n  employees(limit: 5, filter: [{ field: "level", value: "L3" }, { field: "salary", op: gte, value: "90000" }], sort: "-salary") {\n    total\n    items { fullName salary level }\n  }\n}', '{}'],
      'Create department': ['mutation Create($input: DepartmentInput!) {\n  createDepartment(input: $input) { id name code }\n}', '{ "input": { "name": "Research", "code": "RND-2" } }'],
      'Validation error': ['mutation {\n  createDepartment(input: { name: "Bad", code: "lower case" }) { id }\n}', '{}'],
    };
    const sample = h('select', { 'aria-label': 'Sample' }, Object.keys(SAMPLES).map((k) => h('option', { value: k }, k)));
    const queryIn = h('textarea', { rows: 10, class: 'mono', spellcheck: 'false', 'aria-label': 'GraphQL query' });
    const varsIn = h('textarea', { rows: 3, class: 'mono', spellcheck: 'false', 'aria-label': 'Variables (JSON)' });
    const fieldErr = h('input', { type: 'text', placeholder: 'e.g. department or Query.employees:503', style: { maxWidth: '260px' } });
    const forceErr = h('input', { type: 'text', placeholder: 'e.g. 503', style: { maxWidth: '140px' } });
    const out = h('div', { class: 'stack' });
    const load = () => { [queryIn.value, varsIn.value] = SAMPLES[sample.value]; };
    sample.addEventListener('change', load);
    load();

    const send = guard(async () => {
      let variables;
      try { variables = varsIn.value.trim() ? JSON.parse(varsIn.value) : undefined; } catch (e) { throw new Error(`Variables are not valid JSON: ${e.message}`); }
      const body = JSON.stringify({ query: queryIn.value, variables });
      const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await protocolAuthHeaders('POST', '/graphql', body)) };
      if (fieldErr.value.trim()) hdrs['X-Force-GraphQL-Error'] = fieldErr.value.trim();
      if (forceErr.value.trim()) hdrs['X-Force-Error'] = forceErr.value.trim();
      const url = CURL?.ctx?.mode === 'apikey' && CURL.ctx.apiKey.in === 'query' ? `/graphql?${encodeURIComponent(CURL.ctx.apiKey.name)}=${encodeURIComponent(CURL.ctx.apiKey.value)}` : '/graphql';
      const started = performance.now();
      const res = await fetch(url, { method: 'POST', headers: hdrs, body, credentials: 'omit' });
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      let json = null;
      try { json = JSON.parse(text); } catch { /* chaos can break the body */ }
      const errs = Array.isArray(json?.errors) ? json.errors : [];
      const shown = ['content-type', 'x-chaos-injected', 'www-authenticate', 'retry-after', 'x-request-id'];
      clear(out).append(
        h('div', { class: 'row' }, h('span', { class: statusClass(res.status) }, String(res.status)), h('span', { class: 'muted small' }, `${ms} ms · ${fmtBytes(text.length)}`),
          errs.length ? h('span', { class: 'badge warn' }, `${errs.length} error${errs.length > 1 ? 's' : ''}: ${[...new Set(errs.map((e) => e.extensions?.code || '?'))].join(', ')}`) : null,
          json && 'data' in json && errs.length ? h('span', { class: 'badge' }, 'partial data') : null),
        kv(Object.fromEntries(shown.filter((k) => res.headers.get(k)).map((k) => [k, res.headers.get(k)]))),
        h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Response'), h('button', { class: 'small', onclick: () => copy(text) }, 'copy')),
        codeBlock(json ? JSON.stringify(json, null, 2) : text, { maxHeight: '480px' }));
    });

    el.append(h('div', { class: 'card stack' }, titled('Try a GraphQL request', 'protocols.graphql-try'),
      h('div', { class: 'row' }, field('Sample', sample), field('X-Force-GraphQL-Error (optional)', fieldErr), field('X-Force-Error (optional)', forceErr)),
      queryIn,
      field('Variables (JSON)', varsIn),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: send }, 'Send'), h('button', { onclick: load }, 'Reset sample'),
        h('span', { class: 'small muted' }, `Sent from your browser with the active auth mode (${CURL?.mode || 'none'}). The call also appears on the Inspector page.`)),
      out));
  }

  // Server-Sent Events streams, settings and a live viewer (the browser's EventSource).
  async function sseSection(el) {
    const on = !!sval('sseEnabled');
    const listing = on ? await fetch('/sse', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('Server-Sent Events streams', 'protocols.sse'),
        !on ? h('p', { class: 'muted' }, 'The SSE mock is off. Turn on sseEnabled in the settings next to this card.')
          : h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Stream'), h('th', null, 'Request'))),
            h('tbody', null, (listing?.streams || []).map((st) => h('tr', null,
              h('td', null, h('b', null, st.name), h('div', { class: 'small muted' }, st.description)),
              h('td', null, method(st.method), ' ', h('code', null, st.url), ' ', h('button', { class: 'small', onclick: () => copy(st.url) }, 'copy'))))))),
        on && listing ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Stream chaos: ${listing.chaos}. Last change event id: ${listing.lastEventId}.`) : null),
      h('div', { class: 'card' }, titled('SSE settings', 'protocols.sse-settings'),
        settingsForm(['sseEnabled', 'sseHeartbeatSeconds', 'sseRetryMs', 'sseReplayBuffer', 'sseTickIntervalMs'], { onSaved: () => route() }))));
    if (!on) return undefined;

    const which = h('select', { 'aria-label': 'Stream' }, h('option', { value: 'changes' }, 'changes'), h('option', { value: 'ticks' }, 'ticks'));
    const query = h('input', { type: 'text', value: '', placeholder: 'e.g. resource=employees, or interval=500&count=10&dropAfter=3', style: { maxWidth: '360px' } });
    const log = h('pre', { style: { maxHeight: '360px', minHeight: '120px' } });
    const status = h('span', { class: 'badge' }, 'closed');
    let es = null;
    let t0 = 0;
    const line = (text) => { log.textContent += `${String(Math.round(performance.now() - t0)).padStart(6)} ms  ${text}\n`; log.scrollTop = log.scrollHeight; };
    const stop = () => { if (es) { es.close(); es = null; } status.textContent = 'closed'; status.className = 'badge'; btn.textContent = 'Connect'; };
    const btn = h('button', { class: 'primary', onclick: guard(async () => {
      if (es) { stop(); line('closed by you'); return; }
      const params = new URLSearchParams(query.value.trim());
      const c = CURL?.ctx;
      if (c?.mode === 'apikey' && c.apiKey.in === 'query') params.set(c.apiKey.name, c.apiKey.value);
      else if (c?.mode === 'bearer') params.set('access_token', c.bearer);
      else if (c && (c.mode === 'jwt' || c.mode === 'oauth2')) {
        const cl = c.client || { clientId: 'demo-client', secret: 'demo-secret' };
        const r = await fetch('/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${cl.clientId}:${cl.secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=read%20write' });
        const tok = await r.json().catch(() => ({}));
        if (!tok.access_token) throw new Error(`Token request failed (${r.status})`);
        params.set('access_token', tok.access_token);
      } else if (c && c.mode !== 'none' && !(c.mode === 'apikey' && c.apiKey.in === 'query')) toast(`Auth mode "${c.mode}" needs request headers, which EventSource cannot send; use the curl from the guide.`, 'err');
      const qs = params.toString();
      log.textContent = '';
      t0 = performance.now();
      es = new EventSource(`/sse/${which.value}${qs ? `?${qs}` : ''}`);
      status.textContent = 'connecting'; status.className = 'badge warn';
      btn.textContent = 'Disconnect';
      es.onopen = () => { status.textContent = 'open'; status.className = 'badge pass'; line('open'); };
      es.onerror = () => { line(es && es.readyState === 0 ? 'connection lost: the browser reconnects with Last-Event-ID' : 'error'); };
      es.onmessage = (e) => line(`message${e.lastEventId ? ` #${e.lastEventId}` : ''}  ${e.data}`);
      for (const ev of ['subscribed', 'created', 'updated', 'deleted', 'reset', 'tick', 'end']) {
        es.addEventListener(ev, (e) => { line(`${ev}${e.lastEventId ? ` #${e.lastEventId}` : ''}  ${e.data}`); if (ev === 'end') stop(); });
      }
    }) }, 'Connect');
    el.append(h('div', { class: 'card stack' }, titled('Live SSE viewer', 'protocols.sse-try'),
      h('div', { class: 'row' }, field('Stream', which), field('Query (optional)', query), status),
      h('div', { class: 'row' }, btn, h('button', { class: 'small', onclick: () => { log.textContent = ''; } }, 'Clear log'),
        h('span', { class: 'small muted' }, 'Change a record (Data page, back office, /v1 or /soap) to see /sse/changes events arrive.')),
      log));
    return stop;
  }

  function soapTry(el, services) {

    // ---- try a request
    const svcSel = h('select', { 'aria-label': 'Service' }, services.map((sv) => h('option', { value: sv.name }, sv.name)));
    const opSel = h('select', { 'aria-label': 'Operation' });
    const verSel = h('select', { 'aria-label': 'SOAP version' }, h('option', { value: '1.1' }, 'SOAP 1.1'), h('option', { value: '1.2' }, 'SOAP 1.2'));
    const wsse = h('input', { type: 'checkbox', checked: sval('soapWsse') !== 'off' });
    const forceErr = h('input', { type: 'text', placeholder: 'e.g. 503 or malformed-json', style: { maxWidth: '220px' } });
    const bodyIn = h('textarea', { rows: 12, class: 'mono', spellcheck: 'false', 'aria-label': 'SOAP envelope' });
    const out = h('div', { class: 'stack' });
    const svc = () => services.find((sv) => sv.name === svcSel.value);
    const op = () => svc().operations.find((o) => o.name === opSel.value);

    const fillOps = () => { clear(opSel); for (const o of svc().operations) opSel.append(h('option', { value: o.name }, o.name)); };
    const buildEnvelope = () => {
      const v = verSel.value;
      const envNs = v === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
      const c = CURL?.ctx;
      const sec = wsse.checked && c
        ? `\n  <soapenv:Header>\n    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">\n      <wsse:UsernameToken><wsse:Username>${c.basic.user}</wsse:Username><wsse:Password>${c.basic.pass}</wsse:Password></wsse:UsernameToken>\n    </wsse:Security>\n  </soapenv:Header>`
        : '';
      bodyIn.value = `<soapenv:Envelope xmlns:soapenv="${envNs}" xmlns:tns="${svc().namespace}">${sec}\n  <soapenv:Body>\n    ${op().sampleBody}\n  </soapenv:Body>\n</soapenv:Envelope>`;
    };
    svcSel.addEventListener('change', () => { fillOps(); buildEnvelope(); });
    opSel.addEventListener('change', buildEnvelope);
    verSel.addEventListener('change', buildEnvelope);
    wsse.addEventListener('change', buildEnvelope);
    fillOps();
    buildEnvelope();

    const send = guard(async () => {
      const v = verSel.value;
      const path = `/soap/${svc().name}`;
      const action = op().soapAction;
      const hdrs = { ...(await protocolAuthHeaders('POST', path, bodyIn.value)) };
      if (v === '1.2') hdrs['Content-Type'] = `application/soap+xml; charset=utf-8; action="${action}"`;
      else { hdrs['Content-Type'] = 'text/xml; charset=utf-8'; hdrs.SOAPAction = `"${action}"`; }
      if (forceErr.value.trim()) hdrs['X-Force-Error'] = forceErr.value.trim();
      const url = CURL?.ctx?.mode === 'apikey' && CURL.ctx.apiKey.in === 'query' ? `${path}?${encodeURIComponent(CURL.ctx.apiKey.name)}=${encodeURIComponent(CURL.ctx.apiKey.value)}` : path;
      const started = performance.now();
      const res = await fetch(url, { method: 'POST', headers: hdrs, body: bodyIn.value, credentials: 'omit' });
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      const shown = ['content-type', 'x-soap-operation', 'x-chaos-injected', 'www-authenticate', 'retry-after', 'x-request-id'];
      clear(out).append(
        h('div', { class: 'row' }, h('span', { class: statusClass(res.status) }, String(res.status)), h('span', { class: 'muted small' }, `${ms} ms · ${fmtBytes(text.length)}`),
          /<(\w+:)?Fault[\s>]/.test(text) ? h('span', { class: 'badge' }, 'SOAP fault') : null),
        kv(Object.fromEntries(shown.filter((k) => res.headers.get(k)).map((k) => [k, res.headers.get(k)]))),
        h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Response'), h('button', { class: 'small', onclick: () => copy(text) }, 'copy')),
        codeBlock(prettyXml(text), { maxHeight: '480px' }));
    });

    el.append(h('div', { class: 'card stack' }, titled('Try a SOAP request', 'protocols.soap-try'),
      h('div', { class: 'row' }, field('Service', svcSel), field('Operation', opSel), field('Version', verSel), field('X-Force-Error (optional)', forceErr)),
      h('label', { class: 'check' }, wsse, h('span', null, 'Add a WS-Security UsernameToken (BASIC_USER / BASIC_PASS)')),
      bodyIn,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: send }, 'Send'), h('button', { onclick: buildEnvelope }, 'Reset envelope'),
        h('span', { class: 'small muted' }, `Sent from your browser with the active auth mode (${CURL?.mode || 'none'}). The call also appears on the Inspector page.`)),
      out));
  }

  // WebSocket channels, settings and a live console (the browser's own WebSocket).
  async function wsSection(el) {
    const on = !!sval('wsEnabled');
    const listing = on ? await fetch('/ws', { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    const channels = listing?.channels || [];
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, titled('WebSocket channels', 'protocols.ws'),
        !on ? h('p', { class: 'muted' }, 'The WebSocket mock is off. Turn on wsEnabled in the settings next to this card.')
          : h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Channel'), h('th', null, 'URL'))),
            h('tbody', null, channels.map((c) => h('tr', null,
              h('td', null, h('b', null, c.name), h('div', { class: 'small muted' }, c.description)),
              h('td', null, h('code', null, c.url), ' ', h('button', { class: 'small', onclick: () => copy(c.url) }, 'copy'))))))),
        on && listing ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'AsyncAPI: ', h('a', { href: listing.asyncapi, target: '_blank', rel: 'noopener' }, '/ws/asyncapi.json ↗'), ` · ${listing.open} open connection${listing.open === 1 ? '' : 's'}`) : null),
      h('div', { class: 'card' }, titled('WebSocket settings', 'protocols.ws-settings'),
        settingsForm(['wsEnabled', 'wsMaxMessageKb', 'wsIdleTimeoutSeconds', 'wsPingIntervalSeconds'], { onSaved: () => route() }))));
    if (!channels.length) return;

    const chSel = h('select', { 'aria-label': 'Channel' }, channels.map((c) => h('option', { value: c.name }, c.name)));
    const query = h('input', { type: 'text', placeholder: 'query, e.g. resource=employees', style: { maxWidth: '260px' } });
    const msg = h('textarea', { rows: 4, class: 'mono', spellcheck: 'false' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEmployee', params: { id: 1 } }));
    const log = h('pre', { style: { maxHeight: '360px', minHeight: '120px' } });
    const status = h('span', { class: 'badge' }, 'closed');
    let sock = null;
    const started = { t: 0 };
    const line = (dir, text) => {
      log.textContent += `${dir} ${String(Math.round(performance.now() - started.t)).padStart(6)} ms  ${text}\n`;
      log.scrollTop = log.scrollHeight;
    };
    const setState = (st) => { status.textContent = st; status.className = `badge ${st === 'open' ? 'pass' : st === 'connecting' ? 'warn' : ''}`; };
    chSel.addEventListener('change', () => {
      const n = chSel.value;
      msg.value = n === 'rpc' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEmployee', params: { id: 1 } }) : n === 'echo' ? 'hello' : '';
    });
    const browserAuth = () => {
      const c = CURL?.ctx;
      const params = new URLSearchParams(query.value.trim());
      let note = '';
      if (!c || c.mode === 'none') return { params, note };
      if (c.mode === 'apikey' && c.apiKey.in === 'query') params.set(c.apiKey.name, c.apiKey.value);
      else if (c.mode === 'bearer') params.set('access_token', c.bearer);
      else note = c.mode === 'jwt' || c.mode === 'oauth2' ? 'token' : `Auth mode "${c.mode}" needs request headers, which a browser cannot set; the upgrade will be rejected. Use the Node command from the guide.`;
      return { params, note };
    };
    const connectBtn = h('button', { class: 'primary', onclick: guard(async () => {
      if (sock) { sock.close(1000, 'bye'); return; }
      const { params, note } = browserAuth();
      if (note === 'token') {
        const cl = CURL.ctx.client || { clientId: 'demo-client', secret: 'demo-secret' };
        const r = await fetch('/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${cl.clientId}:${cl.secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=read%20write' });
        const tok = await r.json().catch(() => ({}));
        if (!tok.access_token) throw new Error(`Token request failed (${r.status})`);
        params.set('access_token', tok.access_token);
      } else if (note) toast(note, 'err');
      const qs = params.toString();
      const url = `${location.origin.replace(/^http/, 'ws')}/ws/${chSel.value}${qs ? `?${qs}` : ''}`;
      log.textContent = '';
      started.t = performance.now();
      setState('connecting');
      line('·', `connecting to ${url.replace(/access_token=[^&]+/, 'access_token=…')}`);
      sock = new WebSocket(url);
      sock.onopen = () => { setState('open'); connectBtn.textContent = 'Disconnect'; line('·', `open${sock.protocol ? ` (subprotocol ${sock.protocol})` : ''}`); };
      sock.onmessage = (e) => line('←', typeof e.data === 'string' ? e.data : '[binary]');
      sock.onerror = () => line('!', 'error (a rejected upgrade shows as an error in browsers: check the Inspector for its status)');
      sock.onclose = (e) => { line('·', `closed ${e.code}${e.reason ? ` "${e.reason}"` : ''}`); setState('closed'); connectBtn.textContent = 'Connect'; sock = null; };
    }) }, 'Connect');
    const sendBtn = h('button', { onclick: () => { if (!sock || sock.readyState !== 1) { toast('Connect first', 'err'); return; } sock.send(msg.value); line('→', msg.value); } }, 'Send');
    el.append(h('div', { class: 'card stack' }, titled('Live WebSocket console', 'protocols.ws-try'),
      h('div', { class: 'row' }, field('Channel', chSel), field('Query (optional)', query), status),
      msg,
      h('div', { class: 'row' }, connectBtn, sendBtn, h('button', { class: 'small', onclick: () => { log.textContent = ''; } }, 'Clear log'),
        h('span', { class: 'small muted' }, `Credentials for the active auth mode (${CURL?.mode || 'none'}) go in the query string where a browser allows it.`)),
      log));
    return () => { if (sock) sock.close(1001, 'page left'); };
  }

  // ---------------------------------------------------------------- openapi
  VIEWS.openapi = async (el) => {
    const base = location.origin;
    const SPECS = {
      data: {
        title: 'Mock Data API',
        audience: 'For integrations and API clients',
        what: 'The API your integration platform, Postman or generated client calls: /v1 employees, products, departments and categories, the seven pagination schemes, the file pool, and the OAuth token endpoint.',
        use: 'Import it into your integration platform to get every endpoint pre-defined. Re-import after changing auth, date format or required headers.',
        not: 'Does not include tool administration or health probes.',
        json: '/openapi.json', yaml: '/openapi.yaml', docs: '/docs', file: 'api-test-tool',
        auth: 'Open URL. Operations use the active /v1 auth mode.',
      },
      admin: {
        title: 'Admin API',
        audience: 'For operators and automation',
        what: 'The control plane behind this dashboard: settings, seeding, files, OAuth clients, the inspector and the contract tester, plus /health and /ready.',
        use: 'Script the tool from CI or a shell, e.g. switch the auth mode, re-seed data or start a contract run. Do not hand this to integration partners.',
        not: 'Does not include the mock /v1 API.',
        json: '/admin/api/openapi.json', yaml: '/admin/api/openapi.yaml', docs: '/docs?spec=admin', file: 'api-test-tool-admin',
        auth: 'Needs the dashboard password (session cookie, or Basic with any username).',
      },
    };
    const card = (key) => {
      const s = SPECS[key];
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, s.title), h('span', { class: 'small muted' }, s.audience)),
        h('p', null, s.what),
        h('p', { class: 'small' }, h('b', null, 'Use it to: '), s.use),
        h('p', { class: 'small muted' }, s.not, ' ', s.auth),
        h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'nowrap' } }, h('code', { style: { flex: '1', overflowWrap: 'anywhere' } }, base + s.json), h('button', { class: 'small', onclick: () => copy(base + s.json) }, 'copy')),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: s.json, download: `${s.file}.openapi.json` }, 'Download JSON'),
          h('a', { class: 'btn', href: s.yaml, download: `${s.file}.openapi.yaml` }, 'Download YAML'),
          h('a', { class: 'btn primary', href: s.docs, target: '_blank', rel: 'noopener' }, 'Swagger UI ↗')));
    };
    el.append(header('OpenAPI', 'Two specs, generated live from the current settings: one for integrations, one for administering the tool.', tip('openapi')));
    el.append(h('div', { class: 'grid cols-2' }, card('data'), card('admin')));
    const preview = h('div');
    const show = async (key) => {
      clear(preview);
      const r = await fetch(SPECS[key].yaml);
      preview.append(codeBlock(r.ok ? await r.text() : `Could not load ${SPECS[key].yaml} (HTTP ${r.status}).`, { maxHeight: '70vh' }));
    };
    el.append(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('b', null, 'Preview'),
        tabs([{ id: 'data', label: 'Mock Data API' }, { id: 'admin', label: 'Admin API' }], show, 'data')),
      preview));
    await show('data');
  };

  // ---------------------------------------------------------------- tester
  const KIND_LABEL = { openapi: 'OpenAPI', wsdl: 'WSDL', asyncapi: 'AsyncAPI', websocket: 'WebSocket' };

  VIEWS.tester = async (el, params) => {
    if (params[0]) return testerSpec(el, params[0], params[1]);
    const [specs, samples] = await Promise.all([api('GET', '/tester/specs'), api('GET', '/tester/samples')]);
    const name = h('input', { type: 'text', placeholder: 'Name (optional)' });
    const paste = h('textarea', { rows: 8, placeholder: 'Paste OpenAPI 3.0 / 3.1, Swagger 2.0 or AsyncAPI 2.x / 3.0 (YAML or JSON), or a WSDL 1.1 (XML)…' });
    const url = h('input', { type: 'url', placeholder: 'https://…/openapi.yaml, …/Service?wsdl or …/asyncapi.json' });
    const wsUrl = h('input', { type: 'url', placeholder: 'wss://… (WebSocket without a contract)' });
    const file = h('input', { type: 'file', accept: '.yaml,.yml,.json,.wsdl,.xml' });
    const create = async (body) => {
      const r = await api('POST', '/tester/specs', body);
      toast(`Loaded ${r.name} (${KIND_LABEL[r.kind] && r.kind !== 'openapi' ? KIND_LABEL[r.kind] : `${r.originalVersion}${r.originalVersion === '2.0' ? ' → 3.0' : ''}`}) — lint: ${r.lint.error} errors, ${r.lint.warning} warnings`, r.lint.error ? 'err' : 'ok');
      location.hash = `#/tester/${r.id}`;
    };
    el.append(header('API Tester', 'Test an implementation against its contract (OpenAPI for REST, WSDL for SOAP, AsyncAPI for WebSocket): try operations, validate responses, run the whole contract.'));
    el.append(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card stack' }, titled('Add a spec', 'tester.add'), field('Name', name),
        h('div', { class: 'row' }, file, h('button', { onclick: guard(async () => { if (!file.files[0]) return toast('Choose a file', 'err'); await create({ name: name.value || file.files[0].name.replace(/\.(ya?ml|json|wsdl|xml)$/i, ''), content: await file.files[0].text() }); }) }, 'Upload')),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, url, h('button', { onclick: guard(() => create({ name: name.value || undefined, url: url.value })) }, 'Load URL')),
        paste, h('button', { class: 'primary', onclick: guard(() => create({ name: name.value || undefined, content: paste.value })) }, 'Load pasted spec'),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, wsUrl, h('button', { title: 'Test a WebSocket API that has no AsyncAPI document: write the scenario yourself', onclick: guard(() => create({ name: name.value || undefined, kind: 'websocket', url: wsUrl.value })) }, 'New WebSocket scenario'))),
      h('div', { class: 'card stack' }, titled('Bundled samples', 'tester.samples'),
        samples.map((s) => h('div', { class: 'row between' }, h('div', null, h('div', null, s.name), h('div', { class: 'small muted mono' }, s.url)),
          h('div', { class: 'row' },
            h('button', { class: 'small primary', onclick: guard(() => create({ sample: s.id === 'self' ? 'self' : s.file })) }, 'Load'),
            s.file ? h('button', { class: 'small', title: 'Load the same file through the URL loader', onclick: guard(() => create({ name: `${s.name} (via URL)`, url: `${location.origin}${s.url}` })) }, 'Load via URL') : null))))));
    el.append(h('div', { class: 'card table-wrap' }, titled('Specs', 'tester.specs'),
      specs.length ? h('table', null, h('thead', null, h('tr', null, ['Name', 'Version', 'Ops', 'Target', 'Last run', ''].map((x) => h('th', null, x)))),
        h('tbody', null, specs.map((s) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/tester/${s.id}`; } },
          h('td', null, h('div', null, s.name), h('div', { class: 'small muted' }, `${s.source?.type || ''}${s.converted ? ' · converted from 2.0' : ''}`)),
          h('td', null, s.kind !== 'openapi' ? h('span', { class: 'badge' }, KIND_LABEL[s.kind] || s.kind) : s.version), h('td', null, s.operations), h('td', { class: 'small mono' }, s.baseUrl || '—'),
          h('td', null, s.lastRun ? h('span', null, h('span', { class: `badge ${s.lastRun.summary.failed ? 'fail' : 'pass'}` }, `${s.lastRun.summary.passed}/${s.lastRun.summary.total}`), ' ', h('span', { class: 'small muted' }, fmtDate(s.lastRun.at))) : '—'),
          h('td', null, h('button', { class: 'small danger', onclick: guard(async (e) => { e.stopPropagation(); if (!confirm(`Delete ${s.name} and its runs?`)) return; await api('DELETE', `/tester/specs/${s.id}`); route(); }) }, 'Delete'))))))
        : h('div', { class: 'empty' }, 'No specs yet — load the bundled Supplier Order sample (REST), the live SOAP WSDL or the live AsyncAPI (WebSocket) to try it.')));
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
      request: () => (r.request ? h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('div', null, method(r.request.method), ' ', h('code', null, r.request.url)),
        h('button', { class: 'small', title: 'The exact request that was sent, with the same headers and credentials', onclick: () => copy(window.ATT_GUIDES.fromSentRequest(r.request)) }, 'Copy as curl')), kv(r.request.headers), r.request.body ? codeBlock(pretty(r.request.body)) : null) : h('div', { class: 'muted' }, 'Not sent')),
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
    const isWsdl = spec.kind === 'wsdl';
    const isWs = spec.kind === 'asyncapi' || spec.kind === 'websocket';
    const soapVersions = isWsdl ? [...new Set(spec.operations.flatMap((o) => o.soap?.versions || []))].sort() : [];
    const subtitle = isWsdl ? `${spec.title} · WSDL 1.1 · SOAP ${soapVersions.join(' and ') || '?'} · ${spec.operations.length} operations`
      : spec.kind === 'asyncapi' ? `${spec.title} ${spec.apiVersion} · ${spec.version} · ${spec.operations.length} channel${spec.operations.length === 1 ? '' : 's'}`
        : spec.kind === 'websocket' ? `WebSocket scenario · ${spec.doc.url}`
          : `${spec.title} ${spec.apiVersion} · OpenAPI ${spec.version}${spec.converted ? ' (converted from Swagger 2.0)' : ''} · ${spec.operations.length} operations`;
    el.append(header(spec.name, subtitle,
      h('a', { class: 'btn', href: '#/tester' }, '← Specs'),
      spec.source?.type === 'url' || spec.source?.type === 'sample' ? h('button', { onclick: guard(async () => { await api('POST', `/tester/specs/${spec.id}/reload`); toast('Reloaded', 'ok'); route(); }) }, 'Reload') : null,
      h('a', { class: 'btn', href: `/admin/api/tester/specs/${spec.id}/document`, target: '_blank' }, isWsdl ? 'View WSDL' : spec.kind === 'websocket' ? 'View scenario' : 'View JSON')));
    const t = tabs([
      { id: 'target', label: 'Target' },
      { id: 'lint', label: `Spec lint${spec.lint.error ? ` (${spec.lint.error} errors)` : spec.lint.warning ? ` (${spec.lint.warning})` : ''}` },
      { id: 'ops', label: 'Try it' },
      { id: 'run', label: 'Run all' },
      { id: 'history', label: 'History' },
    ], (k) => { history.replaceState(null, '', `#/tester/${specId}/${k}`); draw(k); }, sub || 'target');
    el.append(t, body);

    async function refresh() { spec = await api('GET', `/tester/specs/${specId}`); }
    const specExtra = () => ({ specId: spec.id, specName: spec.name, firstOpId: spec.operations[0]?.id });

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
      const sel = h('select', null, profiles.map((p, i) => h('option', { value: String(i) }, p.label)),
        spec.kind !== 'openapi' ? null : h('option', { value: 'basic' }, 'HTTP Basic (manual)'), spec.kind !== 'openapi' ? null : h('option', { value: 'bearer' }, 'Bearer token (manual)'));
      const fieldsEl = h('div', { class: 'stack' });
      let profile = { ...current };
      const idx = profiles.findIndex((p) => p.type === current.type && (p.scheme === current.scheme || !p.scheme) && (p.type !== 'apikey' || !p.in || !current.in || p.in === current.in));
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
        else if (p.type === 'wsse') {
          fieldsEl.append(h('div', { class: 'grid cols-3' }, input('username', 'Username'), input('password', 'Password', 'password'),
            field('Password type', (() => { const s = h('select', { onchange: () => { p.passwordType = s.value; } }, h('option', { value: 'text' }, 'PasswordText'), h('option', { value: 'digest' }, 'PasswordDigest')); s.value = p.passwordType || 'text'; return s; })())),
          h('div', { class: 'small muted' }, 'Added to every envelope as a wsse:Security header (OASIS UsernameToken). Digest adds a fresh nonce and timestamp per request.'));
        }
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
      const servers = isWsdl
        ? [...new Set((spec.doc.services || []).flatMap((sv) => sv.ports.map((p) => p.address)).filter(Boolean))]
        : spec.kind === 'asyncapi' ? ((spec.doc['x-tester-model'] || {}).servers || []).map((s) => s.url).filter((u) => /^wss?:/.test(u))
          : spec.kind === 'websocket' ? [spec.doc.url]
            : (spec.doc.servers || []).map((s) => s.url);
      const subprotocols = h('input', { type: 'text', value: (spec.target.subprotocols || []).join(', '), placeholder: 'e.g. graphql-transport-ws, v1.json' });
      const oversize = h('input', { type: 'number', value: spec.target.oversizeKb || 2048, min: 1 });
      const soapVer = h('select', null, h('option', { value: 'auto' }, 'Auto (SOAP 1.1 when the WSDL has it)'), h('option', { value: '1.1' }, 'SOAP 1.1'), h('option', { value: '1.2' }, 'SOAP 1.2'));
      soapVer.value = spec.target.soapVersion || 'auto';
      const mockOut = h('div');
      body.append(h('div', { class: 'grid cols-2' },
        h('div', { class: 'card stack' }, titled('Target', 'tester.target', specExtra), field('Name', nameIn),
          isWsdl
            ? field('Endpoint URL', base, servers.length ? `WSDL addresses: ${servers.join(', ')}. Every operation is sent here.` : 'The WSDL declares no address.')
            : isWs ? field('Server URL (ws:// or wss://)', base, spec.kind === 'asyncapi' ? `Channel addresses are appended. Spec servers: ${servers.join(', ') || 'none'}` : 'The scenario connects here (a connect step can add an address).')
              : field('Base URL override', base, servers.length ? `Spec servers: ${servers.join(', ')}` : 'The spec declares no servers.'),
          h('div', { class: 'row' }, servers.map((s) => h('button', { class: 'small', onclick: () => { base.value = s; } }, `use ${s}`)),
            isWsdl || isWs ? null : h('button', { class: 'small', onclick: () => { base.value = location.origin; } }, 'use this tool')),
          isWs ? field('Subprotocols to offer (comma separated)', subprotocols, 'Sent as Sec-WebSocket-Protocol; the server must select one of them.') : null,
          isWs ? field('Oversized-message size for negative tests (KB)', oversize) : null,
          isWsdl ? field('SOAP version', soapVer, `Bindings in this WSDL: SOAP ${soapVersions.join(' and ')}.`) : null,
          auth,
          field('Default headers (JSON object)', headers, 'Sent with every request; {{uuid}} and {{now}} templates are expanded.'),
          field('Timeout (ms)', timeout),
          isWsdl || isWs ? null : h('label', { class: 'check' }, lenient, 'Lenient allOf (flatten allOf before validating)'),
          h('button', { class: 'primary', onclick: guard(async () => {
            let hdrs;
            try { hdrs = JSON.parse(headers.value || '{}'); } catch { throw new Error('Default headers must be a JSON object'); }
            const extra = isWsdl ? { soapVersion: soapVer.value } : isWs ? { subprotocols: subprotocols.value.split(',').map((x) => x.trim()).filter(Boolean), oversizeKb: Number(oversize.value) || 2048 } : {};
            await api('PUT', `/tester/specs/${spec.id}`, { name: nameIn.value, target: { baseUrl: base.value, auth: auth.get(), headers: hdrs, timeoutMs: Number(timeout.value) || 30000, ...extra }, options: isWsdl || isWs ? {} : { lenientAllOf: lenient.checked } });
            await refresh();
            toast('Target saved', 'ok');
          }) }, 'Save target')),
        h('div', null,
          isWsdl || isWs ? h('div', { class: 'card stack' }, h('h2', null, 'Rehearse without a service'),
            h('p', { class: 'muted small' }, isWsdl
              ? 'Mock from spec is for OpenAPI. To rehearse a SOAP run, load "This tool (live SOAP WSDL)" from the bundled samples: it targets this server\'s own /soap services.'
              : 'Mock from spec is for OpenAPI. To rehearse a WebSocket run, load "This tool (live AsyncAPI)" from the bundled samples: it targets this server\'s own /ws channels.')) : null,
          isWsdl || isWs ? null : h('div', { class: 'card stack' }, titled('Mock from spec', 'tester.mock', specExtra),
            h('p', { class: 'muted small' }, 'Serve this spec\'s documented 2xx responses (examples first) from this tool under /mock/<name>, then run the contract against it. Useful before an implementation exists — and it shows how the spec\'s own examples fare against its schemas.'),
            h('div', { class: 'row' },
              h('button', { onclick: guard(async () => { const m = await api('POST', `/tester/specs/${spec.id}/mock`, { useAsTarget: true }); clear(mockOut).append(h('div', { class: 'small' }, `${m.count} rules installed; target set to `, h('code', null, m.url))); await refresh(); base.value = spec.target.baseUrl; }) }, 'Install mock & use as target'),
              h('button', { class: 'small danger', onclick: guard(async () => { const r = await api('DELETE', `/tester/specs/${spec.id}/mock`); toast(`Removed ${r.removed} rules`, 'ok'); }) }, 'Remove mock rules')), mockOut),
          spec.notes?.length ? h('div', { class: 'card' }, h('h2', null, 'Load notes'), h('ul', null, spec.notes.map((n) => h('li', null, n)))) : null)));
    }

    async function drawLint() {
      const lint = await api('GET', `/tester/specs/${spec.id}/lint`);
      body.append(h('div', { class: 'card' }, titled('Spec lint', 'tester.lint', specExtra), h('div', { class: 'row' }, h('span', { class: 'badge fail' }, `${lint.counts.error} errors`), h('span', { class: 'badge warn' }, `${lint.counts.warning} warnings`), h('span', { class: 'badge info' }, `${lint.counts.info} info`)),
        lint.issues.length ? lint.issues.map((i) => h('div', { class: `issue ${i.severity}` }, h('div', { class: 'row' }, h('b', null, i.rule), h('code', { class: 'small muted' }, i.pointer)), h('div', null, i.message), i.fix ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('b', null, 'Fix: '), i.fix) : null))
          : h('div', { class: 'empty' }, 'No issues found.')));
    }

    function drawOps() {
      const listEl = h('div', { class: 'list' });
      const detail = h('div');
      let current = null;
      for (const op of spec.operations) {
        const item = h('div', { class: 'list-item', onclick: () => { for (const x of listEl.children) x.classList.remove('active'); item.classList.add('active'); current = op; showOp(op); } },
          isWsdl ? h('span', { class: 'method post' }, 'SOAP') : isWs ? h('span', { class: 'method get' }, 'WS') : method(op.method),
          isWs
            ? h('div', { style: { minWidth: 0 } }, h('div', { class: 'path' }, op.id), h('div', { class: 'small muted' }, `${op.path || spec.target.baseUrl || ''}${op.ws.toServer.length ? ` · sends ${op.ws.toServer.join(', ')}` : ''}${op.ws.fromServer.length ? ` · receives ${op.ws.fromServer.join(', ')}` : ''}`))
          : isWsdl
            ? h('div', { style: { minWidth: 0 } }, h('div', { class: 'path' }, op.operationId), h('div', { class: 'small muted' }, `${op.path} · ${op.soap.versions.map((v) => `SOAP ${v}`).join(', ')}`))
            : h('div', { style: { minWidth: 0 } }, h('div', { class: 'path' }, op.path), h('div', { class: 'small muted' }, op.operationId || op.summary || '')),
          op.secured ? h('span', { class: 'small muted', title: 'secured' }, '🔒') : h('span'));
        listEl.append(item);
      }
      body.append(h('div', { class: 'card row' }, tip('tester.tryit', () => ({ ...specExtra(), firstOpId: (current || spec.operations[0])?.id })), h('span', { class: 'muted' }, 'Pick an operation, adjust the request, and press Send. Every response is checked against the spec.')),
        h('div', { class: 'split' }, h('div', { class: 'card', style: { padding: 0 } }, listEl), detail));
      detail.append(h('div', { class: 'card empty' }, 'Pick an operation.'));

      const showOp = guard(async (op, exampleName, soapVersion) => {
        const req = await api('GET', `/tester/specs/${spec.id}/request?op=${encodeURIComponent(op.id)}${exampleName ? `&example=${encodeURIComponent(exampleName)}` : ''}${soapVersion ? `&version=${encodeURIComponent(soapVersion)}` : ''}`);
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
          const verSel = isWsdl && op.soap.versions.length > 1 ? h('select', { onchange: () => showOp(op, undefined, verSel.value) }, op.soap.versions.map((v) => h('option', { value: v }, `SOAP ${v}`))) : null;
          if (verSel) verSel.value = req.soapVersion;
          bodySection.append(h('div', { class: 'row between' }, h('h3', null, isWsdl ? `Envelope · SOAP ${req.soapVersion}` : isWs ? `Message to send · ${req.contentType}` : `Body · ${req.contentType}`),
            verSel ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Version'), verSel)
              : exSel ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Example'), exSel) : h('span', { class: 'small muted' }, `source: ${req.exampleName || 'generated'}`)),
          isWsdl ? h('div', { class: 'small muted mono' }, `Content-Type: ${req.contentType}`) : null, bodyEditor);
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
          isWs
            ? h('div', { class: 'row' }, h('span', { class: 'method get' }, 'WS'), h('code', null, `${(spec.target.baseUrl || '').replace(/\/$/, '')}${op.path}`), h('span', { class: 'muted small' }, 'connect → send → listen → close'))
          : isWsdl
            ? h('div', { class: 'row' }, h('span', { class: 'method post' }, 'SOAP'), h('code', null, op.operationId), h('span', { class: 'muted small' }, `${op.path} · ${op.soap.style}${op.soap.faults.length ? ` · faults: ${op.soap.faults.join(', ')}` : ''}`))
            : h('div', { class: 'row' }, method(op.method), h('code', null, op.path), op.operationId ? h('span', { class: 'muted small' }, op.operationId) : null),
          op.summary ? h('div', { class: 'muted' }, op.summary) : null,
          req.params.length ? h('div', null, h('h3', null, isWs ? 'Options' : 'Parameters'), h('table', null, h('tbody', null, paramRows)), h('div', { class: 'small muted' }, 'Templates: {{uuid}} (fresh per send), {{now}}, {{timestamp}}.')) : null,
          bodySection,
          h('div', { class: 'row' }, send, h('span', { class: 'small muted' }, `→ ${spec.target.baseUrl || (isWsdl ? req.endpoint : '') || '(no base URL)'} · auth: ${spec.target.auth?.type || 'none'}`))),
        h('div', { class: 'card' }, out));
      });
    }

    function drawRun() {
      const negative = h('input', { type: 'checkbox' });
      const lenient = h('input', { type: 'checkbox', checked: spec.options?.lenientAllOf });
      const vars = h('textarea', { rows: 4, placeholder: isWsdl ? '{"employee.id": "5", "departmentId": "2"}' : isWs ? '{"orderId": "42"}  (use as {{orderId}} in the scenario)' : '{"purchaseOrderId": "PO-4500123456"}' });
      const scenarioIn = isWs ? h('textarea', { rows: 14, class: 'mono', spellcheck: 'false' }, JSON.stringify(spec.scenario || spec.autoScenario || [], null, 2)) : null;
      const opsSel = h('select', { multiple: true, size: Math.min(8, spec.operations.length) }, spec.operations.map((o) => h('option', { value: o.id }, isWsdl ? o.id : `${o.method.toUpperCase()} ${o.path}`)));
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
      body.append(h('div', { class: 'card stack' }, titled('Contract run', 'tester.run', specExtra),
        h('div', { class: 'small muted' }, isWs
          ? 'The scenario runs top to bottom. Steps: {"connect": {"channel"?, "address"?, "protocols"?}}, {"send": <message or {"message": "Name"}>}, {"expect": {"timeoutMs", "match": {"/json/pointer": value}, "contains", "capture": {"var": "/pointer"}, "correlate"}}, {"listen": ms}, {"wait": ms}, {"ping": {}}, {"close": 1000}, {"expectClose": 1008}. {{var}} templates use captured and supplied variables. Every received message is checked against the channel\'s schemas.'
          : isWsdl
          ? 'Order by operation name: Create/Add → List/Search → Get → Update and others → Delete. Requests contain the required elements only; id-like values (id, *Id, *Number, *Code) from responses fill later requests. Variables can also be keyed as "noun.field", e.g. "employee.id".'
          : 'Order: collection POSTs (creates) → collection GETs (lists) → item operations → DELETEs. IDs are captured from Location headers and response bodies and fed into later path parameters.'),
        h('div', { class: 'row' }, h('label', { class: 'check' }, negative, isWs
          ? 'Negative tests (no credentials → upgrade rejected with 401, malformed message → error reply or close 1003/1007/1008, oversized message → close 1009, invalid UTF-8 → close 1007)'
          : isWsdl
          ? 'Negative tests (no credentials → 401 or fault, missing required element → client fault, unknown id → fault, malformed XML → client fault)'
          : 'Negative tests (no auth → 401, missing required field → 400/422, unknown id → 404)'), isWsdl || isWs ? null : h('label', { class: 'check' }, lenient, 'Lenient allOf')),
        isWs ? field(spec.scenario ? 'Scenario (saved)' : 'Scenario (automatic from the contract; edit and save to customise)', scenarioIn) : null,
        isWs ? h('div', { class: 'row' },
          h('button', { onclick: guard(async () => { let sc; try { sc = JSON.parse(scenarioIn.value); } catch (e) { throw new Error(`Scenario is not valid JSON: ${e.message}`); } await api('PUT', `/tester/specs/${spec.id}`, { scenario: sc }); await refresh(); toast('Scenario saved', 'ok'); }) }, 'Save scenario'),
          spec.kind === 'asyncapi' ? h('button', { onclick: guard(async () => { await api('PUT', `/tester/specs/${spec.id}`, { scenario: null }); await refresh(); scenarioIn.value = JSON.stringify(spec.autoScenario || [], null, 2); toast('Back to the automatic scenario', 'ok'); }) }, 'Use automatic scenario') : null) : null,
        h('div', { class: 'grid cols-2' }, field('Variables (override captured values)', vars), isWs ? h('div') : field('Only these operations (none selected = all)', opsSel)),
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
          h('summary', { class: 'row' }, h('span', { class: `badge ${st.outcome}` }, st.outcome), h('span', { class: 'muted' }, `#${i + 1}`),
            !run.kind || run.kind === 'openapi' ? [method(st.opId.split(' ')[0]), h('code', null, st.opId.split(' ').slice(1).join(' '))]
              : [h('span', { class: `method ${run.kind === 'wsdl' ? 'post' : 'get'}` }, run.kind === 'wsdl' ? 'SOAP' : 'WS'), h('code', null, st.opId)],
            st.kind === 'negative' ? h('span', { class: 'badge' }, `negative: ${st.test}`) : null,
            st.response ? h('span', { class: statusClass(st.response.status) }, st.response.status) : h('span', { style: { color: 'var(--err)' } }, st.error)),
          h('div', { style: { marginTop: '10px' } }, resultView(st)))),
        Object.keys(run.variables || {}).length ? h('div', { class: 'card' }, h('h3', null, 'Variables after run'), kv(run.variables)) : null);
    }

    async function drawHistory() {
      const runs = await api('GET', `/tester/specs/${spec.id}/runs`);
      const out = h('div');
      body.append(h('div', { class: 'card table-wrap' }, titled('Run history', 'tester.history', specExtra), runs.length ? h('table', null, h('thead', null, h('tr', null, ['Started', 'Target', 'Result', 'Options', ''].map((x) => h('th', null, x)))),
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
      h('p', null, 'One server that helps you test an API platform or integration in both directions:'),
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
        h('span', null, 'Import the live spec from ', link('#/openapi', 'OpenAPI'), ' (', code(`${B}/openapi.json`), ') into your API platform or Postman to get every endpoint pre-defined.'))));

    el.append(section('quick-incoming', 'Quick start: incoming testing',
      steps(
        h('span', null, 'Open ', link('#/tester', 'API Tester'), ' and load your contract: upload, paste, or a URL. OpenAPI 3.0, 3.1, Swagger 2.0, WSDL 1.1 (SOAP 1.1/1.2) and AsyncAPI 2.x/3.0 (WebSocket) all work; a WebSocket API without a contract gets a hand-written scenario. To try it first, load the bundled Supplier Order sample or this tool\'s live SOAP WSDL or AsyncAPI.'),
        h('span', null, 'Read the ', h('b', null, 'Spec lint'), ' tab. It flags problems that make valid responses fail validation, such as allOf combined with additionalProperties: false, and placeholder server or token URLs.'),
        h('span', null, 'On the ', h('b', null, 'Target'), ' tab, set the base URL of your implementation and an auth profile (API key, OAuth2 client credentials with your token URL, Basic or Bearer). "Test token request" shows the full token exchange.'),
        h('span', null, 'Use ', h('b', null, 'Try it'), ' to send one operation at a time. The form is pre-filled from the spec; every response gets a list of pass/fail checks.'),
        h('span', null, 'Use ', h('b', null, 'Run all'), ' for the whole contract. IDs from Location headers and responses are reused in later calls; tick "Negative tests" to also check 401, 400/422 and 404 handling. Results are kept under ', h('b', null, 'History'), ' with HTML and JSON reports.'),
        h('span', null, 'No implementation yet? "Install mock & use as target" serves the spec\'s own examples from this server so you can rehearse the run.'))));

    el.append(section('urls', 'URLs and reserved paths',
      h('p', null, 'These paths belong to the tool. ', h('b', null, 'Every other path is captured by the Inspector'), ' and answered with its default response or a matching rule. Calls to /v1 and /oauth are recorded on the Inspector too (with their real responses) unless "Record /v1 & /oauth" is switched off; the dashboard, docs and health checks are never recorded.'),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
        [
          ['/v1/employees, /v1/products, /v1/departments, /v1/categories', 'Mock API with full CRUD (list, create, get, replace, patch, delete). Lists use offset pagination.'],
          ['/v1/p/{offset|page|cursor|keyset|link|hal|token}/{resource}', 'The same lists with each pagination style.'],
          ['/v1/departments/{id}/employees, /v1/categories/{id}/products', 'Nested collections.'],
          ['/v1/files/…', 'File protocols: multipart, raw, base64, tus, presign, download (range), chunked.'],
          ['/soap, /soap/{EmployeeService|ProductService}', 'Mock SOAP 1.1/1.2 services over the same data. ?wsdl returns the WSDL (always open); POST requests use the active auth mode.'],
          ['/ws, /ws/{echo|rpc|changes}, /ws/asyncapi.json', 'Mock WebSocket channels over the same data (the upgrade uses the active auth mode) and their AsyncAPI 3.0 document.'],
          ['/sse, /sse/changes, /sse/ticks, POST /sse/stream', 'Server-Sent Events: change feed with Last-Event-ID replay, numbered ticks, and LLM-style request/stream (described in /openapi.json).'],
          ['/odata/v4, /odata/v4/$metadata', 'OData v4 (JSON) over the same data: query options, paging with @odata.nextLink, navigation and CRUD. $metadata is always open.'],
          ['/graphql, /graphql/schema.graphql', 'GraphQL over the same data: queries (offset pages and Relay connections), mutations, and a changes subscription over WebSocket (graphql-transport-ws). GraphiQL in a browser; the SDL is always open.'],
          ['/files, /files/{key} (the S3 bucket name)', 'S3-compatible API over the file pool: path-style, signed with AWS Signature V4 using the S3 API keys (a signed GET / is ListBuckets). The bucket name is a setting.'],
          ['/oauth/token, /oauth/authorize, /oauth/introspect, /oauth/revoke', 'Built-in OAuth 2.0 server.'],
          ['/.well-known/jwks.json, /.well-known/oauth-authorization-server', 'Signing keys and OAuth discovery.'],
          ['/openapi.json, /openapi.yaml', 'Live OpenAPI for the mock data API (for integrations).'],
          ['/admin/api/openapi.json, .yaml', 'Live OpenAPI for the admin API (password protected).'],
          ['/app', 'Back office app: KPIs and a friendly view of the mock data with create, edit and delete (dashboard password).'],
          ['/docs', 'Swagger UI for both specs (?spec=admin for the admin API).'],
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
    PASSWORD_REQUIRED = !!s.passwordRequired;
    shell();
    if (!s.passwordRequired) $('#logout-btn').classList.add('hidden');
    window.addEventListener('hashchange', route);
    route();
  }
  start();
})();
