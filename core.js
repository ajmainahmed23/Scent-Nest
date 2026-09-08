/**
 * Shared helpers for every Netlify Function.
 *
 * Lives outside netlify/functions/ on purpose — anything inside that folder
 * gets deployed as its own HTTP endpoint, which these are not.
 */
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

/* ------------------------------------------------------------------ *
 * Database
 * ------------------------------------------------------------------ *
 * Serverless functions are frozen between invocations rather than torn
 * down, so the connection promise is cached at module scope. Without this
 * every request opens a new pool and Atlas drops you on connection limits.
 */
let cached = global.__scentnestDb;
if (!cached) cached = global.__scentnestDb = { conn: null, promise: null };

async function getDb() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');

    cached.promise = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    })
      .connect()
      .then((client) => client.db(process.env.MONGODB_DB || 'scentnest'));
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

const collections = async () => {
  const db = await getDb();
  return {
    db,
    users:       db.collection('users'),
    categories:  db.collection('categories'),
    products:    db.collection('products'),
    orders:      db.collection('orders'),
    orderItems:  db.collection('order_items'),
    reviews:     db.collection('reviews'),
    reference:   db.collection('reference_fragrances'),
  };
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body),
});

const ok      = (data) => json(200, { ok: true, data });
const created = (data) => json(201, { ok: true, data });
const fail    = (status, message, details) =>
  json(status, { ok: false, error: message, ...(details ? { details } : {}) });

const preflight = () => ({ statusCode: 204, headers: CORS, body: '' });

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Wraps a handler so thrown HttpErrors become clean responses and anything
 * unexpected returns a 500 without leaking a stack trace to the browser.
 */
function handler(fn) {
  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (event.httpMethod === 'OPTIONS') return preflight();

    try {
      return await fn(event, context);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.details);
      console.error('[unhandled]', err);
      return fail(500, 'Something went wrong on our end. Please try again.');
    }
  };
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
const SALT_ROUNDS = 10;

const hashPassword    = (plain) => bcrypt.hash(plain, SALT_ROUNDS);
const verifyPassword  = (plain, hash) => bcrypt.compare(plain, hash);

const signToken = (user) =>
  jwt.sign(
    { sub: String(user._id), email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '7d' }
  );

/** Returns the decoded token, or null when there is no valid one. */
function readToken(event) {
  const raw = event.headers?.authorization || event.headers?.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/** Throws 401 when the caller is not signed in. */
function requireUser(event) {
  const claims = readToken(event);
  if (!claims) throw new HttpError(401, 'Sign in to continue.');
  return claims;
}

/** Throws 403 when the caller is not an admin. */
function requireAdmin(event) {
  const claims = requireUser(event);
  if (claims.role !== 'admin') throw new HttpError(403, 'Admin access only.');
  return claims;
}

/* ------------------------------------------------------------------ *
 * Domain rules
 * ------------------------------------------------------------------ */
const DECANT_SIZES = [3, 5, 10];

/**
 * Smaller decants cost more per ml — the vial, label and labour cost the
 * same whether you fill 3ml or 10ml. Multipliers keep that honest while
 * still deriving everything from the single price_per_ml field in the
 * schema, so the admin only maintains one number per product.
 */
const SIZE_MULTIPLIER = { 3: 1.45, 5: 1.25, 10: 1.0 };
const BOTTLING_FEE = 40; // BDT per vial

/** Price of one decant, always computed server-side. Never trust the client. */
function decantPrice(product, ml) {
  if (!DECANT_SIZES.includes(Number(ml))) {
    throw new HttpError(400, `Decant size must be one of ${DECANT_SIZES.join(', ')}ml.`);
  }
  if (product.decant_prices?.[ml]) return Math.round(product.decant_prices[ml]);
  const raw = product.price_per_ml * ml * SIZE_MULTIPLIER[ml] + BOTTLING_FEE;
  return Math.round(raw / 10) * 10; // round to the nearest 10 taka
}

const shippingFor = (city = '') =>
  /dhaka/i.test(city)
    ? Number(process.env.SHIPPING_DHAKA || 60)
    : Number(process.env.SHIPPING_OUTSIDE || 120);

/** Bangladeshi mobile: 11 digits starting 01. */
const isPhone = (v) => /^01\d{9}$/.test(String(v || '').replace(/[\s-]/g, ''));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

const toObjectId = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(400, 'That id is not valid.');
  return new ObjectId(id);
};

/** Human-facing order reference: SN-7K2QX9 */
const orderRef = () =>
  'SN-' + Math.random().toString(36).slice(2, 8).toUpperCase();

/**
 * Pre-filled WhatsApp confirmation link (FR-05 / user story: order
 * confirmation via WhatsApp).
 */
function whatsappLink(order, items) {
  const lines = [
    `Hello Scent Nest — confirming order ${order.reference}.`,
    '',
    ...items.map((i) => `• ${i.product_name} ${i.decant_size_ml}ml × ${i.quantity} — BDT ${i.price * i.quantity}`),
    '',
    `Delivery: ${order.delivery_address}`,
    `Total (cash on delivery): BDT ${order.total_amount}`,
  ];
  const number = process.env.SHOP_WHATSAPP || '';
  return `https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`;
}

module.exports = {
  getDb, collections, ObjectId, toObjectId,
  json, ok, created, fail, preflight, parseBody, handler, HttpError,
  hashPassword, verifyPassword, signToken, readToken, requireUser, requireAdmin,
  DECANT_SIZES, SIZE_MULTIPLIER, decantPrice, shippingFor,
  isPhone, isEmail, orderRef, whatsappLink,
};
