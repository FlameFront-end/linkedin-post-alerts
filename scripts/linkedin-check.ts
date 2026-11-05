import { LinkedInSource } from '../services/collector/src/sources/linkedin.js';
import { loadSettings } from '../services/collector/src/linkedin/settings.js';
import { LinkedInError } from '../services/collector/src/linkedin/errors.js';
try {
  const source = new LinkedInSource(
    await loadSettings(
      process.env.LINKEDIN_CONFIG_FILE ?? '.local/linkedin.json',
    ),
  );
  let count = 0;
  for await (const page of source.fetchBatches()) count += page.length;
  console.log(JSON.stringify({ status: 'ok', recentPosts: count }));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: error instanceof LinkedInError ? error.code : 'internal',
    }),
  );
  process.exitCode = 1;
}
