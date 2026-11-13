/**
 * spx-seller-api — unofficial SPX (Shopee Express Vietnam) seller API: log in to the spx.vn seller portal with headless
 * Chrome, then call its APIs with the session cookie.
 *
 * ```ts
 * const session = await loginSpx({ username, password }, { chromePath });  // PERSIST the session
 * const spx = new SpxClient(session);
 * const me = await spx.baseInfo();
 * const wallet = await spx.balance(String(me.account_id));
 * ```
 *
 * See README.
 */
export { SpxClient } from './client';
export { SpxError } from './errors';
export type { SpxErrorCode } from './errors';
export { loginSpx } from './login';
export { createMassOrders } from './portal';
export { getTracking, trackingUrl } from './tracking';
export type { SpxMassCreateInput, SpxMassCreateResult } from './portal';
export type { SpxLoginEvent, SpxLoginOptions, SpxRemote, SpxRemoteKey, SpxRemoteScreen } from './login';
export type * from './types';
