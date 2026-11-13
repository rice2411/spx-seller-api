import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

/** One Chrome tab over CDP (flat session on the browser websocket). */
export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  on(handler: (method: string, params: Record<string, unknown>) => void): void;
  /** Evaluate a JS expression in the page and return its (JSON-serialisable) value. */
  eval<T>(expression: string): Promise<T>;
  close(): void;
}

export interface Browser {
  tab: Cdp;
  /** Stop Chrome + delete the temporary profile (a fixed profile is kept). Call in `finally`. */
  dispose(): Promise<void>;
}

/**
 * Launch headless Chrome (regular UA) + one blank tab with Network/Page enabled.
 *
 * With `profileDir` the profile is fixed and KEPT after shutdown: SPX's device cookies survive, so next time SPX
 * recognises the machine and asks for fewer captchas. Without it a temporary profile is used and deleted.
 */
export async function openBrowser(chromePath: string, userAgent: string, profileDir?: string): Promise<Browser> {
  let dir: string;
  if (profileDir) {
    dir = profileDir;
    await mkdir(dir, { recursive: true });
    // A Chrome killed mid-run (SIGKILL / container restart) leaves lock files → next launch says "profile in use".
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
      await rm(join(dir, f), { force: true }).catch(() => undefined);
  } else {
    dir = await mkdtemp(join(tmpdir(), 'spx-chrome-'));
  }
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Containers run as root — Chromium requires the sandbox off.
      '--no-sandbox',
      '--window-size=1280,900',
      '--lang=vi-VN',
      // The default headless UA contains "HeadlessChrome" — replace it with a regular one.
      `--user-agent=${userAgent}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const kill = async () => {
    // Fixed profile: SIGTERM first so Chrome flushes cookies to disk, SIGKILL after 3 s.
    if (profileDir && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      proc.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
    }
    if (proc.exitCode === null) proc.kill('SIGKILL');
    if (!profileDir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  let ws: string;
  try {
    ws = await waitDevtools(proc);
  } catch (e) {
    await kill();
    throw e;
  }
  const tab = await openTab(ws);
  await tab.send('Network.enable');
  await tab.send('Page.enable');
  return {
    tab,
    dispose: async () => {
      tab.close();
      await kill();
    },
  };
}

/** Wait for Chrome's "DevTools listening on ws://…" line. */
function waitDevtools(proc: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 20 s')), 20_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it was ready`));
    });
  });
}

async function openTab(browserWs: string): Promise<Cdp> {
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let id = 0;
  // Assigned once the tab is attached, but the message handler above it already closes over it.
  // eslint-disable-next-line prefer-const
  let sessionId: string | undefined;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers: ((m: string, p: Record<string, unknown>) => void)[] = [];
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
      sessionId?: string;
    };
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method && (!m.sessionId || m.sessionId === sessionId)) for (const h of handlers) h(m.method, m.params ?? {});
  });
  const raw = <T>(method: string, params: object = {}, sid?: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
  const target = await raw<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  sessionId = (await raw<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
    .sessionId;
  const send = <T>(method: string, params?: object) => raw<T>(method, params, sessionId);
  return {
    send,
    on: (h) => handlers.push(h),
    eval: async <T>(expression: string) => {
      const r = await send<{ result?: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return r.result?.value as T;
    },
    close: () => ws.close(),
  };
}
