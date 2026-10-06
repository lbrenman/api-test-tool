'use strict';
// JWT signing keys. RS256 key pair comes from JWT_PRIVATE_KEY or is generated once and persisted in the DB.
// HS256 secret comes from JWT_SECRET or is generated once and persisted.
const crypto = require('node:crypto');

class KeyService {
  constructor(repo, settings) {
    this.repo = repo;
    this.settings = settings;
  }

  async init() {
    this.jose = require('jose');
    const { importPKCS8, exportJWK, calculateJwkThumbprint } = this.jose;
    let pem = process.env.JWT_PRIVATE_KEY ? process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
    if (!pem) pem = await this.repo.kvGet('jwt:rsaPrivateKey');
    if (!pem) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      await this.repo.kvSet('jwt:rsaPrivateKey', pem);
    }
    this.rsaPrivate = await importPKCS8(pem, 'RS256', { extractable: true });
    const pubObj = crypto.createPublicKey(crypto.createPrivateKey(pem));
    this.rsaPublic = pubObj;
    const jwk = await exportJWK(pubObj);
    this.kid = await calculateJwkThumbprint(jwk);
    this.publicJwk = { ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' };

    let secret = await this.repo.kvGet('jwt:hsSecret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      await this.repo.kvSet('jwt:hsSecret', secret);
    }
    this.generatedHsSecret = secret;
  }

  hsSecret() {
    return new TextEncoder().encode(this.settings.get('jwtSecret') || this.generatedHsSecret);
  }

  alg() { return this.settings.get('jwtAlg'); }

  jwks() { return { keys: [this.publicJwk] }; }

  async sign(claims, { ttl, issuer, audience, subject }) {
    const { SignJWT } = this.jose;
    const alg = this.alg();
    const jwt = new SignJWT(claims)
      .setProtectedHeader(alg === 'RS256' ? { alg, kid: this.kid, typ: 'JWT' } : { alg, typ: 'JWT' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setJti(crypto.randomUUID())
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl);
    if (subject) jwt.setSubject(subject);
    return jwt.sign(alg === 'RS256' ? this.rsaPrivate : this.hsSecret());
  }

  // Verify against whichever algorithm the token declares (RS256 or HS256).
  async verify(token, { issuer, audience }) {
    const { jwtVerify, decodeProtectedHeader } = this.jose;
    let header;
    try { header = decodeProtectedHeader(token); } catch { throw new Error('Malformed JWT'); }
    let key;
    if (header.alg === 'RS256') key = this.rsaPublic;
    else if (header.alg === 'HS256') key = this.hsSecret();
    else throw new Error(`Unsupported JWT alg ${header.alg}`);
    const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: [header.alg], clockTolerance: 5 });
    return { header, payload };
  }

  decode(token) {
    try {
      return { header: this.jose.decodeProtectedHeader(token), payload: this.jose.decodeJwt(token) };
    } catch {
      return null;
    }
  }
}

module.exports = { KeyService };
