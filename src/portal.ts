import { openBrowser, type Cdp } from './cdp';
import { DEFAULT_USER_AGENT, SPX } from './constants';
import { SpxError } from './errors';
import type { SpxSession } from './types';

/**
 * Create shipments in bulk through the portal page ITSELF (`spx.vn/spx-admin/mass-order/create`), in headless
 * Chrome with a saved session.
 *
 * Why the page instead of the API: `v2/excel_upload` → `v2/excel_check` → `v2/batch_create_order` take payloads the
 * portal assembles from its draft — guessing wrong creates real, wrong shipments. Dropping the file into the upload
 * input lets the portal validate every row and compute fees; we only read "Sẵn sàng tạo đơn N / Đơn chưa hợp lệ M"
 * (ready N / invalid M) before clicking. The page is in Vietnamese, so the selectors match Vietnamese labels.
 */

export interface SpxMassCreateInput {
  chromePath: string;
  /** The .xlsx file (base64), in SPX's mass-order template. */
  base64: string;
  filename: string;
  /** Number of rows sent — if the portal reads a different count, "Create" is NOT clicked. */
  expect: number;
  /** Only upload the file and read the counts; never click "Create". */
  dryRun?: boolean;
  userAgent?: string;
  signal?: AbortSignal;
}

export interface SpxMassCreateResult {
  /** "Create" was clicked and the draft left the page (real shipments were created). */
  submitted: boolean;
  ready: number;
  invalid: number;
  /** The "drop off at a service point" option (Gửi tại điểm) is selected. */
  dropOff: boolean;
  /** Why nothing was submitted (when `submitted = false` outside `dryRun`). */
  reason: string | null;
}

const PAGE = `${SPX}/spx-admin/mass-order/create`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Read "Sẵn sàng tạo đơn N / Đơn chưa hợp lệ M" (ready N / invalid M) from the page. */
const READ_SUMMARY = `(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const ok = t.match(/S[aẵ]n s[aà]ng t[aạ]o [dđ]ơn\\s*(\\d+)/i);
  const bad = t.match(/[ĐD]ơn ch[uư]a h[oợ]p l[eệ]\\s*(\\d+)/i);
  return { ready: Number(ok ? ok[1] : 0), invalid: Number(bad ? bad[1] : 0), seen: !!(ok || bad) };
})()`;

/** Select "Gửi tại điểm" (drop off) BEFORE importing — changing it later makes the portal recompute every row's fee. */
const PICK_DROP_OFF = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let radio = document.querySelector('input[name="fulfillment_collect_type"][value="2"]');
  if (!radio) {
    const label = [...document.querySelectorAll('label')].find((el) => /g[uử]i t[aạ]i [dđ]i[eể]m/i.test((el.innerText || '').trim()));
    radio = label ? label.querySelector('input[type=radio]') : null;
  }
  if (!radio) return false;
  if (radio.checked) return true;
  (radio.closest('label') || radio).click();
  await sleep(600);
  return radio.checked;
})()`;

/**
 * Open the Excel import (the file input only exists after clicking "Nhập từ Excel", with a time-based id), then attach
 * the file through DataTransfer and fire `input`/`change` — the portal's React listens for those two events.
 */
const uploadScript = (base64: string, filename: string) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = () => [...document.querySelectorAll('input[type=file]')].find((i) => /xls|csv|sheet|excel/i.test(i.getAttribute('accept') || ''));
  let input = find();
  if (!input) {
    const btn = [...document.querySelectorAll('button,[role=button],a')].find((el) => /nh[aậ]p t[uừ]\\s*excel/i.test((el.innerText || el.textContent || '').trim()));
    if (!btn) return 'no-import-button';
    btn.click();
    for (let i = 0; i < 15 && !input; i++) { await sleep(200); input = find(); }
  }
  if (!input) return 'no-file-input';
  const bin = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(filename)}, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

/**
 * Clear drafts left on the page (a previous run stopped midway / double submit): click "Nhập lại" (reset), then the
 * "Nhập lại" button of the confirmation dialog. Otherwise the new file STACKS on the old draft — two stacked runs gave
 * 12 rows with duplicate customer codes, and SPX rejected all of them.
 */
const CLEAR_DRAFTS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && /^nh[aậ]p l[aạ]i$/i.test((x.innerText || '').trim()));
  if (!b) return 'no-reset-button';
  b.click();
  await sleep(1200);
  const ok = [...document.querySelectorAll('[class*=modal] button')].filter((x) => x.offsetParent)
    .find((x) => /^nh[aậ]p l[aạ]i$/i.test((x.innerText || '').trim()));
  if (!ok) return 'no-reset-confirm';
  ok.click();
  await sleep(1500);
  return 'ok';
})()`;

/**
 * Click "Tạo đơn" (create), then the confirm button of any dialog. Returns the dialog text seen — useful when the
 * click did not go through.
 */
const CLICK_CREATE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.querySelector('button.submit-order-button')
    || [...document.querySelectorAll('button')].find((b) => /^T[aạ]o [dđ]ơn/i.test((b.innerText || '').trim()));
  if (!btn) return { ok: false, note: 'no-create-button' };
  if (btn.disabled) return { ok: false, note: 'create-disabled' };
  btn.click();
  await sleep(1500);
  const modals = [...document.querySelectorAll('[class*=modal]')].filter((e) => e.offsetParent)
    .map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
  const confirm = [...document.querySelectorAll('.ssc-11-modal button, [class*=modal] button')].filter((b) => b.offsetParent)
    .find((b) => /^(x[aá]c nh[aậ]n|đ[oồ]ng [yý]|ok|t[aạ]o)/i.test((b.innerText || '').trim()));
  if (confirm) { confirm.click(); await sleep(1500); }
  return { ok: true, note: (modals[0] || '').slice(0, 200), confirmed: confirm ? confirm.innerText.trim() : null };
})()`;

export async function createMassOrders(session: SpxSession, input: SpxMassCreateInput): Promise<SpxMassCreateResult> {
  const userAgent = input.userAgent || session.userAgent || DEFAULT_USER_AGENT;
  let browser;
  try {
    browser = await openBrowser(input.chromePath, userAgent);
  } catch (e) {
    throw new SpxError('NETWORK', `Could not launch Chrome: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { tab } = browser;
  const aborted = () => {
    if (input.signal?.aborted) throw new SpxError('LOGIN_ABORTED', 'Shipment creation aborted');
  };
  try {
    await setSessionCookies(tab, session.cookie);
    await tab.send('Page.navigate', { url: PAGE });
    // Wait for the page: the "Nhập từ Excel" button or the drop-off option. Redirected to account.spx.vn = expired.
    for (let i = 0; ; i++) {
      aborted();
      await sleep(1000);
      const host = await tab.eval<string>('location.host').catch(() => '');
      if (host.startsWith('account.'))
        throw new SpxError('SESSION_EXPIRED', 'SPX session expired (mass-order page redirected to login)');
      const ready = await tab
        .eval<boolean>(
          `!!([...document.querySelectorAll('button,[role=button],a')].find((el) => /nh[aậ]p t[uừ]\\s*excel/i.test((el.innerText || '').trim())) || document.querySelector('input[name="fulfillment_collect_type"]'))`,
        )
        .catch(() => false);
      if (ready) break;
      if (i >= 30) throw new SpxError('BAD_RESPONSE', 'SPX mass-order page did not finish loading within 30 s');
    }

    // Old drafts on the page → clear them first and check the counts are back to 0 / 0.
    const before = await tab.eval<{ ready: number; invalid: number; seen: boolean }>(READ_SUMMARY);
    if (before.ready + before.invalid > 0) {
      const cleared = await tab.eval<string>(CLEAR_DRAFTS);
      const after = await tab.eval<{ ready: number; invalid: number; seen: boolean }>(READ_SUMMARY);
      if (cleared !== 'ok' || after.ready + after.invalid > 0) {
        return {
          submitted: false,
          ready: after.ready,
          invalid: after.invalid,
          dropOff: false,
          reason: `could not clear ${before.ready + before.invalid} old draft rows on the page (${cleared})`,
        };
      }
    }

    await tab.eval<boolean>(PICK_DROP_OFF).catch(() => false);
    const up = await tab.eval<string>(uploadScript(input.base64, input.filename));
    if (up !== 'ok')
      return {
        submitted: false,
        ready: 0,
        invalid: 0,
        dropOff: false,
        reason: `could not attach the file to the page (${up})`,
      };

    // Wait for the counts to SETTLE — the portal recomputes fees after every change and shows "invalid" meanwhile.
    let prev: { ready: number; invalid: number; seen: boolean } | null = null;
    let stable = 0;
    // Stable for 4 × 1 s AND matching the file's row count: an early read once caught "ready 6" mid-recompute.
    for (let i = 0; i < 40; i++) {
      aborted();
      await sleep(1000);
      const now = await tab.eval<{ ready: number; invalid: number; seen: boolean }>(READ_SUMMARY);
      if (!now.seen) continue;
      stable = prev && now.ready === prev.ready && now.invalid === prev.invalid ? stable + 1 : 0;
      prev = now;
      if (stable >= 4 && now.ready + now.invalid === input.expect) break;
    }
    // After the import SPX resets the method to "Lấy hàng tận nơi" (pickup) → select drop-off again AFTER the file is
    // in, then wait for the recomputed fees to settle once more.
    const dropOff = (await tab.eval<boolean>(PICK_DROP_OFF).catch(() => false)) === true;
    stable = 0;
    for (let i = 0; i < 30; i++) {
      aborted();
      await sleep(1000);
      const now = await tab.eval<{ ready: number; invalid: number; seen: boolean }>(READ_SUMMARY);
      if (!now.seen) continue;
      stable = prev && now.ready === prev.ready && now.invalid === prev.invalid ? stable + 1 : 0;
      prev = now;
      if (stable >= 4 && now.ready + now.invalid === input.expect) break;
    }
    const sum = prev ?? { ready: 0, invalid: 0, seen: false };
    const base = { ready: sum.ready, invalid: sum.invalid, dropOff };
    if (!sum.seen) return { ...base, submitted: false, reason: 'the page showed no counts after the import' };
    if (sum.invalid > 0) return { ...base, submitted: false, reason: `portal reports ${sum.invalid} invalid rows` };
    if (sum.ready <= 0) return { ...base, submitted: false, reason: 'no row is ready' };
    if (sum.ready + sum.invalid !== input.expect || sum.ready !== input.expect) {
      return {
        ...base,
        submitted: false,
        reason: `portal read ${sum.ready + sum.invalid} rows (${sum.ready} ready), expected ${input.expect} — stopping to be safe`,
      };
    }
    if (!dropOff) return { ...base, submitted: false, reason: 'could not select drop-off ("Gửi tại điểm")' };
    if (input.dryRun) return { ...base, submitted: false, reason: null };

    aborted();
    const clicked = await tab.eval<{ ok: boolean; note: string; confirmed: string | null }>(CLICK_CREATE);
    if (!clicked.ok) return { ...base, submitted: false, reason: `could not click Create (${clicked.note})` };
    // Submitted orders leave the page (counts back to 0 / 0). Still there after 20 s = SPX did not accept — report dialog + page text.
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const now = await tab.eval<{ ready: number; invalid: number; seen: boolean }>(READ_SUMMARY).catch(() => null);
      if (now && now.ready + now.invalid === 0) return { ...base, submitted: true, reason: null };
    }
    const page = await tab
      .eval<string>(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`)
      .catch(() => '');
    return {
      ...base,
      submitted: false,
      reason: `clicked Create (dialog: ${clicked.note || 'none'}${clicked.confirmed ? `, clicked "${clicked.confirmed}"` : ''}) but the draft is still on the page — ${page}`,
    };
  } finally {
    await browser.dispose();
  }
}

/** Load the session cookies (`a=1; b=2`) into Chrome for spx.vn before opening the page. */
async function setSessionCookies(tab: Cdp, cookie: string): Promise<void> {
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    await tab.send('Network.setCookie', {
      name,
      value,
      url: `${SPX}/`,
      domain: '.spx.vn',
      path: '/',
      secure: true,
      httpOnly: name === 'spx_token',
    });
  }
}
