/**
 * fragrance-match.js
 *
 * Note-similarity engine for a small perfume catalogue (up to ~2,000 items).
 * No dependencies. Runs in the browser or in a Next.js route handler.
 *
 * ---------------------------------------------------------------------------
 * DATA SHAPE
 * ---------------------------------------------------------------------------
 * {
 *   id: "lv-imagination",
 *   name: "Imagination",
 *   brand: "Louis Vuitton",
 *   inStock: false,                       // false = reference only, never recommended
 *   gender: "masculine" | "feminine" | "unisex",
 *   seasons: ["spring", "summer"],
 *   occasions: ["casual", "office"],
 *   accords: ["citrus", "aromatic", "woody", "amber"],   // ORDER MATTERS: most prominent first
 *   notes: {
 *     top:   ["bergamot", "orange"],
 *     heart: ["black tea", "cinnamon"],
 *     base:  ["ambroxan", "cedar"]
 *   }
 * }
 *
 * Every perfume needs accords + notes. Seasons, occasions and gender are
 * optional and only affect re-ranking, never the similarity score itself.
 */

/* -------------------------------------------------------------------------
 * Tuning constants — these are the dials worth adjusting once you have real
 * data and can eyeball the results.
 * ---------------------------------------------------------------------- */

// Base notes drive the drydown, which is what a customer actually remembers
// wearing. Top notes are gone in twenty minutes and should barely count.
export const LAYER_WEIGHT = { top: 0.5, heart: 1.0, base: 1.6 };

// Accords describe overall character; individual notes describe detail.
// Character matters more for "does this scratch the same itch".
export const ACCORD_SHARE = 0.55;
export const NOTE_SHARE = 0.45;

// Below this, say "no close match" rather than recommending something wrong.
export const MIN_SCORE = 0.22;

/* -------------------------------------------------------------------------
 * Vocabulary normalisation
 *
 * Hand-entered data drifts: "Calabrian bergamot" and "bergamot" must collapse
 * to the same term or they will never match. Add every variant you catch to
 * this map. Keep the LEFT side lowercase.
 * ---------------------------------------------------------------------- */

export const SYNONYMS = {
  'calabrian bergamot': 'bergamot',
  'italian bergamot': 'bergamot',
  'sicilian lemon': 'lemon',
  'mysore sandalwood': 'sandalwood',
  'australian sandalwood': 'sandalwood',
  'virginia cedar': 'cedar',
  'cedarwood': 'cedar',
  'atlas cedar': 'cedar',
  'ambroxan': 'amberwood',
  'ambrox': 'amberwood',
  'cetalox': 'amberwood',
  'amberwood': 'amberwood',
  'ambergris': 'amber',
  'tonka bean': 'tonka',
  'madagascar vanilla': 'vanilla',
  'bourbon vanilla': 'vanilla',
  'vanille': 'vanilla',
  'oud': 'agarwood',
  'oudh': 'agarwood',
  'agarwood': 'agarwood',
  'indonesian patchouli': 'patchouli',
  'white musk': 'musk',
  'musks': 'musk',
  'pink pepper': 'pink pepper',
  'black pepper': 'pepper',
  'sichuan pepper': 'pepper',
  'blackcurrant': 'blackcurrant',
  'black currant': 'blackcurrant',
  'cassis': 'blackcurrant',
  'labdanum': 'labdanum',
  'benzoin': 'benzoin',
  'olibanum': 'incense',
  'frankincense': 'incense',
};

export function normalizeTerm(term) {
  if (!term) return '';
  const cleaned = String(term)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')       // drop parenthetical asides
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return SYNONYMS[cleaned] || cleaned;
}

/* -------------------------------------------------------------------------
 * Vector building
 * ---------------------------------------------------------------------- */

function bump(map, key, weight) {
  map.set(key, (map.get(key) || 0) + weight);
}

/**
 * Turns a perfume's note pyramid into a weighted term vector, and records
 * which layer each term came from (for explaining the match later).
 *
 * Dividing by sqrt(count) stops a perfume with twelve base notes from
 * swamping one with three.
 */
function buildNoteVector(perfume) {
  const vector = new Map();
  const layerOf = new Map();
  const bestWeight = new Map();

  for (const layer of ['top', 'heart', 'base']) {
    const raw = (perfume.notes && perfume.notes[layer]) || [];
    const terms = raw.map(normalizeTerm).filter(Boolean);
    if (!terms.length) continue;

    const weight = LAYER_WEIGHT[layer] / Math.sqrt(terms.length);
    for (const term of terms) {
      bump(vector, term, weight);
      if (weight > (bestWeight.get(term) || 0)) {
        bestWeight.set(term, weight);
        layerOf.set(term, layer);
      }
    }
  }
  return { vector, layerOf };
}

/** Accords listed first are the dominant ones, so they get more weight. */
function buildAccordVector(perfume) {
  const vector = new Map();
  const accords = (perfume.accords || []).map(normalizeTerm).filter(Boolean);
  accords.forEach((accord, rank) => bump(vector, accord, 1 / Math.sqrt(rank + 1)));
  return vector;
}

/* -------------------------------------------------------------------------
 * IDF, normalisation, cosine
 * ---------------------------------------------------------------------- */

/**
 * Inverse document frequency. Bergamot appears in half your catalogue and is
 * therefore nearly meaningless as a match signal; immortelle or agarwood is
 * highly informative. This is the single biggest quality win over naive
 * note-overlap counting.
 */
function buildIdf(vectors, corpusSize) {
  const docFreq = new Map();
  for (const vector of vectors) {
    for (const term of vector.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }
  const idf = new Map();
  for (const [term, freq] of docFreq) {
    idf.set(term, Math.log((corpusSize + 1) / (freq + 1)) + 1);
  }
  return idf;
}

function applyIdfAndNormalize(vector, idf) {
  const weighted = new Map();
  let sumSquares = 0;
  for (const [term, weight] of vector) {
    const value = weight * (idf.get(term) || 1);
    weighted.set(term, value);
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (!magnitude) return weighted;
  for (const [term, value] of weighted) weighted.set(term, value / magnitude);
  return weighted;
}

/** Both vectors are unit length, so the dot product is the cosine. */
function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let total = 0;
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other) total += value * other;
  }
  return total;
}

/* -------------------------------------------------------------------------
 * Index
 * ---------------------------------------------------------------------- */

/**
 * Build once at module load (or at build time) and reuse. For 500 perfumes
 * this takes a couple of milliseconds.
 */
export function buildIndex(perfumes) {
  const noteData = perfumes.map(buildNoteVector);
  const accordData = perfumes.map(buildAccordVector);

  const noteIdf = buildIdf(noteData.map((d) => d.vector), perfumes.length);
  const accordIdf = buildIdf(accordData, perfumes.length);

  const entries = perfumes.map((perfume, i) => ({
    perfume,
    noteVector: applyIdfAndNormalize(noteData[i].vector, noteIdf),
    accordVector: applyIdfAndNormalize(accordData[i], accordIdf),
    layerOf: noteData[i].layerOf,
  }));

  const byId = new Map(entries.map((entry) => [entry.perfume.id, entry]));
  return { entries, byId, noteIdf, accordIdf };
}

/** Turn a loose profile (e.g. parsed from a customer's sentence) into an entry. */
export function profileToEntry(profile, index) {
  const pseudo = {
    id: '__query__',
    name: profile.name || 'Your search',
    accords: profile.accords || [],
    notes: profile.notes || {},
  };
  const { vector, layerOf } = buildNoteVector(pseudo);
  return {
    perfume: pseudo,
    noteVector: applyIdfAndNormalize(vector, index.noteIdf),
    accordVector: applyIdfAndNormalize(buildAccordVector(pseudo), index.accordIdf),
    layerOf,
  };
}

/* -------------------------------------------------------------------------
 * Comparison
 * ---------------------------------------------------------------------- */

export function compare(target, candidate) {
  const noteScore = cosine(target.noteVector, candidate.noteVector);
  const accordScore = cosine(target.accordVector, candidate.accordVector);

  // If either side has no accords recorded, fall back to notes alone rather
  // than silently halving the score.
  const hasAccords = target.accordVector.size > 0 && candidate.accordVector.size > 0;
  const score = hasAccords
    ? ACCORD_SHARE * accordScore + NOTE_SHARE * noteScore
    : noteScore;

  // Which shared notes actually drove the score, strongest first.
  const sharedNotes = [];
  for (const [term, value] of target.noteVector) {
    const other = candidate.noteVector.get(term);
    if (other) {
      sharedNotes.push({
        term,
        layer: target.layerOf.get(term) || 'heart',
        contribution: value * other,
      });
    }
  }
  sharedNotes.sort((a, b) => b.contribution - a.contribution);

  // How much of the note similarity came from each layer — a match built on
  // shared base notes is far more convincing than one built on top notes.
  const layerBreakdown = { top: 0, heart: 0, base: 0 };
  for (const shared of sharedNotes) layerBreakdown[shared.layer] += shared.contribution;

  const sharedAccords = [];
  for (const [term, value] of target.accordVector) {
    const other = candidate.accordVector.get(term);
    if (other) sharedAccords.push({ term, contribution: value * other });
  }
  sharedAccords.sort((a, b) => b.contribution - a.contribution);

  // The most distinctive things in the target that this candidate lacks.
  // Show these to the customer — honesty here prevents returns.
  const missing = [];
  for (const [term, value] of target.noteVector) {
    if (!candidate.noteVector.has(term)) {
      missing.push({ term, layer: target.layerOf.get(term) || 'heart', weight: value });
    }
  }
  missing.sort((a, b) => b.weight - a.weight);

  return {
    score,
    noteScore,
    accordScore,
    layerBreakdown,
    sharedNotes,
    sharedAccords,
    missingNotes: missing.slice(0, 4),
  };
}

/* -------------------------------------------------------------------------
 * Ranking
 * ---------------------------------------------------------------------- */

/**
 * Context is a re-ranking nudge applied AFTER similarity, never part of it.
 * Keeping them separate means your match percentages stay meaningful.
 */
export function contextMultiplier(perfume, context) {
  if (!context) return 1;
  let multiplier = 1;
  if (context.season && perfume.seasons?.includes(context.season)) multiplier += 0.05;
  if (context.occasion && perfume.occasions?.includes(context.occasion)) multiplier += 0.04;
  if (
    context.gender &&
    perfume.gender &&
    perfume.gender !== 'unisex' &&
    perfume.gender !== context.gender
  ) {
    multiplier -= 0.1;
  }
  return multiplier;
}

export function describeMatch(score) {
  if (score >= 0.55) return { label: 'Very close', tier: 3 };
  if (score >= 0.4) return { label: 'Strong match', tier: 2 };
  if (score >= 0.28) return { label: 'Shares the character', tier: 1 };
  return { label: 'Loosely related', tier: 0 };
}

/**
 * @param index    from buildIndex()
 * @param target   an entry (index.byId.get(id)) or a profile object
 * @param options  { limit, minScore, inStockOnly, context, exclude }
 */
export function recommend(index, target, options = {}) {
  const {
    limit = 3,
    minScore = MIN_SCORE,
    inStockOnly = true,
    context = null,
    exclude = [],
  } = options;

  const targetEntry = target.noteVector ? target : profileToEntry(target, index);
  const excluded = new Set([...exclude, targetEntry.perfume.id]);

  const results = [];
  for (const candidate of index.entries) {
    if (excluded.has(candidate.perfume.id)) continue;
    if (inStockOnly && !candidate.perfume.inStock) continue;

    const result = compare(targetEntry, candidate);
    if (result.score < minScore) continue;

    results.push({
      perfume: candidate.perfume,
      ...result,
      ...describeMatch(result.score),
      rankScore: result.score * contextMultiplier(candidate.perfume, context),
    });
  }

  results.sort((a, b) => b.rankScore - a.rankScore);
  return results.slice(0, limit);
}

/* -------------------------------------------------------------------------
 * Name lookup — for the search box
 * ---------------------------------------------------------------------- */

export function searchByName(index, query, limit = 8) {
  const needle = normalizeTerm(query);
  if (!needle) return [];

  const scored = [];
  for (const entry of index.entries) {
    const name = normalizeTerm(entry.perfume.name);
    const brand = normalizeTerm(entry.perfume.brand || '');
    const full = `${brand} ${name}`.trim();

    let rank = -1;
    if (full === needle || name === needle) rank = 0;
    else if (full.startsWith(needle) || name.startsWith(needle)) rank = 1;
    else if (full.includes(needle)) rank = 2;
    else {
      const tokens = needle.split(' ').filter(Boolean);
      if (tokens.length && tokens.every((token) => full.includes(token))) rank = 3;
    }

    if (rank >= 0) scored.push({ entry, rank, length: full.length });
  }

  scored.sort((a, b) => a.rank - b.rank || a.length - b.length);
  return scored.slice(0, limit).map((s) => s.entry.perfume);
}

/* -------------------------------------------------------------------------
 * Optional: the LLM hook
 * ---------------------------------------------------------------------- */

/**
 * Call an LLM ONLY to turn a messy sentence into a structured profile, then
 * feed the result into recommend(). The model never sees your stock and never
 * chooses the product, so it cannot invent a perfume you don't sell.
 *
 * Give it your controlled vocabulary in the prompt and instruct it to return
 * JSON only, using terms from that list.
 */
export function buildQueryPrompt(userText, vocabulary) {
  return [
    'Convert the shopper request below into a fragrance profile.',
    'Reply with JSON only. No prose, no markdown fences.',
    'Shape: {"accords": string[], "notes": {"top": string[], "heart": string[], "base": string[]}, "season": string|null, "occasion": string|null}',
    `Use only these terms: ${vocabulary.join(', ')}`,
    '',
    `Request: ${userText}`,
  ].join('\n');
}

/** Every term in your catalogue — pass this to buildQueryPrompt. */
export function vocabularyOf(perfumes) {
  const terms = new Set();
  for (const perfume of perfumes) {
    for (const accord of perfume.accords || []) terms.add(normalizeTerm(accord));
    for (const layer of ['top', 'heart', 'base']) {
      for (const note of (perfume.notes && perfume.notes[layer]) || []) {
        terms.add(normalizeTerm(note));
      }
    }
  }
  terms.delete('');
  return [...terms].sort();
}
