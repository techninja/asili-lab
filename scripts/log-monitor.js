#!/usr/bin/env node
import blessed from 'blessed';
import { spawn, execSync } from 'child_process';
import _chalk from 'chalk';
import clipboardy from 'clipboardy';

const containerName = process.argv[2] || 'asili-hybrid';

const screen = blessed.screen({
  smartCSR: true,
  title: 'Asili Log Monitor',
  fullUnicode: true
});

const header = blessed.box({
  top: 0,
  left: 0,
  width: '100%',
  height: 1,
  content: '',
  tags: true,
  style: {
    fg: 'white',
    bg: 'blue',
    bold: true
  }
});

const footer = blessed.box({
  bottom: 0,
  left: 0,
  width: '100%',
  height: 1,
  content:
    ' {bold}q{/bold} quit | {bold}↑↓{/bold} scroll | {bold}c{/bold} copy all | {bold}l{/bold} copy last 2 | {bold}p{/bold} copy prev run',
  tags: true,
  style: {
    fg: 'white',
    bg: 'black'
  }
});

const logBox = blessed.log({
  top: 1,
  left: 0,
  width: '100%',
  height: '100%-2',
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: ' ',
    style: { bg: 'blue' }
  },
  keys: true,
  vi: true,
  mouse: true,
  tags: true
});

screen.append(header);
screen.append(footer);
screen.append(logBox);

// Blessed measures emojis as 1 cell wide but terminals render them as 2.
// Pad each emoji so blessed's width calc (1 char + 1 space = 2) matches reality.
const emojiRe = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})(?! )/gu;
function sanitize(str) {
  return str.replace(emojiRe, '$1 ');
}

let logsProcess = null;
let reconnectTimer = null;
let containerStartTime = null;
let previousRunLogs = [];

function getContainerStatus() {
  try {
    const output = execSync(
      `docker inspect -f '{{.State.Status}}|{{.State.StartedAt}}' ${containerName} 2>/dev/null`,
      { encoding: 'utf8' }
    );
    const [status, startedAt] = output.trim().split('|');
    return { status, startedAt };
  } catch {
    return { status: 'not found', startedAt: null };
  }
}

function updateHeader() {
  const { status } = getContainerStatus();
  const statusColor =
    status === 'running' ? '{green-fg}●{/green-fg}' : '{red-fg}●{/red-fg}';
  let uptime = '';
  if (containerStartTime) {
    const secs = Math.floor(
      (Date.now() - new Date(containerStartTime).getTime()) / 1000
    );
    const h = Math.floor(secs / 3600),
      m = Math.floor((secs % 3600) / 60),
      s = secs % 60;
    uptime = `${h}h ${m}m ${s}s`;
  }
  header.setContent(
    ` ${statusColor} {bold}${containerName}{/bold} | ${status} | up ${uptime}`
  );
  screen.render();
}

function startLogs() {
  if (logsProcess) {
    logsProcess.kill();
    logsProcess = null;
  }

  const { status, startedAt } = getContainerStatus();
  if (status !== 'running') {
    logBox.log(
      `{yellow-fg}[${new Date().toLocaleTimeString()}] Container not running, waiting...{/yellow-fg}`
    );
    scheduleReconnect();
    return;
  }

  if (containerStartTime !== startedAt) {
    if (containerStartTime) {
      previousRunLogs = logBox.getContent().split('\n');
    }
    containerStartTime = startedAt;
    logBox.setContent('');
    logBox.setScrollPerc(0);
    screen.render();
  }

  logBox.log(
    `{green-fg}[${new Date().toLocaleTimeString()}] Connected to ${containerName}{/green-fg}`
  );

  logsProcess = spawn('docker', [
    'logs',
    '-f',
    '--since',
    startedAt,
    containerName
  ]);

  logsProcess.stdout.on('data', data => {
    data
      .toString()
      .split('\n')
      .forEach(line => {
        if (line.trim()) logBox.log(sanitize(line));
      });
  });

  logsProcess.stderr.on('data', data => {
    data
      .toString()
      .split('\n')
      .forEach(line => {
        if (line.trim()) logBox.log(`{red-fg}${sanitize(line)}{/red-fg}`);
      });
  });

  logsProcess.on('close', () => {
    logBox.log(
      `{yellow-fg}[${new Date().toLocaleTimeString()}] Connection lost, reconnecting...{/yellow-fg}`
    );
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startLogs();
  }, 2000);
}

screen.key(['q', 'C-c'], () => {
  if (logsProcess) logsProcess.kill();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  process.exit(0);
});

async function copyToClipboard(text, label) {
  try {
    const clean = text.replace(/\{[^}]+\}/g, '');
    await clipboardy.write(clean);
    logBox.log(
      `{green-fg}[${new Date().toLocaleTimeString()}] Copied ${label} to clipboard{/green-fg}`
    );
  } catch (err) {
    logBox.log(
      `{red-fg}[${new Date().toLocaleTimeString()}] Failed to copy: ${err.message}{/red-fg}`
    );
  }
}

screen.key(['c'], () =>
  copyToClipboard(
    logBox.getContent(),
    `${logBox.getContent().split('\n').length} lines`
  )
);

screen.key(['l'], () => {
  const lines = logBox
    .getContent()
    .split('\n')
    .filter(l => l.trim());
  copyToClipboard(lines.slice(-2).join('\n'), 'last 2 lines');
});

screen.key(['p'], () => {
  if (!previousRunLogs.length) {
    logBox.log(
      `{yellow-fg}[${new Date().toLocaleTimeString()}] No previous run logs available{/yellow-fg}`
    );
    return;
  }
  copyToClipboard(
    previousRunLogs.join('\n'),
    `${previousRunLogs.length} lines from previous run`
  );
});

logBox.focus();

setInterval(updateHeader, 1000);
updateHeader();
startLogs();
