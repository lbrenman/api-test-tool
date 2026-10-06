'use strict';
// Auto-generated sample files: CSV, XLSX, JSON, PNG, JPG, PDF, TXT, ZIP (of the others) and a ~10 MB binary.
const { PassThrough } = require('node:stream');
const { SAMPLE_IDS } = require('./sampleIds');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, cols) {
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

function pngBuffer(width = 256, height = 160) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      png.data[i] = Math.round((x / width) * 255);
      png.data[i + 1] = Math.round((y / height) * 255);
      png.data[i + 2] = 180;
      png.data[i + 3] = 255;
      if ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0) png.data[i + 2] = 90;
    }
  }
  return PNG.sync.write(png);
}

function jpgBuffer(width = 320, height = 200) {
  const jpeg = require('jpeg-js');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) * 4;
      const cx = x - width / 2;
      const cy = y - height / 2;
      const r = Math.sqrt(cx * cx + cy * cy);
      data[i] = (r * 3) & 255;
      data[i + 1] = (x * 2) & 255;
      data[i + 2] = 255 - ((y * 2) & 255);
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 85).data;
}

function pdfBuffer(employees, products) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: 'API Test Tool sample report', CreationDate: new Date('2026-01-01T00:00:00Z') } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).text('API Test Tool — Sample Report', { underline: true });
    doc.moveDown().fontSize(11).text(`Employees: ${employees.length}    Products: ${products.length}`);
    doc.moveDown().fontSize(14).text('First employees');
    doc.fontSize(10);
    for (const e of employees.slice(0, 20)) doc.text(`${e.employeeNumber}  ${e.firstName} ${e.lastName}  ${e.title}  ${e.salaryDecimal}`);
    doc.addPage().fontSize(14).text('First products');
    doc.fontSize(10);
    for (const p of products.slice(0, 25)) doc.text(`${p.sku}  ${p.name}  ${p.currency} ${p.priceDecimal}`);
    doc.end();
  });
}

async function xlsxBuffer(employees, products) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'api-test-tool';
  wb.created = new Date('2026-01-01T00:00:00Z');
  const es = wb.addWorksheet('Employees');
  es.columns = [
    { header: 'id', key: 'id', width: 6 }, { header: 'employeeNumber', key: 'employeeNumber', width: 14 },
    { header: 'firstName', key: 'firstName', width: 14 }, { header: 'lastName', key: 'lastName', width: 16 },
    { header: 'email', key: 'email', width: 30 }, { header: 'level', key: 'level', width: 6 },
    { header: 'isActive', key: 'isActive', width: 8 }, { header: 'salary', key: 'salary', width: 12 },
    { header: 'hireDate', key: 'hireDate', width: 12 },
  ];
  employees.forEach((e) => es.addRow(e));
  es.getRow(1).font = { bold: true };
  const ps = wb.addWorksheet('Products');
  ps.columns = [
    { header: 'id', key: 'id', width: 6 }, { header: 'sku', key: 'sku', width: 12 }, { header: 'name', key: 'name', width: 30 },
    { header: 'price', key: 'price', width: 10 }, { header: 'currency', key: 'currency', width: 8 },
    { header: 'inStock', key: 'inStock', width: 8 }, { header: 'stockQty', key: 'stockQty', width: 8 },
  ];
  products.forEach((p) => ps.addRow(p));
  ps.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function zipBuffer(entries) {
  const archiver = require('archiver');
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.pipe(out);
    for (const e of entries) archive.append(e.buffer, { name: e.name, date: new Date('2026-01-01T00:00:00Z') });
    archive.finalize();
  });
}

// Deterministic pseudo-random bytes (xorshift32) so range tests have stable checksums.
function largeBuffer(bytes = 10 * 1024 * 1024, seed = 42) {
  const buf = Buffer.allocUnsafe(bytes);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < bytes; i += 4) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    if (i + 4 <= bytes) buf.writeUInt32LE(x, i);
    else for (let j = i; j < bytes; j++) buf[j] = (x >>> ((j - i) * 8)) & 255;
  }
  return buf;
}

async function generateSamples(ctx) {
  const { resources, files, settings } = ctx;
  const employees = await resources.render('employees', await resources.all('employees'));
  const products = await resources.render('products', await resources.all('products'));
  const flatEmp = employees.map((e) => ({ ...e, department: e.department?.name, address: e.address?.city, skills: (e.skills || []).join('|') }));
  const flatProd = products.map((p) => ({ ...p, category: p.category?.name, tags: (p.tags || []).join('|') }));

  const items = [
    { id: SAMPLE_IDS.employeesCsv, name: 'employees.csv', contentType: 'text/csv',
      buffer: Buffer.from(toCsv(flatEmp, ['id', 'employeeNumber', 'firstName', 'lastName', 'email', 'title', 'level', 'isActive', 'salary', 'salaryDecimal', 'performanceRating', 'department', 'managerId', 'skills', 'address', 'hireDate', 'createdAt'])) },
    { id: SAMPLE_IDS.productsCsv, name: 'products.csv', contentType: 'text/csv',
      buffer: Buffer.from(toCsv(flatProd, ['id', 'sku', 'name', 'description', 'price', 'priceDecimal', 'currency', 'inStock', 'stockQty', 'weightKg', 'category', 'tags', 'rating', 'releaseDate'])) },
    { id: SAMPLE_IDS.xlsx, name: 'data.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsxBuffer(employees, products) },
    { id: SAMPLE_IDS.json, name: 'data.json', contentType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z', employees: employees.slice(0, 50), products: products.slice(0, 50) }, null, 2)) },
    { id: SAMPLE_IDS.png, name: 'gradient.png', contentType: 'image/png', buffer: pngBuffer() },
    { id: SAMPLE_IDS.jpg, name: 'radial.jpg', contentType: 'image/jpeg', buffer: jpgBuffer() },
    { id: SAMPLE_IDS.pdf, name: 'report.pdf', contentType: 'application/pdf', buffer: await pdfBuffer(employees, products) },
    { id: SAMPLE_IDS.txt, name: 'readme.txt', contentType: 'text/plain; charset=utf-8',
      buffer: Buffer.from('API Test Tool sample text file.\nLine two — with unicode: café, naïve, 日本語, 🚀\nLine three.\n') },
  ];
  const zip = await zipBuffer(items.map((i) => ({ name: i.name, buffer: i.buffer })));
  items.push({ id: SAMPLE_IDS.zip, name: 'bundle.zip', contentType: 'application/zip', buffer: zip });
  items.push({ id: SAMPLE_IDS.large, name: 'large-10mb.bin', contentType: 'application/octet-stream', buffer: largeBuffer(10 * 1024 * 1024, settings.get('seedRandomSeed')) });

  // Remove previously generated samples, keep user uploads.
  for (const f of await ctx.repo.list('files')) if (f.source === 'generated') await files.remove(f.id);
  const out = [];
  for (const it of items) {
    const r = await files.store.writeBuffer(it.id, it.buffer, { contentType: it.contentType });
    out.push(await files.meta(it.id, { name: it.name, contentType: it.contentType, source: 'generated', size: r.size, sha256: r.sha256 }));
  }
  return out;
}

module.exports = { generateSamples, largeBuffer, toCsv };
