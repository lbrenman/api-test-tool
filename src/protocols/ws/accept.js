'use strict';
// Accepts a WebSocket upgrade that has passed the shared protocol stack, and applies the common
// connection policy: WS_MAX_MESSAGE_KB, WS_IDLE_TIMEOUT_SECONDS (no messages from the client; pongs do
// not count), WS_PING_INTERVAL_SECONDS keep-alive pings, and the hub used to close connections on shutdown.
// Used by the /ws channels and by GraphQL subscriptions (/graphql, graphql-transport-ws).
const { HttpError } = require('../../util/problem');
const { checkUpgrade, acceptUpgrade } = require('../../util/websocket');

// chooseProtocol(offered: string[]) => string | null
function acceptWs(ctx, req, res, { chooseProtocol = (offered) => offered[0] || null } = {}) {
  const { settings } = ctx;
  const bad = checkUpgrade(req);
  if (bad) throw new HttpError(bad.status, bad.message, { code: 'bad-upgrade' });

  res.statusCode = 101;
  req.ws.accepted = true;
  const conn = acceptUpgrade(req, req.ws.socket, req.ws.head, {
    extraHeaders: res.getHeaders(),
    chooseProtocol,
    maxMessageBytes: settings.get('wsMaxMessageKb') * 1024,
  });
  conn.on('error', () => { /* protocol errors close the connection with the right code */ });
  ctx.wsHub.add(conn);
  res.emit('finish'); // lets the inspector record the upgrade (101) now rather than when the socket closes

  let lastMessage = Date.now();
  let lastPing = Date.now();
  let awaitingPong = false;
  conn.on('message', () => { lastMessage = Date.now(); });
  conn.on('pong', () => { awaitingPong = false; });
  const pingEvery = settings.get('wsPingIntervalSeconds') * 1000;
  const idle = settings.get('wsIdleTimeoutSeconds') * 1000;
  const timer = setInterval(() => {
    if (!conn.open) return;
    const now = Date.now();
    if (idle && now - lastMessage >= idle) { conn.close(1001, `Idle for ${idle / 1000}s`); return; }
    if (pingEvery && now - lastPing >= pingEvery) {
      if (awaitingPong) { conn.terminate(); return; }
      awaitingPong = true;
      lastPing = now;
      conn.ping('keepalive');
    }
  }, Math.max(500, Math.min(pingEvery || 30000, idle || 30000) / 2));
  timer.unref();
  conn.on('close', () => { clearInterval(timer); ctx.wsHub.delete(conn); });
  return conn;
}

module.exports = { acceptWs };
