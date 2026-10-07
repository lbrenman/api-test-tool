'use strict';
// AsyncAPI 3.0 description of the mock WebSocket channels (/ws/asyncapi.json), generated from the
// resolved base URL and the active auth mode. In this document "receive" operations are messages the
// server receives (clients send them) and "send" operations are messages the server sends.
const pkg = require('../../../package.json');
const { RPC_METHODS } = require('./channels');

function securityFor(mode, settings) {
  switch (mode) {
    case 'apikey': return { apiKey: { type: 'httpApiKey', name: settings.get('apiKeyName'), in: settings.get('apiKeyIn') === 'query' ? 'query' : 'header' } };
    case 'basic': return { basic: { type: 'http', scheme: 'basic' } };
    case 'bearer': return { bearer: { type: 'http', scheme: 'bearer', description: 'Authorization header, or ?access_token= on the upgrade URL' } };
    case 'jwt':
    case 'oauth2': return { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A token from the built-in OAuth server, as Authorization header or ?access_token= on the upgrade URL' } };
    case 'hmac': return { hmac: { type: 'httpApiKey', name: 'Authorization', in: 'header', description: 'HMAC signature of GET, path, timestamp and the empty-body hash' } };
    default: return null;
  }
}

function generateAsyncApi(ctx, req) {
  const base = new URL(ctx.baseUrl(req));
  const secure = base.protocol === 'https:';
  const mode = ctx.settings.get('authMode');
  const schemes = securityFor(mode, ctx.settings);
  const security = schemes ? Object.keys(schemes).map((k) => ({ $ref: `#/components/securitySchemes/${k}` })) : undefined;
  const msgRef = (n) => ({ $ref: `#/components/messages/${n}` });
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'API Test Tool — WebSocket mock',
      version: pkg.version,
      description: 'Mock WebSocket channels over the same data as /v1. The upgrade request goes through the same auth, rate limit, required headers and chaos as /v1, so a rejected upgrade returns the usual HTTP status. Channel URL = server host + pathname + channel address.',
    },
    defaultContentType: 'application/json',
    servers: {
      mock: {
        host: base.host,
        protocol: secure ? 'wss' : 'ws',
        pathname: `${base.pathname.replace(/\/$/, '')}/ws`,
        description: 'This tool',
        ...(security ? { security } : {}),
      },
    },
    channels: {
      echo: { address: '/echo', description: 'Every message is sent back unchanged (text or binary).', messages: { text: msgRef('EchoText') } },
      rpc: { address: '/rpc', description: 'JSON-RPC 2.0 requests over the mock data; replies carry the request "id".', messages: { request: msgRef('RpcRequest'), response: msgRef('RpcResponse') } },
      changes: {
        address: '/changes',
        description: 'Pushes an event whenever an employee, product, department or category is created, updated or deleted (through /v1, /soap or the back office). Add ?resource=employees,products to filter.',
        messages: { subscribed: msgRef('Subscribed'), change: msgRef('Change') },
      },
    },
    operations: {
      sendEcho: { action: 'receive', channel: { $ref: '#/channels/echo' }, messages: [{ $ref: '#/channels/echo/messages/text' }], reply: { channel: { $ref: '#/channels/echo' }, messages: [{ $ref: '#/channels/echo/messages/text' }] } },
      callRpc: { action: 'receive', channel: { $ref: '#/channels/rpc' }, messages: [{ $ref: '#/channels/rpc/messages/request' }], reply: { channel: { $ref: '#/channels/rpc' }, messages: [{ $ref: '#/channels/rpc/messages/response' }] } },
      pushChanges: { action: 'send', channel: { $ref: '#/channels/changes' }, messages: [{ $ref: '#/channels/changes/messages/subscribed' }, { $ref: '#/channels/changes/messages/change' }] },
    },
    components: {
      ...(schemes ? { securitySchemes: schemes } : {}),
      messages: {
        EchoText: { name: 'EchoText', contentType: 'text/plain', payload: { type: 'string' }, examples: [{ payload: 'hello' }] },
        RpcRequest: {
          name: 'RpcRequest',
          payload: { $ref: '#/components/schemas/RpcRequest' },
          correlationId: { location: '$message.payload#/id' },
          examples: [{ name: 'getEmployee', payload: { jsonrpc: '2.0', id: 1, method: 'getEmployee', params: { id: 1 } } }, { name: 'ping', payload: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} } }],
        },
        RpcResponse: { name: 'RpcResponse', payload: { $ref: '#/components/schemas/RpcResponse' }, correlationId: { location: '$message.payload#/id' } },
        Subscribed: { name: 'Subscribed', payload: { type: 'object', required: ['type', 'resources', 'at'], properties: { type: { const: 'subscribed' }, resources: { type: 'array', items: { type: 'string' } }, at: { type: 'string', format: 'date-time' } } } },
        Change: {
          name: 'Change',
          payload: {
            type: 'object', required: ['type', 'resource', 'id', 'at'],
            properties: {
              type: { type: 'string', enum: ['created', 'updated', 'deleted'] },
              resource: { type: 'string', enum: ['employees', 'products', 'departments', 'categories'] },
              id: { type: 'integer' },
              at: { type: 'string', format: 'date-time' },
              data: { type: 'object', description: 'The record after the change (absent for deletes)' },
            },
          },
        },
      },
      schemas: {
        RpcRequest: {
          type: 'object', required: ['id', 'method'],
          properties: {
            jsonrpc: { const: '2.0' },
            id: { type: ['integer', 'string'] },
            method: { type: 'string', enum: RPC_METHODS },
            params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } } },
          },
        },
        RpcResponse: {
          type: 'object', required: ['jsonrpc', 'id'],
          properties: {
            jsonrpc: { const: '2.0' },
            id: { type: ['integer', 'string', 'null'] },
            result: {},
            error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} } },
          },
          oneOf: [{ required: ['result'] }, { required: ['error'] }],
        },
      },
    },
  };
}

module.exports = { generateAsyncApi };
