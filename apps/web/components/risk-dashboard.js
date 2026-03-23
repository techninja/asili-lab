import { Debug } from '@asili/debug';
import { useAppStore } from '../lib/store.js';
import { useTraitStore } from '../lib/trait-store.js';
import { TraitDataService } from '../lib/trait-data-service.js';
import { TraitCacheManager } from '../lib/trait-cache-manager.js';
import './pgs-breakdown.js';
import './trait-card.js';
import './results-summary.js';

export class RiskDashboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.processor = null;
    this.queueManager = null;
    this.availableTraits = [];
    this.traitDataService = null;
    this.traitCache = new TraitCacheManager();
    this.unsubscribe = null;
    this.windowSize = 50;
    this.currentWindow = 0;
    this.cacheLoaded = false;
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.subscribeToStore();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.traitDataService?.destroy();
  }

  setProcessor(processor) {
    this.processor = processor;
    window.__asiliProcessor = processor; // Expose for trait cards
    this.queueManager = processor.getQueueManager();
    this.traitDataService = new TraitDataService(processor, this.queueManager);
    this.traitDataService.subscribeToQueueEvents();

    // Render immediately with empty state
    this.filterTraits();

    // Load traits with subscription
    this.loadAvailableTraitsWithStreaming();
  }

  async loadAvailableTraitsWithStreaming() {
    Debug.log(1, 'RiskDashboard', 'loadAvailableTraitsWithStreaming called');
    if (!this.processor) {
      Debug.log(1, 'RiskDashboard', 'No processor available');
      return;
    }

    try {
      // Load traits directly from manifest
      Debug.log(1, 'RiskDashboard', 'Loading traits from manifest');

      // Use generated_at timestamp for cache busting
      const cachedTimestamp = localStorage.getItem('trait_manifest_timestamp');
      const url = cachedTimestamp
        ? `/data/trait_manifest.json?t=${cachedTimestamp}`
        : '/data/trait_manifest.json';

      const response = await fetch(url);
      const manifest = await response.json();

      // Update cached timestamp if changed
      if (manifest.generated_at && manifest.generated_at !== cachedTimestamp) {
        localStorage.setItem('trait_manifest_timestamp', manifest.generated_at);
        Debug.log(
          2,
          'RiskDashboard',
          `Manifest updated: ${manifest.generated_at}`
        );
      }

      // Debug first trait from manifest
      const firstTraitId = Object.keys(manifest.traits)[0];
      const firstTrait = manifest.traits[firstTraitId];
      Debug.log(
        2,
        'RiskDashboard',
        `Sample manifest trait (${firstTraitId}):`,
        firstTrait
      );
      Debug.log(
        2,
        'RiskDashboard',
        `Categories in manifest:`,
        firstTrait.categories
      );

      this.availableTraits = Object.values(manifest.traits).map(trait => {
        const mapped = {
          id: trait.trait_id,
          name: trait.name,
          description: trait.description,
          categories: trait.categories || [],
          emoji: trait.emoji || '',
          trait_type: trait.trait_type || 'disease_risk',
          unit: trait.unit || null,
          file_path: trait.file_path,
          variant_count: trait.expected_variants || 0,
          pgs_count: trait.pgs_count || 0
        };
        return mapped;
      });

      Debug.log(
        1,
        'RiskDashboard',
        `Loaded ${this.availableTraits.length} traits from manifest`
      );
      Debug.log(
        2,
        'RiskDashboard',
        `First mapped trait:`,
        this.availableTraits[0]
      );
      Debug.log(
        2,
        'RiskDashboard',
        `First mapped trait categories:`,
        this.availableTraits[0].categories
      );
      this.populateCategoryFilter();
      this.filterTraits();

      // Load risk results if individual is selected
      const state = useAppStore.getState();
      if (state.selectedIndividual) {
        this.loadCachedRiskDataFromIndexedDB(state.selectedIndividual);
        this.cacheLoaded = true;
      }
    } catch (error) {
      Debug.error('RiskDashboard', 'Failed to load traits:', error);
    }
  }

  setupEventListeners() {
    // Filter controls
    ['searchInput', 'categorySelect', 'sortSelect', 'statusSelect'].forEach(
      id => {
        this.shadowRoot
          .getElementById(id)
          ?.addEventListener('change', () => this.filterTraits());
        this.shadowRoot
          .getElementById(id)
          ?.addEventListener('input', () => this.filterTraits());
      }
    );

    // Queue all button
    this.shadowRoot
      .getElementById('queueAllBtn')
      ?.addEventListener('click', () => this.queueAllTraits());

    // Trait card events
    this.addEventListener('add-to-queue', e => {
      const { traitId, individualId } = e.detail;
      const trait = this.availableTraits.find(t => t.id === traitId);
      this.traitDataService?.addToQueue(traitId, individualId, trait);
    });
  }

  subscribeToStore() {
    this.unsubscribe = useAppStore.subscribe(state => {
      if (this.lastIndividual !== state.selectedIndividual) {
        Debug.log(
          1,
          'RiskDashboard',
          `Individual changed: ${this.lastIndividual} -> ${state.selectedIndividual}`
        );
        this.traitDataService?.clearAllTraitData();
        this.lastIndividual = state.selectedIndividual;
        this.cacheLoaded = false;

        // Load risk results from IndexedDB when individual changes
        Debug.log(
          1,
          'RiskDashboard',
          `Checking cache load on individual change: traits=${this.availableTraits.length}`
        );
        if (state.selectedIndividual && this.availableTraits.length > 0) {
          this.loadCachedRiskDataFromIndexedDB(state.selectedIndividual);
          this.cacheLoaded = true;
        }
      }
      this.updateDisplay(state);
    });
  }

  updateDisplay(state) {
    const grid = this.shadowRoot.getElementById('traitsGrid');
    if (!grid) return;

    if (!state.selectedIndividual || !state.individualReady) {
      grid.innerHTML =
        state.individuals.length === 0
          ? '<div class="loading">Import DNA data to start analyzing genomic risk</div>'
          : '<div class="loading">Select an individual to view genomic risk analysis</div>';
      return;
    }

    if (this.availableTraits.length === 0) {
      grid.innerHTML = '<div class="loading">Loading traits...</div>';
      return;
    }

    this.filterTraits();
  }

  populateCategoryFilter() {
    const categorySelect = this.shadowRoot.getElementById('categorySelect');
    if (!categorySelect) return;

    const categories = new Set();
    this.availableTraits.forEach(trait => {
      trait.categories?.forEach(cat => categories.add(cat));
    });

    const sortedCategories = Array.from(categories).sort((a, b) => {
      if (a === 'Other Conditions') return 1;
      if (b === 'Other Conditions') return -1;
      return a.localeCompare(b);
    });

    // Clear existing options except "All Categories"
    while (categorySelect.children.length > 1) {
      categorySelect.removeChild(categorySelect.lastChild);
    }

    sortedCategories.forEach(category => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      categorySelect.appendChild(option);
    });
  }

  async filterTraits() {
    const state = useAppStore.getState();
    if (!state.selectedIndividual) {
      Debug.log(2, 'RiskDashboard', 'No individual selected, skipping filter');
      return;
    }

    const searchInput = this.shadowRoot.getElementById('searchInput');
    const categorySelect = this.shadowRoot.getElementById('categorySelect');
    const statusSelect = this.shadowRoot.getElementById('statusSelect');
    const sortSelect = this.shadowRoot.getElementById('sortSelect');
    const filterStats = this.shadowRoot.getElementById('filterStats');
    const grid = this.shadowRoot.getElementById('traitsGrid');

    if (
      !searchInput ||
      !categorySelect ||
      !statusSelect ||
      !sortSelect ||
      !filterStats ||
      !grid
    )
      return;

    const searchTerm = searchInput.value.toLowerCase().trim();
    const selectedCategory = categorySelect.value;
    const selectedStatus = statusSelect.value;
    const sortBy = sortSelect.value;

    Debug.log(
      2,
      'RiskDashboard',
      `Filtering ${this.availableTraits.length} traits`
    );

    // Filter traits
    let filteredTraits = this.availableTraits.filter(trait => {
      const matchesSearch =
        !searchTerm ||
        trait.name.toLowerCase().includes(searchTerm) ||
        trait.description?.toLowerCase().includes(searchTerm) ||
        trait.categories?.some(cat => cat.toLowerCase().includes(searchTerm));

      const matchesCategory =
        !selectedCategory || trait.categories?.includes(selectedCategory);

      if (selectedStatus === 'calculated') {
        const state = useTraitStore.getState().getTraitState(trait.id);
        if (!state.cached) return false;
      } else if (selectedStatus === 'pending') {
        const state = useTraitStore.getState().getTraitState(trait.id);
        if (state.cached) return false;
      }

      return matchesSearch && matchesCategory;
    });

    // Sort traits
    filteredTraits.sort((a, b) => {
      switch (sortBy) {
        case 'risk-score': {
          const aState = useTraitStore.getState().getTraitState(a.id);
          const bState = useTraitStore.getState().getTraitState(b.id);
          const aPercentile = this.getPercentile(aState.cached);
          const bPercentile = this.getPercentile(bState.cached);

          // Calculated first, sorted by distance from 50th percentile (most extreme first)
          if (aPercentile !== null && bPercentile !== null) {
            return Math.abs(bPercentile - 50) - Math.abs(aPercentile - 50);
          }
          if (aPercentile !== null) return -1;
          if (bPercentile !== null) return 1;
          return a.name.localeCompare(b.name);
        }
        case 'name':
          return a.name.localeCompare(b.name);
        case 'category': {
          const aCat = a.categories?.[0] || 'zzz';
          const bCat = b.categories?.[0] || 'zzz';
          return aCat.localeCompare(bCat) || a.name.localeCompare(b.name);
        }
        default:
          return a.name.localeCompare(b.name);
      }
    });

    Debug.log(
      1,
      'RiskDashboard',
      `Rendering ${filteredTraits.length} filtered traits`
    );
    filterStats.textContent = `Showing ${filteredTraits.length} of ${this.availableTraits.length} traits`;

    // Update results summary chart
    const summary = this.shadowRoot.querySelector('results-summary');
    if (summary) summary.setTraits(this.availableTraits);

    await this.renderTraits(filteredTraits, state.selectedIndividual);
  }

  getPercentile(cached) {
    if (!cached) return null;
    if (cached.percentile != null) return Math.round(cached.percentile);
    const z = this.calculateZScore(cached.pgsDetails);
    if (z === null) return null;
    const erf = x => {
      const sign = x >= 0 ? 1 : -1;
      x = Math.abs(x);
      const t = 1.0 / (1.0 + 0.3275911 * x);
      const y = 1.0 - (((((1.061405429 * t + -1.453152027) * t + 1.421413741) * t + -0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
      return sign * y;
    };
    return Math.round(Math.max(1, Math.min(99, 0.5 * (1 + erf(z / Math.sqrt(2))) * 100)));
  }

  calculateZScore(pgsDetails) {
    if (!pgsDetails) return null;

    const zScores = Object.values(pgsDetails)
      .map(details => details.zScore)
      .filter(z => z !== null && z !== undefined && !isNaN(z));

    if (zScores.length === 0) return null;

    // Use median for robustness against outliers
    const sorted = zScores.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  async renderTraits(traits, individualId) {
    const grid = this.shadowRoot.getElementById('traitsGrid');

    const state = useAppStore.getState();
    const individual = state.individuals.find(ind => ind.id === individualId);
    const individualEmoji = individual?.emoji || '👤';

    if (traits.length === 0) {
      grid.innerHTML = '<div class="loading">No traits match your filters</div>';
      return;
    }

    grid.innerHTML = '';

    const flatGrid = document.createElement('div');
    flatGrid.className = 'trait-grid';

    const windowEnd = Math.min(this.windowSize, traits.length);
    for (let i = 0; i < windowEnd; i++) {
      const card = document.createElement('trait-card');
      card.setData(traits[i], individualId, individualEmoji);
      flatGrid.appendChild(card);
    }

    if (traits.length > this.windowSize) {
      const loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = `Load ${Math.min(this.windowSize, traits.length - windowEnd)} more traits...`;
      loadMore.onclick = () =>
        this.loadMoreTraits(flatGrid, traits, windowEnd, individualId, individualEmoji);
      flatGrid.appendChild(loadMore);
    }

    grid.appendChild(flatGrid);
  }

  async loadCachedRiskDataFromIndexedDB(individualId) {
    Debug.log(
      1,
      'RiskDashboard',
      `Loading cached risk results for ${individualId}`
    );

    if (!this.processor) return;

    // Load in background without blocking UI
    this.loadCacheInBackground(individualId);
  }

  async loadCacheInBackground(individualId) {
    try {
      if (!this.processor.localProcessor) {
        Debug.log(1, 'RiskDashboard', 'Initializing local processor');
        this.processor.localProcessor = new (
          await import('../lib/asili-processor.js')
        ).AsiliProcessor();
        await this.processor.localProcessor.initialize();
        Debug.log(1, 'RiskDashboard', 'Local processor initialized');
      }

      const storage = this.processor.localProcessor.unifiedProcessor?.storage;
      if (!storage) {
        Debug.log(1, 'RiskDashboard', 'No storage available');
        return;
      }

      Debug.log(1, 'RiskDashboard', 'Loading from IndexedDB');

      const db = await storage._getDB();
      const transaction = db.transaction(['risk_scores'], 'readonly');
      const store = transaction.objectStore('risk_scores');
      const index = store.index('individualId');
      const request = index.getAll(individualId);

      request.onsuccess = async () => {
        const results = request.result;
        Debug.log(
          1,
          'RiskDashboard',
          `Found ${results.length} results in IndexedDB`
        );

        if (results.length > 0) {
          useTraitStore.getState().setTraitCacheBatch(
            results.map(result => ({
              traitId: result.traitId,
              cached: result
            }))
          );
          Debug.log(
            1,
            'RiskDashboard',
            `Loaded ${results.length} cached risk results`
          );
        } else {
          Debug.log(
            1,
            'RiskDashboard',
            'IndexedDB empty - trait cards will load results on-demand'
          );
        }
      };

      request.onerror = () => {
        Debug.log(1, 'RiskDashboard', 'Failed to load from IndexedDB');
      };
    } catch (error) {
      Debug.log(1, 'RiskDashboard', `Cache load error: ${error.message}`);
    }
  }

  async loadCachedRiskData(traits, individualId) {
    if (!this.processor) return;

    Debug.log(
      1,
      'RiskDashboard',
      `Loading cached risk data for ${individualId}`
    );

    // Ensure processor is initialized
    if (!this.processor.localProcessor) {
      await this.processor.getAllTraits();
      await this.processor.localProcessor.initialize();
    }

    const storage = this.processor.localProcessor.unifiedProcessor.storage;

    // First, sync from server risk_scores.db to IndexedDB
    if (this.processor.shouldUseServer?.()) {
      Debug.log(
        1,
        'RiskDashboard',
        'Syncing risk results from server DB to IndexedDB'
      );
      await this.processor.getCachedResult(individualId, traits[0]?.id);

      if (this.processor.cacheData) {
        const individualCache = this.processor.cacheData.filter(
          r => r.individual_id === individualId
        );
        Debug.log(
          1,
          'RiskDashboard',
          `Syncing ${individualCache.length} results to IndexedDB`
        );

        for (const row of individualCache) {
          await storage.storeRiskScore(individualId, row.trait_id, {
            riskScore: row.risk_score,
            pgsBreakdown: JSON.parse(row.pgs_breakdown || '{}'),
            pgsDetails: JSON.parse(row.pgs_details || '{}'),
            matchedVariants: row.matched_variants,
            totalVariants: row.total_variants,
            traitLastUpdated: row.trait_last_updated
          });
        }
      }
    }

    // Now load from IndexedDB
    const db = await storage._getDB();

    return new Promise(resolve => {
      const transaction = db.transaction(['risk_scores'], 'readonly');
      const store = transaction.objectStore('risk_scores');
      const request = store.openCursor();

      const results = [];
      request.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value.individualId === individualId) {
            results.push(cursor.value);
          }
          cursor.continue();
        } else {
          Debug.log(
            1,
            'RiskDashboard',
            `Found ${results.length} cached results, updating trait store`
          );
          for (const row of results) {
            const cached = {
              riskScore: row.riskScore,
              pgsBreakdown: row.pgsBreakdown,
              pgsDetails: row.pgsDetails,
              matchedVariants: row.matchedVariants,
              totalVariants: row.totalVariants,
              traitLastUpdated: row.traitLastUpdated,
              calculatedAt: new Date(row.calculatedAt).toISOString()
            };
            useTraitStore.getState().setTraitCache(row.traitId, cached);
          }
          resolve();
        }
      };
    });
  }

  loadMoreTraits(grid, allTraits, currentIndex, individualId, individualEmoji) {
    const loadMoreBtn = grid.querySelector('.load-more-btn');
    const nextWindow = Math.min(currentIndex + this.windowSize, allTraits.length);

    for (let i = currentIndex; i < nextWindow; i++) {
      const card = document.createElement('trait-card');
      card.setData(allTraits[i], individualId, individualEmoji);
      grid.insertBefore(card, loadMoreBtn);
    }

    if (nextWindow >= allTraits.length) {
      loadMoreBtn.remove();
    } else {
      loadMoreBtn.textContent = `Load ${Math.min(this.windowSize, allTraits.length - nextWindow)} more traits...`;
      loadMoreBtn.onclick = () =>
        this.loadMoreTraits(grid, allTraits, nextWindow, individualId, individualEmoji);
    }
  }

  async queueAllTraits() {
    const state = useAppStore.getState();
    if (!state.selectedIndividual || !this.traitDataService) return;

    // Get completed traits from server
    const completedTraitIds = new Set();
    try {
      const response = await fetch('/status');
      const data = await response.json();
      const cachedCount =
        data.progress?.cachedByIndividual?.[state.selectedIndividual] || 0;

      if (cachedCount > 0) {
        // Get actual cached trait IDs from IndexedDB
        const storage =
          this.processor.localProcessor?.unifiedProcessor?.storage;
        if (storage) {
          const db = await storage._getDB();
          const transaction = db.transaction(['risk_scores'], 'readonly');
          const store = transaction.objectStore('risk_scores');
          const request = store.openCursor();

          await new Promise(resolve => {
            request.onsuccess = e => {
              const cursor = e.target.result;
              if (cursor) {
                if (cursor.value.individualId === state.selectedIndividual) {
                  completedTraitIds.add(cursor.value.traitId);
                }
                cursor.continue();
              } else {
                resolve();
              }
            };
          });
        }
      }
    } catch (error) {
      console.error('Failed to load completed traits:', error);
    }

    // Get queued traits
    const queuedTraitIds = new Set();
    const queue = this.queueManager?.getQueue() || [];
    queue.forEach(item => {
      if (item.individualId === state.selectedIndividual) {
        queuedTraitIds.add(item.traitId);
      }
    });

    // Queue traits in background with delays to avoid blocking UI
    const traitsToQueue = this.availableTraits.filter(
      trait => !completedTraitIds.has(trait.id) && !queuedTraitIds.has(trait.id)
    );

    console.log(
      `Queueing ${traitsToQueue.length} traits (${completedTraitIds.size} already completed, ${queuedTraitIds.size} already queued)`
    );

    // Add traits in batches with delays
    const batchSize = 10;
    for (let i = 0; i < traitsToQueue.length; i += batchSize) {
      const batch = traitsToQueue.slice(i, i + batchSize);
      batch.forEach(trait => {
        this.traitDataService.addToQueue(
          trait.id,
          state.selectedIndividual,
          trait
        );
      });

      // Yield to UI every batch
      if (i + batchSize < traitsToQueue.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        .filter-bar {
          background: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 12px 15px;
          margin-bottom: 20px;
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .filter-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .filter-group label {
          font-size: 13px;
          font-weight: 500;
          color: #495057;
        }
        .search-input, .category-select, .sort-select, .status-select {
          padding: 5px 10px;
          border: 1px solid #ced4da;
          border-radius: 4px;
          font-size: 13px;
        }
        .search-input { width: 180px; }
        .category-select, .status-select { min-width: 130px; }
        .filter-stats {
          margin-left: auto;
          font-size: 12px;
          color: #6c757d;
        }
        .queue-all-btn {
          padding: 5px 10px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: bold;
        }
        .queue-all-btn:hover { background: #218838; }
        .trait-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
          gap: 20px;
        }
        .load-more-btn {
          grid-column: 1 / -1;
          padding: 12px;
          background: #f8f9fa;
          border: 2px dashed #dee2e6;
          border-radius: 8px;
          cursor: pointer;
          color: #495057;
          font-size: 14px;
          font-weight: 500;
        }
        .load-more-btn:hover {
          background: #e9ecef;
          border-color: #adb5bd;
        }
        .loading {
          color: #666;
          font-style: italic;
          text-align: center;
          padding: 40px;
        }
      </style>
      <results-summary></results-summary>
      <div class="filter-bar">
        <div class="filter-group">
          <input type="text" class="search-input" placeholder="Search traits..." id="searchInput">
        </div>
        <div class="filter-group">
          <select class="category-select" id="categorySelect">
            <option value="">All Categories</option>
          </select>
        </div>
        <div class="filter-group">
          <select class="status-select" id="statusSelect">
            <option value="">All</option>
            <option value="calculated">Calculated</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Sort:</label>
          <select class="sort-select" id="sortSelect">
            <option value="category" selected>Category</option>
            <option value="name">Name (A-Z)</option>
            <option value="risk-score">Risk Score</option>
          </select>
        </div>
        <div class="filter-stats" id="filterStats">Showing 0 traits</div>
        <button class="queue-all-btn" id="queueAllBtn">🚀 Queue All</button>
      </div>
      <div id="traitsGrid">
        <div class="loading">Loading traits...</div>
      </div>
    `;
  }
}

customElements.define('risk-dashboard', RiskDashboard);
