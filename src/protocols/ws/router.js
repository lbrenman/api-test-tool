'use strict';
// /ws — mock WebSocket channels.
//
//   GET /ws                    channel list (JSON)
//   GET /ws/asyncapi.json      AsyncAPI 3.0 description (always open)
//   GET /ws/{echo|rpc|changes} WebSocket upgrade; goes through the shared protocol stack, so the
//                              upgrade request is authenticated, rate-limited, header-checked and
//                              can be failed by chaos (X-Force-Error: 503 etc.) like any /v1 call.
//
// Upgrades reach Express through handleUpgrade() (src/app.js), which sets req.ws = { socket, head }.
const express = require('express');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { checkUpgrade, acceptUpgrade } = require('../../util/websocket');
const { CHANNELS, RPC_METHODS } = require('./channels');
const { generateAsyncApi } = require('./asyncapi');

function wsBase(baseUrl) {
  return baseUrl.replace(/^http/, 'ws');
}

module.exports = function wsRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const r = express.Router();
  const hub = ctx.wsHub;

  r.use((req, res, next) => {
    if (!settings.get('wsEnabled')) return sendProblem(req, res, 404, { detail: 'The WebSocket mock is disabled (WS_ENABLED=false)', code: 'ws-disabled' });
    next();
  });

  r.get('/', (req, res) => {
    const base = wsBase(baseUrl(req));
    res.json({
      channels: [
        { name: 'echo', url: `${base}/ws/echo`, description: 'Sends every message back unchanged.' },
        { name: 'rpc', url: `${base}/ws/rpc`, description: 'JSON-RPC 2.0 over the mock data.', methods: RPC_METHODS },
        { name: 'changes', url: `${base}/ws/changes`, description: 'Live created/updated/deleted events; ?resource= filters.' },
      ],
      asyncapi: `${baseUrl(req)}/ws/asyncapi.json`,
      open: hub.size,
      maxMessageKb: settings.get('wsMaxMessageKb'),
      idleTimeoutSeconds: settings.get('wsIdleTimeoutSeconds'),
      pingIntervalSeconds: settings.get('wsPingIntervalSeconds'),
    });
  });

  r.get('/asyncapi.json', (req, res) => res.json(generateAsyncApi(ctx, req)));

  r.get('/:channel', ...protocolStack(ctx, { format: 'problem' }), (req, res) => {
    const name = req.params.channel;
    const handler = Object.hasOwn(CHANNELS, name) ? CHANNELS[name] : null;
    if (!handler) throw new HttpError(404, `Unknown WebSocket channel "${name}". Available: ${Object.keys(CHANNELS).join(', ')}`, { code: 'unknown-channel' });
    if (!req.ws) {
      throw new HttpError(426, `This is a WebSocket endpoint: connect to ${wsBase(baseUrl(req))}/ws/${name}`, { code: 'upgrade-required', headers: { Upgrade: 'websocket', Connection: 'Upgrade' } });
    }
    const bad = checkUpgrade(req);
    if (bad) throw new HttpError(bad.status, bad.message, { code: 'bad-upgrade' });

    res.statusCode = 101;
    req.ws.accepted = true;
    const conn = acceptUpgrade(req, req.ws.socket, req.ws.head, {
      extraHeaders: res.getHeaders(),
      chooseProtocol: (offered) => offered[0] || null,
      maxMessageBytes: settings.get('wsMaxMessageKb') * 1024,
    });
    conn.channel = name;
    conn.on('error', () => { /* protocol errors close the connection with the right code */ });
    hub.add(conn);
    res.emit('finish'); // lets the inspector record the upgrade (101) now rather than when the socket closes

    // Idle timeout (no messages from the client; pongs do not count) and keep-alive pings.
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
    conn.on('close', () => { clearInterval(timer); hub.delete(conn); });

    handler(conn, req, ctx);
  });

  r.use((req) => { throw new HttpError(404, `No WebSocket route ${req.method} ${req.originalUrl}`, { code: 'route-not-found' }); });
  return r;
};
