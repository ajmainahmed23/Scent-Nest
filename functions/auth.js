/**
 * /api/auth — FR-01 User Registration & Login
 *
 *   POST   /api/auth/register   { name, email, phone, password, address? }
 *   POST   /api/auth/login      { email, password }
 *   GET    /api/auth/me         (Bearer token)
 *   PUT    /api/auth/me         { name?, phone?, address? }
 */
const {
  collections, handler, parseBody, ok, created, HttpError,
  hashPassword, verifyPassword, signToken, requireUser, toObjectId,
  isEmail, isPhone,
} = require('../core');

/** Everything the frontend is allowed to see about a user. */
const publicUser = (u) => ({
  user_id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  address: u.address || '',
  created_at: u.created_at,
});

/* ------------------------------------------------------------------ */

async function register(body) {
  const { users } = await collections();

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').replace(/[\s-]/g, '');
  const password = String(body.password || '');

  const errors = {};
  if (name.length < 2)     errors.name = 'Tell us your full name.';
  if (!isEmail(email))     errors.email = 'That email address does not look right.';
  if (!isPhone(phone))     errors.phone = 'Use an 11-digit number starting with 01.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields.', errors);

  if (await users.findOne({ email })) {
    throw new HttpError(409, 'An account already uses that email. Try signing in.');
  }

  const doc = {
    name,
    email,
    phone,
    password_hash: await hashPassword(password),
    role: 'customer',                       // admins are promoted by scripts/create-admin.js
    address: String(body.address || '').trim(),
    wishlist: [],                           // FR-07
    created_at: new Date(),
  };

  const { insertedId } = await users.insertOne(doc);
  const user = { ...doc, _id: insertedId };

  return created({ token: signToken(user), user: publicUser(user) });
}

async function login(body) {
  const { users } = await collections();

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = await users.findOne({ email });
  // Same message either way — telling an attacker which emails exist is a gift.
  const bad = new HttpError(401, 'Email or password is incorrect.');
  if (!user) throw bad;
  if (!(await verifyPassword(password, user.password_hash))) throw bad;

  await users.updateOne({ _id: user._id }, { $set: { last_login: new Date() } });

  return ok({ token: signToken(user), user: publicUser(user) });
}

async function me(event) {
  const claims = requireUser(event);
  const { users } = await collections();
  const user = await users.findOne({ _id: toObjectId(claims.sub) });
  if (!user) throw new HttpError(404, 'That account no longer exists.');
  return ok({ user: publicUser(user) });
}

/** FR: customer updates profile and delivery address. */
async function updateMe(event, body) {
  const claims = requireUser(event);
  const { users } = await collections();

  const patch = {};
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (n.length < 2) throw new HttpError(422, 'Name is too short.', { name: 'Tell us your full name.' });
    patch.name = n;
  }
  if (body.phone !== undefined) {
    const p = String(body.phone).replace(/[\s-]/g, '');
    if (!isPhone(p)) throw new HttpError(422, 'Check your number.', { phone: 'Use an 11-digit number starting with 01.' });
    patch.phone = p;
  }
  if (body.address !== undefined) patch.address = String(body.address).trim();

  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
  patch.updated_at = new Date();

  const user = await users.findOneAndUpdate(
    { _id: toObjectId(claims.sub) },
    { $set: patch },
    { returnDocument: 'after' }
  );
  if (!user) throw new HttpError(404, 'That account no longer exists.');

  return ok({ user: publicUser(user) });
}

/* ------------------------------------------------------------------ */

exports.handler = handler(async (event) => {
  // "/.netlify/functions/auth/login" and "/api/auth/login" both end in /login
  const action = (event.path.split('/auth/')[1] || '').replace(/\/$/, '');
  const method = event.httpMethod;

  if (method === 'POST' && action === 'register') return register(parseBody(event));
  if (method === 'POST' && action === 'login')    return login(parseBody(event));
  if (method === 'GET'  && action === 'me')       return me(event);
  if (method === 'PUT'  && action === 'me')       return updateMe(event, parseBody(event));

  throw new HttpError(404, `No auth route for ${method} /${action}`);
});
