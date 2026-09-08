/* SSLCommerz hosted checkout and server-side payment validation. */
const {
  collections, handler, parseBody, ok, HttpError, toObjectId,
} = require('../core');

const sandbox = process.env.SSLCOMMERZ_SANDBOX !== 'false';
const gateway = sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';

function appUrl() {
  const value = String(process.env.APP_URL || '').replace(/\/$/, '');
  if (!value) throw new HttpError(503, 'Payment gateway is not configured yet.');
  return value;
}

function incomingBody(event) {
  if (event.body) {
    try { return JSON.parse(event.body); } catch { return Object.fromEntries(new URLSearchParams(event.body)); }
  }
  return event.queryStringParameters || {};
}

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

async function initiate(event) {
  const body = parseBody(event);
  const { orders, orderItems } = await collections();
  const phone = String(body.phone || '').replace(/[\s-]/g, '');
  const order = await orders.findOne({ _id: toObjectId(body.order_id), contact_phone: phone });
  if (!order) throw new HttpError(404, 'That order could not be found.');
  if (order.payment_method !== 'SSLCommerz') throw new HttpError(400, 'This order is not an online payment order.');
  if (order.payment_status === 'Paid') throw new HttpError(409, 'This order has already been paid.');

  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD;
  if (!storeId || !storePassword) throw new HttpError(503, 'SSLCommerz credentials are not configured yet.');

  const items = await orderItems.find({ order_id: order._id }).toArray();
  const form = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    total_amount: Number(order.total_amount).toFixed(2),
    currency: 'BDT',
    tran_id: order.reference,
    success_url: `${appUrl()}/api/payment/success`,
    fail_url: `${appUrl()}/api/payment/fail`,
    cancel_url: `${appUrl()}/api/payment/cancel`,
    ipn_url: `${appUrl()}/api/payment/ipn`,
    product_category: 'fragrance',
    product_name: items.map((item) => item.product_name).join(', ').slice(0, 255),
    product_profile: 'physical-goods',
    shipping_method: 'Courier',
    num_of_item: String(items.length),
    cus_name: order.customer_name,
    cus_email: order.customer_email || process.env.SHOP_EMAIL || 'nestscent@gmail.com',
    cus_add1: order.delivery_address.slice(0, 50),
    cus_city: order.delivery_city,
    cus_country: 'Bangladesh',
    cus_phone: order.contact_phone,
    ship_name: order.customer_name,
    ship_add1: order.delivery_address.slice(0, 50),
    ship_city: order.delivery_city,
    ship_country: 'Bangladesh',
    value_a: order.reference,
  });

  const response = await fetch(`${gateway}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const result = await response.json();
  if (result.status !== 'SUCCESS' || !result.GatewayPageURL) {
    throw new HttpError(502, result.failedreason || 'SSLCommerz could not start the payment session.');
  }

  await orders.updateOne({ _id: order._id }, {
    $set: { payment_status: 'Initiated', gateway_sessionkey: result.sessionkey, updated_at: new Date() },
  });
  return ok({ payment_url: result.GatewayPageURL, reference: order.reference });
}

async function validatePayment(data) {
  const storeId = process.env.SSLCOMMERZ_STORE_ID;
  const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD;
  if (!storeId || !storePassword) throw new HttpError(503, 'SSLCommerz credentials are not configured yet.');
  if (!data.tran_id || !data.val_id) throw new HttpError(400, 'The payment response is incomplete.');

  const query = new URLSearchParams({
    val_id: data.val_id, store_id: storeId, store_passwd: storePassword, format: 'json',
  });
  const response = await fetch(`${gateway}/validator/api/validationserverAPI.php?${query}`);
  const result = await response.json();
  if (!['VALID', 'VALIDATED'].includes(result.status) || result.tran_id !== data.tran_id) {
    throw new HttpError(400, 'SSLCommerz could not validate this payment.');
  }
  return result;
}

async function complete(event) {
  const data = incomingBody(event);
  const { orders } = await collections();
  const result = await validatePayment(data);
  const order = await orders.findOne({ reference: result.tran_id });
  if (!order) throw new HttpError(404, 'The payment order was not found.');
  if (Number(result.amount) !== Number(order.total_amount) || result.currency !== 'BDT') {
    throw new HttpError(400, 'The validated payment amount does not match the order.');
  }
  await orders.updateOne({ _id: order._id }, {
    $set: {
      payment_status: 'Paid', payment_reference: result.val_id,
      payment_gateway: result.card_type || result.card_brand || 'SSLCommerz', updated_at: new Date(),
    },
  });
  return redirect(`${appUrl()}/?payment=success&ref=${encodeURIComponent(order.reference)}#featured`);
}

async function cancel(event, status) {
  const data = incomingBody(event);
  const { orders, orderItems, products } = await collections();
  if (data.tran_id) {
    const order = await orders.findOne({ reference: data.tran_id });
    if (order && order.payment_status !== 'Paid' && !order.stock_restored) {
      const items = await orderItems.find({ order_id: order._id }).toArray();
      for (const item of items) {
        await products.updateOne({ _id: item.product_id }, { $inc: { stock_ml: item.decant_size_ml * item.quantity } });
      }
      await orders.updateOne({ _id: order._id }, {
        $set: { payment_status: status, status: 'Cancelled', stock_restored: true, updated_at: new Date() },
      });
    }
  }
  return redirect(`${appUrl()}/?payment=${status.toLowerCase()}#featured`);
}

exports.handler = handler(async (event) => {
  const action = (event.path.split('/payment/')[1] || '').replace(/\/$/, '');
  if (event.httpMethod === 'POST' && action === 'initiate') return initiate(event);
  if (['GET', 'POST'].includes(event.httpMethod) && action === 'success') return complete(event);
  if (['GET', 'POST'].includes(event.httpMethod) && action === 'ipn') return complete(event);
  if (['GET', 'POST'].includes(event.httpMethod) && action === 'fail') return cancel(event, 'Failed');
  if (['GET', 'POST'].includes(event.httpMethod) && action === 'cancel') return cancel(event, 'Cancelled');
  throw new HttpError(405, 'Unsupported payment action.');
});
