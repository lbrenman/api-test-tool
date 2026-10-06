'use strict';
// npm run seed [-- --employees 100 --products 200 --seed 7 --no-files]
const { createContext } = require('../src/app');
const { seedAll } = require('../src/services/seed');
const { generateSamples } = require('../src/services/sampleFiles');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const ctx = await createContext();
  const num = (v) => (v === undefined ? undefined : Number(v));
  const r = await seedAll(ctx, { employees: num(arg('employees')), products: num(arg('products')), seed: num(arg('seed')) });
  console.log(`Seeded: ${JSON.stringify(r)}`);
  if (!process.argv.includes('--no-files') && ctx.settings.get('seedSampleFiles')) {
    const files = await generateSamples(ctx);
    console.log(`Generated ${files.length} sample files`);
  }
  await ctx.repo.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
