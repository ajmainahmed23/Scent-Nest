/**
 * Scent Nest — fragrance similarity engine.
 *
 * Pure JS, zero dependencies. Works identically inside a Netlify Function
 * (Node) and in the browser, so you can move it either way later without
 * rewriting it.
 *
 * The job: given a fragrance the customer wants (from the 24k reference
 * catalog) and the decants Scent Nest actually has in stock, rank the stock
 * by how close it smells and explain WHY in words a customer understands.
 */

/* ------------------------------------------------------------------ *
 * 1. Note normalisation
 * ------------------------------------------------------------------ */

const QUALIFIERS = new Set([
  'sicilian','calabrian','egyptian','tunisian','nigerian','ceylon','bulgarian',
  'turkish','moroccan','indian','chinese','italian','french','virginia','texas',
  'madagascar','indonesian','australian','brazilian','russian','spanish',
  'japanese','thai','haitian','somali','florentine','damask','grasse','persian',
  'african','mexican','caribbean','tahitian','bourbon','atlas','himalayan',
  'wild','fresh','dried','candied','roasted','smoked','blonde','dark','golden',
  'sweet','bitter','sour','creamy','crystallized','burnt','toasted','aged',
  'young','ripe','juicy','frozen','sparkling','crushed','whipped','warm','cool',
  'soft','wet'
]);

/** 'Calabrian Bergamot' -> 'bergamot' */
function coreNote(note) {
  let toks = String(note).toLowerCase().trim().split(/\s+/);
  while (toks.length > 1 && QUALIFIERS.has(toks[0])) toks = toks.slice(1);
  if (toks.length > 1 && /^(notes?|accord)$/.test(toks[toks.length - 1])) toks = toks.slice(0, -1);
  return toks.join(' ');
}

const norm = (n) => String(n).toLowerCase().trim().replace(/\s+/g, ' ');

/* ------------------------------------------------------------------ *
 * 2. Layer scoring
 * ------------------------------------------------------------------ *
 * An exact shared note counts full. A shared *core* note (bergamot vs
 * calabrian bergamot) counts partial — they smell related, not identical.
 * Score is normalised by geometric mean of list sizes so a fragrance with
 * 12 base notes can't win just by having many chances to overlap.
 */

const PARTIAL_CREDIT = 0.6;

function layerScore(a = [], b = []) {
  if (!a.length || !b.length) return { score: 0, shared: [] };

  const bExact = new Set(b.map(norm));
  const bCore = new Map();
  b.forEach((n) => bCore.set(coreNote(n), n));

  let total = 0;
  const shared = [];

  for (const raw of a) {
    const n = norm(raw);
    if (bExact.has(n)) {
      total += 1;
      shared.push({ note: raw, weight: 1 });
    } else {
      const c = coreNote(raw);
      if (bCore.has(c)) {
        total += PARTIAL_CREDIT;
        shared.push({ note: c, weight: PARTIAL_CREDIT });
      }
    }
  }

  return { score: total / Math.sqrt(a.length * b.length), shared };
}

/**
 * Accords are ranked (mainaccord1 is the dominant one), so position matters.
 * Matching on the #1 accord of both fragrances is worth far more than both
 * happening to list 'musky' in 5th place.
 */
const ACCORD_WEIGHTS = [1.0, 0.8, 0.6, 0.45, 0.3];

function accordScore(a = [], b = []) {
  if (!a.length || !b.length) return { score: 0, shared: [] };

  const bIndex = new Map();
  b.forEach((x, i) => bIndex.set(norm(x), i));

  let got = 0, max = 0;
  const shared = [];

  a.forEach((x, i) => {
    const wa = ACCORD_WEIGHTS[i] ?? 0.25;
    max += wa;
    const j = bIndex.get(norm(x));
    if (j !== undefined) {
      const wb = ACCORD_WEIGHTS[j] ?? 0.25;
      got += Math.sqrt(wa * wb); // reward agreement on *prominence*, not just presence
      shared.push({ accord: x, rankA: i + 1, rankB: j + 1 });
    }
  });

  return { score: max ? Math.min(got / max, 1) : 0, shared };
}

/* ------------------------------------------------------------------ *
 * 3. Overall weights
 * ------------------------------------------------------------------ *
 * Base notes carry the drydown — what the wearer smells for 6 hours — so
 * they outweigh the top notes, which burn off in 15 minutes.
 */
const WEIGHTS = {
  accords: 0.34,
  base:    0.26,
  middle:  0.18,
  top:     0.12,
  gender:  0.05,
  vibe:    0.05, // season + time-of-day agreement
};

function genderScore(a, b) {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  if (a === 'unisex' || b === 'unisex') return 0.75;
  return 0.15; // a men's fougère is a poor swap for a women's gourmand
}

function overlapRatio(a = [], b = []) {
  if (!a.length || !b.length) return 0.5;
  const B = new Set(b);
  const hits = a.filter((x) => B.has(x)).length;
  return hits / Math.max(a.length, b.length);
}

/* ------------------------------------------------------------------ *
 * 4. Public API
 * ------------------------------------------------------------------ */

/**
 * Compare a target fragrance against one stock item.
 * Both objects take the shape:
 *   { name, brand, gender, notes:{top,middle,base}, accords, season, timeOfDay }
 */
function compare(target, candidate) {
  const t = target.notes || {};
  const c = candidate.notes || {};

  const base   = layerScore(t.base   || [], c.base   || []);
  const middle = layerScore(t.middle || [], c.middle || []);
  const top    = layerScore(t.top    || [], c.top    || []);
  const acc    = accordScore(target.accords || [], candidate.accords || []);
  const gen    = genderScore(target.gender, candidate.gender);
  const vibe   = (overlapRatio(target.season, candidate.season) +
                  overlapRatio(target.timeOfDay, candidate.timeOfDay)) / 2;

  const raw =
    acc.score    * WEIGHTS.accords +
    base.score   * WEIGHTS.base +
    middle.score * WEIGHTS.middle +
    top.score    * WEIGHTS.top +
    gen          * WEIGHTS.gender +
    vibe         * WEIGHTS.vibe;

  // Raw cosine-style scores rarely exceed ~0.65 even for close twins, which
  // reads as a discouraging "65% match" to a shopper. Curve it so the number
  // maps to how a human would describe the closeness, and cap below 100 —
  // nothing but the fragrance itself is a 100% match.
  let percent = Math.min(97, Math.round(Math.pow(raw, 0.62) * 108));

  // Accord-only agreement is weak evidence: two fragrances can both be
  // "woody, amber" and still smell nothing alike. Cap the headline number by
  // how many actual notes we can point to, so we never show a confident 70%
  // next to a reason that names one shared ingredient.
  const evidence = new Set([
    ...base.shared.map((s) => s.note),
    ...middle.shared.map((s) => s.note),
    ...top.shared.map((s) => s.note),
  ]).size;
  const EVIDENCE_CAP = { 0: 45, 1: 58, 2: 70, 3: 82 };
  if (EVIDENCE_CAP[evidence] !== undefined) {
    percent = Math.min(percent, EVIDENCE_CAP[evidence]);
  }

  return {
    id: candidate.id || candidate._id,
    name: candidate.name,
    brand: candidate.brand,
    match: percent,
    raw: Number(raw.toFixed(4)),
    evidence,
    breakdown: {
      accords: Math.round(acc.score * 100),
      base:    Math.round(base.score * 100),
      middle:  Math.round(middle.score * 100),
      top:     Math.round(top.score * 100),
    },
    sharedAccords: acc.shared.map((s) => s.accord),
    sharedNotes: {
      base:   base.shared.map((s) => s.note),
      middle: middle.shared.map((s) => s.note),
      top:    top.shared.map((s) => s.note),
    },
  };
}

/** Title-case a note for display: 'black tea' -> 'Black Tea' */
const titleCase = (s) =>
  String(s).replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

/**
 * Turn a raw comparison into the sentence the customer actually reads.
 */
function explain(target, result) {
  const notes = [
    ...result.sharedNotes.base,
    ...result.sharedNotes.middle,
    ...result.sharedNotes.top,
  ];
  const uniq = [...new Set(notes.map(titleCase))].slice(0, 3);
  const accords = [...new Set(result.sharedAccords.map(titleCase))].slice(0, 2);

  let reason;
  if (uniq.length >= 2) reason = `shares ${uniq.slice(0, -1).join(', ')} & ${uniq[uniq.length - 1]}`;
  else if (uniq.length === 1) reason = `shares ${uniq[0]}`;
  else if (accords.length) reason = `sits in the same ${accords.join(' & ').toLowerCase()} family`;
  else reason = 'has a comparable overall profile';

  const strength =
    result.match >= 78 ? 'Very close to' :
    result.match >= 65 ? 'A strong alternative to' :
    result.match >= 50 ? 'In the same family as' :
                         'A looser take on';

  return `${strength} ${target.name} — ${reason}.`;
}

/**
 * Main entry point.
 *
 * @param {object} target    the fragrance the customer searched for
 * @param {array}  inventory Scent Nest decants currently in stock
 * @param {object} opts      { limit, minMatch, inStockOnly }
 */
function recommend(target, inventory, opts = {}) {
  const { limit = 4, minMatch = 35, inStockOnly = true } = opts;

  return inventory
    .filter((item) => {
      if (inStockOnly && item.stock !== undefined && item.stock <= 0) return false;
      // never recommend the exact fragrance as an "alternative" to itself
      return !(norm(item.name) === norm(target.name) && norm(item.brand) === norm(target.brand));
    })
    .map((item) => {
      const r = compare(target, item);
      r.reason = explain(target, r);
      r.price = item.price;
      r.sizes = item.sizes;
      r.stock = item.stock;
      return r;
    })
    .filter((r) => r.match >= minMatch)
    .sort((a, b) => b.match - a.match)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 5. Catalog search (fuzzy enough for real typing)
 * ------------------------------------------------------------------ */

const BRAND_ALIASES = {
  lv: 'louis vuitton', ysl: 'yves saint laurent', jpg: 'jean paul gaultier',
  ck: 'calvin klein', ch: 'carolina herrera', tf: 'tom ford',
  mfk: 'maison francis kurkdjian', pdm: 'parfums de marly', ga: 'giorgio armani',
  bb: 'bath body works', dg: 'dolce gabbana', vc: 'van cleef arpels',
};

function expandQuery(q) {
  const words = norm(q).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.map((w) => BRAND_ALIASES[w] || w).join(' ');
}

/**
 * Rank the reference catalog against a free-text query.
 * Prefix + substring scoring, boosted by popularity so 'sauvage' surfaces
 * Dior Sauvage rather than an obscure flanker.
 */
function searchCatalog(query, catalog, limit = 8) {
  const q = expandQuery(query);
  if (q.length < 2) return [];
  const terms = q.split(' ').filter(Boolean);

  const scored = [];
  for (const f of catalog) {
    const hay = `${f.name} ${f.brand}`.toLowerCase();
    let score = 0, ok = true;

    for (const t of terms) {
      const at = hay.indexOf(t);
      if (at === -1) { ok = false; break; }
      score += 10;
      if (at === 0) score += 8;                       // matches from the start
      else if (hay[at - 1] === ' ') score += 5;       // matches a word start
    }
    if (!ok) continue;

    if (hay === q) score += 50;
    if (f.name.toLowerCase() === q) score += 30;
    score += Math.log10((f.ratingCount || 0) + 10) * 4; // popularity tiebreak
    score -= Math.abs(hay.length - q.length) * 0.08;    // prefer tight matches

    scored.push({ f, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.f);
}

/* ------------------------------------------------------------------ */

const api = { compare, recommend, explain, searchCatalog, coreNote, WEIGHTS };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ScentMatch = api;
