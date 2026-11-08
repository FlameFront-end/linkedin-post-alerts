import type { Database } from '../../../packages/runtime/src/db.js';
export interface StateStore {
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
}
export class DatabaseState implements StateStore {
  constructor(private readonly db: Database) {}
  async load(key: string) {
    return (
      await this.db.query(
        'SELECT payload FROM processing.source_state WHERE key=$1',
        [key],
      )
    ).rows[0]?.payload;
  }
  async save(key: string, value: unknown) {
    await this.db.query(
      'INSERT INTO processing.source_state(key,payload) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=now()',
      [key, JSON.stringify(value)],
    );
  }
}
