'use strict';
// Global timestamp formatting. Timestamps are stored internally as UTC ISO strings
// and converted on output according to DATE_FORMAT. Date-only fields are untouched.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(customParseFormat);

const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt', 'issuedAt', 'expiresAt', 'discontinuedAt']);

function offsetMinutes(offset) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '+00:00');
  if (!m) return 0;
  const mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === '-' ? -mins : mins;
}

function makeDateFormatter(settings) {
  const opts = () => ({
    format: settings.get('dateFormat'),
    pattern: settings.get('dateFormatPattern'),
    offset: settings.get('dateTzOffset'),
  });

  function formatValue(value) {
    if (value === null || value === undefined) return value;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) return value;
    const { format, pattern, offset } = opts();
    switch (format) {
      case 'epoch-s': return Math.floor(ms / 1000);
      case 'epoch-ms': return ms;
      case 'rfc1123': return new Date(ms).toUTCString();
      case 'iso-offset': return dayjs.utc(ms).utcOffset(offsetMinutes(offset)).format('YYYY-MM-DDTHH:mm:ss.SSSZ');
      case 'custom': return dayjs.utc(ms).utcOffset(offsetMinutes(offset)).format(pattern);
      default: return new Date(ms).toISOString();
    }
  }

  // Accept any supported format on input; returns an ISO string or throws.
  function parseValue(value) {
    if (value === null || value === undefined || value === '') return value === '' ? null : value;
    if (typeof value === 'number') return new Date(value < 1e11 ? value * 1000 : value).toISOString();
    const s = String(value).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return new Date(n < 1e11 ? n * 1000 : n).toISOString();
    }
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    const { pattern, offset } = opts();
    const d = dayjs.utc(s, pattern, true);
    if (d.isValid()) return d.subtract(offsetMinutes(offset), 'minute').toISOString();
    throw new Error(`Unrecognized timestamp: ${s}`);
  }

  // Deep-format all timestamp fields of an output document.
  function formatDoc(doc) {
    if (Array.isArray(doc)) return doc.map(formatDoc);
    if (!doc || typeof doc !== 'object') return doc;
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
      if (TIMESTAMP_FIELDS.has(k) && (typeof v === 'string' || v === null)) out[k] = formatValue(v);
      else if (v && typeof v === 'object' && k !== 'metadata') out[k] = formatDoc(v);
      else out[k] = v;
    }
    return out;
  }

  // Normalize timestamp fields of an incoming document to ISO.
  function parseDoc(doc, errors = [], prefix = '') {
    if (Array.isArray(doc)) return doc.map((d, i) => parseDoc(d, errors, `${prefix}${i}.`));
    if (!doc || typeof doc !== 'object') return doc;
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
      if (TIMESTAMP_FIELDS.has(k) && v !== null && v !== undefined && typeof v !== 'object') {
        try { out[k] = parseValue(v); } catch (e) { errors.push({ field: `${prefix}${k}`, message: e.message }); out[k] = v; }
      } else if (v && typeof v === 'object' && k !== 'metadata') out[k] = parseDoc(v, errors, `${prefix}${k}.`);
      else out[k] = v;
    }
    return out;
  }

  // JSON Schema for a timestamp in the active format (used by the generated OpenAPI).
  function schema({ nullable = false } = {}) {
    const { format, pattern, offset } = opts();
    let s;
    let example;
    const sample = '2026-01-15T14:30:00.000Z';
    switch (format) {
      case 'epoch-s': s = { type: 'integer', format: 'int64', description: 'Unix epoch seconds' }; break;
      case 'epoch-ms': s = { type: 'integer', format: 'int64', description: 'Unix epoch milliseconds' }; break;
      case 'rfc1123': s = { type: 'string', description: 'RFC 1123 HTTP-date (e.g. Thu, 15 Jan 2026 14:30:00 GMT)' }; break;
      case 'custom': s = { type: 'string', description: `Custom format "${pattern}" at offset ${offset}` }; break;
      case 'iso-offset': s = { type: 'string', format: 'date-time', description: `ISO 8601 with offset ${offset}` }; break;
      default: s = { type: 'string', format: 'date-time', description: 'ISO 8601 UTC' };
    }
    example = formatValue(sample);
    s.examples = [example];
    if (nullable) s.type = [s.type, 'null'];
    return s;
  }

  return { formatValue, parseValue, formatDoc, parseDoc, schema, TIMESTAMP_FIELDS };
}

module.exports = { makeDateFormatter, TIMESTAMP_FIELDS };
