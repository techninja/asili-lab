#!/usr/bin/env node

/**
 * Generic ETL/script profiler — wraps any command, sampling CPU/memory at 1s
 * intervals and correlating with pipeline phases detected from log output.
 *
 * Usage:
 *   pnpm profile etl local EFO_0003144
 *   pnpm profile traits refresh
 *   node scripts/profiler.js etl local EFO_0003144
 *
 * Output:
 *   data_out/profiles/<name>_<timestamp>_profile.json
 *   Terminal summary table with per-phase breakdown
 */

import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'data_out', 'profiles');
const NUM_CPUS = os.cpus().length;

// --- Phase detection from log lines ---

const PHASE_PATTERNS = [
  {
    phase: 'init',
    re: /Pipeline Starting|Loading traits|Checking prerequisites|Creating Python|Installing Python|prerequisites met|Performance Config/
  },
  {
    phase: 'download',
    re: /[Dd]ownload|cached (harmonized|PGS) file|Cache HIT|Batch \d+\/\d+: Processing \d+ files|Downloading and analyzing/
  },
  {
    phase: 'prepare',
    re: /[Pp]repare|format \(\d+ columns\)|Analyzing.*PGS files for batching|Created \d+ batches|batching/
  },
  {
    phase: 'import',
    re: /Importing |INSERT|variants \(\d+ms\)|Processing batch|batch_variants/
  },
  {
    phase: 'duckdb',
    re: /🦆|DuckDB|PRAGMA|batch \d+\/\d+ complete|Batch \d+\/\d+:.*variants$/
  },
  { phase: 'merge', re: /[Mm]erg|hierarchical|append|Concatenat/ },
  { phase: 'export', re: /Export|COPY.*TO|standardized/ },
  {
    phase: 'validate',
    re: /[Vv]alidat|Scanning parquet|scan-parquet|Parquet:/
  },
  { phase: 'manifest', re: /manifest|JSON manifest/ },
  { phase: 'api', re: /API|api|rate limit|pgscatalog\.org|fetching|refresh/ },
  { phase: 'db', re: /database|migration|trait_pgs|trait_excluded/ }
];

function detectPhase(line) {
  for (const { phase, re } of PHASE_PATTERNS) {
    if (re.test(line)) return phase;
  }
  return null;
}

// --- /proc readers ---

function readProcFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function getDescendants(pid) {
  // /proc/<pid>/task/<tid>/children requires ptrace access.
  // With ptrace_scope=1 we can only see direct children.
  // Instead, scan /proc for any process whose ppid is in our tree.
  const tree = new Set([pid]);
  try {
    const entries = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e));
    // Multiple passes to catch the full depth
    for (let pass = 0; pass < 4; pass++) {
      let added = false;
      for (const entry of entries) {
        const p = parseInt(entry);
        if (tree.has(p)) continue;
        const stat = readProcFile(`/proc/${p}/stat`);
        if (!stat) continue;
        // ppid is field 4 (1-indexed), after the comm field in parens
        const afterComm = stat.split(') ')[1];
        if (!afterComm) continue;
        const ppid = parseInt(afterComm.split(' ')[1]);
        if (tree.has(ppid)) {
          tree.add(p);
          added = true;
        }
      }
      if (!added) break;
    }
  } catch {
    /* ignore */
  }
  tree.delete(pid);
  return [...tree];
}

/** Get aggregate CPU ticks (user+system) for pid and all descendants */
function getCpuTicks(pid) {
  const pids = [pid, ...getDescendants(pid)];
  let total = 0;
  for (const p of pids) {
    const stat = readProcFile(`/proc/${p}/stat`);
    if (!stat) continue;
    const parts = stat.split(') ')[1]?.split(' ');
    if (!parts) continue;
    // After closing paren: index 11=utime, 12=stime (0-based)
    total += parseInt(parts[11] || 0) + parseInt(parts[12] || 0);
  }
  return total;
}

function getProcessMetrics(pid) {
  const pids = [pid, ...getDescendants(pid)];
  let rssKb = 0,
    threads = 0;
  for (const p of pids) {
    const status = readProcFile(`/proc/${p}/status`);
    if (!status) continue;
    for (const line of status.split('\n')) {
      if (line.startsWith('VmRSS:'))
        rssKb += parseInt(line.split(/\s+/)[1]) || 0;
      if (line.startsWith('Threads:'))
        threads += parseInt(line.split(/\s+/)[1]) || 0;
    }
  }
  return { rssKb, threads, processes: pids.length };
}

// --- Resolve pnpm script to a direct node command ---

function resolveScript(scriptName) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scriptCmd = pkg.scripts?.[scriptName];
  if (!scriptCmd) {
    console.error(
      `Unknown script: "${scriptName}"\nAvailable: ${Object.keys(pkg.scripts || {}).join(', ')}`
    );
    process.exit(1);
  }
  return scriptCmd; // e.g. "node scripts/etl-runner.js"
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: pnpm perf <script> [args...]\n  e.g. pnpm perf etl local EFO_0003144'
    );
    process.exit(1);
  }

  const scriptName = args[0];
  const scriptArgs = args.slice(1);

  // Resolve "etl" -> "node scripts/etl-runner.js" then append extra args
  const resolved = resolveScript(scriptName);
  const parts = resolved.split(/\s+/);
  const cmd = parts[0];
  const cmdArgs = [...parts.slice(1), ...scriptArgs];
  const label = [scriptName, ...scriptArgs].join('_');

  await fsp.mkdir(PROFILE_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const profileName = `${label}_${ts}`;

  console.log(
    `\n🔬 Profiler — ${cmd} ${cmdArgs.join(' ')} (${NUM_CPUS} cores)\n`
  );

  const timeline = [];
  let currentPhase = 'init';
  let lastLogLine = '';
  const phaseLog = [];
  const t0 = Date.now();
  const CLK_TCK = 100;

  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  const pid = child.pid;
  console.log(`  PID: ${pid}\n`);

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`  [${elapsed.padStart(7)}s] ${trimmed}\n`);
    lastLogLine = trimmed;
    const detected = detectPhase(trimmed);
    if (detected && detected !== currentPhase) {
      currentPhase = detected;
      phaseLog.push({ t: Date.now() - t0, phase: detected, line: trimmed });
    }
  }

  let stdoutBuf = '';
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(handleLine);
  });

  let stderrBuf = '';
  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(handleLine);
  });

  // Sample at 1s intervals — read ticks+time atomically to avoid skew
  let prevTicks = getCpuTicks(pid);
  let prevTime = Date.now();

  const sampler = setInterval(() => {
    const ticks = getCpuTicks(pid);
    const now = Date.now();
    const dt = (now - prevTime) / 1000;
    if (dt < 0.1) return;

    const deltaTicks = ticks - prevTicks;
    // When processes exit between samples, their accumulated ticks disappear
    // from the tree, causing a negative delta. Clamp to 0.
    const cpuCores =
      deltaTicks > 0 ? Math.min(deltaTicks / CLK_TCK / dt, NUM_CPUS) : 0;
    const cpuPct = (cpuCores / NUM_CPUS) * 100;

    const metrics = getProcessMetrics(pid);
    const rssMb = metrics ? +(metrics.rssKb / 1024).toFixed(0) : 0;

    timeline.push({
      t: now - t0,
      phase: currentPhase,
      cpuCores: +cpuCores.toFixed(2),
      cpuPct: +cpuPct.toFixed(1),
      rssMb,
      threads: metrics?.threads || 0,
      processes: metrics?.processes || 0,
      log: lastLogLine
    });

    prevTicks = ticks;
    prevTime = now;
  }, 1000);

  const exitCode = await new Promise(resolve => {
    child.on('close', code => {
      clearInterval(sampler);
      resolve(code ?? 0);
    });
  });

  const totalSec = +((Date.now() - t0) / 1000).toFixed(1);

  // --- Write profile JSON ---
  const profilePath = path.join(PROFILE_DIR, `${profileName}_profile.json`);
  await fsp.writeFile(
    profilePath,
    JSON.stringify(
      {
        command: `${cmd} ${cmdArgs.join(' ')}`,
        label,
        numCpus: NUM_CPUS,
        totalSeconds: totalSec,
        exitCode,
        phaseTransitions: phaseLog,
        samples: timeline.length,
        timeline
      },
      null,
      2
    )
  );

  // --- Per-phase summary ---
  const phases = {};
  for (const sample of timeline) {
    const p = sample.phase;
    if (!phases[p])
      phases[p] = {
        samples: 0,
        cpuCoresSum: 0,
        peakRssMb: 0,
        peakThreads: 0,
        peakProcs: 0
      };
    phases[p].samples++;
    phases[p].cpuCoresSum += sample.cpuCores;
    phases[p].peakRssMb = Math.max(phases[p].peakRssMb, sample.rssMb);
    phases[p].peakThreads = Math.max(phases[p].peakThreads, sample.threads);
    phases[p].peakProcs = Math.max(phases[p].peakProcs, sample.processes);
  }

  const W = 92;
  console.log(`\n${'═'.repeat(W)}`);
  console.log(
    `  Profile: ${label}  |  ${totalSec}s  |  ${timeline.length} samples  |  exit ${exitCode}`
  );
  console.log(`${'═'.repeat(W)}`);
  console.log(
    '  ' +
      'Phase'.padEnd(13) +
      'Wall(s)'.padStart(8) +
      '  %Wall'.padStart(8) +
      'Avg Cores'.padStart(11) +
      `  Util%/${NUM_CPUS}`.padStart(10) +
      'Peak MB'.padStart(9) +
      '  Threads'.padStart(9) +
      '  Procs'.padStart(8)
  );
  console.log(`  ${'─'.repeat(W - 4)}`);

  // Show phases in order of first appearance
  const seen = new Set();
  const phaseOrder = [];
  for (const s of timeline) {
    if (!seen.has(s.phase)) {
      seen.add(s.phase);
      phaseOrder.push(s.phase);
    }
  }

  let totalCpuCoresSum = 0;
  for (const p of phaseOrder) {
    const d = phases[p];
    if (!d) continue;
    const wallSec = d.samples;
    const wallPct = (wallSec / totalSec) * 100;
    const avgCores = d.cpuCoresSum / d.samples;
    const utilPct = (avgCores / NUM_CPUS) * 100;
    totalCpuCoresSum += d.cpuCoresSum;
    console.log(
      '  ' +
        p.padEnd(13) +
        wallSec.toString().padStart(8) +
        (wallPct.toFixed(0) + '%').padStart(8) +
        avgCores.toFixed(1).padStart(11) +
        (utilPct.toFixed(0) + '%').padStart(10) +
        (d.peakRssMb + '').padStart(9) +
        d.peakThreads.toString().padStart(9) +
        d.peakProcs.toString().padStart(8)
    );
  }

  console.log(`  ${'─'.repeat(W - 4)}`);
  const overallAvgCores =
    timeline.length > 0 ? totalCpuCoresSum / timeline.length : 0;
  const overallUtil = (overallAvgCores / NUM_CPUS) * 100;
  const peakRss = Math.max(...timeline.map(s => s.rssMb), 0);
  console.log(
    '  ' +
      'TOTAL'.padEnd(13) +
      Math.round(totalSec).toString().padStart(8) +
      '100%'.padStart(8) +
      overallAvgCores.toFixed(1).padStart(11) +
      (overallUtil.toFixed(0) + '%').padStart(10) +
      (peakRss + '').padStart(9) +
      ''.padStart(9) +
      ''.padStart(8)
  );
  console.log(`${'═'.repeat(W)}`);
  console.log(`  📊 ${profilePath}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
