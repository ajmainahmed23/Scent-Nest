#!/usr/bin/env node
/**
 * Seeds MongoDB Atlas with everything the app needs to run.
 *
 *   node scripts/seed.js                                  indexes + categories + 12 products
 *   node scripts/seed.js --reference ./fra_cleaned.csv   also import the 24k catalog
 *   node scripts/seed.js --reset                          drop shop data first
 *
 * The reference import is what powers /api/match. It is separate because
 * it takes a minute and you only need to run it once.
 */
/* Reads .env sitting next to this file — no dotenv dependency needed. */
(function () {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();
const fs = require('fs');
const readline = require('readline');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || 'scentnest';
if (!URI) {
  console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] || true);
};

/* ------------------------------------------------------------------ *
 * Indexes — every field the functions actually filter or sort on
 * ------------------------------------------------------------------ */
async function createIndexes(db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });

  await db.collection('categories').createIndex({ category_name: 1 }, { unique: true });

  await db.collection('products').createIndexes([
    { key: { brand: 1 } },
    { key: { accords: 1 } },
    { key: { category_id: 1 } },
    { key: { is_active: 1, stock_ml: -1 } },
    { key: { price_per_ml: 1 } },
    { key: { rating_avg: -1 } },
    { key: { name: 'text', brand: 'text', description: 'text' }, name: 'product_text' },
  ]);

  await db.collection('orders').createIndexes([
    { key: { reference: 1 }, unique: true },
    { key: { user_id: 1, order_date: -1 } },
    { key: { status: 1, order_date: -1 } },
    { key: { contact_phone: 1 } },
  ]);

  await db.collection('order_items').createIndexes([
    { key: { order_id: 1 } },
    { key: { product_id: 1 } },
  ]);

  await db.collection('reviews').createIndexes([
    { key: { product_id: 1, status: 1, created_at: -1 } },
    { key: { product_id: 1, user_id: 1 }, unique: true },
  ]);

  await db.collection('reference_fragrances').createIndexes([
    { key: { search: 1 } },
    { key: { ratingCount: -1 } },
    { key: { brandSlug: 1 } },
  ]);

  console.log('  indexes created');
}

/* ------------------------------------------------------------------ *
 * Shop data
 * ------------------------------------------------------------------ */
const CATEGORIES = [
  { category_name: 'Men',    description: 'Fragrances marketed to men' },
  { category_name: 'Women',  description: 'Fragrances marketed to women' },
  { category_name: 'Unisex', description: 'Wearable by anyone' },
];

/** Twelve real fragrances with real note structures, priced for Dhaka. */
const PRODUCTS = [
  { name:'Asad', brand:'Lattafa', gender:'men', price_per_ml:105, stock_ml:180, badge:'Bestseller',
    reference_id:'lattafa-perfumes__asad', bottle_price:3900,
    description:'Pineapple and black pepper over a coffee-and-patchouli heart, drying to vanilla and amber. A budget answer to Aventus-style openings with a sweeter finish.',
    accords:['amber','vanilla','fresh spicy','woody','sweet'],
    notes:{ top:['Black pepper','Tobacco','Pineapple'], middle:['Patchouli','Coffee','Iris'], base:['Vanilla','Amber','Dry wood'] },
    season:['fall','winter'] },

  { name:'Khamrah', brand:'Lattafa', gender:'unisex', price_per_ml:120, stock_ml:240, badge:'New',
    reference_id:'lattafa-perfumes__khamrah', bottle_price:4200,
    description:'Cinnamon and nutmeg opening onto dates and praline. Heavy, sweet and built for cool evenings.',
    accords:['sweet','warm spicy','vanilla','cinnamon','gourmand'],
    notes:{ top:['Cinnamon','Nutmeg','Bergamot'], middle:['Dates','Praline','Tuberose'], base:['Vanilla','Tonka bean','Amberwood'] },
    season:['winter'] },

  { name:'Oud for Glory', brand:'Lattafa', gender:'unisex', price_per_ml:115, stock_ml:150, badge:'Cult',
    reference_id:'lattafa-perfumes__bade-e-al-oud-oud-for-glory', bottle_price:4400,
    description:'Saffron and nutmeg over agarwood and patchouli. The closest thing on this shelf to a traditional oud attar.',
    accords:['oud','warm spicy','fresh spicy','woody','smoky'],
    notes:{ top:['Saffron','Nutmeg','Lavender'], middle:['Agarwood (oud)','Patchouli'], base:['Agarwood (oud)','Patchouli','Musk'] },
    season:['fall','winter'] },

  { name:'Yara', brand:'Lattafa', gender:'women', price_per_ml:95, stock_ml:200, badge:'',
    reference_id:'lattafa-perfumes__yara', bottle_price:3400,
    description:'Orchid and tangerine over a tropical gourmand heart, settling into vanilla, musk and sandalwood.',
    accords:['sweet','vanilla','powdery','fruity','floral'],
    notes:{ top:['Orchid','Heliotrope','Tangerine'], middle:['Gourmand accord','Tropical fruits'], base:['Vanilla','Musk','Sandalwood'] },
    season:['spring','winter'] },

  { name:'Fakhar Black', brand:'Lattafa', gender:'men', price_per_ml:100, stock_ml:160, badge:'',
    reference_id:'lattafa-perfumes__fakhar-black', bottle_price:3600,
    description:'A fresh-spicy woody built around bergamot and cardamom with a clean amber drydown. Office-safe.',
    accords:['woody','fresh spicy','amber','aromatic','citrus'],
    notes:{ top:['Bergamot','Cardamom','Pink pepper'], middle:['Lavender','Geranium'], base:['Cedar','Amber','Musk'] },
    season:['spring','summer','fall'] },

  { name:'Club de Nuit Intense Man', brand:'Armaf', gender:'men', price_per_ml:110, stock_ml:190, badge:'Bestseller',
    reference_id:'armaf__club-de-nuit-intense-man', bottle_price:4100,
    description:'Lemon and pineapple over smoky birch. The most requested Aventus alternative in the shop.',
    accords:['citrus','fruity','leather','smoky','woody'],
    notes:{ top:['Lemon','Pineapple','Bergamot'], middle:['Birch','Jasmine','Rose'], base:['Musk','Ambergris','Patchouli'] },
    season:['spring','summer','fall'] },

  { name:'Sauvage', brand:'Dior', gender:'men', price_per_ml:390, stock_ml:95, badge:'',
    reference_id:'dior__sauvage', bottle_price:14500,
    description:'Calabrian bergamot and pepper over ambroxan. Loud, clean and instantly recognisable.',
    accords:['fresh spicy','amber','citrus','woody','aromatic'],
    notes:{ top:['Calabrian bergamot','Pepper'], middle:['Sichuan pepper','Lavender','Pink pepper'], base:['Ambroxan','Cedar','Labdanum'] },
    season:['spring','summer','fall'] },

  { name:'Bleu de Chanel', brand:'Chanel', gender:'men', price_per_ml:420, stock_ml:70, badge:'',
    reference_id:'chanel__bleu-de-chanel-eau-de-parfum', bottle_price:16800,
    description:'Grapefruit and mint into ginger, closing on incense and cedar. The safest formal pick here.',
    accords:['citrus','amber','woody','aromatic','fresh'],
    notes:{ top:['Grapefruit','Lemon','Mint'], middle:['Ginger','Nutmeg','Jasmine'], base:['Incense','Amber','Cedar'] },
    season:['spring','summer','fall','winter'] },

  { name:'Baccarat Rouge 540', brand:'Maison Francis Kurkdjian', gender:'unisex', price_per_ml:880, stock_ml:38, badge:'Low stock',
    reference_id:'maison-francis-kurkdjian__baccarat-rouge-540', bottle_price:38000,
    description:'Saffron and jasmine over amberwood and fir resin. Enormous projection from very little product.',
    accords:['woody','amber','warm spicy','sweet','fresh spicy'],
    notes:{ top:['Saffron','Jasmine'], middle:['Amberwood','Ambergris'], base:['Fir resin','Cedar'] },
    season:['fall','winter'] },

  { name:'Ombre Leather', brand:'Tom Ford', gender:'unisex', price_per_ml:520, stock_ml:60, badge:'',
    reference_id:'tom-ford__ombre-leather-2018', bottle_price:22000,
    description:'Cardamom into raw leather and jasmine sambac, finishing on moss and patchouli. Animalic and dry.',
    accords:['leather','animalic','warm spicy','woody','floral'],
    notes:{ top:['Cardamom'], middle:['Leather','Jasmine sambac'], base:['Amber','Moss','Patchouli'] },
    season:['fall','winter'] },

  { name:'Libre', brand:'Yves Saint Laurent', gender:'women', price_per_ml:370, stock_ml:110, badge:'',
    reference_id:'yves-saint-laurent__libre', bottle_price:13200,
    description:'Lavender and mandarin over orange blossom, landing on Madagascar vanilla and musk.',
    accords:['white floral','citrus','lavender','vanilla','aromatic'],
    notes:{ top:['Lavender','Mandarin orange','Black currant'], middle:['Lavender','Orange blossom','Jasmine'], base:['Madagascar vanilla','Musk','Cedar'] },
    season:['spring','summer','fall','winter'] },

  { name:'Layton', brand:'Parfums de Marly', gender:'unisex', price_per_ml:700, stock_ml:45, badge:'Cult',
    reference_id:'parfums-de-marly__layton', bottle_price:31000,
    description:'Apple and lavender over violet, drying to vanilla, cardamom and sandalwood. Sweet but never cheap.',
    accords:['warm spicy','vanilla','fresh spicy','woody','floral'],
    notes:{ top:['Apple','Lavender','Bergamot'], middle:['Geranium','Violet','Jasmine'], base:['Vanilla','Cardamom','Sandalwood'] },
    season:['fall','winter'] },
];

async function seedShop(db, reset) {
  if (reset) {
    for (const c of ['products', 'categories', 'orders', 'order_items', 'reviews']) {
      await db.collection(c).deleteMany({});
    }
    console.log('  cleared shop collections');
  }

  const categories = db.collection('categories');
  for (const c of CATEGORIES) {
    await categories.updateOne(
      { category_name: c.category_name },
      { $setOnInsert: { ...c, created_at: new Date() } },
      { upsert: true }
    );
  }
  const catByName = Object.fromEntries(
    (await categories.find().toArray()).map((c) => [c.category_name.toLowerCase(), c._id])
  );
  console.log(`  ${CATEGORIES.length} categories`);

  const products = db.collection('products');
  for (const p of PRODUCTS) {
    const genderToCategory = { men: 'men', women: 'women', unisex: 'unisex' };
    await products.updateOne(
      { name: p.name, brand: p.brand },
      {
        $set: {
          ...p,
          category_id: catByName[genderToCategory[p.gender]] || null,
          image_url: p.image_url || '',
          is_active: true,
        },
        $setOnInsert: { rating_avg: 0, rating_count: 0, created_at: new Date() },
      },
      { upsert: true }
    );
  }
  console.log(`  ${PRODUCTS.length} products`);
}

/* ------------------------------------------------------------------ *
 * Reference catalog import (streams the CSV — never loads 24k rows at once)
 * ------------------------------------------------------------------ */
const QUALIFIERS = new Set(['sicilian','calabrian','egyptian','tunisian','nigerian','ceylon','bulgarian','turkish','moroccan','indian','chinese','italian','french','virginia','texas','madagascar','indonesian','australian','brazilian','russian','spanish','japanese','thai','haitian','somali','wild','fresh','dried','candied','roasted','smoked','blonde','dark','golden','sweet','bitter']);
const SEASON_MAP = {
  summer:['citrus','aquatic','marine','ozonic','fresh','green','aromatic','fruity','tropical','coconut','fresh spicy','herbal','mineral'],
  spring:['floral','white floral','green','fresh','powdery','rose','iris','fruity','aldehydic','soapy'],
  fall:['woody','mossy','earthy','warm spicy','tobacco','leather','patchouli','nutty','aromatic','balsamic','smoky'],
  winter:['amber','oriental','oud','leather','sweet','gourmand','vanilla','cinnamon','warm spicy','balsamic','tobacco','chocolate','coffee','caramel','honey','animalic','woody'],
};
const TIME_MAP = {
  day:['citrus','aquatic','marine','ozonic','fresh','green','aromatic','fruity','white floral','powdery','soapy','floral','herbal','mineral','fresh spicy'],
  night:['amber','oriental','oud','leather','sweet','gourmand','vanilla','tobacco','animalic','smoky','boozy','musky','warm spicy','chocolate','coffee'],
};

const titleize = (s) => String(s).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const splitNotes = (v) => String(v || '').split(',').map((n) => n.trim().toLowerCase())
  .filter((n) => n && n !== 'unknown');

function coreNote(n) {
  let t = n.split(/\s+/);
  while (t.length > 1 && QUALIFIERS.has(t[0])) t = t.slice(1);
  return t.join(' ');
}

function derive(accords, map) {
  const scores = {};
  for (const [k, list] of Object.entries(map)) {
    const hit = accords.filter((a) => list.includes(a)).length;
    if (hit) scores[k] = hit;
  }
  if (!Object.keys(scores).length) return [];
  const top = Math.max(...Object.values(scores));
  return Object.entries(scores).filter(([, v]) => v >= top - 1)
    .sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

async function importReference(db, csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`  ! ${csvPath} not found — skipping reference import`);
    return;
  }
  const col = db.collection('reference_fragrances');
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  });

  let header = null, batch = [], count = 0;

  const flush = async () => {
    if (!batch.length) return;
    await col.bulkWrite(batch.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })), { ordered: false });
    count += batch.length;
    batch = [];
    if (count % 4000 === 0) process.stdout.write(`\r  imported ${count}…`);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = line.split(';');
    if (!header) { header = cells.map((h) => h.trim()); continue; }

    const r = Object.fromEntries(header.map((h, i) => [h, (cells[i] || '').trim()]));
    const accords = [1, 2, 3, 4, 5]
      .map((i) => (r[`mainaccord${i}`] || '').toLowerCase())
      .filter((a) => a && a !== 'nan');

    const top = splitNotes(r.Top), middle = splitNotes(r.Middle), base = splitNotes(r.Base);

    batch.push({
      _id: `${r.Brand}__${r.Perfume}`,
      slug: r.Perfume,
      name: titleize(r.Perfume),
      brand: titleize(r.Brand),
      brandSlug: r.Brand,
      country: r.Country,
      gender: (r.Gender || 'unisex').toLowerCase(),
      year: Number(r.Year) || null,
      rating: Number(String(r['Rating Value']).replace(',', '.')) || null,
      ratingCount: Number(r['Rating Count']) || 0,
      notes: { top, middle, base },
      coreNotes: [...new Set([...top, ...middle, ...base].map(coreNote))],
      accords,
      season: derive(accords, SEASON_MAP),
      timeOfDay: derive(accords, TIME_MAP),
      url: r.url,
      search: `${titleize(r.Perfume)} ${titleize(r.Brand)}`.toLowerCase(),
    });

    if (batch.length >= 1000) await flush();
  }
  await flush();
  console.log(`\r  ${count} reference fragrances imported`);
}

/* ------------------------------------------------------------------ */
(async () => {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  console.log(`Seeding "${DB}"…`);

  await createIndexes(db);
  await seedShop(db, process.argv.includes('--reset'));

  const csv = arg('--reference');
  if (csv) await importReference(db, csv === true ? './fra_cleaned.csv' : csv);

  console.log('Done. Run `npm run create-admin` next to make yourself an admin.');
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
