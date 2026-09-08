/**
 * /api/reviews — FR-08 Reviews & Ratings
 *
 *   GET    /api/reviews?product_id=…      published reviews for a product
 *   POST   /api/reviews                   customer — leave a review
 *   GET    /api/reviews/pending           admin — moderation queue
 *   PUT    /api/reviews/:id/moderate      admin — approve or hide
 *   DELETE /api/reviews/:id               admin, or the author
 */
const {
  collections, handler, parseBody, ok, created, HttpError,
  requireUser, requireAdmin, readToken, toObjectId,
} = require('../core');

const publicReview = (r) => ({
  review_id: String(r._id),
  product_id: String(r.product_id),
  rating: r.rating,
  comment: r.comment,
  author: r.author_name,
  verified_purchase: Boolean(r.verified_purchase),
  status: r.status,
  created_at: r.created_at,
});

/** Recomputes the product's cached average from approved reviews only. */
async function refreshRating(productId) {
  const { reviews, products } = await collections();
  const [agg] = await reviews.aggregate([
    { $match: { product_id: productId, status: 'approved' } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]).toArray();

  await products.updateOne(
    { _id: productId },
    { $set: {
        rating_avg: agg ? Math.round(agg.avg * 10) / 10 : 0,
        rating_count: agg ? agg.count : 0,
    } }
  );
}

/* ------------------------------------------------------------------ */

async function listForProduct(params) {
  const { reviews } = await collections();
  if (!params.product_id) throw new HttpError(400, 'Which product?');

  const productId = toObjectId(params.product_id);
  const limit = Math.min(50, Number(params.limit) || 20);

  const list = await reviews
    .find({ product_id: productId, status: 'approved' })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();

  const spread = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const all = await reviews.find(
    { product_id: productId, status: 'approved' },
    { projection: { rating: 1 } }
  ).toArray();
  all.forEach((r) => { spread[r.rating] = (spread[r.rating] || 0) + 1; });

  return ok({
    reviews: list.map(publicReview),
    total: all.length,
    average: all.length
      ? Math.round((all.reduce((n, r) => n + r.rating, 0) / all.length) * 10) / 10
      : 0,
    spread,
  });
}

/**
 * The user story says a customer reviews a product they purchased, so the
 * order history is checked before the review is accepted. Nothing here is
 * about trusting the client — it's a join against order_items.
 */
async function submit(event) {
  const claims = requireUser(event);
  const { reviews, products, orders, orderItems } = await collections();
  const body = parseBody(event);

  const rating = Number(body.rating);
  const comment = String(body.comment || '').trim();

  const errors = {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'Pick 1 to 5 stars.';
  if (comment.length < 10)  errors.comment = 'Write at least a sentence.';
  if (comment.length > 1500) errors.comment = 'Keep it under 1500 characters.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields.', errors);

  const productId = toObjectId(body.product_id);
  const userId = toObjectId(claims.sub);

  const product = await products.findOne({ _id: productId });
  if (!product) throw new HttpError(404, 'We no longer carry that fragrance.');

  if (await reviews.findOne({ product_id: productId, user_id: userId })) {
    throw new HttpError(409, 'You have already reviewed this fragrance.');
  }

  const delivered = await orders.find(
    { user_id: userId, status: 'Delivered' },
    { projection: { _id: 1 } }
  ).toArray();

  const purchased = delivered.length > 0 && await orderItems.findOne({
    order_id: { $in: delivered.map((o) => o._id) },
    product_id: productId,
  });

  if (!purchased) {
    throw new HttpError(403,
      'Reviews are open once your order for this fragrance has been delivered.');
  }

  const doc = {
    product_id: productId,
    user_id: userId,
    author_name: claims.name || 'Customer',
    rating,
    comment,
    verified_purchase: true,
    status: 'approved',        // flip to 'pending' to moderate before publishing
    created_at: new Date(),
  };

  const { insertedId } = await reviews.insertOne(doc);
  await refreshRating(productId);

  return created({ review: publicReview({ ...doc, _id: insertedId }) });
}

/* ------------------------------------------------------------------ *
 * Moderation
 * ------------------------------------------------------------------ */
async function pending(event) {
  requireAdmin(event);
  const { reviews } = await collections();
  const list = await reviews.find({ status: 'pending' })
    .sort({ created_at: 1 }).limit(100).toArray();
  return ok({ reviews: list.map(publicReview) });
}

async function moderate(event, id) {
  requireAdmin(event);
  const { reviews } = await collections();
  const status = String(parseBody(event).status || '');
  if (!['approved', 'hidden', 'pending'].includes(status)) {
    throw new HttpError(422, 'Status must be approved, hidden or pending.');
  }

  const r = await reviews.findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set: { status, moderated_at: new Date() } },
    { returnDocument: 'after' }
  );
  if (!r) throw new HttpError(404, 'No review with that id.');

  await refreshRating(r.product_id);
  return ok({ review: publicReview(r) });
}

async function remove(event, id) {
  const claims = readToken(event);
  if (!claims) throw new HttpError(401, 'Sign in to continue.');

  const { reviews } = await collections();
  const r = await reviews.findOne({ _id: toObjectId(id) });
  if (!r) throw new HttpError(404, 'No review with that id.');

  const isAuthor = String(r.user_id) === claims.sub;
  if (!isAuthor && claims.role !== 'admin') {
    throw new HttpError(403, 'You can only remove your own review.');
  }

  await reviews.deleteOne({ _id: r._id });
  await refreshRating(r.product_id);
  return ok({ deleted: true });
}

/* ------------------------------------------------------------------ */

exports.handler = handler(async (event) => {
  const tail = (event.path.split('/reviews')[1] || '').replace(/^\/|\/$/g, '');
  const [id, sub] = tail.split('/');
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  if (method === 'GET' && id === 'pending') return pending(event);
  if (method === 'GET'  && !id) return listForProduct(params);
  if (method === 'POST' && !id) return submit(event);
  if (method === 'PUT' && id && sub === 'moderate') return moderate(event, id);
  if (method === 'DELETE' && id) return remove(event, id);

  throw new HttpError(405, `${method} is not supported on this route.`);
});
