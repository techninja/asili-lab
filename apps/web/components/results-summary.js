import { Chart } from '/deps/chart.js';
import { useAppStore } from '../lib/store.js';
import { useTraitStore } from '../lib/trait-store.js';
import { fetchChartData, invalidateCache } from '../lib/results-data.js';

const COLORS = [
  '#007acc',
  '#e74c3c',
  '#2ecc71',
  '#f39c12',
  '#9b59b6',
  '#1abc9c'
];
const COLORS_A = COLORS.map(c => c + '88');

export class ResultsSummary extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.chart = null;
    this.data = null;
    this.unsubApp = null;
    this.unsubTrait = null;
    this.lastIndividual = null;
    this.lastTraitCount = 0;
    this.collapsed = true;
  }

  connectedCallback() {
    this.render();
    this.shadowRoot
      .getElementById('toggle')
      .addEventListener('click', () => this.toggleCollapse());
    this.shadowRoot
      .getElementById('chartType')
      .addEventListener('change', () => this.drawChart());
    this.shadowRoot
      .getElementById('categorySelect')
      ?.addEventListener('change', () => this.drawChart());
    this.unsubApp = useAppStore.subscribe(state => {
      if (this.lastIndividual !== state.selectedIndividual) {
        this.lastIndividual = state.selectedIndividual;
        invalidateCache();
        this.refresh();
      }
    });
    this.unsubTrait = useTraitStore.subscribe(() => {
      const count = useTraitStore.getState().traits.size;
      if (count !== this.lastTraitCount) {
        this.lastTraitCount = count;
        invalidateCache();
        this.refresh();
      }
    });
    this.refresh();
  }

  disconnectedCallback() {
    this.unsubApp?.();
    this.unsubTrait?.();
    this.chart?.destroy();
  }

  setTraits() {} // no-op, data comes from API now

  async refresh() {
    const appState = useAppStore.getState();
    if (!appState.selectedIndividual || !appState.individuals.length) {
      this.chart?.destroy();
      this.chart = null;
      return;
    }
    this.data = await fetchChartData();
    this.updateCategorySelect();
    this.drawChart();
  }

  updateCategorySelect() {
    const sel = this.shadowRoot.getElementById('categorySelect');
    if (!sel || !this.data) return;
    const cats = new Set();
    for (const rows of this.data.values())
      rows.forEach(r => r.categories && cats.add(r.categories));
    const sorted = [...cats].sort();
    const prev = sel.value;
    sel.innerHTML = sorted
      .map(c => `<option value="${c}">${c}</option>`)
      .join('');
    if (sorted.includes(prev)) sel.value = prev;
  }

  toggleCollapse() {
    this.collapsed = !this.collapsed;
    const body = this.shadowRoot.getElementById('body');
    const btn = this.shadowRoot.getElementById('toggle');
    body.style.display = this.collapsed ? 'none' : '';
    btn.textContent = this.collapsed ? '▶' : '▼';
    if (!this.collapsed && this.data) this.drawChart();
  }

  drawChart() {
    if (this.collapsed) return;
    const type = this.shadowRoot.getElementById('chartType').value;
    const catSel = this.shadowRoot.getElementById('categorySelect');
    catSel.style.display = type === 'family' ? '' : 'none';

    this.chart?.destroy();
    this.chart = null;

    const canvas = this.shadowRoot.getElementById('canvas');
    if (!canvas || !this.data?.size) return;

    const appState = useAppStore.getState();
    const ctx = canvas.getContext('2d');

    switch (type) {
      case 'profile':
        this.drawProfile(ctx, appState);
        break;
      case 'scatter':
        this.drawScatter(ctx, appState);
        break;
      case 'family':
        this.drawFamily(ctx, appState);
        break;
      case 'quality':
        this.drawQuality(ctx, appState);
        break;
    }
  }

  // --- Trait Profile: horizontal bars of all traits for current individual ---
  drawProfile(ctx, appState) {
    const rows = this.data.get(appState.selectedIndividual) || [];
    const sorted = [...rows]
      .filter(r => r.percentile != null)
      .sort((a, b) => b.percentile - a.percentile);
    const labels = sorted.map(r => r.trait_name);
    const data = sorted.map(r => Math.round(r.percentile));
    const colors = data.map(p =>
      p < 20 ? '#28a745' : p > 80 ? '#dc3545' : '#007acc'
    );
    const ind = appState.individuals.find(
      i => i.id === appState.selectedIndividual
    );

    this.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: `${ind?.emoji || ''} ${ind?.name || ''} Percentile`,
            data,
            backgroundColor: colors.map(c => c + '99'),
            borderColor: colors,
            borderWidth: 1
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            min: 0,
            max: 100,
            title: { display: true, text: 'Percentile', font: { size: 13 } }
          },
          y: { ticks: { font: { size: 11 } } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: item => `${item.raw}th percentile` } }
        }
      }
    });

    // Resize canvas height for many traits
    const wrap = this.shadowRoot.querySelector('.chart-wrap');
    wrap.style.height = Math.max(300, sorted.length * 24) + 'px';
  }

  // --- Scatter: coverage vs percentile with genotyped % as point size ---
  drawScatter(ctx, appState) {
    const rows = this.data.get(appState.selectedIndividual) || [];
    const ind = appState.individuals.find(
      i => i.id === appState.selectedIndividual
    );

    const data = rows
      .filter(r => r.percentile != null)
      .map(r => {
        const coverage = r.expected > 0 ? (r.matched / r.expected) * 100 : 0;
        const pctGenotyped =
          r.best_matched > 0 ? (r.best_genotyped / r.best_matched) * 100 : 0;
        return {
          x: Math.round(coverage * 10) / 10,
          y: Math.round(r.percentile * 10) / 10,
          r: Math.max(4, Math.min(14, pctGenotyped / 8)),
          traitName: r.trait_name,
          pctGenotyped: Math.round(pctGenotyped)
        };
      });

    this.shadowRoot.querySelector('.chart-wrap').style.height = '350px';
    this.chart = new Chart(ctx, {
      type: 'bubble',
      data: {
        datasets: [
          {
            label: `${ind?.emoji || ''} ${ind?.name || ''}`,
            data,
            backgroundColor: data.map(d =>
              d.y < 20 ? '#28a74566' : d.y > 80 ? '#dc354566' : '#007acc66'
            ),
            borderColor: data.map(d =>
              d.y < 20 ? '#28a745' : d.y > 80 ? '#dc3545' : '#007acc'
            ),
            borderWidth: 1.5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: {
              display: true,
              text: 'Variant Coverage %',
              font: { size: 13 }
            },
            min: 0,
            max: 100
          },
          y: {
            title: { display: true, text: 'Percentile', font: { size: 13 } },
            min: 0,
            max: 100
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: item => {
                const d = item.raw;
                return `${d.traitName}: ${d.y}th pctl, ${d.x}% coverage, ${d.pctGenotyped}% genotyped`;
              }
            }
          }
        }
      }
    });
  }

  // --- Family Comparison: grouped bars per trait in a category ---
  drawFamily(ctx, appState) {
    const cat = this.shadowRoot.getElementById('categorySelect').value;
    if (!cat) return;

    // Collect traits in this category
    const traitMap = new Map(); // trait_id -> trait_name
    for (const rows of this.data.values()) {
      rows.forEach(r => {
        if (r.categories === cat) traitMap.set(r.trait_id, r.trait_name);
      });
    }
    const traitIds = [...traitMap.keys()];
    const traitNames = traitIds.map(id => traitMap.get(id));

    const datasets = appState.individuals.map((ind, i) => {
      const rows = this.data.get(ind.id) || [];
      const byTrait = new Map(rows.map(r => [r.trait_id, r]));
      return {
        label: `${ind.emoji} ${ind.name}`,
        data: traitIds.map(id => {
          const r = byTrait.get(id);
          return r?.percentile != null ? Math.round(r.percentile) : null;
        }),
        backgroundColor: COLORS_A[i % COLORS.length],
        borderColor: COLORS[i % COLORS.length],
        borderWidth: 1
      };
    });

    this.shadowRoot.querySelector('.chart-wrap').style.height =
      Math.max(300, traitNames.length * 35) + 'px';
    this.chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: traitNames, datasets },
      options: {
        indexAxis: traitNames.length > 4 ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            ...(traitNames.length > 4
              ? {
                  min: 0,
                  max: 100,
                  title: { display: true, text: 'Percentile' }
                }
              : {})
          },
          y: {
            ...(traitNames.length <= 4
              ? {
                  min: 0,
                  max: 100,
                  title: { display: true, text: 'Percentile' }
                }
              : { ticks: { font: { size: 11 } } })
          }
        },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 13 } } },
          tooltip: {
            callbacks: {
              label: item => `${item.dataset.label}: ${item.raw}th pctl`
            }
          }
        }
      }
    });
  }

  // --- Data Quality: genotyped vs imputed stacked bars per trait ---
  drawQuality(ctx, appState) {
    const rows = this.data.get(appState.selectedIndividual) || [];
    const sorted = [...rows]
      .filter(r => r.best_matched > 0)
      .sort((a, b) => {
        const aG = a.best_genotyped / a.best_matched;
        const bG = b.best_genotyped / b.best_matched;
        return bG - aG;
      });

    const labels = sorted.map(r => r.trait_name);
    const genotypedPct = sorted.map(r =>
      Math.round((r.best_genotyped / r.best_matched) * 100)
    );
    const imputedPct = sorted.map(r =>
      Math.round((r.best_imputed / r.best_matched) * 100)
    );
    const ind = appState.individuals.find(
      i => i.id === appState.selectedIndividual
    );

    this.shadowRoot.querySelector('.chart-wrap').style.height =
      Math.max(300, sorted.length * 24) + 'px';
    this.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Genotyped',
            data: genotypedPct,
            backgroundColor: '#28a74599',
            borderColor: '#28a745',
            borderWidth: 1
          },
          {
            label: 'Imputed',
            data: imputedPct,
            backgroundColor: '#ffc10799',
            borderColor: '#ffc107',
            borderWidth: 1
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            max: 100,
            title: {
              display: true,
              text: '% of Matched Variants',
              font: { size: 13 }
            }
          },
          y: { stacked: true, ticks: { font: { size: 11 } } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 13 } } },
          title: {
            display: true,
            text: `${ind?.emoji || ''} ${ind?.name || ''} — Best PGS Variant Source`,
            font: { size: 14 }
          },
          tooltip: {
            callbacks: { label: item => `${item.dataset.label}: ${item.raw}%` }
          }
        }
      }
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; margin-bottom: 15px; }
        .container {
          background: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 12px 15px;
        }
        .header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .header label {
          font-size: 14px;
          font-weight: 600;
          color: #495057;
        }
        #toggle {
          margin-left: auto;
          background: none;
          border: none;
          cursor: pointer;
          font-size: 12px;
          color: #6c757d;
          padding: 2px 6px;
        }
        #toggle:hover { color: #495057; }
        select {
          padding: 4px 8px;
          border: 1px solid #ced4da;
          border-radius: 4px;
          font-size: 13px;
          background: white;
        }
        .chart-wrap {
          position: relative;
          width: 100%;
          height: 350px;
        }
      </style>
      <div class="container">
        <div class="header">
          <label>Results</label>
          <select id="chartType">
            <option value="profile">Trait Profile</option>
            <option value="scatter">Coverage vs Percentile</option>
            <option value="family">Family Comparison</option>
            <option value="quality">Data Quality</option>
          </select>
          <select id="categorySelect" style="display:none"></select>
          <button id="toggle" title="Toggle chart">▶</button>
        </div>
        <div id="body" style="display:none">
          <div class="chart-wrap">
            <canvas id="canvas"></canvas>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('results-summary', ResultsSummary);
