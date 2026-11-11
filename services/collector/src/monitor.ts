import type { Database } from '../../../packages/runtime/src/db.js';
import type { StateStore } from './state.js';
import { raiseAlert } from './alerts.js';
const controlledPauses = new Set([
  'request_limit',
  'protection_pause',
  'cooldown',
]);
export interface SourceHealth {
  status: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  failures: number;
  newPosts: number;
  discovered: number;
  coverageLimited: boolean;
  failedTargets: number;
  targets: { status: string; posts: number }[];
}
export class SourceMonitor {
  private saving: Promise<void> = Promise.resolve();
  readonly sources: Record<string, SourceHealth> = {};
  constructor(
    private readonly db: Database,
    private readonly state: StateStore,
  ) {}
  async restore() {
    const value = await this.state.load('health');
    if (value && typeof value === 'object') Object.assign(this.sources, value);
  }
  ready(expected: { name: string; intervalMs: number }[]) {
    return expected.every(({ name, intervalMs }) => {
      const source = this.sources[name];
      return (
        source &&
        ['ok', 'partial'].includes(source.status) &&
        Date.now() - Date.parse(source.lastAttemptAt) <
          Math.max(3600000, intervalMs * 2)
      );
    });
  }
  async record(
    name: string,
    reports: {
      status: string;
      posts: number;
      discovered?: number;
      coverageLimited?: boolean;
      pagination?: string;
    }[],
    newPosts: number,
    error?: string,
  ) {
    const previous = this.sources[name];
    const statuses = reports.map((report) => report.status);
    const success =
      !error &&
      statuses.some((status) => status === 'ok' || status === 'partial');
    const status =
      error ??
      (success
        ? statuses.every((status) => status === 'ok' || status === 'skipped')
          ? 'ok'
          : 'partial'
        : (statuses.find(
            (status) => !['skipped', 'disabled', 'budget'].includes(status),
          ) ??
          statuses[0] ??
          'not_started'));
    const failedTargets = reports.filter(
      (report) =>
        !['ok', 'partial', 'skipped', 'budget'].includes(report.status),
    ).length;
    const coverageLimited = reports.some((report) => report.coverageLimited);
    const now = new Date().toISOString();
    this.sources[name] = {
      status,
      lastAttemptAt: now,
      ...(success
        ? { lastSuccessAt: now }
        : previous?.lastSuccessAt
          ? { lastSuccessAt: previous.lastSuccessAt }
          : {}),
      failures:
        success || controlledPauses.has(status)
          ? 0
          : (previous?.failures ?? 0) + 1,
      newPosts,
      discovered: reports.reduce(
        (n, report) => n + (report.discovered ?? report.posts),
        0,
      ),
      coverageLimited,
      failedTargets,
      targets: reports.map((report) => ({
        ...(report.pagination ? { pagination: report.pagination } : {}),
        ...(report.discovered !== undefined
          ? { discovered: report.discovered }
          : {}),
        status: report.status,
        posts: report.posts,
      })),
    };
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => this.state.save('health', this.sources));
    await this.saving;
    if (
      !success &&
      !controlledPauses.has(status) &&
      ([
        'auth_required',
        'rate_limited',
        'search_restricted',
        'source_blocked',
      ].includes(status) ||
        this.sources[name]!.failures >= 2)
    )
      await raiseAlert(this.db, {
        code: `${name}_${status}`.slice(0, 64),
        message:
          status === 'search_restricted'
            ? 'LinkedIn приостановил поисковые действия. Поиск отключён до ручного подтверждения, что он снова работает в браузере. Ограничение сохраняется после перезапуска сервиса.'
            : `${name}: сбор не работает (${status}). Новых публикаций в этом цикле: ${newPosts}. Последний успех: ${previous?.lastSuccessAt ?? 'ещё не было'}.`,
      });
    if (
      success &&
      previous &&
      !controlledPauses.has(previous.status) &&
      !['ok', 'partial'].includes(previous.status)
    )
      await raiseAlert(this.db, {
        code: `${name}_recovered`,
        message: `${name}: сбор восстановлен. Новых публикаций: ${newPosts}.`,
      });
    if (success && failedTargets > 0 && (previous?.failedTargets ?? 0) > 0)
      await raiseAlert(this.db, {
        code: `${name}_degraded`,
        message: `${name}: часть запросов регулярно не работает (${failedTargets} из ${reports.length}). Проверьте /status и журнал target_result.`,
      });
  }
  async diagnostics() {
    const decisions = (
      await this.db.query(
        'SELECT decision,language,count(*)::int AS count FROM processing.posts GROUP BY decision,language',
      )
    ).rows;
    const queue = (
      await this.db.query(
        'SELECT kind,status,count(*)::int AS count FROM queue.jobs GROUP BY kind,status',
      )
    ).rows;
    const delivery = (
      await this.db.query(
        "SELECT max(sent_at) AS last_delivery_at, percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0,extract(epoch FROM (sent_at-detected_at)))) FILTER (WHERE detected_at IS NOT NULL) AS median_detection_to_delivery_seconds, percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0,extract(epoch FROM (sent_at-published_at)))) FILTER (WHERE published_at IS NOT NULL AND published_precision='instant') AS median_publication_to_delivery_seconds FROM processing.deliveries",
      )
    ).rows[0];
    return { sources: this.sources, decisions, queue, delivery };
  }
}
