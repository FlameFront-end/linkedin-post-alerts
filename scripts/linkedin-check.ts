import { createPool } from '../packages/runtime/src/db.js';
import {
  TrafficProtection,
  trafficScopes,
  type TrafficScope,
} from '../services/collector/src/linkedin/protection.js';
import { DatabaseProtectionStore } from '../services/collector/src/linkedin/protection-store.js';
import { loadSettings } from '../services/collector/src/linkedin/settings.js';
import {
  LinkedInClient,
  feedPagePath,
} from '../services/collector/src/linkedin/client.js';
import { LinkedInError } from '../services/collector/src/linkedin/errors.js';
import { decodeHtmlPage } from '../services/collector/src/linkedin/search-html.js';
import { decodeSearch } from '../services/collector/src/linkedin/search.js';
import { decodeJobCards } from '../services/collector/src/linkedin/jobs.js';
import { encodeValue } from '../services/collector/src/linkedin/graph.js';

const [mode, scopeArg, ...extra] = process.argv.slice(2);
const modes = ['--probe', '--confirmed-probe', '--confirmed-account-probe'];
if (
  (mode &&
    (!modes.includes(mode) ||
      !trafficScopes.includes(scopeArg as TrafficScope))) ||
  extra.length ||
  (!mode && scopeArg)
)
  throw Error(
    'Usage: linkedin:check [--probe|--confirmed-probe|--confirmed-account-probe feed|search|jobs]',
  );
if (!process.env.DATABASE_URL)
  throw Error(
    'DATABASE_URL is required: diagnostics may not bypass durable protection',
  );
const pool = createPool(process.env.DATABASE_URL);
let protection: TrafficProtection | undefined;
try {
  const settings = await loadSettings(
    process.env.LINKEDIN_CONFIG_FILE ?? '.local/linkedin.json',
  );
  protection = new TrafficProtection(
    new DatabaseProtectionStore(pool),
    settings.protection,
  );
  if (!mode) {
    console.log(
      JSON.stringify({
        mode: 'status',
        networkRequests: 0,
        limits: settings.protection,
        protection: await protection.snapshot(),
      }),
    );
  } else {
    const scope = scopeArg as TrafficScope;
    if (mode === '--confirmed-probe' || mode === '--confirmed-account-probe')
      await protection.armProbe(scope, mode === '--confirmed-account-probe');
    const client = new LinkedInClient(
      settings.session,
      settings.requestIntervalMs,
      fetch,
      undefined,
      protection.forScope(scope),
    );
    client.beginCycle(1);
    let path = feedPagePath;
    if (scope === 'search') {
      if (!settings.searchPathTemplate || !settings.keywords[0])
        throw new LinkedInError('configuration');
      path = settings.searchPathTemplate
        .replaceAll('{keywords}', encodeValue(settings.keywords[0]))
        .replaceAll('{start}', '0')
        .replaceAll('{count}', '1');
    } else if (scope === 'jobs') {
      if (!settings.jobsKeywords[0]) throw new LinkedInError('configuration');
      path =
        '/jobs-guest/jobs/api/seeMoreJobPostings/search?' +
        new URLSearchParams({
          keywords: settings.jobsKeywords[0],
          location: 'Worldwide',
          start: '0',
          sortBy: 'DD',
        });
    }
    const body = await client.get(path);
    let count: number;
    if (scope === 'search' && typeof body !== 'string')
      count = decodeSearch(body).references.length;
    else {
      if (typeof body !== 'string') throw new LinkedInError('response_format');
      count =
        scope === 'jobs'
          ? decodeJobCards(body).length
          : decodeHtmlPage(body, new Date(), scope).posts.length;
    }
    console.log(
      JSON.stringify({
        status: 'ok',
        scope,
        count,
        networkRequests: client.requestsUsed,
        collectionResumed: false,
      }),
    );
  }
} catch (error) {
  if (mode && protection && error instanceof LinkedInError)
    await protection.failure(scopeArg as TrafficScope, error);
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: error instanceof LinkedInError ? error.code : 'internal',
      reason: error instanceof LinkedInError ? error.reason : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
