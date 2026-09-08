/**
 * Scent Nest — API client and session state.
 *
 * Every page loads this before anything else. It owns two things:
 * talking to /api/*, and remembering who is signed in.
 */
(function (global) {
  'use strict';

  // A raw file preview has no API origin. Keep it usable when the local
  // server is running, while deployed pages continue using same-origin APIs.
  const BASE = location.protocol === 'file:' ? 'http://localhost:3000/api' : '/api';
  const SESSION_KEY = 'sn_session';

  /* ---------------------------------------------------------------- *
   * Session — token + user, persisted across pages (Step 4)
   * ---------------------------------------------------------------- */
  const Session = {
    read() {
      try {
        return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
      } catch {
        return null;
      }
    },
    save(token, user) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
      document.dispatchEvent(new CustomEvent('sn:auth', { detail: user }));
    },
    clear() {
      localStorage.removeItem(SESSION_KEY);
      document.dispatchEvent(new CustomEvent('sn:auth', { detail: null }));
    },
    get token() { return this.read()?.token || null; },
    get user()  { return this.read()?.user || null; },
    get isAdmin() { return this.read()?.user?.role === 'admin'; },
    get isSignedIn() { return Boolean(this.token); },
  };

  /* ---------------------------------------------------------------- *
   * Request
   * ---------------------------------------------------------------- */

  /** Thrown for any non-2xx response. `details` holds per-field messages. */
  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details || {};
    }
  }

  async function request(path, { method = 'GET', body, auth = true, query } = {}) {
    const url = new URL(BASE + path, location.origin);
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      });
    }

    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && Session.token) headers.Authorization = `Bearer ${Session.token}`;

    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      const message = location.protocol === 'file:'
        ? 'Start the site with "node server.js" and open http://localhost:3000.'
        : 'Could not reach the server. Check your connection.';
      throw new ApiError(0, message);
    }

    // 401 means the token expired or was tampered with — drop it rather
    // than leaving the UI showing a signed-in state that no longer works.
    if (res.status === 401 && Session.isSignedIn) {
      Session.clear();
    }

    let payload = {};
    try {
      payload = await res.json();
    } catch {
      throw new ApiError(res.status, 'The server sent back something unreadable.');
    }

    if (!res.ok || payload.ok === false) {
      throw new ApiError(res.status, payload.error || 'Request failed.', payload.details);
    }
    return payload.data;
  }

  /* ---------------------------------------------------------------- *
   * Endpoints
   * ---------------------------------------------------------------- */
  const API = {
    ApiError,
    Session,
    request,

    auth: {
      async register(payload) {
        const d = await request('/auth/register', { method: 'POST', body: payload, auth: false });
        Session.save(d.token, d.user);
        return d.user;
      },
      async login(email, password) {
        const d = await request('/auth/login', { method: 'POST', body: { email, password }, auth: false });
        Session.save(d.token, d.user);
        return d.user;
      },
      logout() { Session.clear(); },
      me: () => request('/auth/me').then((d) => d.user),
      updateMe: (patch) => request('/auth/me', { method: 'PUT', body: patch }).then((d) => {
        Session.save(Session.token, d.user);
        return d.user;
      }),
    },

    products: {
      list:    (query) => request('/products', { query, auth: false }),
      get:     (id) => request(`/products/${id}`, { auth: false }),
      filters: () => request('/products/filters', { auth: false }),
      create:  (body) => request('/products', { method: 'POST', body }),
      update:  (id, body) => request(`/products/${id}`, { method: 'PUT', body }),
      setStock:(id, body) => request(`/products/${id}/stock`, { method: 'PATCH', body }),
      remove:  (id) => request(`/products/${id}`, { method: 'DELETE' }),
    },

    orders: {
      place:  (body) => request('/orders', { method: 'POST', body }),
      track:  (ref, phone) => request('/orders/track', { query: { ref, phone }, auth: false }),
      mine:   () => request('/orders/mine').then((d) => d.orders),
      all:    (query) => request('/orders', { query }),
      get:    (id) => request(`/orders/${id}`),
      setStatus: (id, status) => request(`/orders/${id}/status`, { method: 'PUT', body: { status } }),
      report: (days = 30) => request('/orders/report', { query: { days } }),
    },
      payment: {
        start: (body) => request('/payment/initiate', { method: 'POST', body }),
      },

    reviews: {
      forProduct: (product_id) => request('/reviews', { query: { product_id }, auth: false }),
      submit: (body) => request('/reviews', { method: 'POST', body }),
      pending: () => request('/reviews/pending').then((d) => d.reviews),
      moderate: (id, status) => request(`/reviews/${id}/moderate`, { method: 'PUT', body: { status } }),
      remove: (id) => request(`/reviews/${id}`, { method: 'DELETE' }),
    },

    match: {
      search: (q) => request('/match/search', { query: { q }, auth: false }).then((d) => d.results),
      forReference: (reference_id) => request('/match', { query: { reference_id }, auth: false }),
      forProduct: (product_id) => request('/match', { query: { product_id }, auth: false }),
    },
  };

  /* ---------------------------------------------------------------- *
   * Small shared helpers every page uses
   * ---------------------------------------------------------------- */
  API.money = (n) => '৳' + Number(n || 0).toLocaleString('en-US');

  API.date = (d) => new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  /** Paints per-field errors from an ApiError onto a form. */
  API.showFieldErrors = (form, err) => {
    form.querySelectorAll('.field.bad').forEach((f) => f.classList.remove('bad'));
    Object.keys(err.details || {}).forEach((key) => {
      const field = form.querySelector(`[data-field="${key}"]`);
      if (!field) return;
      field.classList.add('bad');
      const msg = field.querySelector('.err');
      if (msg) msg.textContent = err.details[key];
    });
  };

  global.API = API;
})(window);

/**
 * Scent Nest — cart state.
 *
 * The cart lives in localStorage so it survives page navigation and
 * refreshes (index → shop → product → cart → checkout are separate
 * documents, so there is no in-memory state to share).
 *
 * Prices stored here are for display only. The server recalculates every
 * line from the database when the order is placed, so a tampered cart
 * cannot buy a ৳1,950 decant for ৳5.
 */
(function (global) {
  'use strict';

  const KEY = 'sn_cart';
  const MAX_QTY = 10;

  let items = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(raw) ? raw.filter(valid) : [];
    } catch {
      return [];
    }
  }

  const valid = (i) =>
    i && typeof i.product_id === 'string' &&
    [3, 5, 10].includes(Number(i.decant_size_ml)) &&
    Number(i.quantity) > 0;

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(items));
    document.dispatchEvent(new CustomEvent('sn:cart', { detail: Cart.summary() }));
  }

  const keyOf = (id, ml) => `${id}::${ml}`;

  const Cart = {
    get items() { return items.slice(); },

    /** Total number of vials, which is what the bag badge shows. */
    get count() { return items.reduce((n, i) => n + i.quantity, 0); },

    get subtotal() { return items.reduce((n, i) => n + i.price * i.quantity, 0); },

    get isEmpty() { return items.length === 0; },

    summary() {
      return { count: this.count, subtotal: this.subtotal, items: this.items };
    },

    /**
     * @param product a product object from /api/products
     * @param ml      3, 5 or 10
     */
    add(product, ml, quantity = 1) {
      const size = product.sizes?.find((s) => s.ml === Number(ml));
      if (!size) throw new Error(`${product.name} does not come in ${ml}ml.`);
      if (!size.in_stock) throw new Error(`${product.name} ${ml}ml is out of stock.`);

      const k = keyOf(product.product_id, ml);
      const line = items.find((i) => keyOf(i.product_id, i.decant_size_ml) === k);

      if (line) {
        line.quantity = Math.min(MAX_QTY, line.quantity + quantity);
      } else {
        items.push({
          product_id: product.product_id,
          name: product.name,
          brand: product.brand,
          image_url: product.image_url || '',
          decant_size_ml: Number(ml),
          quantity: Math.min(MAX_QTY, quantity),
          price: size.price,
        });
      }
      persist();
      return this.summary();
    },

    setQuantity(productId, ml, quantity) {
      const k = keyOf(productId, ml);
      const line = items.find((i) => keyOf(i.product_id, i.decant_size_ml) === k);
      if (!line) return this.summary();

      const q = Math.floor(Number(quantity));
      if (!q || q < 1) return this.remove(productId, ml);
      line.quantity = Math.min(MAX_QTY, q);
      persist();
      return this.summary();
    },

    remove(productId, ml) {
      const k = keyOf(productId, ml);
      items = items.filter((i) => keyOf(i.product_id, i.decant_size_ml) !== k);
      persist();
      return this.summary();
    },

    clear() {
      items = [];
      persist();
      return this.summary();
    },

    /**
     * Re-checks every line against current stock and pricing before
     * checkout. A cart can sit in localStorage for days; by the time the
     * customer returns, a fragrance may be sold out or repriced.
     *
     * Returns a list of plain-language changes to show them.
     */
    async revalidate() {
      const changes = [];
      const fresh = [];

      for (const line of items) {
        let product;
        try {
          ({ product } = await API.products.get(line.product_id));
        } catch {
          changes.push(`${line.name} is no longer available and was removed.`);
          continue;
        }

        const size = product.sizes.find((s) => s.ml === line.decant_size_ml);
        if (!size || !size.in_stock) {
          changes.push(`${line.name} ${line.decant_size_ml}ml sold out and was removed.`);
          continue;
        }
        if (size.price !== line.price) {
          changes.push(`${line.name} ${line.decant_size_ml}ml is now ${API.money(size.price)}.`);
          line.price = size.price;
        }

        // Not enough left in the bottle for the quantity they picked
        const maxUnits = Math.floor(product.stock_ml / line.decant_size_ml);
        if (line.quantity > maxUnits) {
          changes.push(`Only ${maxUnits} × ${line.decant_size_ml}ml of ${line.name} left.`);
          line.quantity = maxUnits;
        }

        line.name = product.name;
        line.brand = product.brand;
        fresh.push(line);
      }

      items = fresh;
      persist();
      return changes;
    },

    /** Exactly the shape POST /api/orders expects. */
    toOrderItems() {
      return items.map((i) => ({
        product_id: i.product_id,
        decant_size_ml: i.decant_size_ml,
        quantity: i.quantity,
      }));
    },
  };

  /* ---------------------------------------------------------------- *
   * Keep the bag badge in sync on every page, including when another
   * tab changes the cart.
   * ---------------------------------------------------------------- */
  function paintBadge() {
    const n = Cart.count;
    document.querySelectorAll('[data-bag-count]').forEach((el) => {
      el.textContent = n;
      el.closest('[data-bag]')?.classList.toggle('has-items', n > 0);
    });
  }

  document.addEventListener('sn:cart', paintBadge);
  document.addEventListener('DOMContentLoaded', paintBadge);
  global.addEventListener('storage', (e) => {
    if (e.key === KEY) { items = load(); paintBadge(); }
  });

  global.Cart = Cart;
})(window);
