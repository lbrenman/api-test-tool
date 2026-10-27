'use strict';
// Settings profiles: named sets of live settings that apply to one request when its path starts with /p/<name>,
// so several auth modes or chaos setups can be used side by side on one server without changing the global
// settings (docs/security-roadmap.md, step 1). One built-in profile per auth mode; custom ones are stored in the DB.
// Profiles change behaviour only: data, files, OAuth clients and users, webhooks and sessions stay shared.
const { BY_KEY, coerce } = require('../config/settings');
const { HttpError } = require('../util/problem');

const AUTH_MODES = BY_KEY.authMode.options;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Settings a profile may set: per-request behaviour only. Storage, the OAuth server, the inspector, webhooks,
// the *_ENABLED switches and anything needing a restart stay global.
const KEYS = [
  'authMode', 'apiKey', 'apiKeyName', 'apiKeyIn', 'basicUser', 'basicPass', 'bearerToken', 'hmacKeyId', 'hmacSecret', 'hmacMaxSkewSeconds', 'mtlsAllowedSubjects',
  'errorRate', 'errorTypes', 'latencyMinMs', 'latencyMaxMs', 'chaosTimeoutSeconds', 'chaosSlowDripMs', 'chaosRouteOverrides',
  'rateLimitRpm', 'responseHeaders', 'requiredHeaders',
  'dateFormat', 'dateFormatPattern', 'dateTzOffset',
  'soapWsse', 'soapActionCheck', 'graphqlIntrospection', 'graphqlMaxDepth', 'odataMaxPageSize',
  'llmModels', 'llmRequireKnownModel', 'llmCompletionTokensMin', 'llmCompletionTokensMax', 'llmStreamDelayMs', 'llmToolCallRate',
  'mcpAllowWrites', 'mcpResponseMode', 'mcpValidateHeaders', 'a2aAllowWrites', 'a2aWorkMs',
];
const PROFILE_KEYS = new Set(KEYS.filter((k) => BY_KEY[k] && !BY_KEY[k].restart));

class ProfileService {
  constructor(ctx) {
    this.ctx = ctx;
    this.custom = new Map();
  }

  async init() {
    for (const d of await this.ctx.repo.list('profiles')) if (d && NAME.test(d.name || '')) this.custom.set(d.name, d);
  }

  static keys() { return [...PROFILE_KEYS]; }

  builtIns() {
    return AUTH_MODES.map((m) => ({ name: m, builtIn: true, description: `Auth mode ${m}; everything else global`, settings: { authMode: m } }));
  }

  list() {
    return [...this.builtIns(), ...[...this.custom.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }

  get(name) {
    return this.builtIns().find((p) => p.name === name) || this.custom.get(name) || null;
  }

  validate(settings) {
    const out = {};
    for (const [k, v] of Object.entries(settings || {})) {
      if (!PROFILE_KEYS.has(k)) throw new HttpError(400, `"${k}" cannot be set in a profile. Allowed: ${[...PROFILE_KEYS].join(', ')}`, { code: 'invalid-profile' });
      try { out[k] = coerce(BY_KEY[k], v); } catch (e) { throw new HttpError(400, e.message, { code: 'invalid-profile' }); }
    }
    return out;
  }

  async save(name, { description, settings } = {}, { create = false } = {}) {
    if (!NAME.test(String(name || ''))) throw new HttpError(400, 'Profile names are 1-40 lowercase letters, digits and hyphens, starting with a letter or digit', { code: 'invalid-profile' });
    if (AUTH_MODES.includes(name)) throw new HttpError(409, `"${name}" is a built-in profile and cannot be changed`, { code: 'profile-built-in' });
    const existing = this.custom.get(name);
    if (create && existing) throw new HttpError(409, `Profile "${name}" already exists`, { code: 'profile-exists' });
    if (!create && !existing) throw new HttpError(404, `No profile "${name}"`, { code: 'profile-not-found' });
    const now = new Date().toISOString();
    const doc = {
      name,
      description: String(description ?? existing?.description ?? '').slice(0, 200),
      settings: settings === undefined ? existing.settings : this.validate(settings),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await this.ctx.repo.put('profiles', name, doc);
    this.custom.set(name, doc);
    return doc;
  }

  async remove(name) {
    if (AUTH_MODES.includes(name)) throw new HttpError(409, `"${name}" is a built-in profile and cannot be deleted`, { code: 'profile-built-in' });
    if (!this.custom.has(name)) throw new HttpError(404, `No profile "${name}"`, { code: 'profile-not-found' });
    this.custom.delete(name);
    await this.ctx.repo.del('profiles', name);
  }

  // The settings store for settings.runIn().
  store(profile) { return { name: profile.name, settings: profile.settings }; }

  run(name, fn) {
    const p = this.get(name);
    if (!p) throw new HttpError(404, `No profile "${name}"`, { code: 'profile-not-found' });
    return this.ctx.settings.runIn(this.store(p), fn);
  }
}

module.exports = { ProfileService, PROFILE_KEYS, AUTH_MODES };
