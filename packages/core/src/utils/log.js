/**
 * Structured logger for Asili
 *
 * Levels: error (0), warn (1), info (2), debug (3), trace (4)
 * Set via LOG_LEVEL env var (default: info)
 *
 * Usage:
 *   import { createLogger } from './log.js';
 *   const log = createLogger('ScoreEngine');
 *   log.info('Starting calculation', { traitId, pgsCount: 20 });
 *   log.debug('Query complete', { rows: 285, elapsed: '1.0s' });
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function getLevel() {
  // Node env var (server/container)
  if (typeof process !== 'undefined' && process.env?.LOG_LEVEL) {
    return LEVELS[process.env.LOG_LEVEL.toLowerCase()] ?? LEVELS.info;
  }
  // Browser global
  if (typeof window !== 'undefined' && window.LOG_LEVEL) {
    return LEVELS[window.LOG_LEVEL.toLowerCase()] ?? LEVELS.info;
  }
  return LEVELS.info;
}

function elapsed(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(1) + 's';
}

function fmt(component, msg) {
  const now = new Date();
  const ts = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return `${ts} [${component}] ${msg}`;
}

export function createLogger(component) {
  return {
    error: (msg, ...args) =>
      console.error(fmt(component, `❌ ${msg}`), ...args),
    warn: (msg, ...args) => {
      if (getLevel() >= LEVELS.warn)
        console.warn(fmt(component, `⚠️ ${msg}`), ...args);
    },
    info: (msg, ...args) => {
      if (getLevel() >= LEVELS.info) console.log(fmt(component, msg), ...args);
    },
    debug: (msg, ...args) => {
      if (getLevel() >= LEVELS.debug) console.log(fmt(component, msg), ...args);
    },
    trace: (msg, ...args) => {
      if (getLevel() >= LEVELS.trace) console.log(fmt(component, msg), ...args);
    },
    /** Helper: log elapsed time since startMs */
    elapsed
  };
}
