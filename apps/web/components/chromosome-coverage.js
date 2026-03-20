/**
 * Chromosome Coverage Chart
 * Static rainbow color per chromosome (1-22, X, Y)
 * Outlined bars = total PGS variants, filled = matched
 * Stacked donut pie: arcs fan out from 12 o'clock to final positions
 * SVG renders at native pixel size via ResizeObserver for crisp lines
 */

const CHR_COLORS = {
  '1': '#ef4444', '2': '#f97316', '3': '#f59e0b', '4': '#eab308',
  '5': '#84cc16', '6': '#22c55e', '7': '#10b981', '8': '#14b8a6',
  '9': '#06b6d4', '10': '#0ea5e9', '11': '#3b82f6', '12': '#6366f1',
  '13': '#8b5cf6', '14': '#a855f7', '15': '#c084fc', '16': '#d946ef',
  '17': '#ec4899', '18': '#f43f5e', '19': '#fb7185', '20': '#fda4af',
  '21': '#93c5fd', '22': '#86efac', 'X': '#a1a1aa', 'Y': '#d4d4d8'
};

export class ChromosomeCoverage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._coverage = {};
    this._ro = null;
  }

  connectedCallback() {
    this.render();
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(this);
  }

  disconnectedCallback() {
    this._ro?.disconnect();
  }

  set coverage(value) {
    const newCoverage = value || {};
    if (JSON.stringify(this._coverage) === JSON.stringify(newCoverage)) return;
    this._coverage = newCoverage;
    this.render();
  }

  render() {
    const w = this.clientWidth || 480;

    const matched = this._coverage.matched || this._coverage;
    const totals = this._coverage.totals || {};
    const hasTotals = Object.keys(totals).length > 0;

    const chromosomes = ['1','2','3','4','5','6','7','8','9','10',
                         '11','12','13','14','15','16','17','18','19',
                         '20','21','22','X','Y'];

    const data = chromosomes.map(chr => ({
      chr,
      matched: matched[chr] || 0,
      total: totals[chr] || matched[chr] || 0,
      color: CHR_COLORS[chr]
    }));

    const totalMatched = data.reduce((s, d) => s + d.matched, 0);
    const totalAll = data.reduce((s, d) => s + d.total, 0);
    const maxCount = Math.max(...data.map(d => d.total), 1);
    const coveragePct = totalAll > 0 ? Math.round(totalMatched / totalAll * 100) : 0;

    // Layout in actual pixels
    const h = 110;
    const gap = w / chromosomes.length;
    const barW = Math.max(4, gap - 4);
    const maxH = 90;

    // Pie geometry
    const pieR = 30, pieStroke = 20;
    const pieCx = w - pieR - 8, pieCy = pieR - 14;
    const pieCirc = 2 * Math.PI * pieR;

    // Stacked arcs — each arc's final offset positions it after the previous
    const covFrac = coveragePct / 100;
    let cumDash = 0;
    const arcs = data.filter(d => d.matched > 0).map(d => {
      const frac = d.matched / totalMatched;
      const dash = frac * pieCirc * covFrac;
      const finalOffset = pieCirc / 4 - cumDash;
      cumDash += dash;
      return { dash, gapLen: pieCirc - dash, finalOffset, color: d.color };
    });

    // Animation: each arc starts at offset = -pieCirc/4 (all at 12 o'clock)
    // and transitions to its final offset
    const startOffset = pieCirc / 4;
    const dur = '0.8s';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; overflow: visible; }
        .legend { padding: 8px 10px; font-size: 11px; color: #666; border-top: 1px solid #ddd; text-align: center; }
        .legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin: 0 3px 0 10px; }
        .bar-outline, .bar-fill {
          transform-origin: bottom;
          animation: growUp 0.5s ease-out both;
        }
        ${data.map((_, i) => `.d${i} { animation-delay: ${i * 25}ms; }`).join('\n        ')}
        @keyframes growUp {
          from { transform: scaleY(0); }
          to { transform: scaleY(1); }
        }
      </style>
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="overflow:visible">
        ${data.map((d, i) => {
          const x = Math.round(i * gap + (gap - barW) / 2);
          const totalH = Math.max(4, (d.total / maxCount) * maxH);
          const matchedH = d.total > 0 ? (d.matched / d.total) * totalH : 0;
          const totalY = maxH - totalH;
          const matchedY = maxH - matchedH;
          const title = hasTotals
            ? `Chr ${d.chr}: ${d.matched.toLocaleString()} / ${d.total.toLocaleString()} matched`
            : `Chr ${d.chr}: ${d.matched.toLocaleString()} variants`;
          return `
            <g>
              ${hasTotals ? `<rect class="bar-outline d${i}" x="${x}" y="${totalY}" width="${barW}" height="${totalH}" fill="none" stroke="${d.color}" stroke-opacity="0.35" stroke-width="1" rx="2"><title>${title}</title></rect>` : ''}
              <rect class="bar-fill d${i}" x="${x}" y="${matchedY}" width="${barW}" height="${matchedH}" fill="${d.color}" rx="2">
                <title>${title}</title>
              </rect>
              <text x="${Math.round(i * gap + gap / 2)}" y="107" text-anchor="middle" font-size="10" font-weight="bold" fill="#333">${d.chr}</text>
            </g>`;
        }).join('')}
        ${hasTotals ? `
        <g class="pie">
          <circle cx="${pieCx}" cy="${pieCy}" r="${pieR}" fill="white" fill-opacity="0.9"/>
          <circle cx="${pieCx}" cy="${pieCy}" r="${pieR}" fill="none" stroke="#e5e7eb" stroke-width="${pieStroke}"/>
          ${arcs.map(a => `
          <circle cx="${pieCx}" cy="${pieCy}" r="${pieR}" fill="none"
                  stroke="${a.color}" stroke-width="${pieStroke}" stroke-linecap="butt"
                  stroke-dasharray="${a.dash} ${a.gapLen}" stroke-dashoffset="${a.finalOffset}">
            <animate attributeName="stroke-dasharray" from="0 ${pieCirc}" to="${a.dash} ${a.gapLen}" dur="${dur}" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1"/>
            <animate attributeName="stroke-dashoffset" from="${startOffset}" to="${a.finalOffset}" dur="${dur}" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1"/>
          </circle>`).join('')}
          <text x="${pieCx - 1}" y="${pieCy + 5}" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${coveragePct}<tspan font-size="8" dy="0" dx="0">%</tspan></text>
          <title>${totalMatched.toLocaleString()} / ${totalAll.toLocaleString()} variants matched (${coveragePct}% coverage)</title>
        </g>` : ''}
      </svg>
      <div class="legend">
        ${hasTotals
          ? `<span class="swatch" style="background:#3b82f6"></span>Matched: ${totalMatched.toLocaleString()}<span class="swatch" style="background:none;border:1px solid #94a3b8"></span>Total: ${totalAll.toLocaleString()}`
          : `Total: ${totalMatched.toLocaleString()} matched variants across all chromosomes`}
      </div>
    `;
  }
}

customElements.define('chromosome-coverage', ChromosomeCoverage);
