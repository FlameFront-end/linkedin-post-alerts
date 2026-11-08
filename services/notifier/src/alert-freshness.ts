import type { Alert } from '../../../packages/contracts/src/index.js';
/** Old incident reports must not look like a new failure after an outage. */
export function staleAlert(alert: Alert, now = Date.now()): boolean {
  return now - Date.parse(alert.at) > 3600000;
}
