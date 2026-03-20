// Core interfaces
export * from './interfaces/index.js';

// Progress tracking
export * from './progress/index.js';

// Queue management
export * from './queue/index.js';

// Utilities
export { Debug } from './utils/debug.js';

// Storage
export { BrowserStorageManager } from './storage-manager/browser.js';
export { BasicRiskCalculator } from './risk-calculator/basic.js';

// V2 genomic processor (scorer + calculator + DNA sources)
// Note: DuckDBServerAdapter is server-only (imports os, fs) — import directly from adapters/duckdb-server.js
export { PGSScorer, SharedRiskCalculator, createDNASource } from './genomic-processor/index.js';

// TODO: Browser processor still uses old BrowserGenomicProcessor path.
// Migrate to v2 scorer + duckdb-browser adapter when browser-only mode is prioritized.
// Browser-specific unified processor (no Node.js imports)
export {
  UnifiedProcessor as BrowserUnifiedProcessor,
  createBrowserProcessor
} from './unified-processor-browser.js';

// Full unified processor (with Node.js imports for server)
export {
  UnifiedProcessor,
  createServerProcessor,
  createProcessor
} from './unified-processor.js';
