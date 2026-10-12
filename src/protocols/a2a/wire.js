'use strict';
// A2A wire formats. Tasks, messages and events are kept in the 1.0 shape (ProtoJSON: camelCase,
// TASK_STATE_* / ROLE_* enum names, Parts discriminated by member: text | data | url | raw) and converted
// for 0.3 clients ("kind" discriminators, lowercase states, "user" / "agent", file parts, final flag).
const crypto = require('node:crypto');

const STATES = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'];
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const INTERRUPTED = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);
const V03_STATE = {
  TASK_STATE_SUBMITTED: 'submitted', TASK_STATE_WORKING: 'working', TASK_STATE_COMPLETED: 'completed', TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled', TASK_STATE_INPUT_REQUIRED: 'input-required', TASK_STATE_REJECTED: 'rejected', TASK_STATE_AUTH_REQUIRED: 'auth-required',
};
const FROM_V03_STATE = Object.fromEntries(Object.entries(V03_STATE).map(([k, v]) => [v, k]));

const now = () => new Date().toISOString(); // ISO 8601 UTC with milliseconds, as 1.0 asks
const uuid = () => crypto.randomUUID();

const textPart = (text) => ({ text, mediaType: 'text/plain' });
const dataPart = (data) => ({ data, mediaType: 'application/json' });

function agentMessage(parts, { taskId, contextId } = {}) {
  return { messageId: uuid(), role: 'ROLE_AGENT', parts, ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}) };
}

// ---- 0.3 -> 1.0 (incoming) ----
function partFromV03(p) {
  if (!p || typeof p !== 'object') return p;
  if (p.kind === 'text' || (p.kind === undefined && typeof p.text === 'string')) return { text: p.text, ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.kind === 'data') return { data: p.data, mediaType: 'application/json', ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.kind === 'file' && p.file) {
    const f = p.file;
    return { ...(f.uri !== undefined ? { url: f.uri } : { raw: f.bytes }), ...(f.mimeType ? { mediaType: f.mimeType } : {}), ...(f.name ? { filename: f.name } : {}) };
  }
  return p;
}

function messageFromV03(m) {
  if (!m || typeof m !== 'object') return m;
  const role = m.role === 'user' ? 'ROLE_USER' : m.role === 'agent' ? 'ROLE_AGENT' : m.role;
  const { kind, ...rest } = m; // eslint-disable-line no-unused-vars
  return { ...rest, role, parts: Array.isArray(m.parts) ? m.parts.map(partFromV03) : m.parts };
}

// ---- 1.0 -> 0.3 (outgoing) ----
function partToV03(p) {
  if ('text' in p) return { kind: 'text', text: p.text, ...(p.metadata ? { metadata: p.metadata } : {}) };
  if ('data' in p) return { kind: 'data', data: p.data, ...(p.metadata ? { metadata: p.metadata } : {}) };
  const file = { ...(p.url !== undefined ? { uri: p.url } : { bytes: p.raw }), ...(p.mediaType ? { mimeType: p.mediaType } : {}), ...(p.filename ? { name: p.filename } : {}) };
  return { kind: 'file', file, ...(p.metadata ? { metadata: p.metadata } : {}) };
}

function messageToV03(m) {
  if (!m) return m;
  return { kind: 'message', ...m, role: m.role === 'ROLE_USER' ? 'user' : 'agent', parts: (m.parts || []).map(partToV03) };
}

const statusToV03 = (s) => (s ? { state: V03_STATE[s.state] || 'unknown', ...(s.message ? { message: messageToV03(s.message) } : {}), ...(s.timestamp ? { timestamp: s.timestamp } : {}) } : s);
const artifactToV03 = (a) => ({ ...a, parts: (a.parts || []).map(partToV03) });

function taskToV03(t) {
  const { createdAt, lastModified, ...rest } = t; // eslint-disable-line no-unused-vars
  return {
    kind: 'task', ...rest, status: statusToV03(t.status),
    ...(t.artifacts ? { artifacts: t.artifacts.map(artifactToV03) } : {}),
    ...(t.history ? { history: t.history.map(messageToV03) } : {}),
  };
}

/** A StreamResponse (1.0: {task} | {message} | {statusUpdate} | {artifactUpdate}) in the requested version. */
function streamResponse(ev, version) {
  if (version === '1.0') return ev;
  if (ev.task) return taskToV03(ev.task);
  if (ev.message) return messageToV03(ev.message);
  if (ev.statusUpdate) {
    const s = ev.statusUpdate;
    return { kind: 'status-update', taskId: s.taskId, contextId: s.contextId, status: statusToV03(s.status), final: TERMINAL.has(s.status.state) || INTERRUPTED.has(s.status.state), ...(s.metadata ? { metadata: s.metadata } : {}) };
  }
  const a = ev.artifactUpdate;
  return { kind: 'artifact-update', taskId: a.taskId, contextId: a.contextId, artifact: artifactToV03(a.artifact), ...(a.append !== undefined ? { append: a.append } : {}), ...(a.lastChunk !== undefined ? { lastChunk: a.lastChunk } : {}) };
}

/** SendMessage result: 1.0 wraps it ({task} | {message}); 0.3 returns the object itself with its kind. */
function sendResult(payload, version) {
  if (version === '1.0') return payload;
  return payload.task ? taskToV03(payload.task) : messageToV03(payload.message);
}

const taskOut = (t, version) => (version === '1.0' ? t : taskToV03(t));

module.exports = {
  STATES, TERMINAL, INTERRUPTED, V03_STATE, FROM_V03_STATE, now, uuid, textPart, dataPart, agentMessage,
  messageFromV03, messageToV03, partToV03, streamResponse, sendResult, taskOut, taskToV03,
};
