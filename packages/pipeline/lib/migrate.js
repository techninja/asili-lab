import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConnection } from './shared-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

let migrated = false;

export async function runMigrations() {
  if (migrated) return;

  const conn = await getConnection();

  // Read and execute migration files in order
  const migrationFiles = ['000_create_traits.sql', '001_create_staging.sql'];

  for (const file of migrationFiles) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // Remove comments and split by semicolon
    const statements = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--')) // Remove comment lines
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      await new Promise((resolve, reject) => {
        conn.run(statement, err => (err ? reject(err) : resolve()));
      });
    }
  }

  migrated = true;
}
