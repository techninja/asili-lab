import { describe, it, expect } from 'vitest';
import { ProgressTracker, PROGRESS_STAGES, PROGRESS_SUBSTAGES } from '../src/progress/index.js';
import { BasicRiskCalculator } from '../src/risk-calculator/basic.js';

describe('ProgressTracker', () => {
  it('emits progress updates to subscribers', () => {
    const tracker = new ProgressTracker();
    const updates = [];

    const unsubscribe = tracker.subscribe(status => updates.push({ ...status }));

    tracker.setStage(PROGRESS_STAGES.INITIALIZING, 'Starting up...');
    tracker.setProgress(25, 'Loading components...');
    tracker.setSubstage(PROGRESS_SUBSTAGES.FETCHING_TRAITS, 'Fetching trait data...');
    tracker.setProgress(50, 'Processing data...');
    tracker.complete('All done!');

    unsubscribe();

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].progress).toBe(100);
  });
});

describe('BasicRiskCalculator', () => {
  it('calculates risk from mock data', async () => {
    const calculator = new BasicRiskCalculator({
      populationMean: 0,
      populationStd: 1
    });

    const dnaData = {
      format: 'test',
      variants: [
        { rsid: 'rs123', genotype: 'AA', chromosome: '1', position: 1000 },
        { rsid: 'rs456', genotype: 'AG', chromosome: '2', position: 2000 },
        { rsid: 'rs789', genotype: 'GG', chromosome: '3', position: 3000 }
      ],
      metadata: { source: 'test' }
    };

    const trait = { id: 'test_trait', name: 'Test Trait', category: 'test', pgsIds: ['PGS000001'] };

    const pgsData = {
      id: 'test_pgs',
      type: 'pgs',
      variants: [
        { rsid: 'rs123', effectAllele: 'A', effectWeight: 0.5 },
        { rsid: 'rs456', effectAllele: 'G', effectWeight: -0.3 },
        { rsid: 'rs789', effectAllele: 'G', effectWeight: 0.8 }
      ],
      metadata: { source: 'test' }
    };

    const result = await calculator.calculateRisk(dnaData, trait, pgsData);

    expect(result.traitId).toBe(trait.id);
    expect(typeof result.score).toBe('number');
    expect(typeof result.percentile).toBe('number');
    expect(result.interpretation).toBeTruthy();
    expect(result.metadata).toBeTruthy();
  });
});
