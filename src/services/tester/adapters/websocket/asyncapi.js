'use strict';
// AsyncAPI 2.x / 3.0 → a small WebSocket contract model for the tester.
//   model = { asyncapiVersion, title, servers: [{ name, url, protocol }],
//             channels: [{ id, address, description, toServer: [Msg], fromServer: [Msg] }] }
//   Msg   = { name, pointer (JSON pointer to the message), payloadPointer|null, contentType, examples: [payload], correlation: '/json/pointer'|null }
// Direction conventions (the document describes the server you test):
//   2.x  publish = clients send it (to the server); subscribe = the server sends it
//   3.0  action "receive" = the server receives it (clients send); action "send" = the server sends it; replies are server → client
const yaml = require('js-yaml');
const { get, resolve, escape } = require('../../refs');

class AsyncApiError extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function parseText(text) {
  try { return yaml.load(String(text), { json: true }); } catch (e) { throw new AsyncApiError(`Could not parse AsyncAPI as YAML/JSON: ${e.message.split('\n')[0]}`); }
}

function serverUrl2(s) {
  let url = String(s.url || '');
  for (const [k, v] of Object.entries(s.variables || {})) url = url.replace(`{${k}}`, v.default ?? (v.enum || [])[0] ?? '');
  if (!/^[a-z]+:\/\//i.test(url)) url = `${s.protocol || 'ws'}://${url}`;
  return url;
}

function serverUrl3(s) {
  let host = String(s.host || '');
  let pathname = String(s.pathname || '');
  for (const [k, v] of Object.entries(s.variables || {})) {
    const val = v.default ?? (v.enum || [])[0] ?? '';
    host = host.replace(`{${k}}`, val);
    pathname = pathname.replace(`{${k}}`, val);
  }
  return `${s.protocol || 'ws'}://${host}${pathname}`.replace(/\/$/, '');
}

function correlationOf(doc, msg) {
  const c = msg.correlationId ? resolve(doc, msg.correlationId).node : null;
  const m = c && /^\$message\.payload#(\/.*)?$/.exec(String(c.location || ''));
  return m ? (m[1] || '') : null;
}

function messageInfo(doc, ref, pointer, fallbackName) {
  const { node: msg, pointer: ptr } = resolve(doc, ref, pointer);
  if (!msg || typeof msg !== 'object') return null;
  const finalPtr = ptr || pointer;
  const payloadPtr = msg.payload !== undefined ? `${finalPtr}/payload` : null;
  const examples = [];
  for (const ex of msg.examples || []) if (ex && ex.payload !== undefined) examples.push({ name: ex.name || ex.summary || `example ${examples.length + 1}`, payload: ex.payload });
  const payload = msg.payload ? resolve(doc, msg.payload).node : null;
  if (!examples.length && payload && Array.isArray(payload.examples) && payload.examples.length) examples.push({ name: 'schema example', payload: payload.examples[0] });
  if (!examples.length && payload && payload.example !== undefined) examples.push({ name: 'schema example', payload: payload.example });
  return {
    name: msg.name || msg.messageId || fallbackName || (finalPtr || '').split('/').pop() || 'message',
    pointer: finalPtr,
    payloadPointer: payloadPtr,
    contentType: msg.contentType || doc.defaultContentType || 'application/json',
    examples,
    correlation: correlationOf(doc, msg),
  };
}

// 2.x: message can be a Message, a $ref, or { oneOf: [...] }
function messages2(doc, op, pointer) {
  if (!op || !op.message) return [];
  const m = resolve(doc, op.message, `${pointer}/message`);
  if (m.node && Array.isArray(m.node.oneOf)) {
    return m.node.oneOf.map((x, i) => messageInfo(doc, x, `${m.pointer}/oneOf/${i}`)).filter(Boolean);
  }
  return [messageInfo(doc, op.message, `${pointer}/message`, op.operationId)].filter(Boolean);
}

function buildModel(doc) {
  const version = String(doc.asyncapi || '');
  const model = { asyncapiVersion: version, title: doc.info?.title || 'AsyncAPI', servers: [], channels: [], warnings: [] };
  const v3 = /^3\./.test(version);
  for (const [name, sRef] of Object.entries(doc.servers || {})) {
    const s = resolve(doc, sRef).node || {};
    model.servers.push({ name, url: v3 ? serverUrl3(s) : serverUrl2(s), protocol: String(s.protocol || '').toLowerCase() });
  }
  if (!v3) {
    for (const [address, chRef] of Object.entries(doc.channels || {})) {
      const ptr = `#/channels/${escape(address)}`;
      const ch = resolve(doc, chRef, ptr).node || {};
      model.channels.push({
        id: address, address, description: ch.description || '',
        toServer: messages2(doc, ch.publish, `${ptr}/publish`),
        fromServer: messages2(doc, ch.subscribe, `${ptr}/subscribe`),
      });
    }
    return model;
  }
  const byPointer = new Map();
  for (const [id, chRef] of Object.entries(doc.channels || {})) {
    const ptr = `#/channels/${escape(id)}`;
    const ch = resolve(doc, chRef, ptr).node || {};
    const entry = { id, address: ch.address ?? id, description: ch.description || '', toServer: [], fromServer: [], all: [], hasOps: false };
    for (const [mk, mRef] of Object.entries(ch.messages || {})) {
      const info = messageInfo(doc, mRef, `${ptr}/messages/${escape(mk)}`, mk);
      if (info) { info.key = mk; entry.all.push(info); }
    }
    model.channels.push(entry);
    byPointer.set(ptr, entry);
    if (typeof chRef?.$ref === 'string') byPointer.set(chRef.$ref, entry);
  }
  const pick = (entry, refs) => (refs || []).map((r) => {
    const target = typeof r?.$ref === 'string' ? r.$ref : null;
    const found = entry.all.find((m) => target && (target.endsWith(`/messages/${escape(m.key)}`) || target === m.pointer));
    return found || messageInfo(doc, r, null);
  }).filter(Boolean);
  for (const [opId, opRef] of Object.entries(doc.operations || {})) {
    const op = resolve(doc, opRef).node || {};
    const chPtr = op.channel?.$ref;
    const entry = chPtr && byPointer.get(chPtr);
    if (!entry) { model.warnings.push(`Operation ${opId} refers to channel ${chPtr || '(none)'}, which is not defined`); continue; }
    entry.hasOps = true;
    const msgs = op.messages?.length ? pick(entry, op.messages) : entry.all;
    if (op.action === 'receive') entry.toServer.push(...msgs);
    else if (op.action === 'send') entry.fromServer.push(...msgs);
    if (op.reply) {
      const replyEntry = op.reply.channel?.$ref ? byPointer.get(op.reply.channel.$ref) || entry : entry;
      replyEntry.fromServer.push(...(op.reply.messages?.length ? pick(replyEntry, op.reply.messages) : replyEntry.all));
    }
  }
  for (const e of model.channels) {
    if (!e.hasOps) { e.toServer = [...e.all]; e.fromServer = [...e.all]; }
    const dedupe = (list) => list.filter((m, i) => list.findIndex((x) => x.pointer === m.pointer) === i);
    e.toServer = dedupe(e.toServer);
    e.fromServer = dedupe(e.fromServer);
    delete e.all;
    delete e.hasOps;
  }
  return model;
}

async function loadAsyncApi({ content }) {
  const doc = parseText(content);
  if (!doc || typeof doc !== 'object' || !doc.asyncapi) throw new AsyncApiError('Not an AsyncAPI document (missing "asyncapi")');
  if (!/^[23]\./.test(String(doc.asyncapi))) throw new AsyncApiError(`Unsupported AsyncAPI version ${doc.asyncapi}; use 2.x or 3.0`);
  const model = buildModel(doc);
  return { doc, model, title: model.title, apiVersion: doc.info?.version || '' };
}

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$|\.invalid$/i;

function lintAsyncApi(spec) {
  const { model, doc } = spec;
  const issues = [];
  const add = (severity, rule, pointer, message, fix) => issues.push({ severity, rule, pointer, message, fix });
  for (const w of model.warnings || []) add('error', 'unknown-channel', '#/operations', w);
  const wsServers = model.servers.filter((s) => /^wss?$/.test(s.protocol) || /^wss?:/.test(s.url));
  if (!model.servers.length) add('warning', 'no-servers', '#/servers', 'No servers are defined, so there is no URL to connect to.', 'Set the server URL on the Target tab.');
  else if (!wsServers.length) add('error', 'no-websocket-server', '#/servers', `No server uses ws or wss (found: ${model.servers.map((s) => s.protocol || '?').join(', ')}). Only WebSocket servers can be tested here.`);
  for (const s of wsServers) {
    let host = '';
    try { host = new URL(s.url).hostname; } catch { add('error', 'bad-server-url', `#/servers/${escape(s.name)}`, `Server ${s.name} has an invalid URL "${s.url}".`); continue; }
    if (PLACEHOLDER_HOST.test(host)) add('warning', 'placeholder-server', `#/servers/${escape(s.name)}`, `Server ${s.name} points at a placeholder or local host (${s.url}).`, 'Set the real server URL on the Target tab.');
    if (s.url.startsWith('ws:')) add('info', 'plain-ws', `#/servers/${escape(s.name)}`, `Server ${s.name} uses unencrypted ws://.`);
  }
  if (!model.channels.length) add('error', 'no-channels', '#/channels', 'The document defines no channels.');
  for (const ch of model.channels) {
    const ptr = `#/channels/${escape(ch.id)}`;
    if (!ch.toServer.length && !ch.fromServer.length) add('warning', 'no-messages', ptr, `Channel ${ch.id} has no messages.`);
    for (const m of [...ch.toServer, ...ch.fromServer]) {
      if (!m.payloadPointer) add('warning', 'no-payload', m.pointer, `Message ${m.name} on ${ch.id} has no payload schema, so it cannot be validated.`);
      else if (get(doc, m.payloadPointer.replace(/^#/, '#')) === undefined) add('error', 'unresolved-payload', m.payloadPointer, `Message ${m.name} payload could not be resolved.`);
    }
    for (const m of ch.toServer) if (!m.examples.length && !m.payloadPointer) add('info', 'no-example', m.pointer, `Message ${m.name} has no example; a sample is generated from the schema.`);
    if (/\{[^}]+\}/.test(ch.address)) add('info', 'channel-parameters', ptr, `Channel address ${ch.address} has parameters; replace them in the URL on the Try it tab.`);
  }
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, counts: { error: issues.filter((i) => i.severity === 'error').length, warning: issues.filter((i) => i.severity === 'warning').length, info: issues.filter((i) => i.severity === 'info').length } };
}

module.exports = { loadAsyncApi, lintAsyncApi, buildModel, AsyncApiError, parseText };
