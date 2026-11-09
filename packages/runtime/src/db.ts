import pg from 'pg';
import { log, errorFields } from './logger.js';
export function createPool(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  pool.on('error', (error) =>
    log('database', 'pool_error', errorFields(error), 'error'),
  );
  return pool;
}
export type Database = pg.Pool | pg.PoolClient;
export async function transaction<T>(
  pool: pg.Pool,
  operation: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
