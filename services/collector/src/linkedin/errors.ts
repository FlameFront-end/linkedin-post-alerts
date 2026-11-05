export type LinkedInErrorCode =
  | 'auth_required'
  | 'rate_limited'
  | 'network'
  | 'http_error'
  | 'response_format'
  | 'response_too_large'
  | 'configuration'
  | 'cooldown';
export class LinkedInError extends Error {
  constructor(
    readonly code: LinkedInErrorCode,
    readonly retryAfterSeconds = 60,
  ) {
    super(`LinkedIn: ${code}`);
  }
}
