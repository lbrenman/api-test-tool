'use strict';
// /graphql — GraphQL mock over the shared mock data (GraphQL over HTTP + graphql-transport-ws).
//
//   POST /graphql                 application/json {query, variables?, operationName?} or application/graphql
//   GET  /graphql?query=…         queries only (mutations need POST: 405)
//   GET  /graphql (browser)       GraphiQL page (Accept: text/html, no query) — open
//   GET  /graphql/schema.graphql  SDL — always open, like /openapi.json and the WSDLs
//   GET  /graphql (WebSocket)     subscriptions and operations over graphql-transport-ws
//
// Requests (and WebSocket upgrades) go through the shared protocol stack (required headers, rate limit,
// AUTH_MODE, chaos). Request/transport errors come back as {"errors":[…]} with extensions.code and the
// real HTTP status; field errors are HTTP 200 with partial data. X-Force-GraphQL-Error: field[:status]
// injects a field error (comma list; Type.field also works).
const express = require('express');
const { printSchema } = require('graphql');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify, JSON_TYPES } = require('../../middleware/body');
const { acceptWs } = require('../ws/accept');
const { makeSchema } = require('./schema');
const { prepare, run, readParams, parseForceErrors } = require('./execute');
const { responseType, RESPONSE_TYPE } = require('./errors');
const { session, SUBPROTOCOL } = require('./transportWs');
const { graphiqlPage } = require('./graphiql');

const SAMPLE_QUERY = `query Employees($limit: Int = 5) {
  employees(limit: $limit, sort: "lastName") {
    total
    items { id fullName title level department { name } }
  }
}`;

module.exports = function graphqlRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const r = express.Router();
  const schema = makeSchema(ctx);
  const sdl = printSchema(schema);

  r.use((req, res, next) => {
    req.errorFormat = 'graphql';
    if (!settings.get('graphqlEnabled')) return sendProblem(req, res, 404, { detail: 'The GraphQL mock is disabled (GRAPHQL_ENABLED=false)', code: 'graphql-disabled' });
    next();
  });

  // ---- open: SDL and the GraphiQL page
  r.get('/schema.graphql', (req, res) => res.type('text/plain; charset=utf-8').send(sdl));
  r.get('/', (req, res, next) => {
    if (req.ws || req.query.query !== undefined || req.accepts(['application/json', RESPONSE_TYPE, 'text/html']) !== 'text/html') return next();
    res.type('html').send(graphiqlPage({ endpoint: `${baseUrl(req)}/graphql`, query: SAMPLE_QUERY }));
  });

  const stack = protocolStack(ctx, {
    format: 'graphql',
    body: [
      express.json({ limit: '1mb', type: [...JSON_TYPES, RESPONSE_TYPE], verify }),
      express.text({ limit: '1mb', type: 'application/graphql', verify }),
    ],
  });

  async function answer(req, res, params) {
    const contextValue = { req, forceErrors: parseForceErrors(req.get('x-force-graphql-error')) };
    const out = await run(schema, settings, params, contextValue);
    const type = responseType(req);
    // GraphQL over HTTP: with application/json, well-formed requests answer 200 even when they fail to
    // parse or validate; with application/graphql-response+json those are 400.
    const status = out.requestError && type === RESPONSE_TYPE ? 400 : 200;
    res.status(status).type(`${type}; charset=utf-8`).send(JSON.stringify(out.result));
  }

  r.get('/', ...stack, async (req, res) => {
    if (req.ws) {
      const conn = acceptWs(ctx, req, res, { chooseProtocol: (offered) => (offered.includes(SUBPROTOCOL) ? SUBPROTOCOL : null) });
      conn.channel = 'graphql';
      session(conn, { schema, settings, contextValue: { req, forceErrors: parseForceErrors(req.get('x-force-graphql-error')) } });
      return;
    }
    const { params, error } = readParams(req.query, { fromQueryString: true });
    if (error) throw new HttpError(400, error, { code: 'invalid-graphql-request' });
    // Only queries may use GET; prepare once to know the operation type before executing anything.
    const prep = prepare(schema, settings, params);
    if (prep.operation && prep.operation.operation !== 'query') {
      throw new HttpError(405, `${prep.operation.operation === 'mutation' ? 'Mutations' : 'Subscriptions'} cannot be sent with GET; use POST`, { code: 'method-not-allowed', headers: { Allow: 'POST' } });
    }
    await answer(req, res, params);
  });

  r.post('/', ...stack, async (req, res) => {
    let src = req.body;
    if (req.is('application/graphql')) src = { query: typeof req.body === 'string' ? req.body : '', ...req.query };
    else if (!req.is([...JSON_TYPES, RESPONSE_TYPE])) {
      throw new HttpError(415, 'Send application/json ({"query": "…"}) or application/graphql', { code: 'unsupported-media-type' });
    }
    const { params, error } = readParams(src);
    if (error) throw new HttpError(400, error, { code: 'invalid-graphql-request' });
    await answer(req, res, params);
  });

  r.all('/', (req) => { throw new HttpError(405, `${req.method} is not supported on /graphql; use GET or POST`, { code: 'method-not-allowed', headers: { Allow: 'GET, POST' } }); });
  r.use((req) => { throw new HttpError(404, `No GraphQL route ${req.method} ${req.originalUrl}`, { code: 'route-not-found' }); });
  return r;
};

module.exports.SAMPLE_QUERY = SAMPLE_QUERY;
