'use strict';
// Deterministic data seeding with Faker (SEED_RANDOM_SEED) and relational integrity.
const { faker } = require('@faker-js/faker');
const { LEVELS, PHONE_TYPES, CURRENCIES, SIZES } = require('./schemas');
const { SAMPLE_IDS } = require('./sampleIds');

const DEPARTMENTS = [
  ['Engineering', 'ENG'], ['Sales', 'SALES'], ['Marketing', 'MKT'], ['Finance', 'FIN'], ['Human Resources', 'HR'],
  ['Operations', 'OPS'], ['Customer Success', 'CS'], ['Legal', 'LEGAL'], ['Product', 'PROD'], ['Supply Chain', 'SCM'],
];
const CATEGORIES = [
  ['Electronics', 'ELEC'], ['Home & Kitchen', 'HOME'], ['Outdoor', 'OUT'], ['Office Supplies', 'OFFICE'],
  ['Apparel', 'APP'], ['Toys & Games', 'TOYS'], ['Health', 'HEALTH'], ['Automotive', 'AUTO'],
  ['Books', 'BOOKS'], ['Industrial', 'IND'], ['Garden', 'GARDEN'], ['Café & Pantry', 'PANTRY'],
];
const SKILLS = ['JavaScript', 'Python', 'SQL', 'Kubernetes', 'Negotiation', 'Excel', 'Public speaking', 'Go', 'Java',
  'Salesforce', 'Figma', 'Accounting', 'Forecasting', 'Terraform', 'Customer empathy', 'Rust', 'Data analysis'];
const CERTS = ['AWS Solutions Architect', 'PMP', 'CPA', 'Scrum Master', 'CISSP', 'Google Analytics', 'ITIL v4', 'Six Sigma Green Belt'];
const UNICODE_TAILS = [
  ' — “Édition spéciale” ✨', ' (naïve façade, crème brûlée finish)', ' 🚀🔥 limited run', ' – 日本語テキスト対応',
  ' "quoted" & <escaped> characters', ' Ünïcödé ßtrëss tëst 🧪', " l'été à Montréal ☀️", ' Ελληνικά / Русский / עברית',
];
const COLORS = ['black', 'white', 'red', 'navy', 'forest green', 'sand', 'charcoal', 'sky blue'];

async function seedAll(ctx, { employees, products, seed } = {}) {
  const { repo, settings, resources } = ctx;
  const nEmp = employees ?? settings.get('seedEmployees');
  const nProd = products ?? settings.get('seedProducts');
  const rnd = seed ?? settings.get('seedRandomSeed');

  faker.seed(rnd);
  faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
  const iso = (d) => new Date(d).toISOString();
  const day = (d) => iso(d).slice(0, 10);
  const recent = () => faker.date.between({ from: '2023-01-01T00:00:00Z', to: '2025-12-31T00:00:00Z' });

  for (const c of ['employees', 'products', 'departments', 'categories']) await repo.clear(c);

  const departments = DEPARTMENTS.map(([name, code], i) => {
    const created = recent();
    return { id: i + 1, uuid: faker.string.uuid(), name, code, createdAt: iso(created), updatedAt: iso(created) };
  });
  const categories = CATEGORIES.map(([name, code], i) => {
    const created = recent();
    return { id: i + 1, uuid: faker.string.uuid(), name, code, createdAt: iso(created), updatedAt: iso(created) };
  });

  const emps = [];
  for (let id = 1; id <= nEmp; id++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const salary = faker.number.float({ min: 45000, max: 240000, fractionDigits: 2 });
    const created = recent();
    const updated = faker.date.between({ from: created, to: '2026-01-01T00:00:00Z' });
    const certs = faker.helpers.arrayElements(CERTS, { min: 0, max: 3 }).map((name) => {
      const issued = faker.date.past({ years: 6 });
      return { name, issuedAt: iso(issued), expiresAt: faker.datatype.boolean({ probability: 0.6 }) ? iso(faker.date.future({ years: 3, refDate: issued })) : null };
    });
    const country = faker.helpers.arrayElement(['US', 'US', 'US', 'CA', 'GB', 'DE', 'FR', 'JP', 'IL', 'IN']);
    emps.push({
      id,
      uuid: faker.string.uuid(),
      employeeNumber: `EMP-${String(id).padStart(6, '0')}`,
      firstName,
      lastName,
      email: faker.internet.email({ firstName, lastName, provider: 'example.com' }).toLowerCase(),
      title: faker.person.jobTitle(),
      level: faker.helpers.arrayElement(LEVELS),
      isActive: faker.datatype.boolean({ probability: 0.9 }),
      salary,
      salaryDecimal: salary.toFixed(2),
      performanceRating: faker.datatype.boolean({ probability: 0.85 }) ? faker.number.float({ min: 1, max: 5, fractionDigits: 1 }) : null,
      departmentId: faker.number.int({ min: 1, max: departments.length }),
      managerId: id <= Math.max(1, Math.floor(nEmp * 0.08)) ? null : faker.number.int({ min: 1, max: Math.max(1, Math.floor(nEmp * 0.08)) }),
      skills: faker.helpers.arrayElements(SKILLS, { min: 0, max: 5 }),
      certifications: certs,
      address: {
        street: faker.location.streetAddress(),
        city: faker.location.city(),
        region: faker.location.state({ abbreviated: true }),
        postalCode: faker.location.zipCode(),
        countryCode: country,
        geo: { lat: faker.location.latitude({ precision: 6 }), lng: faker.location.longitude({ precision: 6 }) },
      },
      phoneNumbers: faker.helpers.arrayElements(PHONE_TYPES, { min: 1, max: 3 }).map((type) => ({ type, number: faker.phone.number({ style: 'international' }) })),
      hireDate: day(faker.date.past({ years: 12 })),
      metadata: {
        source: 'seed',
        badgeNumber: faker.number.int({ min: 10000, max: 99999 }),
        remote: faker.datatype.boolean(),
        preferences: { theme: faker.helpers.arrayElement(['light', 'dark', 'system']), notifications: faker.datatype.boolean() },
        ...(faker.datatype.boolean({ probability: 0.3 }) ? { nickname: faker.person.firstName() } : {}),
      },
      avatarFileId: id % 7 === 0 ? SAMPLE_IDS.png : id % 11 === 0 ? SAMPLE_IDS.jpg : null,
      createdAt: iso(created),
      updatedAt: iso(updated),
    });
  }

  const prods = [];
  for (let id = 1; id <= nProd; id++) {
    const price = faker.number.float({ min: 1, max: 2500, fractionDigits: 2 });
    const created = recent();
    const updated = faker.date.between({ from: created, to: '2026-01-01T00:00:00Z' });
    const stockQty = faker.number.int({ min: 0, max: 900 });
    const sku = `SKU-${String(id).padStart(5, '0')}`;
    prods.push({
      id,
      uuid: faker.string.uuid(),
      sku,
      name: faker.commerce.productName(),
      description: faker.commerce.productDescription() + UNICODE_TAILS[id % UNICODE_TAILS.length],
      price,
      priceDecimal: price.toFixed(2),
      currency: faker.helpers.arrayElement(CURRENCIES),
      inStock: stockQty > 0,
      stockQty,
      weightKg: faker.number.float({ min: 0.05, max: 80, fractionDigits: 3 }),
      dimensions: {
        l: faker.number.float({ min: 1, max: 200, fractionDigits: 1 }),
        w: faker.number.float({ min: 1, max: 200, fractionDigits: 1 }),
        h: faker.number.float({ min: 1, max: 200, fractionDigits: 1 }),
        unit: faker.helpers.arrayElement(['cm', 'in']),
      },
      tags: faker.helpers.arrayElements(['new', 'sale', 'eco', 'bestseller', 'clearance', 'imported', 'handmade', 'premium'], { min: 0, max: 4 }),
      variants: faker.helpers.arrayElements(SIZES, { min: 0, max: 3 }).map((size) => ({
        sku: `${sku}-${size}`,
        color: faker.helpers.arrayElement(COLORS),
        size,
        priceDelta: faker.number.float({ min: -20, max: 40, fractionDigits: 2 }),
      })),
      categoryId: faker.number.int({ min: 1, max: categories.length }),
      rating: faker.datatype.boolean({ probability: 0.8 }) ? faker.number.float({ min: 1, max: 5, fractionDigits: 1 }) : null,
      releaseDate: day(faker.date.past({ years: 5 })),
      discontinuedAt: faker.datatype.boolean({ probability: 0.1 }) ? iso(faker.date.between({ from: updated, to: '2026-01-01T00:00:00Z' })) : null,
      imageFileIds: id % 5 === 0 ? [SAMPLE_IDS.png, SAMPLE_IDS.jpg] : id % 3 === 0 ? [SAMPLE_IDS.png] : [],
      createdAt: iso(created),
      updatedAt: iso(updated),
    });
  }

  await repo.putMany('departments', departments.map((d) => ({ id: d.id, data: d })));
  await repo.putMany('categories', categories.map((d) => ({ id: d.id, data: d })));
  await repo.putMany('employees', emps.map((d) => ({ id: d.id, data: d })));
  await repo.putMany('products', prods.map((d) => ({ id: d.id, data: d })));
  await repo.setCounter('departments', departments.length);
  await repo.setCounter('categories', categories.length);
  await repo.setCounter('employees', emps.length);
  await repo.setCounter('products', prods.length);
  await repo.clear('idempotency');
  resources.invalidate();
  await repo.kvSet('seed:last', { at: new Date().toISOString(), employees: nEmp, products: nProd, seed: rnd });
  return { departments: departments.length, categories: categories.length, employees: emps.length, products: prods.length, seed: rnd };
}

async function clearAll(ctx) {
  for (const c of ['employees', 'products', 'departments', 'categories', 'idempotency']) await ctx.repo.clear(c);
  for (const c of ['employees', 'products', 'departments', 'categories']) await ctx.repo.setCounter(c, 0);
  ctx.resources.invalidate();
}

module.exports = { seedAll, clearAll };
