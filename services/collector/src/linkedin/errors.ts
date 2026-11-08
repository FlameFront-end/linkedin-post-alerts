export type LinkedInErrorCode =
  | 'auth_required'
  | 'search_restricted'
  | 'source_blocked'
  | 'request_limit'
  | 'protection_pause'
  | 'rate_limited'
  | 'network'
  | 'http_error'
  | 'item_unavailable'
  | 'response_format'
  | 'response_too_large'
  | 'configuration'
  | 'cooldown'
  | 'budget';
export class LinkedInError extends Error {
  constructor(
    readonly code: LinkedInErrorCode,
    readonly retryAfterSeconds = 60,
    readonly reason?: string,
  ) {
    super(`LinkedIn: ${code}`);
  }
}
