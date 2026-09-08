/**
 * /api/orders — FR-05 COD Checkout · FR-06 Tracking · FR-10 Admin Orders
 *
 *   POST   /api/orders                  place an order (guest or signed in)
 *   GET    /api/orders/track?ref=SN-XXX track by reference + phone
 *   GET    /api/orders/mine             signed-in customer's history
 *   GET    /api/orders                  admin — all orders, filter by status
 *   GET    /api/orders/report           admin — basic sales report
 *   GET    /api/orders/:id              admin — one order with its items
 *   PUT    /api/orders/:id/status       admin — advance the status
 */
const {
  collections, handler, parseBody, ok, created, HttpError,
  requireUser, requireAdmin, readToken, toObjectId,
  decantPrice, shippingFor, isPhone, orderRef, whatsappLink, DECANT_SIZES,
} = require('../core');

const STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

/* ------------------------------------------------------------------ *
 * Place an order
 * ------------------------------------------------------------------ */
async function place(event) {
  const { products, orders, orderItems } = await collections();
  const body = parseBody(event);
  const claims = readToken(event);            // optional — guests may check out

  /* --- delivery details ------------------------------------------ */
  const name    = String(body.name || '').trim();
  const phone   = String(body.phone || '').replace(/[\s-]/g, '');
  const city    = String(body.city || '').trim();
  const address = String(body.address || '').trim();
  const note    = String(body.note || '').trim().slice(0, 500);
  const paymentMethod = String(body.payment_method || 'COD').toUpperCase();
  const paymentReference = String(body.payment_reference || '').trim().slice(0, 80);

  const errors = {};
  if (name.length < 2)     errors.name = 'Who should the courier ask for?';
  if (!isPhone(phone))     errors.phone = 'Use an 11-digit number starting with 01.';
  if (city.length < 2)     errors.city = 'Which city are we delivering to?';
  if (address.length < 10) errors.address = 'Give a full address the courier can find.';
  if (!['COD', 'BKASH', 'SSL'].includes(paymentMethod)) {
    errors.payment_method = 'Choose cash on delivery, bKash, or card/bank payment.';
  }
  if (paymentMethod === 'BKASH' && paymentReference.length < 4) {
    errors.payment_reference = 'Enter the bKash transaction ID after sending payment.';
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields.', errors);

  /* --- cart ------------------------------------------------------- */
  const cart = Array.isArray(body.items) ? body.items : [];
  if (!cart.length) throw new HttpError(400, 'Your cart is empty.');
  if (cart.length > 30) throw new HttpError(400, 'That is more items than we can process in one order.');

  const ids = [...new Set(cart.map((i) => String(i.product_id)))].map(toObjectId);
  const found = await products.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(found.map((p) => [String(p._id), p]));

  // ml needed per product across the whole cart, so two lines of the same
  // fragrance are checked against stock together rather than separately
  const mlNeeded = new Map();
  const lines = [];

  for (const raw of cart) {
    const p = byId.get(String(raw.product_id));
    if (!p) throw new HttpError(409, 'One of the items is no longer available. Refresh your cart.');
    if (p.is_active === false) throw new HttpError(409, `${p.name} is no longer available.`);

    const ml = Number(raw.decant_size_ml);
    if (!DECANT_SIZES.includes(ml)) throw new HttpError(400, 'Unknown decant size in cart.');

    const qty = Math.floor(Number(raw.quantity) || 0);
    if (qty < 1 || qty > 10) throw new HttpError(400, 'Quantity must be between 1 and 10.');

    const key = String(p._id);
    mlNeeded.set(key, (mlNeeded.get(key) || 0) + ml * qty);

    // Price comes from the database, never from the request body.
    lines.push({
      product: p,
      product_id: p._id,
      product_name: p.name,
      brand: p.brand,
      decant_size_ml: ml,
      quantity: qty,
      price: decantPrice(p, ml),
    });
  }

  for (const [pid, needed] of mlNeeded) {
    const p = byId.get(pid);
    if ((p.stock_ml || 0) < needed) {
      throw new HttpError(409,
        `${p.name} only has ${p.stock_ml || 0}ml left — not enough for this order.`,
        { product_id: pid, available_ml: p.stock_ml || 0, requested_ml: needed });
    }
  }

  /* --- totals ----------------------------------------------------- */
  const subtotal = lines.reduce((n, l) => n + l.price * l.quantity, 0);
  const shipping = shippingFor(city);
  const total = subtotal + shipping;

  /* --- write ------------------------------------------------------ *
   * Stock is decremented with a guarded update per product: the filter
   * requires enough ml to still be there, so two customers checking out
   * at the same second can't both take the last 3ml.
   */
  const taken = [];
  try {
    for (const [pid, needed] of mlNeeded) {
      const r = await products.updateOne(
        { _id: toObjectId(pid), stock_ml: { $gte: needed } },
        { $inc: { stock_ml: -needed } }
      );
      if (!r.modifiedCount) {
        throw new HttpError(409, `${byId.get(pid).name} sold out while you were checking out.`);
      }
      taken.push([pid, needed]);
    }
  } catch (err) {
    // put back whatever we already took
    for (const [pid, needed] of taken) {
      await products.updateOne({ _id: toObjectId(pid) }, { $inc: { stock_ml: needed } });
    }
    throw err;
  }

  const order = {
    reference: orderRef(),
    user_id: claims ? toObjectId(claims.sub) : null,
    customer_name: name,
    contact_phone: phone,
    order_date: new Date(),
    status: 'Pending',
    status_history: [{ status: 'Pending', at: new Date() }],
    subtotal,
    shipping,
    total_amount: total,
    delivery_city: city,
    delivery_address: address,
    customer_note: note,
    payment_method: paymentMethod === 'BKASH' ? 'bKash Send Money'
      : paymentMethod === 'SSL' ? 'SSLCommerz' : 'Cash on Delivery',
    payment_status: paymentMethod === 'COD' ? 'Unpaid' : 'Pending',
    payment_reference: paymentReference || null,
  };

  const { insertedId } = await orders.insertOne(order);
  order._id = insertedId;

  const itemDocs = lines.map((l) => ({
    order_id: insertedId,
    product_id: l.product_id,
    product_name: l.product_name,
    brand: l.brand,
    decant_size_ml: l.decant_size_ml,
    quantity: l.quantity,
    price: l.price,
  }));
  await orderItems.insertMany(itemDocs);

  return created({
    order: publicOrder(order),
    items: itemDocs.map(publicItem),
    whatsapp_url: whatsappLink(order, itemDocs),
  });
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */
const publicItem = (i) => ({
  order_item_id: i._id ? String(i._id) : undefined,
  product_id: String(i.product_id),
  product_name: i.product_name,
  brand: i.brand,
  decant_size_ml: i.decant_size_ml,
  quantity: i.quantity,
  price: i.price,
  line_total: i.price * i.quantity,
});

const publicOrder = (o) => ({
  order_id: String(o._id),
  reference: o.reference,
  status: o.status,
  status_history: o.status_history || [],
  order_date: o.order_date,
  subtotal: o.subtotal,
  shipping: o.shipping,
  total_amount: o.total_amount,
  payment_method: o.payment_method,
  payment_status: o.payment_status || 'Unpaid',
  payment_reference: o.payment_reference || null,
  customer_name: o.customer_name,
  contact_phone: o.contact_phone,
  delivery_city: o.delivery_city,
  delivery_address: o.delivery_address,
  customer_note: o.customer_note || '',
});

const itemsFor = async (orderIds) => {
  const { orderItems } = await collections();
  return orderItems.find({ order_id: { $in: orderIds } }).toArray();
};

/* ------------------------------------------------------------------ *
 * Tracking & history
 * ------------------------------------------------------------------ */

/**
 * Guest tracking. Reference alone isn't enough — references are short and
 * guessable, so the phone number on the order has to match too.
 */
async function track(params) {
  const { orders } = await collections();
  const ref = String(params.ref || '').trim().toUpperCase();
  const phone = String(params.phone || '').replace(/[\s-]/g, '');
  if (!ref || !phone) throw new HttpError(400, 'Enter your order reference and mobile number.');

  const order = await orders.findOne({ reference: ref, contact_phone: phone });
  if (!order) throw new HttpError(404, 'No order matches that reference and number.');

  const items = await itemsFor([order._id]);
  return ok({ order: publicOrder(order), items: items.map(publicItem) });
}

async function mine(event, params) {
  const claims = requireUser(event);
  const { orders } = await collections();

  const list = await orders
    .find({ user_id: toObjectId(claims.sub) })
    .sort({ order_date: -1 })
    .limit(Math.min(50, Number(params.limit) || 20))
    .toArray();

  const items = await itemsFor(list.map((o) => o._id));
  const grouped = new Map();
  items.forEach((i) => {
    const k = String(i.order_id);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(publicItem(i));
  });

  return ok({
    orders: list.map((o) => ({ ...publicOrder(o), items: grouped.get(String(o._id)) || [] })),
  });
}

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */
async function adminList(event, params) {
  requireAdmin(event);
  const { orders } = await collections();

  const q = {};
  if (params.status) {
    if (!STATUSES.includes(params.status)) throw new HttpError(400, 'Unknown status.');
    q.status = params.status;
  }
  if (params.q) {
    const rx = new RegExp(String(params.q).trim(), 'i');
    q.$or = [{ reference: rx }, { customer_name: rx }, { contact_phone: rx }];
  }
  // Staff story: today's order list for preparing decants
  if (params.today === 'true') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    q.order_date = { $gte: start };
  }

  const page  = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Number(params.limit) || 25);

  const list = await orders.find(q).sort({ order_date: -1 })
    .skip((page - 1) * limit).limit(limit).toArray();
  const total = await orders.countDocuments(q);

  const items = await itemsFor(list.map((o) => o._id));
  const grouped = new Map();
  items.forEach((i) => {
    const k = String(i.order_id);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(publicItem(i));
  });

  return ok({
    orders: list.map((o) => ({ ...publicOrder(o), items: grouped.get(String(o._id)) || [] })),
    page, limit, total, pages: Math.ceil(total / limit),
  });
}

async function adminOne(event, id) {
  requireAdmin(event);
  const { orders } = await collections();
  const order = await orders.findOne({ _id: toObjectId(id) });
  if (!order) throw new HttpError(404, 'No order with that id.');
  const items = await itemsFor([order._id]);
  return ok({ order: publicOrder(order), items: items.map(publicItem) });
}

/** FR-10: update order status so the customer sees it change. */
async function setStatus(event, id) {
  requireAdmin(event);
  const { orders, orderItems, products } = await collections();
  const status = String(parseBody(event).status || '').trim();
  if (!STATUSES.includes(status)) {
    throw new HttpError(422, `Status must be one of: ${STATUSES.join(', ')}.`);
  }

  const order = await orders.findOne({ _id: toObjectId(id) });
  if (!order) throw new HttpError(404, 'No order with that id.');
  if (order.status === status) return ok({ order: publicOrder(order), changed: false });

  // Cancelling returns the ml to stock — otherwise the shop slowly loses
  // inventory to orders that were never fulfilled.
  if (status === 'Cancelled' && order.status !== 'Cancelled') {
    const items = await itemsFor([order._id]);
    for (const i of items) {
      await products.updateOne(
        { _id: i.product_id },
        { $inc: { stock_ml: i.decant_size_ml * i.quantity } }
      );
    }
  }

  const updated = await orders.findOneAndUpdate(
    { _id: order._id },
    {
      $set: { status, updated_at: new Date() },
      $push: { status_history: { status, at: new Date() } },
    },
    { returnDocument: 'after' }
  );

  return ok({ order: publicOrder(updated), changed: true });
}

/** Admin story: basic sales reports. */
async function report(event, params) {
  requireAdmin(event);
  const { orders, orderItems, products } = await collections();

  const days = Math.min(365, Number(params.days) || 30);
  const since = new Date(Date.now() - days * 864e5);
  const paid = { order_date: { $gte: since }, status: { $ne: 'Cancelled' } };

  const [totals, byStatus, daily, topProducts, lowStock] = await Promise.all([
    orders.aggregate([
      { $match: paid },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total_amount' } } },
    ]).toArray(),

    orders.aggregate([
      { $match: { order_date: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),

    orders.aggregate([
      { $match: paid },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$order_date' } },
          orders: { $sum: 1 }, revenue: { $sum: '$total_amount' },
      } },
      { $sort: { _id: 1 } },
    ]).toArray(),

    orderItems.aggregate([
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'o' } },
      { $unwind: '$o' },
      { $match: { 'o.order_date': { $gte: since }, 'o.status': { $ne: 'Cancelled' } } },
      { $group: {
          _id: '$product_id',
          name: { $first: '$product_name' },
          brand: { $first: '$brand' },
          units: { $sum: '$quantity' },
          ml: { $sum: { $multiply: ['$decant_size_ml', '$quantity'] } },
          revenue: { $sum: { $multiply: ['$price', '$quantity'] } },
      } },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]).toArray(),

    products.find({ is_active: { $ne: false }, stock_ml: { $lt: 20 } })
      .sort({ stock_ml: 1 }).limit(10).toArray(),
  ]);

  const t = totals[0] || { orders: 0, revenue: 0 };
  return ok({
    period_days: days,
    orders: t.orders,
    revenue: t.revenue,
    average_order_value: t.orders ? Math.round(t.revenue / t.orders) : 0,
    by_status: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
    daily: daily.map((d) => ({ date: d._id, orders: d.orders, revenue: d.revenue })),
    top_products: topProducts.map((p) => ({
      product_id: String(p._id), name: p.name, brand: p.brand,
      units: p.units, ml: p.ml, revenue: p.revenue,
    })),
    low_stock: lowStock.map((p) => ({
      product_id: String(p._id), name: p.name, brand: p.brand, stock_ml: p.stock_ml,
    })),
  });
}

/* ------------------------------------------------------------------ */

exports.handler = handler(async (event) => {
  const tail = (event.path.split('/orders')[1] || '').replace(/^\/|\/$/g, '');
  const [id, sub] = tail.split('/');
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  if (method === 'POST' && !id) return place(event);

  if (method === 'GET') {
    if (id === 'track')  return track(params);
    if (id === 'mine')   return mine(event, params);
    if (id === 'report') return report(event, params);
    if (id)              return adminOne(event, id);
    return adminList(event, params);
  }

  if (method === 'PUT' && id && sub === 'status') return setStatus(event, id);

  throw new HttpError(405, `${method} is not supported on this route.`);
});
