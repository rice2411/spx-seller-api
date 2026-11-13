import { openBrowser, type Cdp } from './cdp';
import { ACCOUNT_HOST, DEFAULT_USER_AGENT, LOGIN_URL, TOKEN_COOKIE } from './constants';
import { SpxError } from './errors';
import type { SpxCredentials, SpxSession } from './types';

/**
 * Log in to the SPX seller portal with headless Chrome.
 *
 * Why a browser: `account.spx.vn/api/v4/account/business/authenticate_toc_by_password` requires a
 * `security_device_fingerprint` produced by the page's anti-bot JS. So the page itself runs — we only fill the fields
 * and click, then listen over CDP for the account API's `{error: N}` and for the `spx_token` cookie on spx.vn.
 *
 * Any unexpected step after the password (SMS OTP, captcha, device check) is handed to a HUMAN through `onChallenge`
 * as an `SpxRemote` — nothing is solved or faked automatically.
 */

export type SpxLoginEvent =
  | { type: 'step'; step: 'open' | 'submitted' | 'portal' }
  /** SPX asked for an extra step (OTP / captcha) — a human completes it through `onChallenge`. */
  | { type: 'challenge'; reason: string };

/** One frame of the login page (base64 JPEG) + viewport size. */
export interface SpxRemoteScreen {
  image: string;
  width: number;
  height: number;
}

export type SpxRemoteKey = 'Enter' | 'Backspace' | 'Tab' | 'Escape';

/** Remote control of the login browser. `click` coordinates are 0–1 fractions of the frame. */
export interface SpxRemote {
  screenshot(): Promise<SpxRemoteScreen>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: SpxRemoteKey): Promise<void>;
  /**
   * Replay EXACTLY the path a human just dragged on the frame (slider captcha) — `x`/`y` as 0–1 fractions, `t` as
   * relative ms. Only replays the human's gesture; never computes a path itself.
   */
  drag(points: { x: number; y: number; t: number }[]): Promise<void>;
}

export interface SpxLoginOptions {
  chromePath: string;
  onEvent?: (e: SpxLoginEvent) => void;
  /** Extra step required → keep the browser open and hand an `SpxRemote` to a human; wait `challengeMs`. Absent → `OTP_REQUIRED`. */
  onChallenge?: (remote: SpxRemote) => void;
  /** How long to wait for the human to finish the extra step (ms) — default 5 minutes. */
  challengeMs?: number;
  /** Fixed Chrome profile — SPX recognises the device and asks for fewer checks. */
  profileDir?: string;
  signal?: AbortSignal;
  /** Total time before any extra step (ms) — default 2 minutes. */
  timeoutMs?: number;
  userAgent?: string;
}

/** Read the login page — match inputs by type, not by (hashed) class names. */
const READ_FORM = `(() => {
  const vis = (e) => !!e && e.offsetParent !== null && !e.disabled;
  const user = [...document.querySelectorAll('input[type="text"], input[type="tel"], input[type="email"]')].find(vis);
  const pass = [...document.querySelectorAll('input[type="password"]')].find(vis);
  return {
    host: location.host,
    user: !!user, userFilled: !!(user && user.value),
    pass: !!pass, passFilled: !!(pass && pass.value),
    text: (document.body && document.body.innerText || '').slice(0, 300),
  };
})()`;

interface FormState {
  host: string;
  user: boolean;
  userFilled: boolean;
  pass: boolean;
  passFilled: boolean;
  text: string;
}

const CLICK_SUBMIT = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && !x.disabled && x.type === 'submit');
  if (b) { b.click(); return true; }
  return false;
})()`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function loginSpx(creds: SpxCredentials, opts: SpxLoginOptions): Promise<SpxSession> {
  if (!creds.username || !creds.password) throw new SpxError('LOGIN_FAILED', 'Missing username or password');
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  let deadline = Date.now() + (opts.timeoutMs ?? 2 * 60_000);
  let browser;
  try {
    browser = await openBrowser(opts.chromePath, userAgent, opts.profileDir);
  } catch (e) {
    throw new SpxError('LOGIN_FAILED', `Could not launch Chrome: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { tab } = browser;
  try {
    /** Latest error code of the account API (`{error: N}`, N ≠ 0). */
    let authError = 0;
    const watched = new Map<string, string>();
    tab.on((method, p) => {
      if (method === 'Network.responseReceived') {
        const res = p.response as { url: string };
        if (res.url.includes(`${ACCOUNT_HOST}/api/`)) watched.set(p.requestId as string, new URL(res.url).pathname);
        return;
      }
      if (method === 'Network.loadingFinished' && watched.has(p.requestId as string)) {
        watched.delete(p.requestId as string);
        void tab
          .send<{ body: string }>('Network.getResponseBody', { requestId: p.requestId })
          .then((r) => {
            const code = accountErrorCode(r.body);
            if (code) authError = code;
          })
          .catch(() => undefined);
      }
    });

    opts.onEvent?.({ type: 'step', step: 'open' });
    await tab.send('Page.navigate', { url: LOGIN_URL });

    let submittedAt = 0;
    let tries = 0;
    let challenging = false;
    let last: FormState | null = null;
    for (;;) {
      if (opts.signal?.aborted) throw new SpxError('LOGIN_ABORTED', 'SPX login aborted');
      if (Date.now() > deadline) {
        throw new SpxError('LOGIN_FAILED', `SPX login timed out (page: ${last ? firstLine(last.text) : '?'})`);
      }
      await sleep(700);
      if (await hasToken(tab)) break;
      const f = await tab.eval<FormState>(READ_FORM).catch(() => null);
      if (!f) continue;
      last = f;
      if (challenging) continue; // a human is working on the page — just wait for the cookie

      const onLoginForm = f.host === ACCOUNT_HOST && f.user && f.pass;
      if (submittedAt && Date.now() - submittedAt > 2500) {
        // Wrong credentials: the API returned an error and the page is still on the form — fail now, no remote screen.
        if (authError && onLoginForm) {
          await sleep(500);
          throw new SpxError(
            'LOGIN_FAILED',
            `SPX rejected the login: ${accountErrorReason(authError)} (code ${authError})`,
            authError,
          );
        }
        // Neither back on the portal nor a rejection → SPX wants an extra step (SMS OTP / captcha / device check).
        if (Date.now() - submittedAt > 6000) {
          if (!opts.onChallenge)
            throw new SpxError('OTP_REQUIRED', `SPX requires an extra verification step: ${firstLine(f.text)}`);
          challenging = true;
          deadline = Date.now() + (opts.challengeMs ?? 5 * 60_000);
          opts.onEvent?.({ type: 'challenge', reason: firstLine(f.text) });
          opts.onChallenge(remoteOf(tab));
          continue;
        }
      }
      if (onLoginForm && (!f.userFilled || !f.passFilled) && !submittedAt) {
        if (tries++ >= 3) throw new SpxError('LOGIN_FAILED', 'SPX login page did not accept the username / password');
        await typeInto(tab, 'input[type="text"], input[type="tel"], input[type="email"]', creds.username);
        await typeInto(tab, 'input[type="password"]', creds.password);
        await sleep(300);
        await tab.eval(CLICK_SUBMIT);
        submittedAt = Date.now();
        authError = 0;
        opts.onEvent?.({ type: 'step', step: 'submitted' });
      }
    }

    opts.onEvent?.({ type: 'step', step: 'portal' });
    return { cookie: await spxCookies(tab), userAgent };
  } finally {
    await browser.dispose();
  }
}

/** `{"error": 48401004, …}` → the code; 0 = no error / unreadable. */
function accountErrorCode(body: string): number {
  try {
    const e = (JSON.parse(body) as { error?: unknown }).error;
    return typeof e === 'number' && e !== 0 ? e : 0;
  } catch {
    return 0;
  }
}

/** Known SPX account API error codes → readable reason. Unknown codes show as a number. */
function accountErrorReason(code: number): string {
  const reasons: Record<number, string> = {
    48401004: 'account does not exist or wrong password',
  };
  return reasons[code] ?? 'SPX error';
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? 'unknown'
  );
}

async function typeInto(tab: Cdp, selector: string, text: string): Promise<void> {
  const ok = await tab.eval<boolean>(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent !== null);
    if (!e) return false;
    e.focus(); e.select && e.select();
    return true;
  })()`);
  if (!ok) throw new SpxError('LOGIN_FAILED', `Input ${selector} not found on the SPX login page`);
  await tab.send('Input.insertText', { text });
}

async function hasToken(tab: Cdp): Promise<boolean> {
  const { cookies } = await tab.send<{ cookies: { name: string; value: string; domain: string }[] }>(
    'Network.getAllCookies',
  );
  return cookies.some((c) => c.name === TOKEN_COOKIE && c.value && /(^|\.)spx\.vn$/.test(c.domain.replace(/^\./, '')));
}

/** Cookies sent with `spx.vn` requests (domain `spx.vn` / `.spx.vn`) as `a=1; b=2`. */
async function spxCookies(tab: Cdp): Promise<string> {
  const { cookies } = await tab.send<{ cookies: { name: string; value: string; domain: string }[] }>(
    'Network.getAllCookies',
  );
  const byName = new Map<string, string>();
  for (const c of cookies) if (c.domain === 'spx.vn' || c.domain === '.spx.vn') byName.set(c.name, c.value);
  return [...byName].map(([k, v]) => `${k}=${v}`).join('; ');
}

const KEYS: Record<SpxRemoteKey, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
};

/** Drive the tab over CDP — real mouse events (a JS `click()` cannot reach a captcha in a cross-origin iframe). */
function remoteOf(tab: Cdp): SpxRemote {
  const viewport = async () => {
    const m = await tab.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(
      'Page.getLayoutMetrics',
    );
    return { width: Math.round(m.cssVisualViewport.clientWidth), height: Math.round(m.cssVisualViewport.clientHeight) };
  };
  return {
    screenshot: async () => {
      const [{ data }, size] = await Promise.all([
        tab.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 60 }),
        viewport(),
      ]);
      return { image: data, ...size };
    },
    click: async (x, y) => {
      const { width, height } = await viewport();
      const px = Math.max(0, Math.min(1, x)) * width;
      const py = Math.max(0, Math.min(1, y)) * height;
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
      });
    },
    type: async (text) => {
      await tab.send('Input.insertText', { text });
    },
    drag: async (points) => {
      if (points.length < 2) return;
      const { width, height } = await viewport();
      const at = (p: { x: number; y: number }) => ({
        x: Math.max(0, Math.min(1, p.x)) * width,
        y: Math.max(0, Math.min(1, p.y)) * height,
      });
      const first = at(points[0]);
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...first,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      // Replay the human's timing between points, capping each gap at 200 ms.
      for (let i = 1; i < points.length; i++) {
        const gap = Math.max(0, Math.min(200, points[i].t - points[i - 1].t));
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        await tab.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...at(points[i]),
          button: 'left',
          buttons: 1,
        });
      }
      const last = at(points[points.length - 1]);
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...last,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    },
    key: async (key) => {
      const k = KEYS[key];
      const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
      await tab.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (key === 'Enter') await tab.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
      await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
  };
}
