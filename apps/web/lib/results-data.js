import { useAppStore as _useAppStore } from './store.js';

let summaryCache = null;

// Returns Map<individualId, row[]> where each row has the full joined data
export async function fetchChartData() {
  if (summaryCache) return summaryCache;

  try {
    const res = await fetch('/api/charts/summary');
    if (!res.ok) return new Map();
    const rows = await res.json();

    const byIndividual = new Map();
    for (const row of rows) {
      if (!byIndividual.has(row.individual_id))
        byIndividual.set(row.individual_id, []);
      byIndividual.get(row.individual_id).push(row);
    }
    summaryCache = byIndividual;
    return byIndividual;
  } catch {
    return new Map();
  }
}

export function invalidateCache() {
  summaryCache = null;
}
