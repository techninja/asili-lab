/**
 * Risk Distribution Visualization
 * Shows user's position on a normal distribution curve
 */

export class RiskDistribution extends HTMLElement {
  static get observedAttributes() {
    return ['score', 'emoji', 'other-individuals'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  get score() {
    return parseFloat(this.getAttribute('score')) || 0;
  }

  get emoji() {
    return this.getAttribute('emoji') || '👤';
  }

  get otherIndividuals() {
    const attr = this.getAttribute('other-individuals');
    return attr ? JSON.parse(attr) : [];
  }

  render() {
    const vbW = 400;
    const hostW = this.clientWidth || 400;
    const hostH = this.clientHeight || 200;
    const vbH = Math.round(vbW * (hostH / hostW));
    const sy = vbH / 200;

    const score = this.score;
    const percentile = this.scoreToPercentile(score);
    const userX = this.scoreToX(score);
    let userY = this.getYForX(score, sy);
    const points = this.generateBellCurve(sy);
    const others = this.otherIndividuals;

    // Track occupied positions for stacking
    const occupiedPositions = [{ x: userX, y: userY, score }];

    const positionedOthers = others.map(other => {
      const otherX = this.scoreToX(other.zScore);
      let otherY = this.getYForX(other.zScore, sy);

      // Check for overlaps within 0.3σ
      const overlapping = occupiedPositions.filter(
        pos => Math.abs(pos.x - otherX) < 25
      );

      if (overlapping.length > 0) {
        // Stack above the highest overlapping position
        const highestY = Math.min(...overlapping.map(p => p.y));
        otherY = highestY - 35;

        // If too close to top, shift horizontally
        if (otherY < 10) {
          otherY = 10;
          const shiftDirection = otherX < 200 ? 1 : -1;
          const shiftAmount = 20 * (overlapping.length - 1);
          occupiedPositions.push({
            x: otherX + shiftDirection * shiftAmount,
            y: otherY,
            score: other.zScore
          });
          return {
            ...other,
            x: otherX + shiftDirection * shiftAmount,
            y: otherY,
            shifted: true
          };
        }
      }

      occupiedPositions.push({ x: otherX, y: otherY, score: other.zScore });
      return { ...other, x: otherX, y: otherY, shifted: false };
    });

    // Push user down if stacked others would hit the top
    const minOtherY =
      positionedOthers.length > 0
        ? Math.min(...positionedOthers.map(o => o.y))
        : Infinity;
    if (minOtherY < 15 && userY < 50) {
      userY = Math.max(userY, 50);
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; height: 200px; overflow: hidden; }
        svg { width: 100%; height: 100%; }
        .curve { fill: none; stroke: #007acc; stroke-width: 2; }
        .fill-left { fill: #d4edda; opacity: 0.3; }
        .fill-right { fill: #f8d7da; opacity: 0.3; }
        .user-line { stroke: #dc3545; stroke-width: 2; stroke-dasharray: 4; }
        .user-marker { fill: #dc3545; }
        .label { font-size: 11px; fill: #666; user-select: none; }
        .user-label { font-size: 16px; font-weight: bold; fill: #dc3545; user-select: none; }
        .other-label { font-size: 14px; fill: #666; user-select: none; }
        .other-marker { transition: opacity 0.2s; }
        .other-marker:hover { opacity: 1 !important; }
        .hover-label { font-size: 20px; fill: #333; font-weight: bold; opacity: 0; transition: opacity 0.2s; user-select: none; }
        .other-individual:hover .hover-label { opacity: 1; }
        .percentile-text { font-size: 14px; font-weight: bold; text-anchor: middle; user-select: none; }
      </style>
      <svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none">
        <!-- Risk zones (fixed at center) -->
        <rect x="0" y="${20 * sy}" width="200" height="${160 * sy}" class="fill-left"/>
        <rect x="200" y="${20 * sy}" width="200" height="${160 * sy}" class="fill-right"/>
        
        <!-- Bell curve -->
        <path d="${points}" class="curve"/>
        
        <!-- Standard deviation markers -->
        ${[-4, -3, -2, -1, 0, 1, 2, 3, 4]
          .map(sd => {
            const x = this.scoreToX(sd);
            return `
            <line x1="${x}" y1="${180 * sy}" x2="${x}" y2="${185 * sy}" stroke="#999" stroke-width="1"/>
            <text x="${x}" y="${195 * sy}" class="label" text-anchor="middle">${sd}σ</text>
          `;
          })
          .join('')}
        
        <!-- User position -->
        <line x1="${userX}" y1="${20 * sy}" x2="${userX}" y2="${180 * sy}" class="user-line"/>
        <circle cx="${userX}" cy="${userY}" r="5" class="user-marker"/>
        <text x="${userX}" y="${userY - 10}" class="user-label" text-anchor="middle">${this.emoji}</text>
        
        <!-- Other individuals -->
        ${positionedOthers
          .map(other => {
            const lineStartY = other.shifted
              ? other.y
              : other.y < userY - 10
                ? other.y + 5
                : 20 * sy;
            return `
            <g class="other-individual">
              <line x1="${other.x}" y1="${lineStartY}" x2="${other.x}" y2="${180 * sy}" stroke="#999" stroke-width="1" stroke-dasharray="2" opacity="0.5"/>
              <circle cx="${other.x}" cy="${other.y}" r="4" fill="#999" opacity="0.6" class="other-marker"/>
              <text x="${other.x}" y="${other.y - 8}" class="other-label" text-anchor="middle" opacity="0.8">${other.emoji}</text>
              <text x="${other.x}" y="5" class="hover-label" text-anchor="middle">${other.name}</text>
            </g>
          `;
          })
          .join('')}
        
        <!-- Percentile label -->
        <text x="200" y="${170 * sy}" class="percentile-text" fill="${score < 0 ? '#155724' : '#721c24'}">
          ${percentile}${this.getOrdinalSuffix(percentile)} percentile
        </text>
      </svg>
    `;
  }

  generateBellCurve(sy = 1) {
    const points = [];
    const maxHeight = 160 * sy;
    const peakY = 20 * sy;
    for (let x = 0; x <= 400; x += 2) {
      const score = (x - 200) / 50;
      const y = peakY + maxHeight - this.normalPDF(score) * maxHeight * 2.5;
      points.push(`${x},${y}`);
    }
    return `M ${points.join(' L ')}`;
  }

  normalPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  scoreToX(score) {
    // Clamp score to ±4σ for display
    const clampedScore = Math.max(-4, Math.min(4, score));
    return 200 + clampedScore * 50;
  }

  getYForX(score, sy = 1) {
    const maxHeight = 160 * sy;
    const peakY = 20 * sy;
    return peakY + maxHeight - this.normalPDF(score) * maxHeight * 2.5;
  }

  scoreToPercentile(score) {
    const z = Math.abs(score);
    let percentile =
      z < 1
        ? 50 + z * 34.13
        : z < 2
          ? 84.13 + (z - 1) * 13.59
          : z < 3
            ? 97.72 + (z - 2) * 2.14
            : 99.87;
    return Math.round(
      Math.max(1, Math.min(99, score < 0 ? 100 - percentile : percentile))
    );
  }

  getOrdinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }
}

customElements.define('risk-distribution', RiskDistribution);
