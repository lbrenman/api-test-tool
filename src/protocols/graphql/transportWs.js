'use strict';
// GraphQL over WebSocket, "graphql-transport-ws" subprotocol (the protocol of the graphql-ws library).
//
//   client: connection_init -> server: connection_ack
//   client: subscribe {id, payload:{query, variables, operationName}}
//   server: next {id, payload: ExecutionResult} … complete {id}    (or error {id, payload: [errors]})
//   client: complete {id} stops a subscription; ping/pong either way.
// Close codes: 4400 bad message, 4401 subscribe before ack, 4406 wrong subprotocol, 4408 no
// connection_init in time, 4409 duplicate id, 4429 repeated connection_init.
const { subscribe, execute } = require('graphql');
const { prepare, coded } = require('./execute');

const SUBPROTOCOL = 'graphql-transport-ws';
const INIT_TIMEOUT_MS = 3000;

function session(conn, { schema, settings, contextValue }) {
  let acked = false;
  let initSeen = false;
  const ops = new Map(); // id -> async iterator (or null while a query runs)
  const send = (msg) => { if (conn.open) conn.send(JSON.stringify(msg)); };
  const initTimer = setTimeout(() => { if (!acked) conn.close(4408, 'Connection initialisation timeout'); }, INIT_TIMEOUT_MS);

  if (conn.protocol !== SUBPROTOCOL) {
    clearTimeout(initTimer);
    conn.close(4406, `Subprotocol not acceptable: use ${SUBPROTOCOL}`);
    return;
  }

  conn.on('close', () => {
    clearTimeout(initTimer);
    for (const it of ops.values()) it?.return?.();
    ops.clear();
  });

  conn.on('message', async (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { conn.close(4400, 'Invalid message received'); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') { conn.close(4400, 'Invalid message received'); return; }

    switch (msg.type) {
      case 'connection_init':
        if (initSeen) { conn.close(4429, 'Too many initialisation requests'); return; }
        initSeen = true;
        acked = true;
        clearTimeout(initTimer);
        send({ type: 'connection_ack' });
        return;
      case 'ping':
        send({ type: 'pong', ...(msg.payload !== undefined ? { payload: msg.payload } : {}) });
        return;
      case 'pong':
        return;
      case 'complete': {
        const it = ops.get(msg.id);
        ops.delete(msg.id);
        it?.return?.();
        return;
      }
      case 'subscribe': {
        if (!acked) { conn.close(4401, 'Unauthorized'); return; }
        const { id, payload } = msg;
        if (typeof id !== 'string' || !id || !payload || typeof payload.query !== 'string') { conn.close(4400, 'Invalid message received'); return; }
        if (ops.has(id)) { conn.close(4409, `Subscriber for ${id} already exists`); return; }
        ops.set(id, null);
        const prep = prepare(schema, settings, payload);
        if (prep.requestErrors) { ops.delete(id); send({ id, type: 'error', payload: prep.requestErrors }); return; }
        const args = { schema, document: prep.document, variableValues: payload.variables || undefined, operationName: payload.operationName || undefined, contextValue };
        try {
          if (prep.operation.operation !== 'subscription') {
            const result = await execute(args);
            if (!ops.has(id)) return; // completed by the client meanwhile
            if (!('data' in result)) send({ id, type: 'error', payload: result.errors.map((e) => coded(e, 'BAD_USER_INPUT')) });
            else { send({ id, type: 'next', payload: result }); send({ id, type: 'complete' }); }
            ops.delete(id);
            return;
          }
          const it = await subscribe(args);
          if (!it || typeof it[Symbol.asyncIterator] !== 'function') { // an ExecutionResult with errors
            ops.delete(id);
            send({ id, type: 'error', payload: (it?.errors || []).map((e) => coded(e, 'BAD_USER_INPUT')) });
            return;
          }
          if (!ops.has(id)) { it.return?.(); return; }
          ops.set(id, it);
          for await (const result of it) {
            if (!ops.has(id)) break;
            send({ id, type: 'next', payload: result });
          }
          if (ops.get(id) === it) { ops.delete(id); send({ id, type: 'complete' }); }
        } catch (e) {
          ops.delete(id);
          send({ id, type: 'error', payload: [{ message: e.message || 'Internal error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        }
        return;
      }
      default:
        conn.close(4400, `Unexpected message type "${msg.type}"`);
    }
  });
}

module.exports = { session, SUBPROTOCOL };
