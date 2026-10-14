// LeaderboardWidget – sortable, filterable results table. No dependencies; styles live in theme/site.css.
class LeaderboardWidget extends HTMLElement {
  async connectedCallback() {
    /* ----------------- HTML skeleton ----------------- */
    this.innerHTML = `
      <div class="lb">
        <div class="lb-controls">
          <div class="lb-control">
            <label id="lb-size-label">Model size <span>(billion parameters): <output></output></span></label>
            <div class="lb-range" role="group" aria-labelledby="lb-size-label">
              <div class="track"></div><div class="fill"></div>
              <input type="range" min="0" max="1000" value="0" aria-label="Smallest model size">
              <input type="range" min="0" max="1000" value="1000" aria-label="Largest model size">
            </div>
          </div>
          <div class="lb-control narrow">
            <label for="lb-midpoint">Colour midpoint</label>
            <input type="range" id="lb-midpoint" min="0.1" max="0.9" step="0.05" value="0.2">
          </div>
        </div>
        <div class="lb-scroll">
          <table class="lb-table"><thead><tr></tr></thead><tbody></tbody></table>
        </div>
        <p class="lb-note">Click a column header to sort. Darker cells compress better within that column; compare models within a column, not across columns.</p>
        <div class="lb-empty" hidden>No models in this size range.</div>
      </div>`;

    /* ----------------- Load data ----------------- */
    let data;
    try {
      const res = await fetch("/static/data/leaderboard.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.error("Leaderboard load error", err);
      this.innerHTML = `<div class="lb-empty">Couldn't load the leaderboard data. Please try again later.</div>`;
      return;
    }

    /* ----------------- DOM refs and state ----------------- */
    const headerRow = this.querySelector("thead tr");
    const tbody     = this.querySelector("tbody");
    const scroller  = this.querySelector(".lb-scroll");
    const empty     = this.querySelector(".lb-empty");
    const midpoint  = this.querySelector("#lb-midpoint");
    const [lo, hi]  = this.querySelectorAll(".lb-range input");
    const fill      = this.querySelector(".lb-range .fill");
    const sizeOut   = this.querySelector("output");
    let sort = { key: "average", dir: 1 };

    const datasets = [...new Set(data.flatMap((r) => Object.keys(r)))]
      .filter((k) => !["model", "parameters", "average"].includes(k))
      .sort();

    /* ----------------- Size slider ----------------- */
    // slider positions 0–1000 map piecewise-linearly onto parameter counts;
    // most models are small, so the first 30B get more than half of the track
    const sizes = data.map((r) => +r.parameters);
    const pMin = Math.floor(Math.min(...sizes));
    const pMax = Math.ceil(Math.max(...sizes));
    const knots = pMax > 100 ? [[0, pMin], [550, 30], [800, 100], [1000, pMax]] : [[0, pMin], [1000, pMax]];
    const sizeAt = (pos) => {
      for (let i = 1; i < knots.length; i++) {
        const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
        if (pos <= x1) return Math.round((y0 + (y1 - y0) * (pos - x0) / (x1 - x0)) * 10) / 10;
      }
      return pMax;
    };
    const onSize = (moved) => {
      // handles can't cross: the one being dragged stops at the other
      if (+lo.value > +hi.value) moved.value = moved === lo ? hi.value : lo.value;
      // when both sit at the right end, keep the lower handle on top so it can be dragged back
      lo.style.zIndex = +lo.value > 990 ? 2 : "";
      const a = lo.value / 1000, b = hi.value / 1000;
      fill.style.left = `calc(8px + (100% - 16px) * ${a})`;
      fill.style.width = `calc((100% - 16px) * ${b - a})`;
      sizeOut.textContent = `${sizeAt(+lo.value).toFixed(1)}–${sizeAt(+hi.value).toFixed(1)}`;
      render();
    };

    /* ----------------- Colours ----------------- */
    // sequential single-hue scale (colour-blind safe) from the CSS tokens in theme/site.css
    const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const rgb = (hex) => {
      const h = hex.replace("#", "");
      const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    };
    const mix = (c0, c1, t) => `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * t)).join(",")})`;
    // good (lowest) → mid (at the midpoint) → surface (highest)
    const scale = (vals) => {
      const min = Math.min(...vals), max = Math.max(...vals);
      const mid = min + (max - min) * +midpoint.value;
      const [good, middle, bad] = ["--lb-good", "--lb-mid", "--surface"].map((t) => rgb(token(t)));
      return (v) => {
        if (max === min) return mix(good, good, 0);
        return v <= mid ? mix(good, middle, (v - min) / (mid - min || 1)) : mix(middle, bad, (v - mid) / (max - mid || 1));
      };
    };

    /* ----------------- Table ----------------- */
    const label = (name) => name.replace(/\.json$/, "").replace(/[-_]/g, " ").replace(/(^|\s)\w/g, (m) => m.toUpperCase());

    const th = (text, key, cls = "") => {
      const el = document.createElement("th");
      el.textContent = text;
      if (cls) el.className = cls;
      if (key) {
        el.dataset.key = key;
        el.addEventListener("click", () => {
          sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 };
          render();
        });
      }
      headerRow.appendChild(el);
    };
    th("Model", null, "model");
    th("Params (B)", "parameters");
    datasets.forEach((ds) => th(label(ds), ds));
    th("Average", "average", "avg");

    const td = (text, cls = "", bg = "") => {
      const el = document.createElement("td");
      el.textContent = text;
      if (cls) el.className = cls;
      if (bg) el.style.background = bg;
      return el;
    };

    function render() {
      const sLo = sizeAt(+lo.value), sHi = sizeAt(+hi.value);
      const rows = data
        .filter((r) => +r.parameters >= sLo && +r.parameters <= sHi)
        .map((r) => {
          const vals = datasets.filter((ds) => r[ds] !== undefined).map((ds) => r[ds]);
          return { ...r, avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : r.average ?? 0 };
        });

      rows.sort((a, b) => {
        if (sort.key === "parameters") return sort.dir * (a.parameters - b.parameters);
        if (sort.key === "average") return sort.dir * (a.avg - b.avg);
        return sort.dir * ((a[sort.key] ?? Infinity) - (b[sort.key] ?? Infinity));
      });

      headerRow.querySelectorAll("th").forEach((el) => {
        el.querySelector(".arrow")?.remove();
        el.classList.toggle("sorted", el.dataset.key === sort.key);
        if (el.dataset.key === sort.key) el.insertAdjacentHTML("beforeend", `<span class="arrow">${sort.dir > 0 ? "↑" : "↓"}</span>`);
      });

      scroller.hidden = !rows.length;
      empty.hidden = !!rows.length;
      tbody.replaceChildren();
      if (!rows.length) return;

      const scales = {};
      datasets.forEach((ds) => {
        const vals = rows.flatMap((r) => (r[ds] !== undefined ? [r[ds]] : []));
        if (vals.length) scales[ds] = scale(vals);
      });
      const avgScale = scale(rows.map((r) => r.avg));

      rows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.append(td(r.model, "model"), td((+r.parameters).toFixed(1), "dim"));
        datasets.forEach((ds) => tr.append(r[ds] === undefined ? td("–", "dim") : td(r[ds].toFixed(2), "", scales[ds](r[ds]))));
        tr.append(td(r.avg.toFixed(2), "avg", avgScale(r.avg)));
        tbody.appendChild(tr);
      });
    }

    /* ----------------- Wire up ----------------- */
    lo.addEventListener("input", () => onSize(lo));
    hi.addEventListener("input", () => onSize(hi));
    midpoint.addEventListener("input", render);
    // recolour when the theme toggles
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onSize(hi);
  }
}

customElements.define("leaderboard-widget", LeaderboardWidget);
