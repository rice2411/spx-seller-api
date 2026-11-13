/** A seller portal session — returned by `loginSpx`. PERSIST it and reuse it until SPX reports it expired. */
export interface SpxSession {
  /** `spx.vn` cookies as `a=1; b=2` — the real credential is `spx_token`. */
  cookie: string;
  userAgent?: string;
}

/** Phone number / username / email + password (the "Log in" tab of account.spx.vn). */
export interface SpxCredentials {
  username: string;
  password: string;
}

/** Envelope of every `/shipment/*` API: `retcode` 0 = success. */
export interface SpxEnvelope<T> {
  retcode: number;
  message?: string;
  data: T;
}

export interface SpxCallInit {
  method?: 'GET' | 'POST';
  /** Object → JSON (POST). */
  body?: unknown;
  /** Query string (GET). */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface SpxClientOptions {
  logger?: (level: 'debug' | 'warn', msg: string) => void;
}

/** One checkpoint of a parcel's journey (`sls_tracking_info.records[]`). Times are unix SECONDS. */
export interface SpxTrackingRecord {
  /** Stable checkpoint code, e.g. `F000` manifested · `F100` picked up from seller · `F600` out for delivery · `F980` delivered. */
  code: string;
  /** English checkpoint name, e.g. `Enter Sorting Center`. */
  name: string;
  /** Localised description shown to buyers (falls back to the internal description). */
  description: string;
  time: number;
  /** `display_flag = 1` — the checkpoints SPX shows on its public tracking page. */
  visible: boolean;
  location?: string;
}

/** Public tracking of one parcel — no session needed. */
export interface SpxTracking {
  trackingNumber: string;
  /** Status group in English: `Pending` · `Picked up` · `In Transit` · `Out for Delivery` · `Delivered` · `Cancelled` · `Returned`. */
  statusGroup: string | null;
  /** Every checkpoint, newest first (as SPX returns them). */
  records: SpxTrackingRecord[];
  /** When the carrier took the parcel (`F100`, else the earliest scan other than `F000`) — unix seconds. */
  pickedUpAt: number | null;
  /** Successful delivery (`F980`) — unix seconds. */
  deliveredAt: number | null;
}
