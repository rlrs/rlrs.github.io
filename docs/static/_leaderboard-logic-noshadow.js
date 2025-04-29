// Leaderboard script – rebuilds header row from scratch (no duplicates)
// Removes the legacy <select id="sort-by"> entirely and ensures rendering
// -------------------------------------------------------------------------
export function bootstrapLeaderboard(root) {
  /* --------------------------------------------------------------
     State: column & order for sorting (default: Average asc)
  -------------------------------------------------------------- */
  let currentSort = { column: "average", order: "asc" };

  /* --------------------------------------------------------------
     Load the JSON data
  -------------------------------------------------------------- */
  d3.json("static/data/leaderboard.json")
    .then((data) => {
      /* ----------------------------------------------------------
         Grab DOM elements we need
      ---------------------------------------------------------- */
      const table               = root.getElementById("leaderboard-table");
      const headerRow           = table.querySelector("thead tr"); // we'll rebuild this
      const tbody               = table.querySelector("tbody");

      const showTopNSelect      = root.getElementById("show-top-n");
      const datasetFilters      = root.getElementById("dataset-filters");
      const selectAllCheckbox   = root.getElementById("select-all-datasets");
      const noResultsMessage    = root.getElementById("no-results");
      const colorMidpointSlider = root.getElementById("color-gradient-midpoint");
      const colorAverageCheckbox  = root.getElementById("color-average");
      const colorDatasetsCheckbox = root.getElementById("color-datasets");

      /* ----------------------------------------------------------
         Parse datasets & parameter sizes from the JSON
      ---------------------------------------------------------- */
      const datasets = new Set();
      const paramSizes = [];
      data.forEach((row) => {
        paramSizes.push(+row.parameters);
        Object.keys(row).forEach((k) => {
          if (!["model", "parameters", "average"].includes(k)) datasets.add(k);
        });
      });
      const sortedDatasets = Array.from(datasets).sort();

      /* ----------------------------------------------------------
         Build / update parameter range slider
      ---------------------------------------------------------- */
      const paramMin = Math.floor(Math.min(...paramSizes));
      const paramMax = Math.ceil(Math.max(...paramSizes));

      const parameterRange = root.getElementById("parameter-range");
      root.getElementById("param-min-value").textContent = paramMin;
      root.getElementById("param-max-value").textContent = paramMax;

      noUiSlider.create(parameterRange, {
        start: [paramMin, paramMax],
        connect: true,
        range: { min: paramMin, max: paramMax },
      });
      parameterRange.noUiSlider.on("update", () => updateTable());

      /* ----------------------------------------------------------
         Create dataset filter checkboxes (left panel)
      ---------------------------------------------------------- */
      sortedDatasets.forEach((ds) => {
        const div = document.createElement("div");
        div.className = "form-check me-3 mb-2";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "form-check-input dataset-checkbox";
        cb.id = `dataset-${ds.replace(/\./g, "-")}`;
        cb.value = ds;
        cb.checked = true;
        cb.addEventListener("change", () => {
          updateSelectAllCheckbox();
          updateTable();
        });

        const label = document.createElement("label");
        label.className = "form-check-label";
        label.htmlFor = cb.id;
        label.textContent = formatDatasetName(ds);

        div.append(cb, label);
        datasetFilters.appendChild(div);
      });

      /* ----------------------------------------------------------
         Build the table header row from scratch each run
      ---------------------------------------------------------- */
      buildHeaderRow();

      function buildHeaderRow() {
        headerRow.innerHTML = ""; // clear any existing headers

        // Helper to create a <th>
        const makeTh = (text, key, isDataset = false) => {
          const th = document.createElement("th");
          th.textContent = text;

          if (key) {
            if (isDataset) th.dataset.dataset = key;
            else th.dataset.column = key;
            th.classList.add("sortable");
            th.style.cursor = "pointer";
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
          return th;
        };

        makeTh("Model");
        makeTh("Parameters", "parameters");
        sortedDatasets.forEach((ds) => makeTh(formatDatasetName(ds), ds, true));
        makeTh("Average", "average");

        updateSortIndicators();
      }

      /* ----------------------------------------------------------
         Select‑all checkbox helper
      ---------------------------------------------------------- */
      selectAllCheckbox.addEventListener("change", function () {
        const checked = this.checked;
        root.querySelectorAll(".dataset-checkbox").forEach((cb) => (cb.checked = checked));
        updateTable();
      });
      function updateSelectAllCheckbox() {
        const boxes = root.querySelectorAll(".dataset-checkbox");
        const checked = root.querySelectorAll(".dataset-checkbox:checked");
        selectAllCheckbox.checked = boxes.length === checked.length;
        selectAllCheckbox.indeterminate = checked.length && checked.length < boxes.length;
      }

      /* ----------------------------------------------------------
         Table update: filter → sort → render
      ---------------------------------------------------------- */
      function updateTable() {
        tbody.innerHTML = "";

        const [pMin, pMax] = parameterRange.noUiSlider.get().map(Number);
        const selectedDs = Array.from(root.querySelectorAll(".dataset-checkbox:checked")).map((c) => c.value);

        // --- filter & compute visibleAverage -------------------
        let rows = data
          .filter((r) => +r.parameters >= pMin && +r.parameters <= pMax)
          .map((r) => {
            const vals = selectedDs.filter((ds) => r[ds] !== undefined).map((ds) => r[ds]);
            return { ...r, visibleAverage: vals.length ? d3.mean(vals) : r.average || 0 };
          });

        // --- sort ---------------------------------------------
        const dir = currentSort.order === "asc" ? 1 : -1;
        rows.sort((a, b) => {
          const col = currentSort.column;
          if (col === "parameters") return dir * (+a.parameters - +b.parameters);
          if (col === "average") return dir * (a.visibleAverage - b.visibleAverage);
          const av = a[col] !== undefined ? a[col] : Infinity;
          const bv = b[col] !== undefined ? b[col] : Infinity;
          return dir * (av - bv);
        });

        // if (showTopNSelect.value !== "all") rows = rows.slice(0, +showTopNSelect.value);

        // --- toggle header visibility for non‑selected datasets
        headerRow.querySelectorAll("th[data-dataset]").forEach((th) => {
          th.style.display = selectedDs.includes(th.dataset.dataset) ? "" : "none";
        });

        // --- color scales --------------------------------------
        const midpoint = 0.2;
        const colorAvg = colorAverageCheckbox.checked;
        const colorDs  = colorDatasetsCheckbox.checked;

        const dsScales = {};
        selectedDs.forEach((ds) => {
          const vals = rows.flatMap((r) => (r[ds] !== undefined ? [r[ds]] : []));
          if (!vals.length) return;
          const min = d3.min(vals);
          const max = d3.max(vals);
          const mid = min + (max - min) * midpoint;
          dsScales[ds] = d3.scaleLinear().domain([min, mid, max]).range(["#63be7b", "#ffffff", "#f8696b"]);
        });

        const avgVals = rows.map((r) => r.visibleAverage);
        const avgScale = d3
          .scaleLinear()
          .domain([
            d3.min(avgVals) || 0,
            (d3.min(avgVals) || 0) + (d3.max(avgVals) - (d3.min(avgVals) || 0)) * midpoint,
            d3.max(avgVals) || 1,
          ])
          .range(["#63be7b", "#ffffff", "#f8696b"]);

        // --- render or show no‑results -------------------------
        if (!rows.length) {
          noResultsMessage.classList.remove("d-none");
          table.classList.add("d-none");
          return;
        }
        noResultsMessage.classList.add("d-none");
        table.classList.remove("d-none");

        rows.forEach((row) => {
          const tr = document.createElement("tr");

          // Model ------------------------------------------------
          const tdModel = document.createElement("td");
          tdModel.textContent = row.model;
          tr.appendChild(tdModel);

          // Parameters -------------------------------------------
          const tdParam = document.createElement("td");
          tdParam.textContent = (+row.parameters).toFixed(1);
          tdParam.style.background = "#fffdd0";
          tr.appendChild(tdParam);

          // Dataset cells ----------------------------------------
          sortedDatasets.forEach((ds) => {
            const td = document.createElement("td");
            if (row[ds] !== undefined) {
              td.textContent = row[ds].toFixed(2);
              if (colorDs && dsScales[ds]) {
                const bg = dsScales[ds](row[ds]);
                td.style.background = bg;
                td.style.color = d3.hsl(bg).l < 0.5 ? "#fff" : "#000";
              }
            } else {
              td.textContent = "N/A";
              td.style.background = "#ddd";
              td.style.color = "#f2f2f2";
            }
            td.style.display = selectedDs.includes(ds) ? "" : "none";
            tr.appendChild(td);
          });

          // Average ---------------------------------------------
          const tdAvg = document.createElement("td");
          tdAvg.textContent = row.visibleAverage.toFixed(2);
          if (colorAvg) {
            const bg = avgScale(row.visibleAverage);
            tdAvg.style.background = bg;
            tdAvg.style.color = d3.hsl(bg).l < 0.5 ? "#fff" : "#000";
          }
          tr.appendChild(tdAvg);

          tbody.appendChild(tr);
        });
      }

      /* ----------------------------------------------------------
         Sort arrow indicators
      ---------------------------------------------------------- */
      function updateSortIndicators() {
        headerRow.querySelectorAll("th.sortable").forEach((th) => {
          th.classList.remove("sort-asc", "sort-desc");
          const key = th.dataset.column || th.dataset.dataset;
          if (key === currentSort.column) th.classList.add(currentSort.order === "asc" ? "sort-asc" : "sort-desc");
        });
      }

      /* ----------------------------------------------------------
         Utility: prettify dataset names
      ---------------------------------------------------------- */
      function formatDatasetName(name) {
        return name
          .replace(/\.json$/, "")
          .replace(/[-_]/g, " ")
          .replace(/^(\w)|\s(\w)/g, (m) => m.toUpperCase());
      }

      /* ----------------------------------------------------------
         Kick things off!
      ---------------------------------------------------------- */
      updateTable();
    })
    .catch((err) => {
      console.error("Error loading leaderboard data:", err);
      root.querySelector(".leaderboard-container").innerHTML =
        '<div class="alert alert-danger">Error loading leaderboard data. Please try again later.</div>';
    });
}

/* -------------------------------------------------------------------------
CSS (include in stylesheet)

th.sortable { position: relative; }
th.sortable::after {
  content: "";
  border: 5px solid transparent;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
}
th.sortable.sort-asc::after  { border-bottom-color: currentColor; }
th.sortable.sort-desc::after { border-top-color: currentColor; }
------------------------------------------------------------------------- */
