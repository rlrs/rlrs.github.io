class LeaderboardWidget extends HTMLElement {
    async connectedCallback () {
      // 1. attach shadow tree
      const root = this.attachShadow({mode: 'open'});
  
      // 2. inject template (HTML + CSS + JS)
      root.innerHTML = `
        <link rel="stylesheet"
              href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
        <link rel="stylesheet"
              href="https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.css">
        <style>
        .leaderboard-container {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 2rem 0;
            max-width: 100%;
        }
        
        .filter-controls {
            background-color: #f8f9fa;
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
        }
        
        #parameter-range {
            height: 8px;
            margin: 0 10px;
        }
        
        .form-check-input:checked {
            background-color: #007bff;
            border-color: #007bff;
        }
        
        #leaderboard-table {
            width: 100%;
            max-width: 100%;
            margin-bottom: 1rem;
            background-color: transparent;
            border-collapse: collapse;
        }
        
        #leaderboard-table th,
        #leaderboard-table td {
            padding: 0.75rem;
            text-align: center;
            border-top: 1px solid #dee2e6;
        }
        
        #leaderboard-table thead th {
            vertical-align: bottom;
            border-bottom: 2px solid #dee2e6;
            position: sticky;
            top: 0;
            background-color: white;
            z-index: 2;
            font-weight: 600;
        }
        
        .table-responsive {
            display: block;
            width: 100%;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            -ms-overflow-style: -ms-autohiding-scrollbar;
            max-height: 90vh;
            overflow-y: auto;
        }
        
        #no-results {
            text-align: center;
            padding: 2rem;
        }
        
        .dataset-filters {
            max-height: 150px;
            overflow-y: auto;
        }
        
        th.sortable {
            position: relative;
        }

        th.sortable::after {
            content: "";
            border: 5px solid transparent;
            position: absolute;
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
        }

        th.sortable.sort-asc::after {
        border-bottom-color: currentColor;
        }

        th.sortable.sort-desc::after {
        border-top-color: currentColor;
        }
        </style>
  
        <div class="leaderboard-container mx-auto max-w-6xl dark:bg-gray-900 dark:text-gray-200">
            <p class="lead">Model compression performance across different datasets. Lower values are better.</p>
            
            <div class="filter-controls mb-4">
            <div class="row g-3">
                <div class="col-md-6">
                <label for="parameter-range" class="form-label">Parameter Size Range (Billions)</label>
                <div class="d-flex align-items-center">
                    <span id="param-min-value" class="pe-2">0</span>
                    <div class="flex-grow-1">
                    <div id="parameter-range"></div>
                    </div>
                    <span id="param-max-value" class="ps-2">25</span>
                </div>
                </div>
                <div class="col-md-3">
                <label for="color-gradient-midpoint" class="form-label">Color Midpoint</label>
                <input type="range" class="form-range" id="color-gradient-midpoint" min="0.1" max="0.9" step="0.05" value="0.5">
                </div>
                <div class="col-md-3">
                <div class="d-flex flex-column h-100">
                    <label class="form-label">Sort By</label>
                    <select id="sort-by" class="form-select">
                    <option value="average" selected>Average (Best First)</option>
                    <option value="parameters-asc">Parameters (Small → Large)</option>
                    <option value="parameters-desc">Parameters (Large → Small)</option>
                    <!-- Dynamic dataset options will be added via JS -->
                    </select>
                </div>
                </div>
            </div>
            <div class="row g-3 mt-2">
                <div class="col-md-6">
                <label class="form-label">Datasets</label>
                <div class="dataset-filters d-flex flex-wrap" id="dataset-filters">
                    <!-- Checkboxes will be added dynamically -->
                    <div class="form-check me-3 mb-2">
                    <input class="form-check-input" type="checkbox" id="select-all-datasets" checked>
                    <label class="form-check-label" for="select-all-datasets">
                        Select All
                    </label>
                    </div>
                </div>
                </div>
                <div class="col-md-3">
                <label class="form-label">Colored Columns</label>
                <div class="color-filters d-flex flex-wrap">
                    <div class="form-check me-3">
                    <input class="form-check-input" type="checkbox" id="color-average" checked>
                    <label class="form-check-label" for="color-average">
                        Average
                    </label>
                    </div>
                    <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="color-datasets" checked>
                    <label class="form-check-label" for="color-datasets">
                        Datasets
                    </label>
                    </div>
                </div>
                </div>
                <div class="col-md-3">
                <div class="d-flex flex-column h-100">
                    <label class="form-label">Display Count</label>
                    <select id="show-top-n" class="form-select">
                    <option value="all">All Models</option>
                    <option value="5">Top 5</option>
                    <option value="10" selected>Top 10</option>
                    <option value="20">Top 20</option>
                    </select>
                </div>
                </div>
            </div>
            </div>
            
            <div class="table-responsive">
            <table id="leaderboard-table" class="table table-hover">
                <thead>
                <tr>
                    <th>Model</th>
                    <th>Params (B)</th>
                    <!-- Dynamic headers will be added via JS -->
                    <th>Average</th>
                </tr>
                </thead>
                <tbody>
                <!-- Table content will be populated by JavaScript -->
                </tbody>
            </table>
            </div>
            
            <div id="no-results" class="alert alert-info d-none">
            No models match the selected filters.
            </div>
        </div>
      `;

      /* Load heavy libraries **after** shadow root exists */
      await import('https://cdn.jsdelivr.net/npm/d3@7');
      await import('https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.js');
      const { bootstrapLeaderboard } = await import('/static/leaderboard-logic.js');
      bootstrapLeaderboard(this.shadowRoot);
    }
  }
  customElements.define('leaderboard-widget', LeaderboardWidget);
  