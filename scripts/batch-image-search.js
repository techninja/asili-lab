#!/usr/bin/env node

/**
 * Batch search Unsplash for trait cover images.
 * Uses the asili-web search-images.js env for the API key.
 *
 * Usage: node scripts/batch-image-search.js
 * Output: JSON map of trait_id → top image result
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_ROOT = resolve(ROOT, '../asili-web');

// Load env from asili-web
for (const name of ['.env', '.env.local']) {
  const envPath = resolve(WEB_ROOT, name);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
if (!ACCESS_KEY) { console.error('Missing UNSPLASH_ACCESS_KEY'); process.exit(1); }

// Curated search queries — abstract/evocative, not clinical
const QUERIES = {
  EFO_0004340: 'fitness scale healthy lifestyle',
  OBA_VT0001253: 'tall person standing architecture',
  EFO_0004612: 'healthy heart olive oil mediterranean',
  EFO_0004530: 'blood test laboratory vial',
  EFO_0004574: 'cholesterol healthy food avocado',
  EFO_0006335: 'blood pressure measurement health',
  EFO_0006336: 'heart health stethoscope calm',
  EFO_0005106: 'body composition fitness athlete',
  OBA_VT0000217: 'immune system white blood cells microscope',
  OBA_1000968: 'sunshine vitamin D outdoors',
  EFO_0004541: 'blood sugar diabetes glucose monitor',
  OBA_VT0000188: 'blood glucose test strip',
  EFO_0006527: 'cigarette smoke habit',
  OBA_1000840: 'wine glass social drinking',
  EFO_0004458: 'inflammation health wellness',
  EFO_0004338: 'weight scale bathroom morning',
  EFO_0004343: 'body shape measurement tape',
  OBA_1001085: 'waist measurement fitness',
  EFO_0007788: 'body proportions fitness mirror',
  OBA_1001087: 'heartbeat pulse wrist watch',
  EFO_0007825: 'hair loss baldness man',
  EFO_0008328: 'sunrise morning person alarm clock',
  EFO_0007660: 'anxiety emotion mood portrait',
  OBA_1000110: 'skeleton bones xray strength',
  EFO_0004620: 'vitamin supplement pills health',
  EFO_0004531: 'kidney health crystal uric acid',
  EFO_0004703: 'teenage girl growing up adolescence',
  EFO_0004704: 'mature woman aging gracefully',
  EFO_0004713: 'breathing lungs spirometry',
  EFO_0004312: 'deep breath lungs fresh air',
  EFO_0006925: 'heart artery cardiovascular',
  EFO_0004697: 'hormones women health flowers',
  EFO_0007777: 'metabolism energy fire flame',
  EFO_0004587: 'immune system defense shield',
  EFO_0004842: 'allergy immune response pollen',
  EFO_0005091: 'immune cells defense biology',
  EFO_0006781: 'coffee cup morning beans',
  EFO_0004279: 'suntan beach skin sun',
  EFO_0005035: 'brain memory hippocampus neuroscience',
  EFO_0007794: 'nicotine cigarette metabolism',
  EFO_0009102: 'family children parenthood',
  EFO_0004695: 'eye pressure glaucoma vision',
  EFO_0004309: 'blood platelets clotting bandage',
  EFO_0004305: 'red blood cells microscope',
  EFO_0007800: 'body fat fitness calipers',
  OBA_1000032: 'hip measurement body shape',
  EFO_0004344: 'newborn baby birth weight',
  HP_0001000: 'skin tone diversity melanin',
  HP_0000545: 'eyeglasses myopia nearsighted reading',
  EFO_0004833: 'white blood cells neutrophil defense',
  EFO_0004348: 'blood sample test tube hematology',
  EFO_0009188: 'red blood cells variation size',
  EFO_0004527: 'hemoglobin blood oxygen red',
  EFO_0004611: 'cholesterol artery heart health',
  EFO_0004682: 'electrocardiogram ECG heart rhythm',
  EFO_0005763: 'blood pressure pulse wave',
  OBA_1001005: 'kidney function creatinine lab',
  OBA_0003747: 'kidney filtration health organ',
  EFO_0004908: 'testosterone strength hormone muscle',
  EFO_0004337: 'brain intelligence thinking puzzle',
  EFO_0008579: 'risk taking adventure skydiving',
  EFO_0004315: 'drinking alcohol social bar',
  EFO_0005670: 'smoking cigarette first light',
  EFO_0004698: 'insomnia sleepless night bed',
};

async function search(query) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${ACCESS_KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  // Prefer images with descriptions, fall back to any
  const withDesc = data.results.filter(img => img.description && img.description.length > 10);
  const best = withDesc[0] || data.results[0];
  if (!best) return null;
  return {
    unsplash_id: best.id,
    url: best.urls.regular,
    thumb: best.urls.small,
    photographer: best.user.name,
    photographer_username: best.user.username,
    description: best.description || best.alt_description || '',
  };
}

const results = {};
const entries = Object.entries(QUERIES);

for (let i = 0; i < entries.length; i++) {
  const [traitId, query] = entries[i];
  try {
    // Rate limit: Unsplash allows 50 req/hr for demo apps
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    const img = await search(query);
    if (img) {
      results[traitId] = img;
      console.error(`[${i + 1}/${entries.length}] ${traitId}: ✓ ${img.unsplash_id} — ${img.photographer}`);
    } else {
      console.error(`[${i + 1}/${entries.length}] ${traitId}: ✗ no results`);
    }
  } catch (e) {
    console.error(`[${i + 1}/${entries.length}] ${traitId}: ✗ ${e.message}`);
  }
}

console.log(JSON.stringify(results, null, 2));
