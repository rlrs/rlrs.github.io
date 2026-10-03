// LeaderboardWidget – sortable, filterable results table; colours come from the site's CSS tokens
class LeaderboardWidget extends HTMLElement {
    async connectedCallback () {
      /* ----------------- HTML skeleton ----------------- */
      this.innerHTML = `
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.css" />
      <style>
        /* nouislider, restyled with the site's colour tokens (theme/site.css) */
        leaderboard-widget .noUi-target{background:var(--line);border:none;border-radius:9999px;height:4px;box-shadow:none}
        leaderboard-widget .noUi-connect{background:var(--accent)}
        leaderboard-widget .noUi-horizontal .noUi-handle{height:16px;width:16px;top:-6px;right:-8px;border-radius:9999px;border:2px solid var(--accent);background:var(--surface);box-shadow:none;cursor:grab}
        leaderboard-widget .noUi-handle:after,leaderboard-widget .noUi-handle:before{display:none}
        leaderboard-widget .noUi-handle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        leaderboard-widget .noUi-horizontal .noUi-tooltip{bottom:auto;top:-30px;border:none;border-radius:6px;background:var(--ink);color:var(--paper);font-size:.75rem;font-weight:500;padding:1px 6px;font-variant-numeric:tabular-nums}
        leaderboard-widget input[type=range]{accent-color:var(--accent)}
      </style>
      <div class="text-ink-soft">
        <!-- Controls -->
        <div class="mb-5 flex flex-wrap items-end gap-x-10 gap-y-6 rounded-xl border border-line bg-surface px-5 pt-4 pb-5">
          <div class="grow basis-72">
            <label class="block text-sm font-medium text-ink">Model size <span class="font-normal text-muted">(billion parameters)</span></label>
            <div class="px-2 pt-10"><div id="parameter-range"></div></div>
          </div>
          <div class="basis-52 grow sm:grow-0">
            <label for="color-gradient-midpoint" class="block text-sm font-medium text-ink">Colour midpoint</label>
            <input type="range" id="color-gradient-midpoint" min="0.1" max="0.9" step="0.05" value="0.2" class="mt-4 w-full cursor-pointer" />
          </div>
        </div>

        <!-- Table -->
        <div class="overflow-auto max-h-[80vh] rounded-xl border border-line bg-surface">
          <table id="leaderboard-table" class="min-w-full text-sm border-separate border-spacing-0">
            <thead><tr></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-muted">Click a column header to sort. Darker cells compress better within that column; compare models within a column, not across columns.</p>

        <!-- Empty state -->
        <div id="no-results" class="hidden rounded-xl border border-dashed border-line p-8 text-center text-muted">
          No models in this size range.
        </div>
      </div>
      `;

      /* ----------------- Load libraries ----------------- */
      await import("https://cdn.jsdelivr.net/npm/d3@7");
      await import("https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.js");
  
      /* ----------------- Component state ----------------- */
      let currentSort = { column: "average", order: "asc" };
  
      /* ----------------- DOM refs ----------------- */
      const table               = this.querySelector("#leaderboard-table");
      const headerRow           = table.querySelector("thead tr");
      const tbody               = table.querySelector("tbody");
      const noResultsMessage    = this.querySelector("#no-results");
      const colorMidpointSlider = this.querySelector("#color-gradient-midpoint");
      const parameterRange      = this.querySelector("#parameter-range");
  
      /* ----------------- Helpers ----------------- */
      // sequential single-hue scale (colour-blind safe), defined in theme/site.css
      const token  = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const GOOD   = () => token("--lb-good");
      const MID    = () => token("--lb-mid");
      const BAD    = () => token("--surface");

      /* ----------------- Load data ----------------- */
      d3.json("/static/data/leaderboard.json").then((data) => {
        const datasets = new Set();
        const paramSizes = [];
        data.forEach((row) => {
          paramSizes.push(+row.parameters);
          Object.keys(row).forEach((k) => {
            if (!["model", "parameters", "average"].includes(k)) datasets.add(k);
          });
        });
        const sortedDatasets = Array.from(datasets).sort();
  
        /* Range slider */
        const pMin = Math.floor(Math.min(...paramSizes));
        const pMax = Math.ceil(Math.max(...paramSizes));
  
        noUiSlider.create(parameterRange, {
          start: [pMin, pMax],
          connect: true,
          // most models are small: give the first 30B more than half of the track
          range: pMax > 100 ? { min: pMin, "55%": 30, "80%": 100, max: pMax } : { min: pMin, max: pMax },
          step: 0.1,
          margin: 0.1,
          tooltips: [true, true],
          format: {
            to: (value) => (+value).toFixed(1),
            from: (value) => (+value),
          },
        });
  
        /* Build header */
        buildHeader();
  
        /* Listeners */
        parameterRange.noUiSlider.on("update", updateTable);
        colorMidpointSlider.addEventListener("input", updateTable);
        const darkObserver = new MutationObserver(updateTable);
        darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  
        /* Initial render */
        updateTable();
  
        /* ===== functions ===== */
        function buildHeader() {
          headerRow.innerHTML = "";
          const makeTH = (label, key, isDataset = false) => {
            const th = document.createElement("th");
            th.textContent = label;
            th.className = "sticky top-0 z-20 bg-surface border-b border-line px-3 pt-3 pb-2 align-bottom text-xs font-medium text-muted text-right whitespace-normal min-w-[5.5rem] select-none";
            if (key) {
              if (isDataset) th.dataset.dataset = key; else th.dataset.column = key;
              th.classList.add("cursor-pointer", "hover:text-ink", "transition-colors");
              th.addEventListener("click", () => {
                if (currentSort.column === key) {
                  currentSort.order = currentSort.order === "asc" ? "desc" : "asc";
                } else {
                  currentSort = { column: key, order: "asc" };
                }
                updateSortIndicators();
                updateTable();
              });
            }
            headerRow.appendChild(th);
          };
          makeTH("Model");
          // model column stays put when the table scrolls sideways
          headerRow.lastChild.classList.add("left-0", "z-30", "text-left", "min-w-0");
          headerRow.lastChild.classList.remove("text-right");
          makeTH("Params (B)", "parameters");
          sortedDatasets.forEach((ds) => makeTH(formatDatasetName(ds), ds, true));
          makeTH("Average", "average");
          headerRow.lastChild.classList.add("border-l");
          updateSortIndicators();
        }
  
        function updateSortIndicators() {
          headerRow.querySelectorAll("th[data-column], th[data-dataset]").forEach((th) => {
            th.querySelector(".sort-icon")?.remove();
          });
          const key = currentSort.column;
          const th = headerRow.querySelector(`[data-column='${key}'], [data-dataset='${key}']`);
          if (!th) return;
          const icon = document.createElement("span");
          icon.className = "sort-icon ml-1 text-accent";
          icon.textContent = currentSort.order === "asc" ? "↑" : "↓";
          th.classList.add("text-ink");
          headerRow.querySelectorAll("th").forEach((o) => o !== th && o.classList.remove("text-ink"));
          th.appendChild(icon);
        }
  
        function updateTable() {
          tbody.innerHTML = "";
          const [pLo, pHi] = parameterRange.noUiSlider.get().map(Number);
          const midpoint = +colorMidpointSlider.value;
  
          let rows = data
            .filter((r) => +r.parameters >= pLo && +r.parameters <= pHi)
            .map((r) => {
              const vals = sortedDatasets.filter((ds) => r[ds] !== undefined).map((ds) => r[ds]);
              return { ...r, visibleAverage: vals.length ? d3.mean(vals) : r.average ?? 0 };
            });
  
          const dir = currentSort.order === "asc" ? 1 : -1;
          rows.sort((a, b) => {
            const col = currentSort.column;
            if (col === "parameters") return dir * (+a.parameters - +b.parameters);
            if (col === "average") return dir * (a.visibleAverage - b.visibleAverage);
            const av = a[col] ?? Infinity;
            const bv = b[col] ?? Infinity;
            return dir * (av - bv);
          });
  
          const dsScales = {};
          sortedDatasets.forEach((ds) => {
            const vals = rows.flatMap((r) => (r[ds] !== undefined ? [r[ds]] : []));
            if (!vals.length) return;
            const min = d3.min(vals);
            const max = d3.max(vals);
            const mid = min + (max - min) * midpoint;
            dsScales[ds] = d3.scaleLinear().domain([min, mid, max]).range([GOOD(), MID(), BAD()]);
          });
  
          const avgVals = rows.map((r) => r.visibleAverage);
          const avgScale = d3.scaleLinear()
            .domain([
              d3.min(avgVals) ?? 0,
              (d3.min(avgVals) ?? 0) + (d3.max(avgVals) - (d3.min(avgVals) ?? 0)) * midpoint,
              d3.max(avgVals) ?? 1,
            ])
            .range([GOOD(), MID(), BAD()]);
  
          if (!rows.length) {
            noResultsMessage.classList.remove("hidden");
            table.classList.add("hidden");
            return;
          }
          noResultsMessage.classList.add("hidden");
          table.classList.remove("hidden");
  
          rows.forEach((row, idx) => {
            const tr = document.createElement("tr");
            tr.className = "group";
  
            const cell = (txt) => {
              const td = document.createElement("td");
              td.textContent = txt;
              td.className = "px-3 py-2 border-b border-line text-right tabular-nums";
              return td;
            };
  
            // model
            const modelTd = cell(row.model);
            modelTd.classList.remove("text-right", "tabular-nums");
            // narrow screens: wrap long names so the numbers stay in view
            modelTd.classList.add("text-left", "font-medium", "text-ink", "min-w-[8.5rem]", "max-w-[8.5rem]", "sm:max-w-none", "wrap-anywhere", "sm:wrap-normal", "sm:whitespace-nowrap", "sticky", "left-0", "z-10", "bg-surface");
            tr.appendChild(modelTd);
  
            // params
            const paramTd = cell((+row.parameters).toFixed(1));
            paramTd.classList.add("text-muted");
            tr.appendChild(paramTd);
  
            // datasets
            sortedDatasets.forEach((ds) => {
              const td = cell("–");
              if (row[ds] !== undefined) {
                td.textContent = row[ds].toFixed(2);
                td.style.background = dsScales[ds] ? dsScales[ds](row[ds]) : "";
              } else {
                td.classList.add("text-muted");
              }
              tr.appendChild(td);
            });
  
            // average
            const avgTd = cell(row.visibleAverage.toFixed(2));
            avgTd.style.background = avgScale(row.visibleAverage);
            avgTd.classList.add("font-semibold", "text-ink", "border-l");
            tr.appendChild(avgTd);
  
            tbody.appendChild(tr);
          });
        }
  
        function formatDatasetName(name) {
          return name.replace(/\.json$/, "").replace(/[-_]/g, " ").replace(/^(\w)|\s(\w)/g, (m) => m.toUpperCase());
        }
      }).catch((err) => {
        console.error("Leaderboard load error", err);
        this.innerHTML = `<div class="rounded-xl border border-line p-6 text-muted">Couldn't load the leaderboard data. Please try again later.</div>`;
      });
    }
  }
  
  customElements.define("leaderboard-widget", LeaderboardWidget);
  