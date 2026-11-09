import { log, errorFields } from '../packages/runtime/src/logger.js';
import { readFile, readdir } from 'node:fs/promises';
import { createPool } from '../packages/runtime/src/db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = createPool(url);
const client = await pool.connect();
try {
  log('migrate', 'started');
  await client.query('SELECT pg_advisory_lock(472017)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory))
    .filter((v) => /^\d+.*\.sql$/.test(v))
    .sort()) {
    const exists = await client.query(
      'SELECT 1 FROM public.schema_migrations WHERE name=$1',
      [name],
    );
    if (exists.rowCount) {
      log('migrate', 'migration_present', { migration: name });
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query(
        'INSERT INTO public.schema_migrations(name) VALUES($1)',
        [name],
      );
      await client.query('COMMIT');
      log('migrate', 'migration_applied', { migration: name });
    } catch (error) {
      log(
        'migrate',
        'migration_failed',
        { migration: name, ...errorFields(error) },
        'error',
      );
      await client.query('ROLLBACK');
      throw error;
    }
  }
  log('migrate', 'completed');
} finally {
  await client.query('SELECT pg_advisory_unlock(472017)');
  client.release();
  await pool.end();
}
