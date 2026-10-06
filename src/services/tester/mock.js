'use strict';
// "Mock from spec": turn a spec's documented 2xx responses (examples first) into inspector catch-all rules
// under /mock/{slug}, so the tester can run a whole spec against this tool before a real implementation exists.
const { listOperations } = require('./operations');
const { mediaSample, sample } = require('./sample');
const { deref, locate, get } = require('./refs');

function slugify(s) {
  return String(s || 'spec').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'spec';
}

function buildMockRules(spec, slug) {
  const { doc } = spec;
  const prefix = `/mock/${slug}`;
  const rules = [];
  const ops = listOperations(doc).filter((o) => !['options', 'head', 'trace'].includes(o.method));
  // Static paths before templated ones so /a/b wins over /a/{id}.
  ops.sort((a, b) => (a.path.split('{').length - b.path.split('{').length) || b.path.length - a.path.length);
  for (const op of ops) {
    const code = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
    if (!code) continue;
    const ptr = locate(doc, op.pointer, ['responses', code]);
    const resp = ptr ? get(doc, ptr) : {};
    const media = Object.keys(resp.content || {})[0];
    let body = null;
    if (media) {
      const { value } = mediaSample(doc, resp.content[media], 'response');
      body = value;
    }
    const headers = [];
    for (const [h, hRef] of Object.entries(resp.headers || {})) {
      const hd = deref(doc, hRef) || {};
      let v;
      if (/^location$/i.test(h)) {
        const last = op.path.split('/').filter((s) => s && !s.startsWith('{')).pop() || '';
        const noun = last.replace(/ies$/, 'y').replace(/s$/, '').replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase());
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
        const idKey = keys.find((k) => k === `${noun}Id`) || (keys.includes('id') ? 'id' : keys.find((k) => /Id$/.test(k)));
        const idVal = idKey ? encodeURIComponent(body[idKey]) : '{{uuid}}';
        v = `{{baseUrl}}{{path}}/${idVal}`;
      } else if (/^etag$/i.test(h)) v = '"{{uuid}}"';
      else if (/correlation|request-id/i.test(h)) v = '{{uuid}}';
      else {
        const s = sample(doc, hd.schema || { type: 'string' }, { key: h });
        v = typeof s === 'object' ? JSON.stringify(s) : String(s ?? '');
      }
      headers.push({ name: h, value: v });
    }
    rules.push({
      name: `${slug}: ${op.method.toUpperCase()} ${op.path}`,
      source: `spec:${slug}`,
      method: op.method.toUpperCase(),
      path: `${prefix}${op.path}`,
      status: Number(code),
      contentType: media || 'application/json',
      headers,
      body: body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    });
  }
  return { prefix, rules };
}

async function installMock(ctx, spec, slugIn) {
  const slug = slugify(slugIn || spec.name || spec.title);
  const { prefix, rules } = buildMockRules(spec, slug);
  const existing = (ctx.settings.get('inspectorRules') || []).filter((r) => r.source !== `spec:${slug}`);
  await ctx.settings.set('inspectorRules', [...rules, ...existing]);
  return { slug, prefix, count: rules.length };
}

async function removeMock(ctx, slug) {
  const existing = ctx.settings.get('inspectorRules') || [];
  const kept = existing.filter((r) => r.source !== `spec:${slug}`);
  await ctx.settings.set('inspectorRules', kept);
  return existing.length - kept.length;
}

module.exports = { buildMockRules, installMock, removeMock, slugify };
