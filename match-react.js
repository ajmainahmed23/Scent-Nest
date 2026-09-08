(function (global) {
  "use strict";

  const { createElement: h, useState } = global.React;
  const { createRoot } = global.ReactDOM;
  const times = {
    regular: ["day", "night", "office", "casual"],
    office: ["day", "office", "casual"],
    party: ["night", "evening", "party"],
    night: ["night", "evening", "party"],
    casual: ["day", "casual", "office"],
  };

  function targetFrom(query, preference) {
    const tokens = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const topWords = ["citrus", "bergamot", "grapefruit", "lemon", "orange", "pepper", "mint", "apple", "marine", "fresh", "green", "lavender", "saffron", "cinnamon", "nutmeg", "ginger", "pineapple"];
    const middleWords = ["woody", "amber", "vanilla", "sweet", "spicy", "floral", "jasmine", "iris", "tobacco", "dates", "praline", "coffee", "tea", "patchouli", "oud"];
    const baseWords = ["musk", "cedar", "sandalwood", "vetiver", "tonka", "labdanum", "resin", "smoky", "woody", "vanilla", "oud", "patchouli"];
    const notes = { top: [], middle: [], base: [] };
    tokens.forEach((word) => {
      const layer = topWords.includes(word) ? "top" : middleWords.includes(word) ? "middle" : "base";
      notes[layer].push(word);
    });
    return {
      name: query,
      brand: "Your preference",
      gender: "unisex",
      notes,
      accords: [...new Set(tokens)].slice(0, 5),
      season: [],
      timeOfDay: times[preference] || times.regular,
    };
  }

  function stock() {
    return (global.SHEET_PRODUCTS || []).map((p) => ({
      ...p,
      notes: { top: p.top || [], middle: p.mid || [], base: p.base || [] },
      accords: [...(p.top || []), ...(p.mid || []), ...(p.base || [])],
      timeOfDay: /amber|vanilla|tobacco|oud|smoky|spicy/i.test(`${p.name} ${p.notes}`)
        ? ["night", "evening", "party"]
        : ["day", "office", "casual"],
    }));
  }

  function Results({ results }) {
    if (!results.length) return h("div", { className: "match-empty" }, "No close match found. Try fresh citrus, woody, spicy, or sweet vanilla.");
    return results.map((result) => h("article", { className: "match-card", key: result.id || result.name },
      h("img", { src: result.image, alt: result.name }),
      h("div", { className: "match-card-body" },
        h("div", { className: "match-card-head" }, h("span", null, result.brand), h("strong", null, `${result.match}%`)),
        h("h3", null, result.name),
        h("p", null, result.reason)
      )
    ));
  }

  function Finder() {
    const [query, setQuery] = useState("");
    const [preference, setPreference] = useState("regular");
    const [results, setResults] = useState(null);
    const search = () => {
      const found = query.trim() && global.ScentMatch
        ? global.ScentMatch.recommend(targetFrom(query.trim(), preference), stock(), { limit: 3, minMatch: 15 })
        : [];
      setResults(found.map((result) => ({ ...result, image: global.SHEET_PRODUCTS.find((p) => p.name === result.name && p.brand === result.brand)?.image || "all_perfume_photos_HD/Hawas_Ice.jpg" })));
    };
    return h("div", { className: "match-layout rise" },
      h("div", { className: "match-panel" },
        h("label", { htmlFor: "reactMatchInput" }, "Describe the fragrance you want"),
        h("textarea", { id: "reactMatchInput", rows: 4, value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Try: fresh citrus, woody, amber or sweet vanilla tobacco" }),
        h("div", { className: "match-preferences" },
          h("label", { htmlFor: "reactMatchPreference" }, "When do you wear it?"),
          h("select", { id: "reactMatchPreference", value: preference, onChange: (e) => setPreference(e.target.value) },
            h("option", { value: "regular" }, "Regular wear"), h("option", { value: "office" }, "Office / daily"), h("option", { value: "party" }, "Party / evening"), h("option", { value: "night" }, "Night / date night"), h("option", { value: "casual" }, "Casual / relaxed")
          )
        ),
        h("div", { className: "match-actions" },
          h("button", { className: "btn btn-gold", type: "button", onClick: search }, "Find similar scents"),
          h("button", { className: "btn btn-ghost", type: "button", onClick: () => { setQuery(""); setPreference("regular"); setResults(null); } }, "Clear")
        ),
        h("p", { className: "match-hint" }, "We compare your notes and wear preference against the house catalog and suggest the closest decants in stock.")
      ),
      h("div", { className: "match-results" }, results === null ? h("div", { className: "match-empty" }, "Example: fresh citrus, woody, amber or vanilla tobacco") : h(Results, { results }))
    );
  }

  const mount = document.getElementById("match-react-root");
  if (mount) createRoot(mount).render(h(Finder));
})(window);
