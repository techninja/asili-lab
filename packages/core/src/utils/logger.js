import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../../../../');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

class Logger {
  constructor(scriptName) {
    this.scriptName = scriptName;
    this.scriptDir = path.join(LOGS_DIR, scriptName);
    this.logFile = null;
    this.fileStream = null;
  }

  init() {
    if (!fs.existsSync(this.scriptDir)) {
      fs.mkdirSync(this.scriptDir, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, -5);
    this.logFile = path.join(this.scriptDir, `${timestamp}.log`);
    this.fileStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    this.log(
      `=== ${this.scriptName} started at ${new Date().toISOString()} ===`
    );
  }

  log(...args) {
    const message = args.join(' ');
    console.log(message);
    if (this.fileStream) {
      this.fileStream.write(`${message}\n`);
    }
  }

  error(...args) {
    const message = args.join(' ');
    console.error(message);
    if (this.fileStream) {
      this.fileStream.write(`ERROR: ${message}\n`);
    }
  }

  close() {
    if (this.fileStream) {
      this.log(
        `=== ${this.scriptName} finished at ${new Date().toISOString()} ===`
      );
      this.fileStream.end();
    }
  }
}

export function createLogger(scriptName) {
  const logger = new Logger(scriptName);
  logger.init();
  return logger;
}
