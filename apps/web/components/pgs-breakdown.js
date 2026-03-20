import { useTraitStore } from '../lib/trait-store.js';
import { useAppStore } from '../lib/store.js';
import './chromosome-coverage.js';
import './risk-distribution.js';

export class PGSBreakdown extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.traitId = null;
    this.pgsId = null;
    this.unsubscribe = null;
    this.chart = null;
  }

  static get observedAttributes() {
    return ['trait-id', 'pgs-id'];
  }

  attributeChangedCallback() {
    this.traitId = this.getAttribute('trait-id');
    this.pgsId = this.getAttribute('pgs-id');
    this.updateDisplay();
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.subscribeToTraitStore();
    this.updateDisplay();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  setupEventListeners() {
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('.back-btn')) {
        this.goBack();
      }
      if (e.target.closest('.nav-btn')) {
        const direction = e.target.dataset.direction;
        this.navigate(direction === 'next' ? 1 : -1);
      }
      if (e.target.closest('.quality-info-btn')) {
        this.showQualityBreakdown();
      }
      if (e.target.closest('.quality-modal-close')) {
        this.hideQualityBreakdown();
      }
    });
  }

  subscribeToTraitStore() {
    let previousState = null;
    this.unsubscribe = useTraitStore.subscribe(() => {
      if (!this.traitId) return;
      const currentState = useTraitStore.getState().getTraitState(this.traitId);
      // Only update if THIS trait's state changed
      if (JSON.stringify(currentState) !== JSON.stringify(previousState)) {
        previousState = currentState;
        this.updateDisplay();
      }
    });
  }

  updateDisplay() {
    if (!this.traitId || !this.pgsId) return;
    
    const content = this.shadowRoot?.querySelector('.content');
    if (!content) return;
    
    const state = useTraitStore.getState().getTraitState(this.traitId);
    if (!state.cached?.pgsDetails?.[this.pgsId]) return;
    
    const appState = useAppStore.getState();
    const allIndividuals = appState.individuals || [];
    
    const pgsData = state.cached.pgsDetails[this.pgsId];
    const pgsBreakdown = state.cached.pgsBreakdown[this.pgsId];
    const navigation = state.pgsNavigation;
    const score = pgsBreakdown.positiveSum + pgsBreakdown.negativeSum;
    const gridCols = `12em repeat(${allIndividuals.length}, auto) auto auto auto`;
    
    content.innerHTML = `

      <div class="header">
        <button class="back-btn">← Back</button>
        <h4 title="PGS Catalog: ${pgsData.metadata?.name || this.pgsId}" style="max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0;">
          <a href="https://www.pgscatalog.org/score/${this.pgsId}" target="_blank" style="color: inherit; text-decoration: none;">${this.pgsId}</a>
        </h4>
        <div class="nav-buttons">
          <button class="nav-btn" data-direction="prev" ${navigation?.currentIndex === 0 ? 'disabled' : ''}>↑</button>
          <button class="nav-btn" data-direction="next" ${navigation?.currentIndex === navigation?.pgsIds.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>
      
      <div class="pgs-info">
        ${pgsData.zScore !== null && pgsData.zScore !== undefined ? `
          <div class="z-score">${pgsData.zScore >= 0 ? '+' : ''}${pgsData.zScore.toFixed(3)}σ</div>
          <div class="percentile">${this.zScoreToPercentile(pgsData.zScore)}${this.getOrdinalSuffix(this.zScoreToPercentile(pgsData.zScore))} percentile</div>
          <risk-distribution score="${pgsData.zScore}" style="height:80px;margin:4px 0 0"></risk-distribution>
        ` : `
          <div class="z-score">N/A</div>
        `}
      </div>
      
      <div class="chromosome-section">
        <h5>Chromosome Coverage</h5>
        <chromosome-coverage></chromosome-coverage>
      </div>

      <div class="calculation-summary">
        <div>• ${pgsBreakdown.positive} variants increase risk (+${pgsBreakdown.positiveSum.toFixed(4)})</div>
        <div>• ${pgsBreakdown.negative} variants decrease risk (${pgsBreakdown.negativeSum.toFixed(4)})</div>
        <div><strong>Raw Score: ${score >= 0 ? '+' : ''}${score.toFixed(4)}</strong></div>
        ${pgsData.zScore !== null && pgsData.zScore !== undefined ? (() => {
          const traitType = state.cached.trait_type || 'disease_risk';
          const unit = state.cached.unit || null;
          
          return `
          <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #eee;">
            <div><strong>PGS Information:</strong></div>
            <div>• ID: <a href="https://www.pgscatalog.org/score/${this.pgsId}" target="_blank" style="color: #007acc;">${this.pgsId}</a></div>
            ${pgsData.metadata?.name ? `<div>• Name: ${pgsData.metadata.name}</div>` : ''}
            ${pgsData.metadata?.variants_number ? `<div>• Total variants: ${pgsData.metadata.variants_number.toLocaleString()}</div>` : ''}
            ${pgsData.performanceMetric ? `<div>• Performance (R²): ${(pgsData.performanceMetric * 100).toFixed(1)}%</div>` : ''}
            ${pgsData.qualityScore !== undefined ? `
            <div>• Quality Score: <strong>${pgsData.qualityScore.toFixed(1)}/100</strong> 
              <button class="quality-info-btn" data-pgs-id="${this.pgsId}" title="How is this score calculated?">ℹ️</button>
            </div>
            ` : ''}
            ${traitType === 'quantitative' && unit && pgsData.value !== null && pgsData.value !== undefined ? `
            <div style="margin-top: 8px;"><strong>Quantitative Value:</strong></div>
            <div>• Predicted value: ${pgsData.value.toFixed(2)} ${unit}</div>
            <div>• Z-score: ${pgsData.zScore >= 0 ? '+' : ''}${pgsData.zScore.toFixed(3)}σ</div>
            <div>• Percentile: ${this.zScoreToPercentile(pgsData.zScore)}${this.getOrdinalSuffix(this.zScoreToPercentile(pgsData.zScore))}</div>
            ${state.cached.phenotype_mean && state.cached.phenotype_sd ? `
            <div style="margin-top: 8px;"><strong>Population Context:</strong></div>
            <div>• Population mean: ${state.cached.phenotype_mean} ${unit}</div>
            <div>• Population std dev: ${state.cached.phenotype_sd} ${unit}</div>
            <div>• Reference: ${state.cached.reference_population || 'General population'}</div>
            ` : ''}
            ` : `
            <div style="margin-top: 8px;"><strong>Genetic Risk Score:</strong></div>
            <div>• Raw score: ${score >= 0 ? '+' : ''}${score.toFixed(4)}</div>
            <div>• Z-score: ${pgsData.zScore >= 0 ? '+' : ''}${pgsData.zScore.toFixed(3)}σ</div>
            <div>• Percentile: ${this.zScoreToPercentile(pgsData.zScore)}${this.getOrdinalSuffix(this.zScoreToPercentile(pgsData.zScore))}</div>
            <div style="margin-top: 8px;"><strong>Normalization:</strong></div>
            <div>• Population mean: ${pgsData.normMean !== undefined && pgsData.normMean !== null ? pgsData.normMean.toFixed(4) : 'N/A'}</div>
            <div>• Population std dev: ${pgsData.normSd !== undefined && pgsData.normSd !== null ? pgsData.normSd.toFixed(4) : 'N/A'}</div>
            ${(() => {
              const totalVars = pgsData.metadata?.variants_number || pgsBreakdown.total || 1;
              const cov = pgsData.coverage ?? (pgsData.matchedVariants / totalVars);
              if (pgsData.normalizationScaled) {
                return `<div style="color: #0066cc;">ℹ️ Scaled by coverage (${(cov * 100).toFixed(1)}%) to match partial variant set</div>`;
              } else if (pgsData.insufficientCoverage) {
                return `<div style="color: #856404;">⚠️ Low coverage (${(cov * 100).toFixed(1)}%) - using theoretical normalization</div>`;
              }
              return '';
            })()}
            ${pgsData.normMean !== undefined && pgsData.normSd !== undefined ? `<div>• Formula: (${score.toFixed(4)} - ${pgsData.normMean.toFixed(4)}) / ${pgsData.normSd.toFixed(4)} = ${pgsData.zScore.toFixed(3)}</div>` : ''}
            `}
          </div>
          `;
        })() : ''}
      </div>
      
      <div class="score-distribution">
        <h5>Effect Weight Distribution</h5>
        <canvas id="distributionChart-${this.pgsId}" width="300" height="150"></canvas>
      </div>
      
      <div class="variant-list">
        <h5>Top Contributing Variants</h5>
        <div class="variant-table-wrap">
          <div class="waterfall-layer"></div>
          <table class="variant-table">
            <colgroup>
              <col style="width: 30%">
              ${allIndividuals.map(() => `<col style="width: 2em">`).join('')}
              <col style="width: 2em">
              <col style="width: 19%">
              <col style="width: 3em">
            </colgroup>
            <thead>
              <tr>
                <th>Variant</th>
                ${allIndividuals.map(ind => `<th title="${ind.name}'s DNA">${ind.emoji}</th>`).join('')}
                <th>🎯</th>
                <th>Weight</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
          ${(() => {
            const topVariants = (pgsData.topVariants || pgsBreakdown.topVariants || []).slice(0, 20);
            let cumulative = 0;
            const waterfall = topVariants.map(v => {
              const contribution = v.contribution != null ? v.contribution : (() => {
                const genotype = v.userGenotype || 'N/A';
                const effectAlleleCount = genotype === 'N/A' ? 0 : genotype.split('').filter(allele => allele === v.effect_allele).length;
                return v.effect_weight * effectAlleleCount;
              })();
              const start = cumulative;
              cumulative += contribution;
              return { ...v, start, end: cumulative, contribution };
            });

            const maxAbs = Math.max(...waterfall.map(v => Math.abs(v.end)), 0.01);

            return waterfall.map((variant, idx) => {
              const variantId = variant.rsid || 'Unknown';
              let displayId, linkUrl, linkTitle;
              if (variantId.startsWith('rs')) {
                displayId = variantId;
                linkUrl = `https://www.ncbi.nlm.nih.gov/snp/${variantId}`;
                linkTitle = `See more about ${variantId} on NCBI dbSNP`;
              } else if (variantId.includes(':')) {
                const parts = variantId.split(':');
                displayId = parts.length >= 3 ? `chr${parts[0]}:${parts[1]}` : variantId;
                const pos = parseInt(parts[1]);
                linkUrl = `https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg19&position=chr${parts[0]}:${Math.max(1, pos - 5000)}-${pos + 5000}`;
                linkTitle = `See more about ${displayId} on UCSC Genome Browser`;
              } else {
                displayId = variantId;
                linkUrl = null;
              }

              const barStartPercent = 50 + (Math.min(variant.start, variant.end) / maxAbs) * 40;
              const barWidthPercent = (Math.abs(variant.contribution) / maxAbs) * 40;
              const barColor = variant.contribution >= 0 ? 'rgba(220, 53, 69, 0.3)' : 'rgba(21, 87, 36, 0.3)';
              const userDosage = variant.dosage != null ? variant.dosage : 0;

              return `
              <tr data-bar-left="${barStartPercent}" data-bar-width="${barWidthPercent}" data-bar-color="${barColor}">
                <td class="variant-id" title="Variant: ${displayId}">${linkUrl ? `<a href="${linkUrl}" target="_blank" title="${linkTitle}">${displayId}</a>` : displayId}</td>
                ${allIndividuals.map(ind => {
                  if (ind.id === appState.selectedIndividual) {
                    const geno = variant.userGenotype || '—';
                    return `<td class="genotype" title="${ind.name}: ${geno}">${geno}</td>`;
                  }
                  const other = variant.otherGenotypes?.[ind.id];
                  return `<td class="genotype" title="${ind.name}: ${other?.genotype || 'no data'}">${other?.genotype || '—'}</td>`;
                }).join('')}
                <td class="effect-allele" title="Effect allele: ${variant.effect_allele}">${variant.effect_allele}</td>
                <td class="weight ${variant.effect_weight >= 0 ? 'positive' : 'negative'}" title="Effect weight: ${variant.effect_weight >= 0 ? '+' : ''}${variant.effect_weight.toFixed(6)}">${variant.effect_weight >= 0 ? '+' : ''}${variant.effect_weight.toFixed(6)}</td>
                <td class="contribution" title="Dosage: ${userDosage.toFixed(2)}">×${Number.isInteger(userDosage) ? userDosage : userDosage.toFixed(1)}</td>
              </tr>
            `}).join('');
          })()}
            </tbody>
          </table>
        </div>
      </div>
      
      </div>
    `;
    
    // Set component data after DOM update
    setTimeout(() => {
      this.createChart(pgsData);
      this.positionWaterfallBars();
      const coverage = this.shadowRoot.querySelector('chromosome-coverage');
      if (coverage) {
        coverage.coverage = {
          matched: pgsBreakdown.chromosomeCoverage || {},
          totals: pgsBreakdown.chrTotals || {}
        };
      }
    }, 0);
  }

  positionWaterfallBars() {
    const wrap = this.shadowRoot.querySelector('.variant-table-wrap');
    const layer = wrap?.querySelector('.waterfall-layer');
    const rows = wrap?.querySelectorAll('tbody tr[data-bar-left]');
    if (!layer || !rows?.length) return;
    layer.innerHTML = '';
    for (const row of rows) {
      const bar = document.createElement('div');
      bar.className = 'waterfall-bar';
      bar.style.top = row.offsetTop + 'px';
      bar.style.height = row.offsetHeight + 'px';
      bar.style.left = row.dataset.barLeft + '%';
      bar.style.width = row.dataset.barWidth + '%';
      bar.style.background = row.dataset.barColor;
      layer.appendChild(bar);
    }
  }

  calculateCoverage(variants) {
    const coverage = {};
    for (const v of variants) {
      const chr = v.chromosome || this.extractChr(v.rsid);
      if (!chr) continue;
      if (!coverage[chr]) coverage[chr] = { matched: 0, total: 0 };
      coverage[chr].matched++;
      coverage[chr].total++;
    }
    return coverage;
  }

  extractChr(rsid) {
    if (rsid?.includes(':')) {
      return rsid.split(':')[0].replace('chr', '');
    }
    return null;
  }

  goBack() {
    useTraitStore.getState().setSelectedPgs(this.traitId, null, null);
  }

  navigate(direction) {
    const state = useTraitStore.getState().getTraitState(this.traitId);
    const navigation = state.pgsNavigation;
    if (!navigation) return;
    
    const newIndex = navigation.currentIndex + direction;
    if (newIndex >= 0 && newIndex < navigation.pgsIds.length) {
      const newPgsId = navigation.pgsIds[newIndex];
      const newNavigation = { ...navigation, currentIndex: newIndex };
      useTraitStore.getState().setSelectedPgs(this.traitId, newPgsId, newNavigation);
    }
  }

  formatScore(score) {
    if (score == null) return 'N/A';
    const abs = Math.abs(score);
    const sign = score >= 0 ? '+' : '';
    return abs >= 10 ? `${sign}${score.toFixed(2)}σ` : `${sign}${score.toFixed(3)}σ`;
  }

  zScoreToPercentile(zScore) {
    const erf = (x) => {
      const sign = x >= 0 ? 1 : -1;
      x = Math.abs(x);
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const t = 1.0 / (1.0 + p * x);
      const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return sign * y;
    };
    return Math.round(0.5 * (1 + erf(zScore / Math.sqrt(2))) * 100);
  }

  getOrdinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  showQualityBreakdown() {
    const state = useTraitStore.getState().getTraitState(this.traitId);
    const pgsData = state.cached?.pgsDetails?.[this.pgsId];
    const pgsBreakdown = state.cached?.pgsBreakdown?.[this.pgsId];
    if (!pgsData || !pgsBreakdown) return;

    // Import SharedRiskCalculator to get breakdown
    import('../../packages/core/src/genomic-processor/calculator.js').then(({ SharedRiskCalculator }) => {
      const breakdown = SharedRiskCalculator.getQualityScoreBreakdown(
        pgsData.matchedVariants,
        pgsData.metadata?.variants_number || pgsBreakdown.total,
        pgsData.performanceMetric,
        !pgsData.insufficientEmpiricalData,
        pgsData.zScore,
        pgsData.genotypedVariants
      );

      const totalVariants = pgsData.metadata?.variants_number || pgsBreakdown.total || 1;
      const coverage = pgsData.coverage ?? (pgsData.matchedVariants / totalVariants);
      const coveragePct = (coverage * 100).toFixed(1);
      const penaltyInfo = breakdown.coveragePenalty !== undefined && breakdown.coveragePenalty < 1.0 ? 
        `<div class="coverage-penalty-warning">
          ⚠️ <strong>Coverage Penalty Applied:</strong> Only ${coveragePct}% of PGS variants matched. 
          R² contribution reduced to ${(breakdown.coveragePenalty * 100).toFixed(1)}% of its value.
        </div>` : '';

      const modal = document.createElement('div');
      modal.className = 'quality-modal';
      modal.innerHTML = `
        <div class="quality-modal-content">
          <div class="quality-modal-header">
            <h3>Quality Score Breakdown</h3>
            <button class="quality-modal-close">×</button>
          </div>
          <div class="quality-modal-body">
            ${penaltyInfo}
            <div class="quality-total">
              <span>Total Score:</span>
              <strong>${breakdown.total}/100</strong>
              <span class="quality-label">${breakdown.explanation}</span>
            </div>
            <div class="quality-components">
              ${breakdown.components.map(comp => `
                <div class="quality-component">
                  <div class="component-header">
                    <span class="component-name">${comp.name}</span>
                    <span class="component-weight">${comp.weight}</span>
                  </div>
                  <div class="component-bar">
                    <div class="component-fill" style="width: ${(comp.score / comp.maxScore) * 100}%"></div>
                    <span class="component-score">${comp.score}/${comp.maxScore}</span>
                  </div>
                  <div class="component-desc">${comp.description}</div>
                </div>
              `).join('')}
            </div>
            <div class="quality-footer">
              <p><strong>Why this matters:</strong> Quality score prioritizes predictive accuracy (R²) over variant count. A PGS with high R² and fewer variants is scientifically superior to one with low R² and many variants.</p>
              <p><a href="https://github.com/your-org/asili/blob/main/docs/PGS_QUALITY_SCORE.md" target="_blank">Learn more about quality scoring →</a></p>
            </div>
          </div>
        </div>
      `;
      this.shadowRoot.appendChild(modal);
    });
  }

  hideQualityBreakdown() {
    const modal = this.shadowRoot.querySelector('.quality-modal');
    if (modal) modal.remove();
  }

  async createChart(pgsData) {
    const canvas = this.shadowRoot.getElementById(`distributionChart-${this.pgsId}`);
    if (!canvas) return;

    // Destroy existing chart if it exists
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }

    const state = useTraitStore.getState().getTraitState(this.traitId);
    const pgsBreakdown = state.cached.pgsBreakdown[this.pgsId];
    const buckets = pgsBreakdown?.weightBuckets || [];
    
    if (buckets.length === 0) {
      canvas.style.display = 'none';
      return;
    }

    if (typeof Chart === 'undefined') {
      await window.loadChartJS?.();
    }
    if (typeof Chart === 'undefined') return;

    // Create linear x-axis labels based on bucket positions
    const labels = buckets.map((b, i) => {
      if (i === 0) return b.min.toFixed(4);
      if (i === buckets.length - 1) return b.max.toFixed(4);
      if (i === Math.floor(buckets.length / 2)) return ((b.min + b.max) / 2).toFixed(4);
      return '';
    });

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Variant Count',
          data: buckets.map(b => b.count),
          borderColor: '#007acc',
          backgroundColor: 'rgba(0, 122, 204, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          spanGaps: true
        }]
      },
      options: {
        responsive: false,
        scales: {
          y: { 
            beginAtZero: true, 
            title: { display: true, text: 'Variants' },
            type: 'logarithmic',
            min: 1
          },
          x: { 
            title: { display: true, text: 'Effect Weight' }, 
            ticks: { 
              maxRotation: 0,
              autoSkip: false
            } 
          }
        },
        plugins: { 
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                const bucket = buckets[idx];
                return `${bucket.min.toFixed(4)} to ${bucket.max.toFixed(4)}`;
              },
              label: (context) => `${context.parsed.y} variants`
            }
          }
        }
      }
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .header { display: flex; align-items: center; gap: 10px; margin-bottom: 15px; }
        .back-btn { background: none; border: none; cursor: pointer; color: #007acc; }
        .header h4 { margin: 0; flex: 1; }
        .nav-buttons { display: flex; gap: 5px; }
        .nav-btn { background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; width: 24px; height: 24px; cursor: pointer; }
        .nav-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .pgs-info { text-align: center; margin-bottom: 12px; }
        .z-score { font-size: 1.8em; font-weight: bold; color: #007acc; }
        .percentile { font-size: 13px; color: #555; margin-top: 2px; }
        .score-and-chart { display: flex; align-items: center; justify-content: center; margin-bottom: 10px; }
        .score { font-size: 1.5em; font-weight: bold; color: #007acc; text-align: center; }
        .variants { font-size: 12px; color: #666; margin-top: 5px; }
        .calculation-summary { margin-bottom: 20px; font-size: 12px; line-height: 1.4; }
        .calculation-summary div { margin-bottom: 3px; }
        .score-distribution { margin: 15px 0; }
        .score-distribution h5 { margin: 0 0 10px 0; font-size: 12px; }
        .score-distribution canvas { max-width: 100%; height: 150px; }
        .variant-list { margin: 15px 0; }
        .variant-list h5 { margin: 0 0 10px 0; font-size: 14px; }
        .variant-table-wrap { position: relative; border: 1px solid #ddd; border-radius: 4px; max-height: 200px; overflow: auto; }
        .waterfall-layer { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: 0; }
        .waterfall-bar { position: absolute; border-radius: 2px; }
        .variant-table { position: relative; z-index: 1; width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
        .variant-table thead th { position: sticky; top: 0; background: #f5f5f5; padding: 4px 4px; font-size: 13px; font-weight: bold; text-align: center; z-index: 2; }
        .variant-table thead th:first-child { text-align: left; }
        .variant-table thead th:nth-last-child(-n+2) { text-align: right; }
        .variant-table tbody tr { cursor: default; user-select: none; }
        .variant-table tbody tr:hover { background: rgba(240, 248, 255, 0.8); }
        .variant-table td { padding: 4px 8px; border-bottom: 1px solid #eee; white-space: nowrap; }
        .variant-id { max-width: 10em; overflow: hidden; text-overflow: ellipsis; }
        .variant-id a { color: #007acc; text-decoration: none; font-family: monospace; }
        .variant-id a:hover { text-decoration: underline; }
        .genotype { font-family: monospace; font-weight: bold; color: #2e7d32; text-align: center; }
        .effect-allele { font-family: monospace; color: #d32f2f; font-weight: bold; text-align: center; }
        .weight, .contribution { font-family: monospace; text-align: right; }
        .weight.positive { color: #721c24; }
        .weight.negative { color: #155724; }
        .chromosome-section { margin: 15px 0; }
        .chromosome-section h5 { margin: 0 0 10px 0; font-size: 14px; }
        .quality-info-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 4px; vertical-align: middle; }
        .quality-info-btn:hover { opacity: 0.7; }
        .quality-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
        .quality-modal-content { background: white; border-radius: 8px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
        .quality-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; }
        .quality-modal-header h3 { margin: 0; font-size: 18px; }
        .quality-modal-close { background: none; border: none; font-size: 28px; cursor: pointer; color: #666; line-height: 1; padding: 0; width: 32px; height: 32px; }
        .quality-modal-close:hover { color: #000; }
        .quality-modal-body { padding: 20px; }
        .quality-total { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; padding: 12px; background: #f0f8ff; border-radius: 6px; }
        .quality-total strong { font-size: 24px; color: #007acc; }
        .quality-label { margin-left: auto; font-size: 12px; color: #666; font-style: italic; }
        .quality-components { display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px; }
        .quality-component { }
        .component-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .component-name { font-weight: 600; font-size: 13px; }
        .component-weight { font-size: 12px; color: #666; }
        .component-bar { position: relative; height: 24px; background: #f0f0f0; border-radius: 4px; overflow: hidden; margin-bottom: 4px; }
        .component-fill { position: absolute; left: 0; top: 0; height: 100%; background: linear-gradient(90deg, #007acc, #0099ff); transition: width 0.3s ease; }
        .component-score { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 600; color: #333; }
        .component-desc { font-size: 11px; color: #666; }
        .quality-footer { padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; line-height: 1.5; }
        .quality-footer p { margin: 8px 0; }
        .quality-footer a { color: #007acc; text-decoration: none; }
        .quality-footer a:hover { text-decoration: underline; }
        .coverage-penalty-warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px; margin-bottom: 16px; font-size: 12px; line-height: 1.4; color: #856404; }
      </style>
      <div class="content"></div>
    `;
  }
}

customElements.define('pgs-breakdown', PGSBreakdown);
