import { Debug } from '@asili/debug';
import { useAppStore } from '../lib/store.js';
import './import-progress.js';
import './emoji-builder.js';

export class IndividualManager extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.processor = null;
    this.unsubscribe = null;
    this.selectedFile = null;
    this.showingUpload = false;
    this.importAborted = false;
    this.editingIndividual = null; // individual being edited inline
  }

  async connectedCallback() {
    this.render();
    this.setupEventListeners();

    this.unsubscribe = useAppStore.subscribe(state => {
      this.updateUI(state);
    });
  }

  setProcessor(processor) {
    this.processor = processor;
    Debug.log('IndividualManager', 'External processor set');
    setTimeout(() => this.loadIndividuals(), 100);
  }

  async initializeProcessor() {
    try {
      const { AsiliProcessor } = await import('../lib/asili-processor.js');
      this.processor = new AsiliProcessor();
      await this.processor.initialize();
      Debug.log('IndividualManager', 'Processor initialized');
    } catch (error) {
      Debug.error('IndividualManager', 'Failed to initialize processor:', error);
    }
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.processor?.cleanup();
  }

  async loadIndividuals() {
    if (!this.processor?.storage) return;

    try {
      const individuals = await this.processor.storage.getIndividuals();
      const store = useAppStore.getState();

      Debug.log(1, 'IndividualManager', `Loaded ${individuals.length} individuals:`,
        individuals.map(ind => `${ind.name} (${ind.status})`));

      store.setIndividuals(individuals);

      const readyIndividuals = individuals.filter(
        ind => ind.status === 'ready' || ind.status === 'complete'
      );

      if (readyIndividuals.length > 0 && !store.selectedIndividual && store.uploadState === 'idle') {
        Debug.log(1, 'IndividualManager', `Auto-selecting individual: ${readyIndividuals[0].name}`);
        store.setSelectedIndividual(readyIndividuals[0].id);
      }
    } catch (error) {
      Debug.error('IndividualManager', 'Failed to load individuals:', error);
    }
  }

  updateUI(state) {
    const container = this.shadowRoot.getElementById('container');
    if (!container) return;

    if (state.individuals.length === 0) {
      this.renderNoDataState(state);
    } else if (state.individuals.length === 1) {
      this.renderSingleUserState(state);
    } else {
      this.renderMultipleUsersState(state);
    }

    // Update progress if importing or deleting
    if ((state.uploadState === 'importing' || state.uploadState === 'deleting') && state.uploadProgress) {
      const progressEl = this.shadowRoot.getElementById(
        state.uploadState === 'importing' ? 'importProgress' : 'deleteProgress'
      );
      if (progressEl) {
        const progressMatch = state.uploadProgress.match(/(\d+)%/);
        const percent = progressMatch ? parseInt(progressMatch[1]) : 0;
        const displayPercent = state.uploadState === 'deleting' ? 100 - percent : percent;
        progressEl.setProgress(displayPercent, state.uploadProgress);
      }
    }

    if (state.cancelImport) {
      this.cancelImport();
    }
  }

  // --- Edit panel ---

  renderEditPanel(individual) {
    return `
      <div class="edit-panel">
        <div class="edit-field">
          <label for="editName">Name</label>
          <input type="text" id="editName" value="${individual.name}" />
        </div>
        <emoji-builder id="emojiBuilder"></emoji-builder>
        <div class="edit-actions">
          <button class="danger-btn" id="editRemoveBtn">🗑️ Remove</button>
          <span class="edit-spacer"></span>
          <button class="secondary-btn" id="editCancelBtn">Cancel</button>
          <button class="primary-btn" id="editSaveBtn">Save</button>
        </div>
      </div>
    `;
  }

  setupEditListeners(individual) {
    const builder = this.shadowRoot.getElementById('emojiBuilder');
    if (builder) builder.value = individual.emoji || '👤';

    const nameInput = this.shadowRoot.getElementById('editName');
    nameInput?.focus();
    nameInput?.select();

    const saveBtn = this.shadowRoot.getElementById('editSaveBtn');
    const cancelBtn = this.shadowRoot.getElementById('editCancelBtn');
    const removeBtn = this.shadowRoot.getElementById('editRemoveBtn');

    if (nameInput) {
      nameInput.onkeydown = e => {
        if (e.key === 'Enter') this.saveEdit(individual.id);
        if (e.key === 'Escape') this.closeEdit();
      };
    }
    if (saveBtn) saveBtn.onclick = () => this.saveEdit(individual.id);
    if (cancelBtn) cancelBtn.onclick = () => this.closeEdit();
    if (removeBtn) removeBtn.onclick = () => this.removeIndividual(individual.id);
  }

  async saveEdit(individualId) {
    const nameInput = this.shadowRoot.getElementById('editName');
    const builder = this.shadowRoot.getElementById('emojiBuilder');
    const name = nameInput?.value.trim();
    if (!name) return;

    try {
      await this.processor.storage.updateIndividual(individualId, {
        name,
        emoji: builder?.value || '👤',
      });
      this.editingIndividual = null;
      await this.loadIndividuals();
    } catch (error) {
      Debug.error('IndividualManager', 'Failed to update individual:', error);
    }
  }

  closeEdit() {
    this.editingIndividual = null;
    this.updateUI(useAppStore.getState());
  }

  editIndividual(individual) {
    this.editingIndividual = individual;
    this.updateUI(useAppStore.getState());
  }

  // --- State renderers ---

  renderNoDataState(state) {
    const container = this.shadowRoot.getElementById('container');

    if (state.uploadState === 'importing') {
      container.innerHTML = `<import-progress id="importProgress" name="${state.importingIndividual?.name || ''}" emoji="${state.importingIndividual?.emoji || '👤'}"></import-progress>`;
    } else if (state.uploadState === 'deleting') {
      container.innerHTML = `<import-progress id="deleteProgress" name="Deleting ${state.importingIndividual?.name || 'Individual'}" emoji=""></import-progress>`;
    } else if (this.showingUpload) {
      container.innerHTML = this.renderUploadComponent();
      this.setupUploadListeners();
    } else {
      container.innerHTML = `
        <div class="no-data-state">
          <div class="welcome-message">
            <h3>Welcome to Asili</h3>
            <p>Import your DNA data to get started with personalized genomic risk analysis</p>
          </div>
          <button class="primary-btn" id="importBtn">📁 Import DNA Data</button>
        </div>
      `;
      this.shadowRoot.getElementById('importBtn').onclick = () => this.startImport();
    }
  }

  renderSingleUserState(state) {
    const individual = state.individuals[0];
    const container = this.shadowRoot.getElementById('container');

    if (state.uploadState === 'importing') {
      container.innerHTML = `<import-progress id="importProgress" name="${state.importingIndividual?.name || ''}" emoji="${state.importingIndividual?.emoji || '👤'}"></import-progress>`;
    } else if (state.uploadState === 'deleting') {
      container.innerHTML = '<import-progress id="deleteProgress" name="Deleting Data" emoji="🗑️"></import-progress>';
    } else if (this.showingUpload) {
      container.innerHTML = `
        <div class="single-user-state">
          <div class="individual-display">
            <span class="emoji">${individual.emoji || '👤'}</span>
            <span class="name">${individual.name}</span>
            <button class="edit-btn" id="editBtn">✏️</button>
          </div>
          ${this.renderUploadComponent()}
        </div>
      `;
      this.shadowRoot.getElementById('editBtn').onclick = () => this.editIndividual(individual);
      this.setupUploadListeners();
    } else if (this.editingIndividual?.id === individual.id) {
      container.innerHTML = `
        <div class="single-user-state">
          ${this.renderEditPanel(individual)}
        </div>
      `;
      this.setupEditListeners(individual);
    } else {
      const failed = individual.status !== 'complete' && individual.status !== 'ready';
      container.innerHTML = `
        <div class="single-user-state">
          <div class="individual-display">
            <span class="emoji" id="userEmoji">${individual.emoji || '👤'}</span>
            <span class="name ${failed ? 'failed' : ''}" id="userName">${individual.name}${failed ? ' (Failed Import)' : ''}</span>
            <button class="edit-btn" id="editBtn">✏️</button>
          </div>
          <div class="actions">
            <button class="secondary-btn" id="addBtn">+ Add Another</button>
            <button class="danger-btn" id="removeBtn">🗑️ Remove</button>
          </div>
        </div>
      `;
      this.shadowRoot.getElementById('editBtn').onclick = () => this.editIndividual(individual);
      this.shadowRoot.getElementById('addBtn').onclick = () => this.startImport();
      this.shadowRoot.getElementById('removeBtn').onclick = () => this.removeIndividual(individual.id);
    }
  }

  renderMultipleUsersState(state) {
    const container = this.shadowRoot.getElementById('container');

    if (state.uploadState === 'importing') {
      container.innerHTML = `<import-progress id="importProgress" name="${state.importingIndividual?.name || ''}" emoji="${state.importingIndividual?.emoji || '👤'}"></import-progress>`;
    } else if (state.uploadState === 'deleting') {
      container.innerHTML = '<import-progress id="deleteProgress" name="Deleting Data" emoji="🗑️"></import-progress>';
    } else {
      const selectedIndividual = state.individuals.find(i => i.id === state.selectedIndividual);

      const selectorHTML = `
        <div class="selector-row">
          <select id="individualSelect">
            ${state.individuals.map(ind => {
              const status = (ind.status === 'complete' || ind.status === 'ready') ? '' : ' (Failed Import)';
              return `<option value="${ind.id}" ${ind.id === state.selectedIndividual ? 'selected' : ''}>${ind.emoji || '👤'} ${ind.name}${status}</option>`;
            }).join('')}
          </select>
          <button class="edit-btn" id="editBtn">✏️</button>
        </div>
      `;

      if (this.showingUpload) {
        container.innerHTML = `<div class="multiple-users-state">${selectorHTML}${this.renderUploadComponent()}</div>`;
        this._bindSelect(state);
        this.shadowRoot.getElementById('editBtn').onclick = () => {
          if (selectedIndividual) this.editIndividual(selectedIndividual);
        };
        this.setupUploadListeners();
      } else if (this.editingIndividual && selectedIndividual?.id === this.editingIndividual.id) {
        container.innerHTML = `
          <div class="multiple-users-state">
            ${selectorHTML}
            ${this.renderEditPanel(selectedIndividual)}
          </div>
        `;
        this._bindSelect(state);
        this.shadowRoot.getElementById('editBtn').onclick = () => this.closeEdit();
        this.setupEditListeners(selectedIndividual);
      } else {
        container.innerHTML = `
          <div class="multiple-users-state">
            ${selectorHTML}
            <div class="actions">
              <button class="secondary-btn" id="addBtn">+ Add Individual</button>
              <button class="danger-btn" id="removeBtn">🗑️ Remove Current</button>
            </div>
          </div>
        `;
        this._bindSelect(state);
        this.shadowRoot.getElementById('editBtn').onclick = () => {
          if (selectedIndividual) this.editIndividual(selectedIndividual);
        };
        this.shadowRoot.getElementById('addBtn').onclick = () => this.startImport();
        this.shadowRoot.getElementById('removeBtn').onclick = () => {
          if (state.selectedIndividual) this.removeIndividual(state.selectedIndividual);
        };
      }
    }
  }

  _bindSelect(state) {
    const select = this.shadowRoot.getElementById('individualSelect');
    if (!select) return;
    select.onchange = e => {
      const selectedId = e.target.value;
      const individual = state.individuals.find(i => i.id === selectedId);
      const isReady = individual && (individual.status === 'ready' || individual.status === 'complete');
      this.editingIndividual = null; // close edit when switching
      useAppStore.getState().setSelectedIndividual(selectedId, isReady);
    };
  }

  // --- Upload ---

  renderUploadComponent() {
    const fileName = this.selectedFile ? this.selectedFile.name : '';
    const fileSize = this.selectedFile ? (this.selectedFile.size / 1024 / 1024).toFixed(1) : '';
    const defaultName = fileName.replace(/\.[^/.]+$/, '');

    return `
      <div class="upload-component">
        <div class="file-info">Selected: ${fileName} (${fileSize} MB)</div>
        <div class="upload-form">
          <div class="form-row">
            <input type="text" id="nameInput" placeholder="Individual name" value="${defaultName}" />
            <emoji-builder id="uploadEmojiBuilder"></emoji-builder>
          </div>
          <div class="form-actions">
            <button class="secondary-btn" id="cancelBtn">Cancel</button>
            <button class="primary-btn" id="importBtn">Import</button>
          </div>
        </div>
      </div>
    `;
  }

  startImport() {
    this.showingUpload = true;
    const fileInput = this.shadowRoot.getElementById('fileInput');
    fileInput.click();
  }

  setupEventListeners() {
    this.shadowRoot.addEventListener('change', e => {
      if (e.target.id === 'fileInput') {
        const file = e.target.files[0];
        if (file) {
          this.selectedFile = file;
          this.updateUI(useAppStore.getState());
        }
      }
    });
  }

  setupUploadListeners() {
    const nameInput = this.shadowRoot.getElementById('nameInput');
    const importBtn = this.shadowRoot.getElementById('importBtn');
    const cancelBtn = this.shadowRoot.getElementById('cancelBtn');

    if (nameInput) {
      nameInput.onkeydown = e => {
        if (e.key === 'Enter') this.importIndividual();
      };
    }
    if (importBtn) importBtn.onclick = () => this.importIndividual();
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        this.showingUpload = false;
        this.selectedFile = null;
        this.shadowRoot.getElementById('fileInput').value = '';
        this.updateUI(useAppStore.getState());
      };
    }
  }

  // --- Actions ---

  async removeIndividual(individualId) {
    if (!confirm('Remove all data for this individual? This cannot be undone.')) {
      const store = useAppStore.getState();
      store.cancelImport = false;
      this.importAborted = false;
      return;
    }

    const store = useAppStore.getState();
    this.editingIndividual = null;
    store.setUploadState('deleting', 'Starting deletion...');

    try {
      if (!this.processor) throw new Error('Processor not initialized');

      try {
        await this.processor.storage.deleteIndividual(individualId);
      } catch (error) {
        if (!error.message?.includes('404')) throw error;
      }

      if (store.selectedIndividual === individualId) {
        store.setSelectedIndividual(null);
      }
      store.setUploadState('idle');
      await this.loadIndividuals();
    } catch (error) {
      Debug.error('IndividualManager', 'Failed to remove individual:', error);
      store.setUploadState('idle');
      alert('Failed to remove individual');
    }
  }

  async importIndividual() {
    const nameInput = this.shadowRoot.getElementById('nameInput');
    const builder = this.shadowRoot.getElementById('uploadEmojiBuilder');

    const name = nameInput?.value.trim();
    const emoji = builder?.value || '👤';

    if (!name) { alert('Please enter a name'); return; }
    if (!this.selectedFile) { alert('Please select a file'); return; }

    const individualId = `${Date.now()}_${name.replace(/\s+/g, '_')}`;

    useAppStore.getState().setUploadState('importing', 'Starting import...', { name, emoji });

    this.showingUpload = false;
    this.updateUI(useAppStore.getState());

    try {
      this.importAborted = false;
      const result = await this.processor.importDNA(
        this.selectedFile, individualId, name, emoji,
        (message, percent) => {
          if (this.importAborted) throw new Error('Import cancelled by user');
          useAppStore.getState().setUploadState('importing', `${message} (${Math.round(percent)}%)`, { name, emoji });
        }
      );

      this.selectedFile = null;
      this.shadowRoot.getElementById('fileInput').value = '';

      await this.processor.storage.updateIndividual(individualId, { status: 'complete' });

      const store = useAppStore.getState();
      store.setUploadState('idle');
      await this.loadIndividuals();
      store.setSelectedIndividual(individualId, true);

      Debug.log('IndividualManager', 'Import completed successfully', result);
    } catch (error) {
      Debug.error('IndividualManager', 'Import error:', error);
      if (error.message === 'Import cancelled by user') {
        Debug.log('IndividualManager', 'Import cancelled by user');
      } else {
        const store = useAppStore.getState();
        store.setUploadState('idle');
        store.setSelectedIndividual(null);
        setTimeout(() => this.updateUI(store), 3000);
      }
    }
  }

  cancelImport() {
    Debug.log('IndividualManager', 'Cancel import called');
    const store = useAppStore.getState();
    const individualId = store.selectedIndividual;

    this.importAborted = true;
    store.cancelImport = false;

    if (individualId) {
      this.removeIndividual(individualId);
    } else {
      store.setUploadState('idle');
      store.setSelectedIndividual(null);
      this.showingUpload = false;
      this.selectedFile = null;
      this.shadowRoot.getElementById('fileInput').value = '';
      this.updateUI(store);
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; margin-bottom: 20px; }

        .no-data-state { text-align: center; padding: 40px 20px; }
        .welcome-message h3 { margin: 0 0 10px 0; color: #333; }
        .welcome-message p { margin: 0 0 30px 0; color: #666; }

        .single-user-state .individual-display,
        .multiple-users-state .selector-row {
          display: flex; align-items: center; gap: 10px; margin-bottom: 15px;
        }
        .emoji { font-size: 24px; }
        .name.failed { color: #dc3545; }
        .edit-btn { background: none; border: none; cursor: pointer; font-size: 16px; }
        .edit-btn:hover { opacity: 0.7; }

        select { padding: 8px; font-size: 14px; min-width: 200px; }
        select:disabled { opacity: 0.6; }

        .actions { display: flex; gap: 10px; }

        /* Edit panel */
        .edit-panel {
          background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px;
          padding: 15px; margin-top: 4px;
        }
        .edit-field { margin-bottom: 10px; }
        .edit-field label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; text-transform: uppercase; }
        .edit-field input {
          width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;
          font-size: 14px; box-sizing: border-box;
        }
        .edit-actions {
          display: flex; gap: 8px; align-items: center; margin-top: 12px;
        }
        .edit-spacer { flex: 1; }

        /* Upload */
        .upload-component {
          background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px;
          padding: 15px; margin-top: 10px;
        }
        .file-info { font-size: 14px; color: #666; margin-bottom: 10px; }
        .upload-form .form-row {
          display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px;
        }
        .upload-form input {
          padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;
        }
        .form-actions { display: flex; gap: 10px; justify-content: flex-end; }

        .primary-btn {
          background: #007acc; color: white; border: none; padding: 12px 24px;
          border-radius: 6px; cursor: pointer; font-size: 16px;
        }
        .primary-btn:hover { background: #005a99; }
        .secondary-btn {
          background: #f0f0f0; color: #333; border: 1px solid #ccc;
          padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;
        }
        .secondary-btn:hover { background: #e0e0e0; }
        .danger-btn {
          background: #dc3545; color: white; border: none;
          padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;
        }
        .danger-btn:hover { background: #c82333; }

        input[type="file"] { display: none; }
      </style>

      <div id="container"></div>
      <input type="file" id="fileInput" accept=".txt,.csv">
    `;
  }
}

customElements.define('individual-manager', IndividualManager);
