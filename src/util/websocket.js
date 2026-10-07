'use strict';
// A small, dependency-free WebSocket implementation (RFC 6455) used by both sides of the tool:
//   - the mock /ws endpoints (server role, unmasked frames)
//   - the WebSocket contract tester (client role, masked frames), which needs things browsers and
//     the built-in WebSocket hide: the HTTP status of a rejected upgrade, raw frames, close codes,
//     oversized or deliberately broken frames for negative tests.
// Supports text/binary messages, fragmentation, ping/pong, the close handshake and size limits.
// Extensions (permessage-deflate) are not negotiated.
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const CLOSE_NAMES = {
  1000: 'normal', 1001: 'going away', 1002: 'protocol error', 1003: 'unsupported data', 1005: 'no status', 1006: 'abnormal (no close frame)',
  1007: 'invalid payload', 1008: 'policy violation', 1009: 'message too big', 1010: 'extension required', 1011: 'internal error', 1012: 'service restart', 1013: 'try again later',
};

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const acceptKey = (key) => crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');

function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true, rsv1 = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

class ProtocolError extends Error {
  constructor(message, code = 1002) { super(message); this.code = code; }
}

/**
 * One WebSocket connection over an upgraded socket.
 * Events: message ({ data: string|Buffer, binary }), ping (Buffer), pong (Buffer),
 *         close ({ code, reason, clean, by: 'local'|'remote'|'network' }), error (Error)
 */
class WsConnection extends EventEmitter {
  constructor(socket, { role, maxMessageBytes = 16 * 1024 * 1024, head } = {}) {
    super();
    this.socket = socket;
    this.role = role; // 'server' | 'client'
    this.maxMessageBytes = maxMessageBytes;
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts: [], size }
    this.state = 'open'; // open | closing | closed
    this.closeInfo = null;
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('close', () => this.finish({ code: this.closeInfo?.code ?? 1006, reason: this.closeInfo?.reason ?? '', clean: !!this.closeInfo, by: this.closeInfo?.by || 'network' }));
    if (head && head.length) setImmediate(() => this.onData(head));
  }

  get open() { return this.state === 'open'; }

  write(buf) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(buf);
    return true;
  }

  frame(opcode, payload, opts = {}) {
    return this.write(encodeFrame(opcode, payload, { mask: this.role === 'client', ...opts }));
  }

  send(data, { binary } = {}) {
    if (this.state !== 'open') return false;
    const isBin = binary ?? Buffer.isBuffer(data);
    return this.frame(isBin ? OP.BINARY : OP.TEXT, isBin ? data : Buffer.from(String(data), 'utf8'));
  }

  /** Raw bytes on the wire (tester negative tests). */
  sendRaw(buf) { return this.write(buf); }

  ping(data = '') { return this.state === 'open' && this.frame(OP.PING, Buffer.from(String(data))); }

  close(code = 1000, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.closeInfo = { code, reason, by: 'local' };
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = code === 1005 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([code >> 8, code & 0xff]), r]);
    this.frame(OP.CLOSE, payload);
    // The server closes the TCP connection; a client waits for it, then gives up.
    if (this.role === 'server') setTimeout(() => this.socket.end(), 50).unref?.();
    setTimeout(() => this.socket.destroy(), 3000).unref?.();
  }

  terminate() { this.socket.destroy(); }

  finish(info) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', info);
  }

  fail(code, message) {
    this.emit('error', new ProtocolError(message, code));
    if (this.state === 'open') this.close(code, message);
    else this.socket.destroy();
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      for (;;) {
        const f = this.parseFrame();
        if (!f) break;
        this.handleFrame(f);
      }
    } catch (e) {
      if (e instanceof ProtocolError) this.fail(e.code, e.message);
      else throw e;
    }
  }

  parseFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80);
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) throw new ProtocolError(`Frame of ${big} bytes exceeds the ${this.maxMessageBytes}-byte limit`, 1009);
      len = Number(big);
      off = 10;
    }
    if (rsv) throw new ProtocolError('Reserved bits set without a negotiated extension');
    if (this.role === 'server' && !masked) throw new ProtocolError('Client frames must be masked');
    if (this.role === 'client' && masked) throw new ProtocolError('Server frames must not be masked');
    if (opcode >= 0x8 && (len > 125 || !fin)) throw new ProtocolError('Invalid control frame');
    if (len > this.maxMessageBytes) throw new ProtocolError(`Frame of ${len} bytes exceeds the ${this.maxMessageBytes}-byte limit`, 1009);
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const key = b.subarray(off, off + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
      payload = out;
    } else payload = Buffer.from(payload);
    this.buf = b.subarray(need);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING: this.emit('ping', payload); if (this.state === 'open') this.frame(OP.PONG, payload); return;
      case OP.PONG: this.emit('pong', payload); return;
      case OP.CLOSE: {
        let code = 1005;
        let reason = '';
        if (payload.length === 1) throw new ProtocolError('Invalid close frame');
        if (payload.length >= 2) { code = payload.readUInt16BE(0); reason = payload.subarray(2).toString('utf8'); }
        if (this.state === 'open') {
          this.closeInfo = { code, reason, by: 'remote' };
          this.state = 'closing';
          this.frame(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
          if (this.role === 'server') this.socket.end(); else setTimeout(() => this.socket.destroy(), 1000).unref?.();
        } else if (this.closeInfo) {
          this.closeInfo.peerCode = code;
          if (this.role === 'client') this.socket.end();
        }
        return;
      }
      case OP.TEXT:
      case OP.BINARY:
        if (this.fragments) throw new ProtocolError('New message started before the previous one finished');
        if (fin) return this.deliver(opcode, payload);
        this.fragments = { opcode, parts: [payload], size: payload.length };
        return;
      case OP.CONT:
        if (!this.fragments) throw new ProtocolError('Continuation frame without a message');
        this.fragments.parts.push(payload);
        this.fragments.size += payload.length;
        if (this.fragments.size > this.maxMessageBytes) throw new ProtocolError(`Message exceeds the ${this.maxMessageBytes}-byte limit`, 1009);
        if (fin) { const { opcode: op, parts } = this.fragments; this.fragments = null; this.deliver(op, Buffer.concat(parts)); }
        return;
      default:
        throw new ProtocolError(`Unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  deliver(opcode, payload) {
    if (this.state !== 'open') return;
    if (opcode === OP.TEXT) {
      let text;
      try { text = UTF8.decode(payload); } catch { throw new ProtocolError('Text message is not valid UTF-8', 1007); }
      this.emit('message', { data: text, binary: false });
    } else this.emit('message', { data: payload, binary: true });
  }
}

// ---------------------------------------------------------------- server side
/** Validate an upgrade request. Returns null when acceptable, or { status, message }. */
function checkUpgrade(req) {
  if (req.method !== 'GET') return { status: 405, message: 'WebSocket upgrades must use GET' };
  if (!/\bwebsocket\b/i.test(req.headers.upgrade || '')) return { status: 400, message: 'Missing "Upgrade: websocket" header' };
  if (!/\bupgrade\b/i.test(req.headers.connection || '')) return { status: 400, message: 'Missing "Connection: Upgrade" header' };
  if (req.headers['sec-websocket-version'] !== '13') return { status: 426, message: 'Sec-WebSocket-Version must be 13' };
  const key = req.headers['sec-websocket-key'];
  if (!key || Buffer.from(key, 'base64').length !== 16) return { status: 400, message: 'Invalid Sec-WebSocket-Key' };
  return null;
}

/**
 * Complete the handshake on an upgraded socket. extraHeaders are added to the 101 response.
 * chooseProtocol(requested[]) returns the subprotocol to accept (or null).
 */
function acceptUpgrade(req, socket, head, { extraHeaders = {}, chooseProtocol, maxMessageBytes } = {}) {
  const requested = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const protocol = chooseProtocol ? chooseProtocol(requested) : null;
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    ...Object.entries(extraHeaders).filter(([k, v]) => v !== undefined && !/^(upgrade|connection|sec-websocket-|content-length|content-type|transfer-encoding)/i.test(k))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`),
  ];
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const conn = new WsConnection(socket, { role: 'server', head, maxMessageBytes });
  conn.protocol = protocol;
  return conn;
}

// ---------------------------------------------------------------- client side
/**
 * Connect as a client. Resolves { conn, status: 101, headers, protocol, durationMs }.
 * A rejected upgrade resolves { conn: null, status, headers, body } (no throw), so tests can
 * assert on 401/403/429. Network errors reject.
 */
function connect(url, { headers = {}, protocols = [], timeoutMs = 15000, maxMessageBytes } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`Invalid WebSocket URL "${url}"`)); return; }
    if (!/^wss?:$/.test(u.protocol)) { reject(new Error('WebSocket URL must start with ws:// or wss://')); return; }
    const secure = u.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');
    const started = Date.now();
    const req = (secure ? https : http).request({
      protocol: secure ? 'https:' : 'http:',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      agent: false, // a fresh connection per handshake: never reuse a pooled socket
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
      },
      timeout: timeoutMs,
    });
    req.on('timeout', () => { req.destroy(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`)); });
    req.on('error', (e) => reject(e));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => resolve({ conn: null, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 4000), durationMs: Date.now() - started }));
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        resolve({ conn: null, status: 101, headers: res.headers, body: '', error: 'Invalid Sec-WebSocket-Accept from the server', durationMs: Date.now() - started });
        return;
      }
      const protocol = res.headers['sec-websocket-protocol'] || null;
      const conn = new WsConnection(socket, { role: 'client', head, maxMessageBytes });
      conn.protocol = protocol;
      resolve({ conn, status: 101, headers: res.headers, protocol, durationMs: Date.now() - started });
    });
    req.end();
  });
}

module.exports = { WsConnection, encodeFrame, acceptKey, checkUpgrade, acceptUpgrade, connect, OP, CLOSE_NAMES, ProtocolError };
