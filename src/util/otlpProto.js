'use strict';
// Protobuf encoding of OTLP export requests (OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf), in-house like the other wire
// formats here. Input is the OTLP JSON shape services/telemetry.js builds (camelCase fields, hex trace/span ids,
// 64-bit integers as decimal strings), so one builder serves both encodings. Field numbers are those of
// opentelemetry-proto v1 (collector/{trace,metrics,logs}/v1, trace/v1, metrics/v1, logs/v1, common/v1, resource/v1); only the
// fields this tool sends are listed.

// Field types: string, bytes (from hex), enum/uint32/bool (varint), int64 (signed varint), fixed32, fixed64, sfixed64,
// double, a message name, or [type] for repeated fields (repeated numbers are packed).
const MESSAGES = {
  ExportTraceServiceRequest: { resourceSpans: [1, ['ResourceSpans']] },
  ExportMetricsServiceRequest: { resourceMetrics: [1, ['ResourceMetrics']] },
  ExportLogsServiceRequest: { resourceLogs: [1, ['ResourceLogs']] },
  Resource: { attributes: [1, ['KeyValue']], droppedAttributesCount: [2, 'uint32'] },
  InstrumentationScope: { name: [1, 'string'], version: [2, 'string'], attributes: [3, ['KeyValue']] },
  KeyValue: { key: [1, 'string'], value: [2, 'AnyValue'] },
  AnyValue: { stringValue: [1, 'string'], boolValue: [2, 'bool'], intValue: [3, 'int64'], doubleValue: [4, 'double'] },
  ResourceSpans: { resource: [1, 'Resource'], scopeSpans: [2, ['ScopeSpans']], schemaUrl: [3, 'string'] },
  ScopeSpans: { scope: [1, 'InstrumentationScope'], spans: [2, ['Span']], schemaUrl: [3, 'string'] },
  Span: {
    traceId: [1, 'bytes'], spanId: [2, 'bytes'], traceState: [3, 'string'], parentSpanId: [4, 'bytes'], name: [5, 'string'],
    kind: [6, 'enum'], startTimeUnixNano: [7, 'fixed64'], endTimeUnixNano: [8, 'fixed64'], attributes: [9, ['KeyValue']],
    status: [15, 'Status'],
  },
  Status: { message: [2, 'string'], code: [3, 'enum'] },
  ResourceMetrics: { resource: [1, 'Resource'], scopeMetrics: [2, ['ScopeMetrics']], schemaUrl: [3, 'string'] },
  ScopeMetrics: { scope: [1, 'InstrumentationScope'], metrics: [2, ['Metric']], schemaUrl: [3, 'string'] },
  Metric: { name: [1, 'string'], description: [2, 'string'], unit: [3, 'string'], gauge: [5, 'Gauge'], sum: [7, 'Sum'], histogram: [9, 'Histogram'] },
  ResourceLogs: { resource: [1, 'Resource'], scopeLogs: [2, ['ScopeLogs']], schemaUrl: [3, 'string'] },
  ScopeLogs: { scope: [1, 'InstrumentationScope'], logRecords: [2, ['LogRecord']], schemaUrl: [3, 'string'] },
  LogRecord: {
    timeUnixNano: [1, 'fixed64'], severityNumber: [2, 'enum'], severityText: [3, 'string'], body: [5, 'AnyValue'],
    attributes: [6, ['KeyValue']], flags: [8, 'fixed32'], traceId: [9, 'bytes'], spanId: [10, 'bytes'], observedTimeUnixNano: [11, 'fixed64'],
  },
  Gauge: { dataPoints: [1, ['NumberDataPoint']] },
  Sum: { dataPoints: [1, ['NumberDataPoint']], aggregationTemporality: [2, 'enum'], isMonotonic: [3, 'bool'] },
  Histogram: { dataPoints: [1, ['HistogramDataPoint']], aggregationTemporality: [2, 'enum'] },
  NumberDataPoint: { startTimeUnixNano: [2, 'fixed64'], timeUnixNano: [3, 'fixed64'], asDouble: [4, 'double'], asInt: [6, 'sfixed64'], attributes: [7, ['KeyValue']] },
  HistogramDataPoint: {
    startTimeUnixNano: [2, 'fixed64'], timeUnixNano: [3, 'fixed64'], count: [4, 'fixed64'], sum: [5, 'double'],
    bucketCounts: [6, ['fixed64']], explicitBounds: [7, ['double']], attributes: [9, ['KeyValue']],
  },
};

const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

const tag = (num, wire) => varint((num << 3) | wire);

function i64(v, signed) {
  const b = Buffer.alloc(8);
  const n = BigInt(v);
  if (signed) b.writeBigInt64LE(n); else b.writeBigUInt64LE(BigInt.asUintN(64, n));
  return b;
}

function f64(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(v));
  return b;
}

// One scalar value without its tag, and the wire type it needs.
function scalar(type, v) {
  switch (type) {
    case 'string': return [LEN, Buffer.from(String(v), 'utf8')];
    case 'bytes': return [LEN, Buffer.from(String(v), 'hex')];
    case 'bool': return [VARINT, varint(v ? 1 : 0)];
    case 'enum':
    case 'uint32':
    case 'int64': return [VARINT, varint(v)];
    case 'fixed32': { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v) >>> 0); return [I32, b]; }
    case 'fixed64': return [I64, i64(v, false)];
    case 'sfixed64': return [I64, i64(v, true)];
    case 'double': return [I64, f64(v)];
    default: throw new Error(`otlpProto: unknown type ${type}`);
  }
}

function field(num, type, v) {
  if (MESSAGES[type]) {
    const body = encode(v, type);
    return Buffer.concat([tag(num, LEN), varint(body.length), body]);
  }
  const [wire, bytes] = scalar(type, v);
  return Buffer.concat([tag(num, wire), ...(wire === LEN ? [varint(bytes.length)] : []), bytes]);
}

// Encodes a message given in OTLP JSON shape. Unknown fields are skipped; default values are written as given
// (proto3 readers accept them).
function encode(obj, msg) {
  const def = MESSAGES[msg];
  if (!def) throw new Error(`otlpProto: unknown message ${msg}`);
  const parts = [];
  for (const [name, [num, type]] of Object.entries(def)) {
    const v = obj?.[name];
    if (v === undefined || v === null) continue;
    if (Array.isArray(type)) {
      const t = type[0];
      if (!Array.isArray(v) || !v.length) continue;
      if (MESSAGES[t] || t === 'string' || t === 'bytes') {
        for (const item of v) parts.push(field(num, t, item));
      } else {
        const packed = Buffer.concat(v.map((item) => scalar(t, item)[1]));
        parts.push(tag(num, LEN), varint(packed.length), packed);
      }
    } else {
      parts.push(field(num, type, v));
    }
  }
  return Buffer.concat(parts);
}

module.exports = { encode, MESSAGES };
