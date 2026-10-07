'use strict';
// GraphiQL page for GET /graphql in a browser (loaded from a CDN, versions pinned). Auth headers can
// be added in GraphiQL's Headers tab; the dashboard's Protocols page has a console that adds the
// active auth automatically.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function graphiqlPage({ endpoint, query }) {
  const cfg = JSON.stringify({ endpoint, query }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphiQL — API Test Tool</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphiql@3.7.1/graphiql.min.css">
<style>html,body,#graphiql{height:100%;margin:0}#fallback{font:15px system-ui,sans-serif;padding:24px;display:none}</style>
</head>
<body>
<div id="graphiql"></div>
<div id="fallback">GraphiQL could not be loaded from the CDN. Send POST requests to <code>${esc(endpoint)}</code>, or use the GraphQL console on the dashboard's Protocols page.</div>
<script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script crossorigin src="https://cdn.jsdelivr.net/npm/graphiql@3.7.1/graphiql.min.js"></script>
<script>
  (function () {
    var cfg = ${cfg};
    if (!window.GraphiQL || !window.React || !window.ReactDOM) { document.getElementById('fallback').style.display = 'block'; return; }
    var root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(React.createElement(GraphiQL, {
      fetcher: GraphiQL.createFetcher({ url: cfg.endpoint }),
      defaultQuery: cfg.query,
      defaultEditorToolsVisibility: true,
    }));
  })();
</script>
</body>
</html>`;
}

module.exports = { graphiqlPage };
