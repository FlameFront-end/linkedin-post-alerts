# LinkedIn collector operations

- All live requests to LinkedIn must use TrafficProtection backed by DatabaseProtectionStore. Do not use direct fetch, curl, an unprotected LinkedInClient or a separate browser session as a workaround for a source restriction.
- `npm run linkedin:check` is the normal diagnostic: no LinkedIn network request. Test changes with synthetic responses and the separate test databases.
- Only use `--confirmed-probe` after the owner has confirmed that the same surface works normally in their browser. Existing confirmation in this chat is sufficient; do not ask again. One probe must retain all rolling budgets and cooldowns.
- Do not reset the traffic_protection database record, rotate credentials/accounts/proxies, or restart the collector to evade a hold. Restarting is allowed for deployment; persistent holds remain.
- Keep COLLECTION_PAUSED enabled during the currently confirmed search suspension. Restoring ordinary collection requires a successful protected probe after the owner's confirmation.
- The current caps are application policy, not LinkedIn-published safe rates. Do not promise that account restrictions cannot recur.
