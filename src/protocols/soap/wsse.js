'use strict';
// WS-Security UsernameToken (OASIS WSS 1.0) for the SOAP mock, controlled by SOAP_WSSE:
//   off      - the Security header is ignored
//   optional - checked when present
//   required - every request must carry a valid UsernameToken
// Credentials are BASIC_USER / BASIC_PASS. PasswordText and PasswordDigest are both accepted;
// PasswordDigest = Base64(SHA-1(nonce bytes + Created + password)), Created within HMAC_MAX_SKEW_SECONDS.
// This is independent of AUTH_MODE: with both set, a request needs both.
const crypto = require('node:crypto');
const { HttpError } = require('../../util/problem');
const { safeEq } = require('../../services/oauth');
const { NS, child, attr, textOf } = require('../../util/xml');

const TYPE_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';
const TYPE_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';

const fail = (detail, code = 'wsse-failed-authentication') => new HttpError(401, detail, { code });

function passwordDigest(nonceB64, created, password) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonceB64, 'base64'), Buffer.from(created + password, 'utf8')])).digest('base64');
}

/** Returns the authenticated username, or null when nothing was checked. Throws a 401 fault on failure. */
function checkWsse(header, settings) {
  const mode = settings.get('soapWsse');
  if (mode === 'off') return null;
  const security = child(header, 'Security', NS.wsse);
  if (!security) {
    if (mode === 'required') throw fail('A wsse:Security header with a UsernameToken is required', 'wsse-security-required');
    return null;
  }
  const token = child(security, 'UsernameToken', NS.wsse);
  if (!token) throw fail('wsse:Security must contain a wsse:UsernameToken', 'wsse-invalid-security');
  const userEl = child(token, 'Username', NS.wsse);
  const passEl = child(token, 'Password', NS.wsse);
  if (!userEl || !passEl) throw fail('UsernameToken needs wsse:Username and wsse:Password', 'wsse-invalid-security');
  const user = textOf(userEl);
  const pass = textOf(passEl);
  const type = attr(passEl, 'Type') || TYPE_TEXT;
  const expectedPass = settings.get('basicPass');

  let ok = safeEq(user, settings.get('basicUser'));
  if (type === TYPE_DIGEST) {
    const nonce = textOf(child(token, 'Nonce', NS.wsse));
    const created = textOf(child(token, 'Created', NS.wsu));
    if (!nonce || !created) throw fail('PasswordDigest needs wsse:Nonce and wsu:Created', 'wsse-invalid-security');
    const ts = Date.parse(created);
    const skew = settings.get('hmacMaxSkewSeconds');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skew * 1000) throw fail(`wsu:Created must be within ${skew}s of the server time`);
    ok = safeEq(pass, passwordDigest(nonce, created, expectedPass)) && ok;
  } else if (type === TYPE_TEXT) {
    ok = safeEq(pass, expectedPass) && ok;
  } else {
    throw fail(`Unsupported password Type "${type}"`, 'wsse-invalid-security');
  }
  if (!ok) throw fail('The security token could not be authenticated');
  return user;
}

module.exports = { checkWsse, passwordDigest, TYPE_TEXT, TYPE_DIGEST };
