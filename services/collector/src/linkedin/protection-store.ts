import type pg from 'pg';
import { transaction } from '../../../../packages/runtime/src/db.js';
import {
  trafficStateSchema,
  type TrafficState,
  type ProtectionStore,
} from './protection.js';
/** Serialize reservations across collector instances and diagnostic commands. */
export class DatabaseProtectionStore implements ProtectionStore {
  constructor(private readonly pool: pg.Pool) {}
  async update<T>(operation: (state: TrafficState) => T): Promise<T> {
    return transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(472018)');
      const row = (
        await db.query(
          "SELECT payload FROM processing.source_state WHERE key='traffic_protection' FOR UPDATE",
        )
      ).rows[0];
      const state = trafficStateSchema.parse(row?.payload ?? {});
      const result = operation(state);
      await db.query(
        "INSERT INTO processing.source_state(key,payload) VALUES('traffic_protection',$1) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=now()",
        [JSON.stringify(state)],
      );
      return result;
    });
  }
}
