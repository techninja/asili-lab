#!/usr/bin/env node

import chalk from 'chalk';
import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllTraits } from './lib/trait-db.js';
import { closeConnection } from './lib/shared-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, 'trait_overrides.json');

// Common reference values from literature
const COMMON_REFERENCES = {
  // Anthropometric (UK Biobank)
  'body mass index': { mean: 27.4, sd: 4.8, pop: 'UK Biobank' },
  'bmi': { mean: 27.4, sd: 4.8, pop: 'UK Biobank' },
  'height': { mean: 168.5, sd: 9.3, pop: 'UK Biobank (mixed sex)' },
  'weight': { mean: 78.0, sd: 15.5, pop: 'UK Biobank' },
  'waist': { mean: 0.87, sd: 0.07, pop: 'UK Biobank' },
  'body fat': { mean: 25.0, sd: 8.5, pop: 'UK Biobank' },
  'body composition': { mean: 25.0, sd: 8.5, pop: 'UK Biobank' },
  'lean mass': { mean: 50.0, sd: 11.0, pop: 'UK Biobank' },
  'bone density': { mean: 0.0, sd: 1.0, pop: 'T-score reference' },
  'grip strength': { mean: 30.0, sd: 11.0, pop: 'UK Biobank (mixed sex)' },
  'metabolic rate': { mean: 1600, sd: 250, pop: 'UK Biobank' },

  // Lipids (NHANES, mg/dL)
  triglyceride: { mean: 150, sd: 90, pop: 'NHANES US adults, fasting' },
  cholesterol: { mean: 200, sd: 40, pop: 'NHANES US adults' },
  ldl: { mean: 115, sd: 35, pop: 'NHANES US adults' },
  hdl: { mean: 55, sd: 15, pop: 'NHANES US adults' },

  // Blood pressure (UK Biobank, mmHg)
  systolic: { mean: 138, sd: 19, pop: 'UK Biobank' },
  diastolic: { mean: 82, sd: 10, pop: 'UK Biobank' },

  // Glucose (mg/dL)
  hba1c: { mean: 5.4, sd: 0.5, pop: 'Non-diabetic adults' },
  glucose: { mean: 95, sd: 12, pop: 'Fasting, non-diabetic' },
  'c-reactive': { mean: 2.5, sd: 4.0, pop: 'UK Biobank' },

  // Blood counts
  wbc: { mean: 7.0, sd: 2.0, pop: 'UK Biobank', unit: 'thousand/μL' },
  rbc: { mean: 4.7, sd: 0.5, pop: 'UK Biobank', unit: 'million/μL' },
  platelet: { mean: 250, sd: 60, pop: 'UK Biobank', unit: 'thousand/μL' },
  lymphocyte: { mean: 2.0, sd: 0.7, pop: 'UK Biobank', unit: 'thousand/μL' },
  hemoglobin: { mean: 14.0, sd: 1.5, pop: 'UK Biobank', unit: 'g/dL' },

  // Reproductive
  menarche: { mean: 12.5, sd: 1.3, pop: 'European ancestry' },
  'first period': { mean: 12.5, sd: 1.3, pop: 'European ancestry' },
  menopause: { mean: 50.5, sd: 3.8, pop: 'European ancestry' },

  // Cardiac
  heart_rate: { mean: 70, sd: 12, pop: 'UK Biobank', unit: 'bpm' },
  pr_interval: { mean: 160, sd: 25, pop: 'UK Biobank', unit: 'ms' },
  qt_interval: { mean: 410, sd: 30, pop: 'UK Biobank', unit: 'ms' },
  qrs_duration: { mean: 95, sd: 15, pop: 'UK Biobank', unit: 'ms' },

  // Lung function
  'fev1': { mean: 3.0, sd: 0.8, pop: 'UK Biobank' },
  'fvc': { mean: 3.8, sd: 1.0, pop: 'UK Biobank' },
  'peak expiratory': { mean: 400, sd: 120, pop: 'UK Biobank' },

  // Renal
  creatinine: { mean: 0.9, sd: 0.2, pop: 'UK Biobank' },
  'urate': { mean: 5.5, sd: 1.4, pop: 'UK Biobank' },
  'cystatin': { mean: 0.9, sd: 0.15, pop: 'UK Biobank' },

  // Other
  'caffeine': { mean: 3.0, sd: 2.0, pop: 'UK Biobank', unit: 'cups/day' },
  'coffee': { mean: 3.0, sd: 2.0, pop: 'UK Biobank', unit: 'cups/day' },
  'alcohol': { mean: 10, sd: 12, pop: 'UK Biobank', unit: 'drinks/week' },
  'drinking': { mean: 10, sd: 12, pop: 'UK Biobank', unit: 'drinks/week' },
  'sleep': { mean: 7.0, sd: 1.0, pop: 'UK Biobank', unit: 'hours' },
  'insomnia': { mean: 3.0, sd: 1.5, pop: 'UK Biobank (frequency score)' },
  'telomere': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (z-score)' },
  'neuroticism': { mean: 4.0, sd: 3.2, pop: 'UK Biobank' },
  'cognitive': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (z-score)' },
  'risk-taking': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (z-score)' },
  'chronotype': { mean: 3.0, sd: 1.0, pop: 'UK Biobank (morningness score)' },
  'number of children': { mean: 2.0, sd: 1.2, pop: 'UK Biobank' },
  'smoking': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (z-score)' },
  'nicotine': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (ratio z-score)' },
  'lifespan': { mean: 80, sd: 10, pop: 'UK Biobank' },
  'balding': { mean: 2.0, sd: 1.2, pop: 'UK Biobank (Hamilton scale)' },

  // Cardiac intervals
  'pr interval': { mean: 160, sd: 25, pop: 'UK Biobank', unit: 'ms' },
  'qt interval': { mean: 410, sd: 30, pop: 'UK Biobank', unit: 'ms' },
  'qrs': { mean: 95, sd: 15, pop: 'UK Biobank', unit: 'ms' },
  'rr interval': { mean: 860, sd: 140, pop: 'UK Biobank', unit: 'ms' },
  'p wave': { mean: 110, sd: 15, pop: 'UK Biobank', unit: 'ms' },
  'pp interval': { mean: 860, sd: 140, pop: 'UK Biobank', unit: 'ms' },
  'ejection fraction': { mean: 60, sd: 6, pop: 'UK Biobank' },
  'pulse pressure': { mean: 55, sd: 15, pop: 'UK Biobank' },

  // Blood counts extended
  'eosinophil': { mean: 0.2, sd: 0.15, pop: 'UK Biobank', unit: 'thousand/μL' },
  'monocyte': { mean: 0.5, sd: 0.2, pop: 'UK Biobank', unit: 'thousand/μL' },
  'neutrophil': { mean: 4.5, sd: 1.5, pop: 'UK Biobank', unit: 'thousand/μL' },
  'reticulocyte': { mean: 60, sd: 20, pop: 'UK Biobank', unit: 'thousand/μL' },
  'hematocrit': { mean: 42, sd: 3.5, pop: 'UK Biobank', unit: '%' },
  'red cell distribution': { mean: 13.5, sd: 1.0, pop: 'UK Biobank' },
  'mean corpuscular hemoglobin': { mean: 30, sd: 2, pop: 'UK Biobank', unit: 'pg' },
  'mean platelet volume': { mean: 9.0, sd: 1.0, pop: 'UK Biobank', unit: 'fL' },
  'mean red blood cell volume': { mean: 90, sd: 5, pop: 'UK Biobank', unit: 'fL' },
  'mean reticulocyte volume': { mean: 100, sd: 6, pop: 'UK Biobank', unit: 'fL' },
  'white blood cell': { mean: 7.0, sd: 2.0, pop: 'UK Biobank', unit: 'thousand/μL' },

  // Hormones & biomarkers
  'testosterone': { mean: 12.0, sd: 6.0, pop: 'UK Biobank (mixed sex)' },
  'estradiol': { mean: 50, sd: 30, pop: 'UK Biobank (postmenopausal)' },
  'vitamin d': { mean: 25, sd: 12, pop: 'UK Biobank' },
  'vitamin b12': { mean: 400, sd: 150, pop: 'UK Biobank' },
  'thyroid stimulating hormone': { mean: 2.0, sd: 1.2, pop: 'UK Biobank' },
  'thyroxine': { mean: 8.0, sd: 1.5, pop: 'UK Biobank' },
  'ige': { mean: 50, sd: 100, pop: 'UK Biobank' },
  'psa': { mean: 1.5, sd: 2.0, pop: 'UK Biobank males' },
  'factor viii': { mean: 100, sd: 40, pop: 'Reference range' },
  'lipoprotein': { mean: 30, sd: 30, pop: 'UK Biobank' },
  'insulin': { mean: 0.0, sd: 1.0, pop: 'UK Biobank (z-score)' },

  // Renal & liver
  'uric acid': { mean: 5.5, sd: 1.4, pop: 'UK Biobank' },
  'urate': { mean: 5.5, sd: 1.4, pop: 'UK Biobank' },
  'kidney filtration': { mean: 90, sd: 15, pop: 'UK Biobank' },
  'egfr': { mean: 90, sd: 15, pop: 'UK Biobank' },
  'alt': { mean: 25, sd: 15, pop: 'UK Biobank' },
  'liver fat': { mean: 3.0, sd: 4.0, pop: 'UK Biobank' },
  'sodium': { mean: 140, sd: 2.5, pop: 'UK Biobank' },

  // Eye
  'eye pressure': { mean: 15, sd: 3, pop: 'UK Biobank' },
  'intraocular': { mean: 15, sd: 3, pop: 'UK Biobank' },
  'nearsighted': { mean: -1.0, sd: 2.5, pop: 'UK Biobank (diopters)' },
  'myopia': { mean: -1.0, sd: 2.5, pop: 'UK Biobank (diopters)' },

  // Brain volumes (mm³, UK Biobank imaging)
  'hippocampal': { mean: 3900, sd: 400, pop: 'UK Biobank imaging' },
  'dentate gyrus': { mean: 300, sd: 40, pop: 'UK Biobank imaging' },
  'subiculum': { mean: 450, sd: 55, pop: 'UK Biobank imaging' },
  'presubiculum': { mean: 320, sd: 40, pop: 'UK Biobank imaging' },
  'parasubiculum': { mean: 65, sd: 12, pop: 'UK Biobank imaging' },
  'fimbria': { mean: 90, sd: 20, pop: 'UK Biobank imaging' },
  'molecular layer': { mean: 580, sd: 65, pop: 'UK Biobank imaging' },
  'hippocampal fissure': { mean: 170, sd: 40, pop: 'UK Biobank imaging' },

  // Lung
  'lung capacity': { mean: 3.8, sd: 1.0, pop: 'UK Biobank' },
  'airflow ratio': { mean: 0.76, sd: 0.07, pop: 'UK Biobank' },

  // Misc
  'aortic': { mean: 33, sd: 4, pop: 'UK Biobank' },
  'hip circumference': { mean: 103, sd: 9, pop: 'UK Biobank' },
  'skin pigmentation': { mean: 0.0, sd: 1.0, pop: 'Reference (z-score)' },
  'carbohydrate': { mean: 250, sd: 80, pop: 'UK Biobank' },
};

function suggestReference(traitName, unit) {
  const nameLower = traitName.toLowerCase();

  for (const [key, ref] of Object.entries(COMMON_REFERENCES)) {
    const keyNorm = key.replace(/_/g, ' ');
    if (nameLower === keyNorm || nameLower.includes(keyNorm) || nameLower.includes(key)) {
      return ref;
    }
  }

  return null;
}

async function loadOverrides() {
  const data = await fs.readFile(OVERRIDES_PATH, 'utf8');
  return JSON.parse(data);
}

async function saveOverrides(overrides) {
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

async function listQuantitativeTraits() {
  console.log(chalk.cyan('\n=== Quantitative Traits Without References ===\n'));

  const overrides = await loadOverrides();
  const traits = await getAllTraits();

  const quantitative = traits.filter(t => {
    const override = overrides[t.trait_id];
    return override?.trait_type === 'quantitative' && !override.phenotype_mean;
  });

  console.log(
    chalk.blue(
      `Found ${quantitative.length} quantitative traits without phenotype references:\n`
    )
  );

  // Group by category
  const byCategory = {};
  for (const trait of quantitative) {
    const override = overrides[trait.trait_id];
    const unit = override?.unit || 'unknown';
    const category = unit;

    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({
      id: trait.trait_id,
      name: override?.editorial_name || trait.name,
      unit: unit
    });
  }

  // Display by category
  for (const [category, items] of Object.entries(byCategory).sort()) {
    console.log(chalk.bold.yellow(`\n${category}:`));
    for (const item of items) {
      console.log(chalk.gray(`  ${item.id}: ${item.name}`));
    }
  }

  console.log(
    chalk.blue(`\n\nTotal: ${quantitative.length} traits need references`)
  );

  return quantitative;
}

async function interactiveAdd() {
  console.log(chalk.cyan('\n=== Add Phenotype References Interactively ===\n'));

  const overrides = await loadOverrides();
  const traits = await getAllTraits();

  const quantitative = traits.filter(t => {
    const override = overrides[t.trait_id];
    return override?.trait_type === 'quantitative' && !override.phenotype_mean;
  });

  if (quantitative.length === 0) {
    console.log(
      chalk.green('✓ All quantitative traits have phenotype references!')
    );
    return;
  }

  console.log(chalk.blue(`${quantitative.length} traits need references\n`));

  const choices = quantitative.map(t => {
    const override = overrides[t.trait_id];
    return {
      title: `${override?.editorial_name || t.name} (${t.trait_id})`,
      description: `Unit: ${override?.unit || 'unknown'}`,
      value: t.trait_id
    };
  });

  const { traitId } = await prompts({
    type: 'autocomplete',
    name: 'traitId',
    message: 'Select trait to add reference for:',
    choices: choices,
    limit: 10
  });

  if (!traitId) return;

  const trait = traits.find(t => t.trait_id === traitId);
  const override = overrides[traitId];
  const traitName = override?.editorial_name || trait.name;
  const unit = override?.unit;

  console.log(chalk.bold.blue(`\n📋 ${traitName} (${traitId})`));
  console.log(chalk.gray(`   Unit: ${unit || 'unknown'}`));

  // Try to suggest a reference
  const suggestion = suggestReference(traitName, unit);
  if (suggestion) {
    console.log(chalk.yellow(`\n💡 Suggested reference:`));
    console.log(chalk.gray(`   Mean: ${suggestion.mean}`));
    console.log(chalk.gray(`   SD: ${suggestion.sd}`));
    console.log(chalk.gray(`   Population: ${suggestion.pop}`));

    const { useSuggestion } = await prompts({
      type: 'confirm',
      name: 'useSuggestion',
      message: 'Use suggested values?',
      initial: true
    });

    if (useSuggestion) {
      overrides[traitId] = {
        ...override,
        phenotype_mean: suggestion.mean,
        phenotype_sd: suggestion.sd,
        reference_population: suggestion.pop
      };

      await saveOverrides(overrides);
      console.log(chalk.green(`\n✓ Added reference for ${traitName}`));

      const { addAnother } = await prompts({
        type: 'confirm',
        name: 'addAnother',
        message: 'Add another?',
        initial: true
      });

      if (addAnother) {
        await interactiveAdd();
      }
      return;
    }
  }

  // Manual entry
  console.log(chalk.yellow('\n📝 Enter reference values manually:'));

  const answers = await prompts([
    {
      type: 'number',
      name: 'mean',
      message: 'Phenotype mean:',
      validate: value => !isNaN(value) || 'Must be a number'
    },
    {
      type: 'number',
      name: 'sd',
      message: 'Phenotype SD:',
      validate: value =>
        (!isNaN(value) && value > 0) || 'Must be a positive number'
    },
    {
      type: 'text',
      name: 'population',
      message: 'Reference population:',
      initial: 'UK Biobank European',
      validate: value => value.trim().length > 0 || 'Cannot be empty'
    },
    {
      type: 'text',
      name: 'source',
      message: 'Source (optional - for documentation):',
      initial: ''
    }
  ]);

  if (
    answers.mean !== undefined &&
    answers.sd !== undefined &&
    answers.population
  ) {
    overrides[traitId] = {
      ...override,
      phenotype_mean: answers.mean,
      phenotype_sd: answers.sd,
      reference_population: answers.population
    };

    await saveOverrides(overrides);
    console.log(chalk.green(`\n✓ Added reference for ${traitName}`));

    if (answers.source) {
      console.log(chalk.gray(`   Source: ${answers.source}`));
      console.log(
        chalk.yellow(
          '   (Note: Source not stored in JSON, add to documentation)'
        )
      );
    }

    const { addAnother } = await prompts({
      type: 'confirm',
      name: 'addAnother',
      message: 'Add another?',
      initial: true
    });

    if (addAnother) {
      await interactiveAdd();
    }
  }
}

async function batchAdd() {
  console.log(chalk.cyan('\n=== Batch Add Common References ===\n'));

  const overrides = await loadOverrides();
  const traits = await getAllTraits();

  const quantitative = traits.filter(t => {
    const override = overrides[t.trait_id];
    return override?.trait_type === 'quantitative' && !override.phenotype_mean;
  });

  let addedCount = 0;
  const suggestions = [];

  for (const trait of quantitative) {
    const override = overrides[trait.trait_id];
    const traitName = override?.editorial_name || trait.name;
    const unit = override?.unit;

    const suggestion = suggestReference(traitName, unit);
    if (suggestion) {
      suggestions.push({
        trait_id: trait.trait_id,
        name: traitName,
        unit: unit,
        ...suggestion
      });
    }
  }

  if (suggestions.length === 0) {
    console.log(chalk.yellow('No automatic suggestions available'));
    return;
  }

  console.log(
    chalk.blue(
      `Found ${suggestions.length} traits with suggested references:\n`
    )
  );

  for (const s of suggestions) {
    console.log(chalk.bold(`${s.name} (${s.trait_id})`));
    console.log(chalk.gray(`  Mean: ${s.mean} ${s.unit || ''}`));
    console.log(chalk.gray(`  SD: ${s.sd}`));
    console.log(chalk.gray(`  Population: ${s.pop}\n`));
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Add all ${suggestions.length} suggested references?`,
    initial: true
  });

  if (!confirm) return;

  for (const s of suggestions) {
    const override = overrides[s.trait_id];
    overrides[s.trait_id] = {
      ...override,
      phenotype_mean: s.mean,
      phenotype_sd: s.sd,
      reference_population: s.pop
    };
    addedCount++;
  }

  await saveOverrides(overrides);
  console.log(chalk.green(`\n✓ Added ${addedCount} phenotype references`));
  console.log(chalk.yellow('Run `pnpm traits --fresh` to update the database'));
}

async function exportMissing() {
  console.log(chalk.cyan('\n=== Export Missing References to CSV ===\n'));

  const overrides = await loadOverrides();
  const traits = await getAllTraits();

  const quantitative = traits.filter(t => {
    const override = overrides[t.trait_id];
    return override?.trait_type === 'quantitative' && !override.phenotype_mean;
  });

  const csv = [
    'trait_id,name,unit,suggested_mean,suggested_sd,suggested_population,notes'
  ];

  for (const trait of quantitative) {
    const override = overrides[trait.trait_id];
    const traitName = override?.editorial_name || trait.name;
    const unit = override?.unit || '';

    const suggestion = suggestReference(traitName, unit);

    csv.push(
      [
        trait.trait_id,
        `"${traitName}"`,
        unit,
        suggestion?.mean || '',
        suggestion?.sd || '',
        suggestion?.pop ? `"${suggestion.pop}"` : '',
        ''
      ].join(',')
    );
  }

  const outputPath = path.join(__dirname, 'missing_phenotype_refs.csv');
  await fs.writeFile(outputPath, csv.join('\n'));

  console.log(
    chalk.green(`✓ Exported ${quantitative.length} traits to ${outputPath}`)
  );
  console.log(chalk.gray('Edit the CSV and use it to batch import references'));
}

async function main() {
  const command = process.argv[2];

  if (command === 'list') {
    await listQuantitativeTraits();
    closeConnection();
    return;
  }

  if (command === 'batch') {
    await batchAdd();
    closeConnection();
    return;
  }

  if (command === 'export') {
    await exportMissing();
    closeConnection();
    return;
  }

  if (command === 'add') {
    await interactiveAdd();
    closeConnection();
    return;
  }

  // Interactive mode
  console.log(chalk.bold.blue('\n🧬 Phenotype Reference Manager\n'));

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: '📋 List traits without references', value: 'list' },
      { title: '➕ Add reference interactively', value: 'add' },
      { title: '🔄 Batch add common references', value: 'batch' },
      { title: '📤 Export missing to CSV', value: 'export' },
      { title: '🚪 Exit', value: 'exit' }
    ]
  });

  switch (action) {
    case 'list':
      await listQuantitativeTraits();
      break;
    case 'add':
      await interactiveAdd();
      break;
    case 'batch':
      await batchAdd();
      break;
    case 'export':
      await exportMissing();
      break;
    case 'exit':
      console.log(chalk.gray('Goodbye!'));
      break;
  }

  closeConnection();
}

main().catch(console.error);
