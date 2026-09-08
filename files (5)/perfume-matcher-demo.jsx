import React, { useMemo, useState } from 'react';

/* ===========================================================================
   DEMO ONLY — the engine below is a copy of fragrance-match.js so this file
   runs standalone. In your Next.js app, import from fragrance-match.js instead
   of duplicating it.

   The note lists in SAMPLE_CATALOGUE are illustrative placeholders. Replace
   them with your own verified data before showing this to a customer.
   ======================================================================== */

const LAYER_WEIGHT = { top: 0.5, heart: 1.0, base: 1.6 };
const ACCORD_SHARE = 0.55;
const NOTE_SHARE = 0.45;

const SYNONYMS = {
  'calabrian bergamot': 'bergamot',
  'cedarwood': 'cedar',
  'ambroxan': 'amberwood',
  'ambergris': 'amber',
  'tonka bean': 'tonka',
  'oud': 'agarwood',
  'oudh': 'agarwood',
  'cassis': 'blackcurrant',
  'black currant': 'blackcurrant',
  'white musk': 'musk',
  'frankincense': 'incense',
};

function normalizeTerm(term) {
  if (!term) return '';
  const cleaned = String(term)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return SYNONYMS[cleaned] || cleaned;
}

function bump(map, key, weight) {
  map.set(key, (map.get(key) || 0) + weight);
}

function buildNoteVector(perfume) {
  const vector = new Map();
  const layerOf = new Map();
  const bestWeight = new Map();
  for (const layer of ['top', 'heart', 'base']) {
    const terms = ((perfume.notes && perfume.notes[layer]) || [])
      .map(normalizeTerm)
      .filter(Boolean);
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

function buildAccordVector(perfume) {
  const vector = new Map();
  (perfume.accords || [])
    .map(normalizeTerm)
    .filter(Boolean)
    .forEach((accord, rank) => bump(vector, accord, 1 / Math.sqrt(rank + 1)));
  return vector;
}

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

function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let total = 0;
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other) total += value * other;
  }
  return total;
}

function buildIndex(perfumes) {
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
  return { entries, byId: new Map(entries.map((e) => [e.perfume.id, e])) };
}

function compare(target, candidate) {
  const noteScore = cosine(target.noteVector, candidate.noteVector);
  const accordScore = cosine(target.accordVector, candidate.accordVector);
  const hasAccords = target.accordVector.size > 0 && candidate.accordVector.size > 0;
  const score = hasAccords
    ? ACCORD_SHARE * accordScore + NOTE_SHARE * noteScore
    : noteScore;

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

  const layerBreakdown = { top: 0, heart: 0, base: 0 };
  for (const shared of sharedNotes) layerBreakdown[shared.layer] += shared.contribution;

  const sharedAccords = [];
  for (const [term, value] of target.accordVector) {
    const other = candidate.accordVector.get(term);
    if (other) sharedAccords.push({ term, contribution: value * other });
  }
  sharedAccords.sort((a, b) => b.contribution - a.contribution);

  const missing = [];
  for (const [term, value] of target.noteVector) {
    if (!candidate.noteVector.has(term)) missing.push({ term, weight: value });
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

function describeMatch(score) {
  if (score >= 0.55) return 'Very close';
  if (score >= 0.4) return 'Strong match';
  if (score >= 0.28) return 'Shares the character';
  return 'Loosely related';
}

function recommend(index, targetEntry, { limit = 3, minScore = 0.22 } = {}) {
  const results = [];
  for (const candidate of index.entries) {
    if (candidate.perfume.id === targetEntry.perfume.id) continue;
    if (!candidate.perfume.inStock) continue;
    const result = compare(targetEntry, candidate);
    if (result.score < minScore) continue;
    results.push({ perfume: candidate.perfume, ...result, label: describeMatch(result.score) });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/* ===========================================================================
   SAMPLE DATA — placeholder notes, replace with your own.
   ======================================================================== */

const SAMPLE_CATALOGUE = [
  {
    id: 'lv-imagination',
    name: 'Imagination',
    brand: 'Louis Vuitton',
    inStock: false,
    accords: ['citrus', 'aromatic', 'woody', 'amber'],
    notes: {
      top: ['bergamot', 'orange', 'lemon'],
      heart: ['black tea', 'cinnamon', 'ginger'],
      base: ['amberwood', 'cedar', 'cypress'],
    },
  },
  {
    id: 'creed-aventus',
    name: 'Aventus',
    brand: 'Creed',
    inStock: false,
    accords: ['fruity', 'woody', 'smoky', 'musky'],
    notes: {
      top: ['pineapple', 'bergamot', 'blackcurrant', 'apple'],
      heart: ['birch', 'patchouli', 'jasmine', 'rose'],
      base: ['musk', 'oakmoss', 'ambergris', 'vanilla'],
    },
  },
  {
    id: 'tf-tobacco-vanille',
    name: 'Tobacco Vanille',
    brand: 'Tom Ford',
    inStock: false,
    accords: ['warm spicy', 'tobacco', 'vanilla', 'sweet'],
    notes: {
      top: ['tobacco leaf', 'spices'],
      heart: ['vanilla', 'cacao', 'tonka bean', 'dried fruits'],
      base: ['woody notes', 'benzoin'],
    },
  },
  {
    id: 'bleu-de-chanel',
    name: 'Bleu de Chanel',
    brand: 'Chanel',
    inStock: false,
    accords: ['aromatic', 'citrus', 'woody', 'amber'],
    notes: {
      top: ['grapefruit', 'lemon', 'mint', 'pink pepper'],
      heart: ['ginger', 'nutmeg', 'jasmine'],
      base: ['incense', 'amberwood', 'sandalwood', 'patchouli'],
    },
  },
  {
    id: 'rasasi-hawas',
    name: 'Hawas',
    brand: 'Rasasi',
    inStock: true,
    accords: ['fruity', 'aquatic', 'woody', 'musky'],
    notes: {
      top: ['apple', 'cinnamon', 'bergamot', 'lemon'],
      heart: ['jasmine', 'cardamom', 'sea notes'],
      base: ['ambergris', 'musk', 'driftwood'],
    },
  },
  {
    id: 'armaf-cdnim',
    name: 'Club de Nuit Intense Man',
    brand: 'Armaf',
    inStock: true,
    accords: ['fruity', 'woody', 'smoky', 'musky'],
    notes: {
      top: ['pineapple', 'blackcurrant', 'apple', 'lemon', 'bergamot'],
      heart: ['birch', 'jasmine', 'rose'],
      base: ['musk', 'vanilla', 'ambergris', 'patchouli'],
    },
  },
  {
    id: 'lattafa-khamrah',
    name: 'Khamrah',
    brand: 'Lattafa',
    inStock: true,
    accords: ['warm spicy', 'sweet', 'vanilla', 'boozy'],
    notes: {
      top: ['cinnamon', 'nutmeg', 'bergamot'],
      heart: ['dates', 'praline', 'tuberose'],
      base: ['vanilla', 'tonka bean', 'benzoin', 'amberwood'],
    },
  },
  {
    id: 'lattafa-raghba',
    name: 'Raghba',
    brand: 'Lattafa',
    inStock: true,
    accords: ['vanilla', 'sweet', 'woody', 'smoky'],
    notes: {
      top: ['vanilla', 'sugar'],
      heart: ['oud', 'incense'],
      base: ['musk', 'sandalwood', 'amber'],
    },
  },
  {
    id: 'lattafa-yara',
    name: 'Yara',
    brand: 'Lattafa',
    inStock: true,
    accords: ['sweet', 'vanilla', 'fruity', 'powdery'],
    notes: {
      top: ['orchid', 'tangerine', 'heliotrope'],
      heart: ['vanilla', 'gourmand notes'],
      base: ['sandalwood', 'musk'],
    },
  },
  {
    id: 'ahg-amber-oud',
    name: 'Amber Oud Gold',
    brand: 'Al Haramain',
    inStock: true,
    accords: ['citrus', 'sweet', 'woody', 'amber'],
    notes: {
      top: ['lemon', 'bergamot', 'apple'],
      heart: ['jasmine', 'rose', 'saffron'],
      base: ['amberwood', 'musk', 'vanilla', 'cedar'],
    },
  },
  {
    id: 'ma-tea-noir',
    name: 'Tea Noir',
    brand: 'Maison Alhambra',
    inStock: true,
    accords: ['citrus', 'aromatic', 'woody', 'amber'],
    notes: {
      top: ['bergamot', 'orange'],
      heart: ['black tea', 'cinnamon', 'cardamom'],
      base: ['amberwood', 'cedar', 'musk'],
    },
  },
  {
    id: 'armaf-ventana',
    name: 'Ventana Blue',
    brand: 'Armaf',
    inStock: true,
    accords: ['aromatic', 'citrus', 'woody', 'fresh spicy'],
    notes: {
      top: ['grapefruit', 'lemon', 'mint'],
      heart: ['ginger', 'nutmeg', 'jasmine'],
      base: ['amberwood', 'sandalwood', 'patchouli'],
    },
  },
];

/* ===========================================================================
   UI
   ======================================================================== */

const COLORS = {
  ground: '#161E1A',
  panel: '#1E2823',
  panelEdge: '#2C3A33',
  ink: '#E9E5D8',
  quiet: '#93A395',
  brass: '#C9A227',
  base: '#C9A227',
  heart: '#9BA88E',
  top: '#5E7A6A',
};

const LAYER_LABEL = { top: 'Opening', heart: 'Heart', base: 'Drydown' };

function titleCase(text) {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function Chip({ children, tone = 'quiet' }) {
  const tones = {
    quiet: { border: COLORS.panelEdge, color: COLORS.quiet },
    brass: { border: COLORS.brass, color: COLORS.brass },
    heart: { border: COLORS.heart, color: COLORS.heart },
  };
  return (
    <span
      className="inline-block rounded-full px-3 py-1 text-xs"
      style={{ border: `1px solid ${tones[tone].border}`, color: tones[tone].color }}
    >
      {children}
    </span>
  );
}

/** Width shows overall strength; segments show which layers earned it. */
function StrataBar({ score, breakdown }) {
  const total = breakdown.top + breakdown.heart + breakdown.base;
  const fill = Math.min(score / 0.7, 1) * 100;
  const segments = total
    ? ['base', 'heart', 'top'].map((layer) => ({
        layer,
        pct: (breakdown[layer] / total) * 100,
      }))
    : [{ layer: 'heart', pct: 100 }];

  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full"
      style={{ backgroundColor: COLORS.panelEdge }}
    >
      <div className="flex h-full" style={{ width: `${fill}%` }}>
        {segments.map((segment) => (
          <div
            key={segment.layer}
            style={{ width: `${segment.pct}%`, backgroundColor: COLORS[segment.layer] }}
          />
        ))}
      </div>
    </div>
  );
}

function MatchCard({ match, showDetail }) {
  const shared = match.sharedNotes.slice(0, 4);
  return (
    <article
      className="rounded-lg p-5"
      style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelEdge}` }}
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <p className="text-sm" style={{ color: COLORS.quiet }}>
            {match.perfume.brand}
          </p>
          <h3
            className="text-2xl leading-tight"
            style={{ fontFamily: 'Georgia, serif', color: COLORS.ink }}
          >
            {match.perfume.name}
          </h3>
        </div>
        <p className="text-sm" style={{ color: COLORS.brass }}>
          {match.label}
        </p>
      </div>

      <div className="mb-4 mt-3">
        <StrataBar score={match.score} breakdown={match.layerBreakdown} />
      </div>

      {shared.length > 0 && (
        <p className="mb-3 text-sm leading-relaxed" style={{ color: COLORS.ink }}>
          Shares{' '}
          {shared.map((note, i) => (
            <span key={note.term}>
              <span style={{ color: COLORS[note.layer] }}>{note.term}</span>
              <span style={{ color: COLORS.quiet }}> in the {LAYER_LABEL[note.layer].toLowerCase()}</span>
              {i < shared.length - 1 ? ', ' : ''}
            </span>
          ))}
          .
        </p>
      )}

      {match.missingNotes.length > 0 && (
        <p className="mb-3 text-sm leading-relaxed" style={{ color: COLORS.quiet }}>
          Missing {match.missingNotes.map((note) => note.term).join(', ')}.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {match.sharedAccords.slice(0, 3).map((accord) => (
          <Chip key={accord.term} tone="heart">
            {accord.term}
          </Chip>
        ))}
      </div>

      {showDetail && (
        <dl
          className="mt-4 grid grid-cols-3 gap-4 border-t pt-3 text-sm"
          style={{ borderColor: COLORS.panelEdge, color: COLORS.quiet }}
        >
          <div>
            <dt>Blended</dt>
            <dd style={{ color: COLORS.ink }}>{match.score.toFixed(3)}</dd>
          </div>
          <div>
            <dt>Accords</dt>
            <dd style={{ color: COLORS.ink }}>{match.accordScore.toFixed(3)}</dd>
          </div>
          <div>
            <dt>Notes</dt>
            <dd style={{ color: COLORS.ink }}>{match.noteScore.toFixed(3)}</dd>
          </div>
        </dl>
      )}
    </article>
  );
}

export default function PerfumeMatcher() {
  const index = useMemo(() => buildIndex(SAMPLE_CATALOGUE), []);
  const [selectedId, setSelectedId] = useState('lv-imagination');
  const [showDetail, setShowDetail] = useState(false);

  const targetEntry = index.byId.get(selectedId);
  const matches = useMemo(
    () => recommend(index, targetEntry, { limit: 3 }),
    [index, targetEntry],
  );

  const target = targetEntry.perfume;

  return (
    <div
      className="min-h-screen w-full px-5 py-10"
      style={{ backgroundColor: COLORS.ground, color: COLORS.ink }}
    >
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <h1
            className="text-3xl leading-tight"
            style={{ fontFamily: 'Georgia, serif', color: COLORS.ink }}
          >
            Find it in stock
          </h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: COLORS.quiet }}>
            Pick a fragrance you want. The matcher compares its accords and note
            pyramid against everything on the shelf and shows why each suggestion
            lands where it does. Sample data — swap in your own before launch.
          </p>
        </header>

        <label className="mb-2 block text-sm" style={{ color: COLORS.quiet }}>
          Fragrance you're looking for
        </label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="mb-8 w-full rounded-md px-4 py-3 text-base"
          style={{
            backgroundColor: COLORS.panel,
            color: COLORS.ink,
            border: `1px solid ${COLORS.panelEdge}`,
          }}
        >
          {SAMPLE_CATALOGUE.map((perfume) => (
            <option key={perfume.id} value={perfume.id}>
              {perfume.brand} {perfume.name}
              {perfume.inStock ? ' (in stock)' : ''}
            </option>
          ))}
        </select>

        <section
          className="mb-8 rounded-lg p-5"
          style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelEdge}` }}
        >
          <h2 className="text-xl" style={{ fontFamily: 'Georgia, serif' }}>
            {target.brand} {target.name}
          </h2>
          <div className="mt-4 space-y-2">
            {['top', 'heart', 'base'].map((layer) => (
              <div key={layer} className="flex flex-wrap items-baseline gap-2">
                <span className="w-20 shrink-0 text-sm" style={{ color: COLORS[layer] }}>
                  {LAYER_LABEL[layer]}
                </span>
                <span className="text-sm" style={{ color: COLORS.ink }}>
                  {titleCase((target.notes[layer] || []).join(', '))}
                </span>
              </div>
            ))}
          </div>
        </section>

        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-xl" style={{ fontFamily: 'Georgia, serif' }}>
            {matches.length ? 'On the shelf' : 'Nothing close yet'}
          </h2>
          <button
            onClick={() => setShowDetail((v) => !v)}
            className="rounded px-2 py-1 text-sm underline"
            style={{ color: COLORS.quiet }}
          >
            {showDetail ? 'Hide scores' : 'Show scores'}
          </button>
        </div>

        {matches.length ? (
          <div className="space-y-4">
            {matches.map((match) => (
              <MatchCard key={match.perfume.id} match={match} showDetail={showDetail} />
            ))}
          </div>
        ) : (
          <p
            className="rounded-lg p-5 text-sm leading-relaxed"
            style={{
              backgroundColor: COLORS.panel,
              border: `1px solid ${COLORS.panelEdge}`,
              color: COLORS.quiet,
            }}
          >
            Nothing in stock is close enough to suggest honestly. Message us and
            we'll source it, or tell us what you liked about it and we'll pick by hand.
          </p>
        )}

        <p className="mt-8 text-sm leading-relaxed" style={{ color: COLORS.quiet }}>
          Bar width shows how strong the match is. The segments show where it
          came from — <span style={{ color: COLORS.base }}>drydown</span>,{' '}
          <span style={{ color: COLORS.heart }}>heart</span>,{' '}
          <span style={{ color: COLORS.top }}>opening</span>. A match built on
          drydown is the one that will still smell right four hours in.
        </p>
      </div>
    </div>
  );
}
