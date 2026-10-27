'use strict';
// Prepares a Newman run for the collection's "Mutual TLS" folder: issues two client certificates from a running
// server's lab CA (admin API, no password) and writes them, the CA and Newman's client certificate list to a folder.
// Certificate a is presented to https://127.0.0.1:<port>, b to https://localhost:<port>.
//   node scripts/mtls-newman-setup.js http://127.0.0.1:3000 8443 ./mtls-run
//   -> prints the newman flags to add (--ssl-client-cert-list, --ssl-extra-ca-certs, --env-var mtlsUrl=…)
const fs = require('node:fs');
const path = require('node:path');

async function mtlsSetup(adminBase, mtlsPort, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const post = async (cn, uri) => {
    const res = await fetch(`${adminBase}/admin/api/mtls/certs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cn, san: { uri: [uri] } }) });
    if (!res.ok) throw new Error(`Issuing ${cn} failed: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
  const a = await post('newman-a', 'spiffe://lab/newman-a');
  const b = await post('newman-b', 'spiffe://lab/newman-b');
  const file = (n, text) => { const f = path.resolve(dir, n); fs.writeFileSync(f, text); return f; };
  const ca = file('lab-ca.pem', await (await fetch(`${adminBase}/admin/api/mtls/ca.pem`)).text());
  const certs = [['a', a, '127.0.0.1'], ['b', b, 'localhost']].map(([n, c, host]) => ({
    name: `newman-${n}`, matches: [`https://${host}:${mtlsPort}/*`], cert: { src: file(`${n}.pem`, c.certPem) }, key: { src: file(`${n}-key.pem`, c.keyPem) },
  }));
  const list = file('ssl-client-cert-list.json', JSON.stringify(certs, null, 2));
  const env = { mtlsUrl: `https://127.0.0.1:${mtlsPort}`, mtlsUrlOther: `https://localhost:${mtlsPort}`, mtlsSanUri: 'spiffe://lab/newman-a' };
  return {
    newman: { sslClientCertList: certs, sslExtraCaCerts: ca, insecureFileRead: true },
    env: Object.entries(env).map(([key, value]) => ({ key, value })),
    flags: [`--ssl-client-cert-list ${list}`, `--ssl-extra-ca-certs ${ca}`, ...Object.entries(env).map(([k, v]) => `--env-var ${k}=${v}`)].join(' '),
  };
}

module.exports = { mtlsSetup };

if (require.main === module) {
  const [adminBase, port, dir] = process.argv.slice(2);
  mtlsSetup(adminBase, port, dir || 'mtls-run').then((r) => console.log(r.flags)).catch((e) => { console.error(e.message); process.exit(1); });
}
