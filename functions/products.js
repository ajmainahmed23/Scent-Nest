/**
 * /api/products — FR-02 Catalog & Search · FR-03 Product Details · FR-09 Admin
 *
 *   GET    /api/products                    filters, search, sort, paging
 *   GET    /api/products/:id                one product + priced sizes + reviews summary
 *   GET    /api/products/filters            facet values for the shop sidebar
 *   POST   /api/products                    admin — create
 *   PUT    /api/products/:id                admin — update
 *   PATCH  /api/products/:id/stock          admin — adjust stock_ml
 *   DELETE /api/products/:id                admin — remove
 */
const {
  collections, handler, parseBody, ok, created, HttpError,
  requireAdmin, toObjectId, DECANT_SIZES, decantPrice,
} = require('../core');

/** Attach the three decant prices and per-size availability to a product. */
function withPricing(p) {
  const sizes = DECANT_SIZES.map((ml) => ({
    ml,
    price: decantPrice(p, ml),
    in_stock: (p.stock_ml || 0) >= ml,
  }));
  return {
    product_id: String(p._id),
    name: p.name,
    brand: p.brand,
    category_id: p.category_id ? String(p.category_id) : null,
    description: p.description || '',
    notes: p.notes || { top: [], middle: [], base: [] },
    accords: p.accords || [],
    gender: p.gender || 'unisex',
    price_per_ml: p.price_per_ml,
    bottle_price: p.bottle_price || null,
    stock_ml: p.stock_ml || 0,
    image_url: p.image_url || '',
    badge: p.badge || '',
    reference_id: p.reference_id || null,   // links to reference_fragrances
    season: p.season || [],
    rating_avg: p.rating_avg || 0,
    rating_count: p.rating_count || 0,
    is_active: p.is_active !== false,
    sizes,
    from_price: Math.min(...sizes.map((s) => s.price)),
    created_at: p.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */
async function list(params) {
  const { products } = await collections();
  const q = { is_active: { $ne: false } };

  // brand=Dior,Chanel
  if (params.brand) q.brand = { $in: params.brand.split(',').map((s) => s.trim()) };

  // scent=woody,amber  — matches the accord list (proposal calls this "scent type")
  if (params.scent) q.accords = { $in: params.scent.split(',').map((s) => s.trim().toLowerCase()) };

  if (params.gender) q.gender = params.gender.toLowerCase();
  if (params.category) q.category_id = toObjectId(params.category);

  // size=5 — only products with enough left to fill that decant
  if (params.size) {
    const ml = Number(params.size);
    if (!DECANT_SIZES.includes(ml)) throw new HttpError(400, 'Unknown decant size.');
    q.stock_ml = { $gte: ml };
  }
  if (params.in_stock === 'true') q.stock_ml = { ...(q.stock_ml || {}), $gte: 3 };

  // Free-text across name, brand and notes
  if (params.q) {
    const rx = new RegExp(String(params.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: rx }, { brand: rx }, { description: rx },
             { 'notes.top': rx }, { 'notes.middle': rx }, { 'notes.base': rx }];
  }

  const sortMap = {
    newest: { created_at: -1 },
    price_asc: { price_per_ml: 1 },
    price_desc: { price_per_ml: -1 },
    rating: { rating_avg: -1, rating_count: -1 },
    name: { name: 1 },
  };
  const sort = sortMap[params.sort] || sortMap.newest;

  const page  = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(params.limit) || 12));

  let docs = await products.find(q).sort(sort).skip((page - 1) * limit).limit(limit).toArray();
  const total = await products.countDocuments(q);

  let items = docs.map(withPricing);

  // Price filtering happens after pricing is computed, because the stored
  // field is price_per_ml but shoppers filter on what a vial actually costs.
  const min = Number(params.min_price), max = Number(params.max_price);
  if (!Number.isNaN(min)) items = items.filter((p) => p.from_price >= min);
  if (!Number.isNaN(max)) items = items.filter((p) => p.from_price <= max);

  return ok({
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  });
}

/** Facet values so the shop sidebar isn't hard-coded. */
async function filters() {
  const { products } = await collections();
  const [brands, accords, genders, range] = await Promise.all([
    products.distinct('brand', { is_active: { $ne: false } }),
    products.distinct('accords', { is_active: { $ne: false } }),
    products.distinct('gender', { is_active: { $ne: false } }),
    products.aggregate([
      { $match: { is_active: { $ne: false } } },
      { $group: { _id: null, min: { $min: '$price_per_ml' }, max: { $max: '$price_per_ml' } } },
    ]).toArray(),
  ]);

  return ok({
    brands: brands.sort(),
    scents: accords.sort(),
    genders: genders.sort(),
    sizes: DECANT_SIZES,
    price_per_ml: range[0] ? { min: range[0].min, max: range[0].max } : { min: 0, max: 0 },
  });
}

async function detail(id) {
  const { products, reviews } = await collections();
  const p = await products.findOne({ _id: toObjectId(id) });
  if (!p) throw new HttpError(404, 'We no longer carry that fragrance.');

  const recent = await reviews
    .find({ product_id: p._id })
    .sort({ created_at: -1 })
    .limit(5)
    .toArray();

  return ok({
    product: withPricing(p),
    reviews: recent.map((r) => ({
      review_id: String(r._id),
      rating: r.rating,
      comment: r.comment,
      author: r.author_name,
      created_at: r.created_at,
    })),
  });
}

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */
function validateProduct(body, { partial = false } = {}) {
  const out = {};
  const need = (k) => !partial || body[k] !== undefined;
  const errors = {};

  if (need('name')) {
    const v = String(body.name || '').trim();
    if (v.length < 2) errors.name = 'Give the fragrance a name.';
    else out.name = v;
  }
  if (need('brand')) {
    const v = String(body.brand || '').trim();
    if (!v) errors.brand = 'Which house makes it?';
    else out.brand = v;
  }
  if (need('price_per_ml')) {
    const v = Number(body.price_per_ml);
    if (!(v > 0)) errors.price_per_ml = 'Price per ml must be above zero.';
    else out.price_per_ml = v;
  }
  if (need('stock_ml')) {
    const v = Number(body.stock_ml);
    if (!(v >= 0)) errors.stock_ml = 'Stock cannot be negative.';
    else out.stock_ml = v;
  }

  if (body.description !== undefined) out.description = String(body.description).trim();
  if (body.image_url !== undefined)   out.image_url = String(body.image_url).trim();
  if (body.badge !== undefined)       out.badge = String(body.badge).trim();
  if (body.gender !== undefined)      out.gender = String(body.gender).toLowerCase();
  if (body.bottle_price !== undefined) out.bottle_price = Number(body.bottle_price) || null;
  if (body.reference_id !== undefined) out.reference_id = body.reference_id || null;
  if (body.is_active !== undefined)   out.is_active = Boolean(body.is_active);
  if (body.category_id) out.category_id = toObjectId(body.category_id);
  if (Array.isArray(body.accords)) out.accords = body.accords.map((a) => String(a).toLowerCase());
  if (Array.isArray(body.season))  out.season = body.season.map(String);
  if (body.notes && typeof body.notes === 'object') {
    out.notes = {
      top:    (body.notes.top    || []).map(String),
      middle: (body.notes.middle || []).map(String),
      base:   (body.notes.base   || []).map(String),
    };
  }
  if (body.decant_prices && typeof body.decant_prices === 'object') {
    out.decant_prices = {};
    DECANT_SIZES.forEach((ml) => {
      if (body.decant_prices[ml]) out.decant_prices[ml] = Number(body.decant_prices[ml]);
    });
  }

  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields.', errors);
  return out;
}

async function create(event) {
  requireAdmin(event);
  const { products } = await collections();

  const doc = {
    notes: { top: [], middle: [], base: [] },
    accords: [],
    is_active: true,
    rating_avg: 0,
    rating_count: 0,
    ...validateProduct(parseBody(event)),
    created_at: new Date(),
  };

  const { insertedId } = await products.insertOne(doc);
  return created({ product: withPricing({ ...doc, _id: insertedId }) });
}

async function update(event, id) {
  requireAdmin(event);
  const { products } = await collections();

  const patch = { ...validateProduct(parseBody(event), { partial: true }), updated_at: new Date() };
  const p = await products.findOneAndUpdate(
    { _id: toObjectId(id) }, { $set: patch }, { returnDocument: 'after' }
  );
  if (!p) throw new HttpError(404, 'No product with that id.');
  return ok({ product: withPricing(p) });
}

/** Admin story: manage stock levels. Relative adjustments avoid lost updates. */
async function adjustStock(event, id) {
  requireAdmin(event);
  const { products } = await collections();
  const body = parseBody(event);

  let update;
  if (body.set !== undefined) {
    const v = Number(body.set);
    if (!(v >= 0)) throw new HttpError(422, 'Stock cannot be negative.');
    update = { $set: { stock_ml: v, updated_at: new Date() } };
  } else if (body.adjust !== undefined) {
    update = { $inc: { stock_ml: Number(body.adjust) }, $set: { updated_at: new Date() } };
  } else {
    throw new HttpError(400, 'Send either { set } or { adjust } in ml.');
  }

  const p = await products.findOneAndUpdate({ _id: toObjectId(id) }, update, { returnDocument: 'after' });
  if (!p) throw new HttpError(404, 'No product with that id.');
  if (p.stock_ml < 0) {
    await products.updateOne({ _id: p._id }, { $set: { stock_ml: 0 } });
    p.stock_ml = 0;
  }
  return ok({ product: withPricing(p) });
}

/** Soft delete by default — hard delete would orphan order_items rows. */
async function remove(event, id) {
  requireAdmin(event);
  const { products } = await collections();
  const hard = /hard=true/.test(event.rawQuery || '');

  if (hard) {
    const r = await products.deleteOne({ _id: toObjectId(id) });
    if (!r.deletedCount) throw new HttpError(404, 'No product with that id.');
    return ok({ deleted: true, hard: true });
  }

  const p = await products.findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set: { is_active: false, updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  if (!p) throw new HttpError(404, 'No product with that id.');
  return ok({ deleted: true, hard: false, product: withPricing(p) });
}

/* ------------------------------------------------------------------ */

exports.handler = handler(async (event) => {
  const tail = (event.path.split('/products')[1] || '').replace(/^\/|\/$/g, '');
  const [id, sub] = tail.split('/');
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  if (method === 'GET') {
    if (!id) return list(params);
    if (id === 'filters') return filters();
    return detail(id);
  }
  if (method === 'POST'  && !id) return create(event);
  if (method === 'PUT'   && id)  return update(event, id);
  if (method === 'PATCH' && id && sub === 'stock') return adjustStock(event, id);
  if (method === 'DELETE' && id) return remove(event, id);

  throw new HttpError(405, `${method} is not supported on this route.`);
});
