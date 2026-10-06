'use strict';
// JSON Schemas for the mock resources: input schemas (validation) and output schemas (OpenAPI).

const TS_IN = { type: ['string', 'integer', 'number'], description: 'Timestamp in any supported format' };
const TS_IN_NULL = { type: ['string', 'integer', 'number', 'null'] };
const READONLY_IN = { id: {}, uuid: {}, createdAt: {}, updatedAt: {} };

const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
const PHONE_TYPES = ['mobile', 'work', 'home', 'fax'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const DIM_UNITS = ['cm', 'in'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];

const address = {
  type: 'object',
  additionalProperties: false,
  properties: {
    street: { type: 'string', maxLength: 200 },
    city: { type: 'string', maxLength: 100 },
    region: { type: 'string', maxLength: 100 },
    postalCode: { type: 'string', maxLength: 20 },
    countryCode: { type: 'string', pattern: '^[A-Z]{2}$' },
    geo: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
      },
    },
  },
};

function employeeProps(ts, tsNull) {
  return {
    employeeNumber: { type: 'string', pattern: '^EMP-[0-9]{6}$' },
    firstName: { type: 'string', minLength: 1, maxLength: 100 },
    lastName: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email', maxLength: 200 },
    title: { type: 'string', maxLength: 120 },
    level: { type: 'string', enum: LEVELS },
    isActive: { type: 'boolean' },
    salary: { type: 'number', minimum: 0 },
    salaryDecimal: { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$', description: 'Decimal amount as a string' },
    performanceRating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
    departmentId: { type: 'integer', minimum: 1 },
    managerId: { type: ['integer', 'null'], minimum: 1 },
    skills: { type: 'array', items: { type: 'string', maxLength: 60 } },
    certifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'issuedAt'],
        properties: { name: { type: 'string', maxLength: 120 }, issuedAt: ts, expiresAt: tsNull },
      },
    },
    address,
    phoneNumbers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'number'],
        properties: { type: { type: 'string', enum: PHONE_TYPES }, number: { type: 'string', maxLength: 40 } },
      },
    },
    hireDate: { type: 'string', format: 'date' },
    metadata: { type: 'object', description: 'Free-form object', additionalProperties: true },
    avatarFileId: { type: ['string', 'null'] },
  };
}

function productProps(ts, tsNull) {
  return {
    sku: { type: 'string', pattern: '^[A-Z0-9-]{3,40}$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    price: { type: 'number', minimum: 0 },
    priceDecimal: { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$' },
    currency: { type: 'string', enum: CURRENCIES },
    inStock: { type: 'boolean' },
    stockQty: { type: 'integer', minimum: 0 },
    weightKg: { type: 'number', minimum: 0 },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        l: { type: 'number', minimum: 0 }, w: { type: 'number', minimum: 0 }, h: { type: 'number', minimum: 0 },
        unit: { type: 'string', enum: DIM_UNITS },
      },
    },
    tags: { type: 'array', items: { type: 'string', maxLength: 40 } },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku'],
        properties: {
          sku: { type: 'string' }, color: { type: 'string' }, size: { type: 'string', enum: SIZES }, priceDelta: { type: 'number' },
        },
      },
    },
    categoryId: { type: 'integer', minimum: 1 },
    rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
    releaseDate: { type: 'string', format: 'date' },
    discontinuedAt: tsNull,
    imageFileIds: { type: 'array', items: { type: 'string' } },
  };
}

const simpleProps = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  code: { type: 'string', pattern: '^[A-Z0-9-]{2,16}$' },
};

const INPUT = {
  employees: {
    type: 'object', additionalProperties: false,
    required: ['firstName', 'lastName', 'email', 'departmentId'],
    properties: { ...READONLY_IN, department: {}, ...employeeProps(TS_IN, TS_IN_NULL) },
  },
  products: {
    type: 'object', additionalProperties: false,
    required: ['name', 'sku', 'price', 'currency', 'categoryId'],
    properties: { ...READONLY_IN, category: {}, ...productProps(TS_IN, TS_IN_NULL) },
  },
  departments: {
    type: 'object', additionalProperties: false, required: ['name', 'code'],
    properties: { ...READONLY_IN, ...simpleProps },
  },
  categories: {
    type: 'object', additionalProperties: false, required: ['name', 'code'],
    properties: { ...READONLY_IN, ...simpleProps },
  },
};

// Output schemas for the generated OpenAPI. dateSchema(opts) comes from the date formatter.
function outputSchemas(dateSchema) {
  const ts = dateSchema();
  const tsNull = dateSchema({ nullable: true });
  const summary = (desc) => ({
    type: 'object', description: desc, required: ['id', 'name', 'code'],
    properties: { id: { type: 'integer' }, name: { type: 'string' }, code: { type: 'string' } },
  });
  const common = {
    id: { type: 'integer', readOnly: true, examples: [1] },
    uuid: { type: 'string', format: 'uuid', readOnly: true },
    createdAt: { ...ts, readOnly: true },
    updatedAt: { ...ts, readOnly: true },
  };
  return {
    Employee: {
      type: 'object',
      required: ['id', 'uuid', 'employeeNumber', 'firstName', 'lastName', 'email', 'level', 'isActive', 'departmentId', 'department', 'createdAt', 'updatedAt'],
      properties: { ...common, ...employeeProps(ts, tsNull), department: { ...summary('Department summary'), readOnly: true } },
    },
    Product: {
      type: 'object',
      required: ['id', 'uuid', 'sku', 'name', 'price', 'priceDecimal', 'currency', 'inStock', 'categoryId', 'category', 'createdAt', 'updatedAt'],
      properties: { ...common, ...productProps(ts, tsNull), category: { ...summary('Category summary'), readOnly: true } },
    },
    Department: { type: 'object', required: ['id', 'name', 'code', 'createdAt', 'updatedAt'], properties: { ...common, ...simpleProps } },
    Category: { type: 'object', required: ['id', 'name', 'code', 'createdAt', 'updatedAt'], properties: { ...common, ...simpleProps } },
    EmployeeInput: { type: 'object', required: INPUT.employees.required, properties: employeeProps(ts, tsNull) },
    ProductInput: { type: 'object', required: INPUT.products.required, properties: productProps(ts, tsNull) },
    DepartmentInput: { type: 'object', required: ['name', 'code'], properties: simpleProps },
    CategoryInput: { type: 'object', required: ['name', 'code'], properties: simpleProps },
  };
}

module.exports = { INPUT, outputSchemas, LEVELS, PHONE_TYPES, CURRENCIES, DIM_UNITS, SIZES };
