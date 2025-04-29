// LeaderboardWidget – simplified controls & proper sort arrows, dark‑mode aware with Tailwind
class LeaderboardWidget extends HTMLElement {
    async connectedCallback () {
      /* ----------------- HTML skeleton ----------------- */
      this.innerHTML = `
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.css" />
      <style>
        /* -------- nouislider track & connect bar -------- */
        .noUi-target{background:#e5e7eb;border:none;border-radius:9999px;height:6px}
        .noUi-connect{background:#3b82f6;border-radius:9999px}
        /* -------- make the circle handle invisible -------- */
        .noUi-handle{height:0;width:0;border:none;background:transparent;top:0;cursor:pointer;box-shadow:none}
        .noUi-handle:after,.noUi-handle:before{display:none}
        /* -------- tooltip becomes the visible drag element, placed above -------- */
        .noUi-tooltip{position:absolute;top:-36px;bottom:auto;background:#3b82f6;color:#fff;font-size:0.75rem;font-weight:500;padding:2px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 4px rgba(0,0,0,0.08)}
        .noUi-tooltip::after{content:"";position:absolute;left:50%;bottom:-4px;transform:translateX(-50%);border-width:4px;border-style:solid;border-color:#3b82f6 transparent transparent transparent}
        .noUi-horizontal .noUi-tooltip{transform:translate(-50%,100%);}
        /* -------- dark mode variants -------- */
        .dark .noUi-target{background:#374151}
        .dark .noUi-connect{background:#2563eb}
        .dark .noUi-tooltip{background:#2563eb;color:#e0e7ff}
        .dark .noUi-tooltip::after{border-color:#2563eb transparent transparent transparent}
      </style>
      <div class="leaderboard-container mx-auto max-w-6xl text-gray-900 dark:text-gray-200">
        <p class="text-lg mb-4">Model compression performance across different datasets. <span class="font-medium">Lower is better.</span></p>

        <!-- Controls row -->
        <div class="filter-controls bg-gray-100 dark:bg-gray-800 rounded-lg p-6 mb-6">
          <div class="flex flex-wrap items-end gap-8">
            <!-- Parameter range (takes most width) -->
            <div class="grow basis-0 min-w-[280px]">
              <label for="parameter-range" class="block mb-2 text-sm font-medium">Parameter Size Range (Billions)</label>
              <div class="flex items-center gap-2">
                <span id="param-min-value" class="text-center w-12">0</span>
                <div class="grow"><div id="parameter-range"></div></div>
                <span id="param-max-value" class="text-center w-12">25</span>
              </div>
            </div>
            <!-- Color midpoint (compact) -->
            <div class="basis-56">
              <label for="color-gradient-midpoint" class="block mb-2 text-sm font-medium">Color Midpoint</label>
              <input type="range" id="color-gradient-midpoint" min="0.1" max="0.9" step="0.05" value="0.5" class="w-full h-2 rounded-lg bg-gray-200 appearance-none cursor-pointer dark:bg-gray-700" />
            </div>
          </div>
        </div>

        <!-- Table -->
        <div class="overflow-x-auto max-h-[85vh]">
          <table id="leaderboard-table" class="min-w-full text-sm">
            <thead><tr></tr></thead>
            <tbody></tbody>
          </table>
        </div>

        <!-- Empty state -->
        <div id="no-results" class="hidden text-center p-8 bg-blue-50 text-blue-600 dark:bg-blue-900 dark:text-blue-100 rounded-lg">
          No models match the selected filters.
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
      const isDark = () => document.documentElement.classList.contains("dark");
      const GOOD   = () => (isDark() ? "#4ade80" : "#63be7b");
      const BAD    = () => (isDark() ? "#f87171" : "#f8696b");
      const NEUTRAL= () => (isDark() ? "#374151" : "#ffffff");
  
      /* ----------------- Load data ----------------- */
      d3.json("static/data/leaderboard.json").then((data) => {
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
        this.querySelector("#param-min-value").textContent = pMin;
        this.querySelector("#param-max-value").textContent = pMax;
  
        noUiSlider.create(parameterRange, {
          start: [pMin, pMax],
          connect: true,
          range: { min: pMin, max: pMax },
          step: 0.1,
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
            th.className = "px-3 py-2 border-t border-gray-200 dark:border-gray-600 font-medium text-center sticky top-0 z-20 bg-white dark:bg-gray-700 select-none";
            if (key) {
              if (isDataset) th.dataset.dataset = key; else th.dataset.column = key;
              th.classList.add("cursor-pointer", "group", "relative");
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
          makeTH("Params (B)", "parameters");
          sortedDatasets.forEach((ds) => makeTH(formatDatasetName(ds), ds, true));
          makeTH("Average", "average");
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
          icon.className = "sort-icon absolute right-1.5 top-1/2 -translate-y-1/2 text-xs select-none";
          icon.textContent = currentSort.order === "asc" ? "▲" : "▼";
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
            dsScales[ds] = d3.scaleLinear().domain([min, mid, max]).range([GOOD(), NEUTRAL(), BAD()]);
          });
  
          const avgVals = rows.map((r) => r.visibleAverage);
          const avgScale = d3.scaleLinear()
            .domain([
              d3.min(avgVals) ?? 0,
              (d3.min(avgVals) ?? 0) + (d3.max(avgVals) - (d3.min(avgVals) ?? 0)) * midpoint,
              d3.max(avgVals) ?? 1,
            ])
            .range([GOOD(), NEUTRAL(), BAD()]);
  
          if (!rows.length) {
            noResultsMessage.classList.remove("hidden");
            table.classList.add("hidden");
            return;
          }
          noResultsMessage.classList.add("hidden");
          table.classList.remove("hidden");
  
          rows.forEach((row, idx) => {
            const tr = document.createElement("tr");
            tr.className = idx % 2 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-700";
  
            const cell = (txt) => {
              const td = document.createElement("td");
              td.textContent = txt;
              td.className = "px-3 py-2 border-t border-gray-200 dark:border-gray-600 text-center";
              return td;
            };
  
            // model
            const modelTd = cell(row.model);
            modelTd.classList.add("text-left", "font-medium", "whitespace-nowrap");
            tr.appendChild(modelTd);
  
            // params
            const paramTd = cell((+row.parameters).toFixed(1));
            paramTd.style.background = isDark() ? "#92400e" : "#fffdd0";
            paramTd.style.color = isDark() ? "#fff" : "#2d2d2d";
            tr.appendChild(paramTd);
  
            // datasets
            sortedDatasets.forEach((ds) => {
              const td = cell("N/A");
              if (row[ds] !== undefined) {
                td.textContent = row[ds].toFixed(2);
                const bg = dsScales[ds] ? dsScales[ds](row[ds]) : NEUTRAL();
                td.style.background = bg;
                td.style.color = d3.hsl(bg).l < 0.5 ? "#fff" : "#000";
              } else {
                td.classList.add("italic");
                td.style.background = isDark() ? "#4b5563" : "#e5e7eb";
              }
              tr.appendChild(td);
            });
  
            // average
            const avgTd = cell(row.visibleAverage.toFixed(2));
            const bg = avgScale(row.visibleAverage);
            avgTd.style.background = bg;
            avgTd.style.color = d3.hsl(bg).l < 0.5 ? "#fff" : "#000";
            avgTd.classList.add("font-semibold");
            tr.appendChild(avgTd);
  
            tbody.appendChild(tr);
          });
        }
  
        function formatDatasetName(name) {
          return name.replace(/\.json$/, "").replace(/[-_]/g, " ").replace(/^(\w)|\s(\w)/g, (m) => m.toUpperCase());
        }
      }).catch((err) => {
        console.error("Leaderboard load error", err);
        this.innerHTML = `<div class="p-6 bg-red-50 dark:bg-red-900 text-red-700 dark:text-red-100 rounded-lg">Error loading leaderboard data. Please try again later.</div>`;
      });
    }
  }
  
  customElements.define("leaderboard-widget", LeaderboardWidget);
  