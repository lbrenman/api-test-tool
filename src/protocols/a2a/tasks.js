'use strict';
// A2A task engine: an in-memory task store, the task lifecycle (SUBMITTED -> WORKING -> artifacts ->
// COMPLETED / FAILED / REJECTED / INPUT_REQUIRED / CANCELED), event fan-out to every open stream for a task,
// and push notifications (one POST per event to each configured webhook, in the version it was set up with).
const { agentMessage, textPart, dataPart, now, uuid, TERMINAL, INTERRUPTED, streamResponse } = require('./wire');
const { makeAgent } = require('./agent');

class A2AError extends Error {
  // name: TaskNotFound, TaskNotCancelable, PushNotificationNotSupported, UnsupportedOperation, ContentTypeNotSupported,
  //       InvalidAgentResponse, ExtendedAgentCardNotConfigured, ExtensionSupportRequired, VersionNotSupported,
  //       or a JSON-RPC one (InvalidParams, InvalidRequest, MethodNotFound, Internal)
  constructor(name, message, meta) { super(message); this.a2a = name; this.meta = meta; }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function makeEngine(ctx) {
  const agent = makeAgent(ctx);
  const tasks = new Map(); // id -> record { task, listeners:Set, push:Map, pending, owner, abort }

  const workMs = () => ctx.settings.get('a2aWorkMs');

  function prune() {
    const max = ctx.settings.get('a2aTaskRetention');
    if (tasks.size <= max) return;
    for (const [id, r] of tasks) {
      if (tasks.size <= max) break;
      if (TERMINAL.has(r.task.status.state) && !r.listeners.size) tasks.delete(id);
    }
  }

  function snapshot(r, historyLength, { includeArtifacts = true } = {}) {
    const t = JSON.parse(JSON.stringify(r.task));
    if (historyLength !== undefined && historyLength !== null) t.history = historyLength > 0 ? (t.history || []).slice(-historyLength) : [];
    if (!includeArtifacts) delete t.artifacts;
    return t;
  }

  // ---- events: streams and push notifications ----
  function emit(r, ev) {
    r.task.lastModified = now();
    for (const l of r.listeners) { try { l(ev); } catch { /* closed */ } }
    for (const cfg of r.push.values()) deliver(cfg, ev);
  }

  async function deliver(cfg, ev) {
    const headers = { 'Content-Type': cfg.version === '1.0' ? 'application/a2a+json' : 'application/json', 'User-Agent': 'api-test-tool-a2a' };
    const auth = cfg.authentication;
    if (auth?.credentials) headers.Authorization = `${auth.scheme || (Array.isArray(auth.schemes) ? auth.schemes[0] : 'Bearer')} ${auth.credentials}`;
    if (cfg.token) headers['X-A2A-Notification-Token'] = cfg.token;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ctx.settings.get('webhookTimeoutMs'));
    cfg.deliveries = (cfg.deliveries || 0) + 1;
    try {
      const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(streamResponse(ev, cfg.version)), signal: ac.signal });
      cfg.lastStatus = res.status;
      await res.arrayBuffer().catch(() => {});
    } catch (e) {
      cfg.lastStatus = null;
      cfg.lastError = e.message;
      ctx.log('warn', `A2A push to ${cfg.url} failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function addPush(r, cfg, version) {
    const id = cfg.id || uuid();
    const stored = { id, taskId: r.task.id, url: cfg.url, ...(cfg.token ? { token: cfg.token } : {}), ...(cfg.authentication ? { authentication: cfg.authentication } : {}), version, createdAt: now() };
    r.push.set(id, stored);
    return stored;
  }

  function setStatus(r, state, text) {
    const message = text ? agentMessage([textPart(text)], { taskId: r.task.id, contextId: r.task.contextId }) : undefined;
    r.task.status = { state, ...(message ? { message } : {}), timestamp: now() };
    if (message) r.task.history.push(message);
    emit(r, { statusUpdate: { taskId: r.task.id, contextId: r.task.contextId, status: r.task.status } });
  }

  function addArtifact(r, artifact) {
    r.task.artifacts.push(artifact);
  }

  // ---- the work itself ----
  async function work(r, step, forced) {
    const signal = r.abort.signal;
    const steps = Math.max(1, workMs());
    try {
      setStatus(r, 'TASK_STATE_WORKING', step.kind === 'tool' ? `${step.label}…` : undefined);
      await sleep(steps / 3, signal);
      if (signal.aborted) return;
      if (forced === 'reject') { setStatus(r, 'TASK_STATE_REJECTED', 'Rejected (forced by X-Force-A2A-Error: reject)'); return; }
      if (forced === 'fail') { setStatus(r, 'TASK_STATE_FAILED', 'Failure forced by X-Force-A2A-Error: fail'); return; }
      if (forced === 'auth-required') { setStatus(r, 'TASK_STATE_AUTH_REQUIRED', 'Additional authorization is required (forced by X-Force-A2A-Error: auth-required)'); return; }
      if (forced === 'input-required') { r.pending = { type: 'reparse' }; setStatus(r, 'TASK_STATE_INPUT_REQUIRED', 'More input is needed (forced by X-Force-A2A-Error: input-required). Send another message with this taskId.'); return; }
      if (step.kind === 'reject') { setStatus(r, 'TASK_STATE_REJECTED', step.text); return; }
      if (step.kind === 'ask') { r.pending = step.pending; setStatus(r, 'TASK_STATE_INPUT_REQUIRED', step.text); return; }

      const result = await agent.run(step.tool, step.args, signal);
      if (signal.aborted) return;
      if (!result.ok) { setStatus(r, 'TASK_STATE_FAILED', result.text); return; }

      // The answer as an artifact streamed in chunks (append / lastChunk), then the structured data.
      const artifactId = uuid();
      const lines = result.text.split('\n');
      const chunks = [];
      for (let i = 0; i < lines.length; i += 3) chunks.push(lines.slice(i, i + 3).join('\n') + (i + 3 < lines.length ? '\n' : ''));
      const answer = { artifactId, name: 'answer', description: 'The answer in plain text', parts: [textPart(result.text)] };
      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(steps / 3 / chunks.length, signal);
        if (signal.aborted) return;
        emit(r, { artifactUpdate: { taskId: r.task.id, contextId: r.task.contextId, artifact: { artifactId, name: 'answer', parts: [textPart(chunks[i])] }, append: i > 0, lastChunk: i === chunks.length - 1 } });
      }
      addArtifact(r, answer);
      if (result.data !== undefined) {
        const data = { artifactId: uuid(), name: 'data', description: `Structured result of ${step.tool}`, parts: [dataPart(result.data)], metadata: { operation: step.tool } };
        addArtifact(r, data);
        emit(r, { artifactUpdate: { taskId: r.task.id, contextId: r.task.contextId, artifact: data, append: false, lastChunk: true } });
      }
      await sleep(steps / 3, signal);
      if (signal.aborted) return;
      r.pending = null;
      setStatus(r, 'TASK_STATE_COMPLETED');
    } catch (e) {
      ctx.log('error', 'a2a task', e.stack || e);
      if (!TERMINAL.has(r.task.status.state)) setStatus(r, 'TASK_STATE_FAILED', `Internal error: ${e.message}`);
    } finally {
      r.done?.();
    }
  }

  /**
   * Handles a SendMessage / SendStreamingMessage. Returns { message } for a direct reply, or { record, started }
   * where started resolves once the task is created (the work keeps running). `listener` (streams) is attached
   * before the first event so nothing is missed.
   */
  async function send(message, { owner, forced, listener, pushConfig, version } = {}) {
    const text = (message.parts || []).filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
    const data = (message.parts || []).find((p) => p.data && typeof p.data === 'object' && !Array.isArray(p.data))?.data;

    let r = null;
    if (message.taskId) {
      r = tasks.get(message.taskId);
      if (!r || (r.owner && owner && r.owner !== owner)) throw new A2AError('TaskNotFound', `Task ${message.taskId} not found`, { taskId: message.taskId });
      if (TERMINAL.has(r.task.status.state)) throw new A2AError('UnsupportedOperation', `Task ${message.taskId} is ${r.task.status.state} and cannot take more messages`, { taskId: message.taskId });
      if (!INTERRUPTED.has(r.task.status.state)) throw new A2AError('UnsupportedOperation', `Task ${message.taskId} is still ${r.task.status.state}; wait until it needs input`, { taskId: message.taskId });
    }

    const step = await agent.plan(text, data, r?.pending);
    if (step.kind === 'reply' && !r) {
      return { message: agentMessage([textPart(step.text)], { contextId: message.contextId || uuid() }) };
    }

    if (!r) {
      const contextId = message.contextId || uuid();
      const t = { id: uuid(), contextId, status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() }, artifacts: [], history: [], createdAt: now(), lastModified: now(), metadata: {} };
      r = { task: t, listeners: new Set(), push: new Map(), pending: null, owner: owner || null, abort: new AbortController() };
      tasks.set(t.id, r);
      prune();
    } else {
      r.abort = new AbortController();
    }
    r.task.history.push({ ...message, taskId: r.task.id, contextId: r.task.contextId });
    if (pushConfig) addPush(r, pushConfig, version);
    if (listener) r.listeners.add(listener);
    const finished = new Promise((resolve) => { r.done = resolve; });
    const first = { task: snapshot(r) };
    if (listener) listener(first);
    for (const cfg of r.push.values()) deliver(cfg, first);
    setImmediate(() => work(r, step.kind === 'reply' ? { kind: 'ask', text: step.text, pending: { type: 'reparse' } } : step, forced));
    return { record: r, finished };
  }

  function get(id, owner) {
    const r = tasks.get(id);
    if (!r || (r.owner && owner && r.owner !== owner)) throw new A2AError('TaskNotFound', `Task ${id} not found`, { taskId: id });
    return r;
  }

  function cancel(id, owner) {
    const r = get(id, owner);
    if (TERMINAL.has(r.task.status.state)) throw new A2AError('TaskNotCancelable', `Task ${id} is already ${r.task.status.state}`, { taskId: id });
    r.abort.abort();
    r.pending = null;
    setStatus(r, 'TASK_STATE_CANCELED', 'Canceled at the client\'s request.');
    r.done?.();
    return r;
  }

  function list({ owner, contextId, status, pageSize = 50, pageToken, historyLength, includeArtifacts = false, statusTimestampAfter } = {}) {
    let all = [...tasks.values()].filter((r) => !r.owner || !owner || r.owner === owner).map((r) => r.task);
    if (contextId) all = all.filter((t) => t.contextId === contextId);
    if (status) all = all.filter((t) => t.status.state === status);
    if (statusTimestampAfter) all = all.filter((t) => t.status.timestamp > statusTimestampAfter);
    all.sort((a, b) => (a.status.timestamp < b.status.timestamp ? 1 : -1));
    let start = 0;
    if (pageToken) {
      try { start = JSON.parse(Buffer.from(pageToken, 'base64url').toString()).o; } catch { throw new A2AError('InvalidParams', 'Invalid pageToken'); }
      if (!Number.isInteger(start) || start < 0) throw new A2AError('InvalidParams', 'Invalid pageToken');
    }
    const size = Math.min(Math.max(1, pageSize), 100);
    const page = all.slice(start, start + size).map((t) => snapshot({ task: t }, historyLength ?? 0, { includeArtifacts }));
    const next = start + size < all.length ? Buffer.from(JSON.stringify({ o: start + size })).toString('base64url') : '';
    return { tasks: page, nextPageToken: next, pageSize: size, totalSize: all.length };
  }

  return { send, get, cancel, list, snapshot, addPush, A2AError, agent, tasks };
}

module.exports = { makeEngine, A2AError };
