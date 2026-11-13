/** Error from SPX or from the library itself. `code` lets callers branch (e.g. session expired → log in again). */
export class SpxError extends Error {
  constructor(
    readonly code: SpxErrorCode,
    message: string,
    /** HTTP status or SPX `retcode`, if any. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpxError';
  }
}

export type SpxErrorCode =
  /** 401/403, or a `retcode` whose message is about login — `spx_token` expired → call `loginSpx` again. */
  | 'SESSION_EXPIRED'
  /** SPX returned `retcode` ≠ 0 (business error: bad address, insufficient balance…). `status` = retcode. */
  | 'API_ERROR'
  /** Other HTTP status. `status` is set. */
  | 'HTTP_ERROR'
  /** Network error / timeout. */
  | 'NETWORK'
  /** Unexpected body (not JSON, empty label…). */
  | 'BAD_RESPONSE'
  /** Login failed (wrong credentials, Chrome failed to launch, form not found…). */
  | 'LOGIN_FAILED'
  /** SPX asked for an extra step (OTP / captcha) and no `onChallenge` was provided. */
  | 'OTP_REQUIRED'
  /** Caller aborted through `signal`. */
  | 'LOGIN_ABORTED';
