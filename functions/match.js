/**
 * /api/match — the note-similarity feature.
 *
 * Runs the comparison server-side against the shop's own stock, so the
 * browser never downloads the 24k reference catalog.
 *
 *   GET /api/match/search?q=lv+imagination     autocomplete over the reference data
 *   GET /api/match?reference_id=…              closest stock items to that fragrance
 *   GET /api/match?product_id=…                "you may also like" from one of our own
 */
const { collections, handler, ok, HttpError } = require('../core');
const ScentMatch = require('../matcher');

/** Reshape a stock product into what the matcher expects. */
const asCandidate = (p) => ({
  id: String(p._id),
  name: p.name,
  brand: p.brand,
  gender: p.gender || 'unisex',
  notes: p.notes || { top: [], middle: [], base: [] },
  accords: p.accords || [],
  season: p.season || [],
  timeOfDay: p.time_of_day || [],
  stock: p.stock_ml || 0,
  price: p.price_per_ml,
});

const asTarget = (f) => ({
  reference_id: f._id,
  name: f.name,
  brand: f.brand,
  gender: f.gender,
  year: f.year || null,
  notes: f.notes,
  accords: f.accords,
  season: f.season || [],
  timeOfDay: f.timeOfDay || [],
});

/**
 * Autocomplete. Mongo's regex does the narrowing so we only rank a few
 * hundred candidates in memory instead of all 24,000.
 */
async function search(params) {
  const { reference } = await collections();
  const q = String(params.q || '').trim();
  if (q.length < 2) return ok({ results: [] });

  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shortlist = await reference
    .find({ search: { $regex: safe.split(/\s+/).join('.*'), $options: 'i' } })
    .sort({ ratingCount: -1 })
    .limit(300)
    .toArray();

  const ranked = ScentMatch.searchCatalog(q, shortlist, Math.min(10, Number(params.limit) || 8));

  return ok({
    results: ranked.map((f) => ({
      reference_id: f._id,
      name: f.name,
      brand: f.brand,
      year: f.year || null,
      gender: f.gender,
      accords: (f.accords || []).slice(0, 3),
    })),
  });
}

async function recommend(params) {
  const { reference, products } = await collections();

  let target;
  let excludeId = null;

  if (params.reference_id) {
    const f = await reference.findOne({ _id: params.reference_id });
    if (!f) throw new HttpError(404, 'That fragrance is not in our reference data.');
    target = asTarget(f);
  } else if (params.product_id) {
    const { toObjectId } = require('../core');
    const p = await products.findOne({ _id: toObjectId(params.product_id) });
    if (!p) throw new HttpError(404, 'No product with that id.');
    excludeId = String(p._id);
    target = {
      name: p.name, brand: p.brand, gender: p.gender || 'unisex',
      notes: p.notes || {}, accords: p.accords || [],
      season: p.season || [], timeOfDay: p.time_of_day || [],
    };
  } else {
    throw new HttpError(400, 'Send either reference_id or product_id.');
  }

  const stock = await products
    .find({ is_active: { $ne: false }, stock_ml: { $gte: 3 } })
    .toArray();

  const candidates = stock
    .filter((p) => String(p._id) !== excludeId)
    .map(asCandidate);

  const results = ScentMatch.recommend(target, candidates, {
    limit: Math.min(6, Number(params.limit) || 4),
    minMatch: Number(params.min) || 35,
  });

  // Does the shop already carry the exact thing they searched for?
  const exact = stock.find(
    (p) => p.reference_id === params.reference_id ||
           (p.name.toLowerCase() === target.name.toLowerCase() &&
            p.brand.toLowerCase() === target.brand.toLowerCase())
  );

  return ok({
    target,
    we_stock_it: exact ? { product_id: String(exact._id), name: exact.name } : null,
    matches: results.map((r) => ({
      product_id: r.id,
      name: r.name,
      brand: r.brand,
      match: r.match,
      reason: r.reason,
      shared_notes: r.sharedNotes,
      shared_accords: r.sharedAccords,
      breakdown: r.breakdown,
    })),
  });
}

exports.handler = handler(async (event) => {
  if (event.httpMethod !== 'GET') throw new HttpError(405, 'Use GET.');
  const tail = (event.path.split('/match')[1] || '').replace(/^\/|\/$/g, '');
  const params = event.queryStringParameters || {};

  if (tail === 'search') return search(params);
  if (!tail) return recommend(params);

  throw new HttpError(404, 'No match route there.');
});
