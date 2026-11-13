import { SPX, TRACKING_TIMEOUT_MS, TRACKING_USER_AGENT } from './constants';
import { SpxError } from './errors';
import type { SpxTracking, SpxTrackingRecord } from './types';

/** Public tracking page of a parcel — the link SPX itself sends to buyers. */
export const trackingUrl = (trackingNumber: string): string =>
  `${SPX}/track?${encodeURIComponent(trackingNumber.trim())}`;

interface RawRecord {
  tracking_code?: string;
  tracking_name?: string;
  description?: string;
  buyer_description?: string;
  actual_time?: number | string;
  display_flag?: number | string;
  current_location?: { location_name?: string };
}

interface RawOrderInfo {
  order_info?: { tracking_code_group_name?: string };
  sls_tracking_info?: { records?: RawRecord[] };
}

const codeOf = (r: RawRecord): string =>
  String(r.tracking_code ?? '')
    .trim()
    .toUpperCase();

/** Shape the raw `get_order_info` payload. Exported for tests. */
export function parseTracking(trackingNumber: string, data: RawOrderInfo | null | undefined): SpxTracking {
  const raw = data?.sls_tracking_info?.records ?? [];
  const records: SpxTrackingRecord[] = raw.map((r) => ({
    code: codeOf(r),
    name: String(r.tracking_name ?? ''),
    description: String(r.buyer_description || r.description || ''),
    time: Number(r.actual_time) || 0,
    visible: Number(r.display_flag) === 1,
    location: r.current_location?.location_name || undefined,
  }));

  const delivered = records.find((r) => r.code === 'F980' && r.time > 0);
  // The delivery clock starts when the carrier TAKES the parcel (F100 "Pickup From Seller"), not when the seller
  // created the order (F000 "Manifested"). Without F100, use the earliest scan that is not F000.
  let pickedUpAt = records.find((r) => r.code === 'F100' && r.time > 0)?.time ?? null;
  if (!pickedUpAt) {
    const inNetwork = records.filter((r) => r.code !== 'F000' && r.time > 0).map((r) => r.time);
    pickedUpAt = inNetwork.length ? Math.min(...inNetwork) : null;
  }

  return {
    trackingNumber,
    statusGroup: data?.order_info?.tracking_code_group_name ?? null,
    records,
    pickedUpAt,
    deliveredAt: delivered?.time ?? null,
  };
}

/**
 * Track a parcel through SPX's public endpoint (the one behind `spx.vn/track`) — no session or cookie needed.
 * Throws `SpxError` (`NETWORK` / `HTTP_ERROR` / `BAD_RESPONSE` / `API_ERROR`) when the lookup fails.
 */
export async function getTracking(
  trackingNumber: string,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<SpxTracking> {
  const tn = trackingNumber.trim();
  const url = `${SPX}/shipment/order/open/order/get_order_info?spx_tn=${encodeURIComponent(tn)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': opts.userAgent || TRACKING_USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? TRACKING_TIMEOUT_MS),
    });
  } catch (e) {
    throw new SpxError('NETWORK', `Could not reach SPX tracking: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new SpxError('HTTP_ERROR', `SPX tracking returned HTTP ${res.status}`, res.status);
  let body: { retcode?: number; message?: string; data?: RawOrderInfo };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new SpxError('BAD_RESPONSE', 'SPX tracking did not return JSON');
  }
  if (typeof body.retcode === 'number' && body.retcode !== 0) {
    throw new SpxError('API_ERROR', `SPX tracking error ${body.retcode}: ${body.message ?? tn}`, body.retcode);
  }
  return parseTracking(tn, body.data);
}
