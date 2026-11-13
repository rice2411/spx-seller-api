import { BALANCE_PARAMS, DEFAULT_USER_AGENT, SPX, TIMEOUT_MS } from './constants';
import { SpxError } from './errors';
import type { SpxCallInit, SpxClientOptions, SpxEnvelope, SpxSession } from './types';

/** `retcode` ≠ 0 with a message about logging in → treat as an expired session. */
const AUTH_MESSAGE = /login|auth|token|unauthor|đăng nhập/i;

/**
 * Calls the SPX seller portal APIs with the session cookie (`spx_token`). Endpoints were read from the portal bundle
 * (2026-11-10) — see README.
 */
export class SpxClient {
  private readonly log: NonNullable<SpxClientOptions['logger']>;

  constructor(
    private readonly session: SpxSession,
    opts: SpxClientOptions = {},
  ) {
    this.log = opts.logger ?? (() => undefined);
  }

  /** Account info: `store_name`, `user_name`, `phone_number`, `account_id`… — also a cheap "is the session alive" check. */
  baseInfo(): Promise<Record<string, unknown>> {
    return this.call('/shipment/account/api/base_info/detail');
  }

  /**
   * Seller wallet ("Balance" screen): `balance`, `received_amount`, `paid_amount`, `frozen_balance`,
   * `withdraw_enabled`, `disabled_reason` — amounts are STRINGS. `bizAccountId` = `account_id` from `baseInfo`
   * (missing → `-1000012 param error`).
   */
  balance(bizAccountId: string | number): Promise<Record<string, unknown>> {
    return this.call('/shipment/forward/account/api/spx_seller/seller_balance/detail', {
      query: { ...BALANCE_PARAMS, biz_account_id: String(bizAccountId) },
    });
  }

  /**
   * Wallet transactions (`seller_tran_type_list`: 1 = COD credited to the wallet; empty = every type). `bizAccountId` =
   * `account_id` from `baseInfo`. Paginate with `offset`. `list[]`: `biz_transaction_id`, `seller_tran_type`,
   * `tracking_number`, `transaction_amount`, `balance_before/after` (strings), `tran_time` (seconds), `settlement_sn`;
   * plus `total`.
   */
  transactions(input: {
    bizAccountId: string | number;
    offset?: number;
    size?: number;
    types?: number[];
  }): Promise<Record<string, unknown>> {
    return this.call('/shipment/forward/account/api/spx_seller/seller_balance/transaction_list', {
      method: 'POST',
      body: {
        ...BALANCE_PARAMS,
        offset: input.offset ?? 0,
        size: input.size ?? 50,
        ...(input.types ? { seller_tran_type_list: input.types } : {}),
        // MUST be a string — a number yields `-1000012 ReadString: expects "`.
        biz_account_id: String(input.bizAccountId),
      },
    });
  }

  /** Shipments, newest first: `list[].order_info.{spx_tn, order_sn, ctime}`, `parcel_info.customer_tracking_no`. */
  listOrders(input: { offset?: number; pageSize?: number } = {}): Promise<Record<string, unknown>> {
    return this.call('/shipment/order/logistic/order/list_all_order', {
      method: 'POST',
      body: { page_size: input.pageSize ?? 50, offset: input.offset ?? 0, language: 'vi' },
    });
  }

  /** Shipping label (PDF) by `order_sn` (NOT the `spx_tn` tracking number). */
  async label(orderSns: string[]): Promise<Buffer> {
    const res = await this.fetch(
      `${SPX}/shipment/order/logistic/label/batch_get_shipping_label?order_sn_list=${encodeURIComponent(orderSns.join(','))}`,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new SpxError('BAD_RESPONSE', `SPX returned an empty label (${buf.length} bytes)`);
    return buf;
  }

  /** Call any `/shipment/*` API and return `data` (after checking `retcode`). */
  async call<T = Record<string, unknown>>(path: string, init: SpxCallInit = {}): Promise<T> {
    let url = `${SPX}${path}`;
    if (init.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) if (v !== undefined) qs.set(k, String(v));
      url += `?${qs.toString()}`;
    }
    const res = await this.fetch(url, init.method ?? (init.body !== undefined ? 'POST' : 'GET'), init.body);
    let env: SpxEnvelope<T>;
    try {
      env = (await res.json()) as SpxEnvelope<T>;
    } catch {
      throw new SpxError('BAD_RESPONSE', `SPX did not return JSON (${path})`);
    }
    if (env.retcode !== 0) {
      const msg = env.message ?? '';
      if (AUTH_MESSAGE.test(msg)) throw new SpxError('SESSION_EXPIRED', `SPX session expired: ${msg}`, env.retcode);
      throw new SpxError('API_ERROR', `SPX error ${env.retcode}: ${msg || path}`, env.retcode);
    }
    return env.data;
  }

  private async fetch(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          cookie: this.session.cookie,
          'user-agent': this.session.userAgent || DEFAULT_USER_AGENT,
          accept: 'application/json, text/plain, */*',
          origin: SPX,
          referer: `${SPX}/spx-admin`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new SpxError('NETWORK', `Could not reach SPX: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SpxError('SESSION_EXPIRED', `SPX session expired (HTTP ${res.status})`, res.status);
    }
    if (!res.ok)
      throw new SpxError('HTTP_ERROR', `SPX returned HTTP ${res.status} (${new URL(url).pathname})`, res.status);
    this.log('debug', `SPX ${method} ${new URL(url).pathname} → ${res.status}`);
    return res;
  }
}
