/** SPX seller portal — every API lives under `${SPX}/shipment/...`, authenticated by the `spx_token` cookie (httpOnly). */
export const SPX = 'https://spx.vn';
/**
 * Opening the admin page redirects to `account.spx.vn/authenticate/login?next=…` (phone / username / email + password,
 * or SMS). After login, `next` (`/shipment/account/api/login`) sets the `spx_token` cookie and returns to `/spx-admin`.
 */
export const LOGIN_URL = `${SPX}/spx-admin`;
export const ACCOUNT_HOST = 'account.spx.vn';
/** Session cookie of the seller portal (httpOnly, domain spx.vn). */
export const TOKEN_COOKIE = 'spx_token';

/** Seller wallet (COD balance): fixed parameters the portal sends (`pages-finance`, 2026-11-10). */
export const BALANCE_PARAMS = { business_entity: 4, product_line: 7 } as const;

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export const TIMEOUT_MS = 30_000;

/** Public tracking lookup is light — fail fast so a batch refresh is not held up by one slow parcel. */
export const TRACKING_TIMEOUT_MS = 8_000;

/**
 * User agent for the public tracking endpoint. A full desktop Chrome UA gets HTTP 403 there, while a bare `Mozilla/5.0`
 * (or no UA at all) is served — checked 2026-11-13.
 */
export const TRACKING_USER_AGENT = 'Mozilla/5.0';
