/**
 * Log in once and save the session to a JSON file.
 *
 *   SPX_USERNAME=0901234567 SPX_PASSWORD=secret CHROME_PATH=/usr/bin/chromium \
 *     npx tsx examples/login-and-save-session.ts ./session.json
 *
 * ⚠️ The session file holds live credentials (cookies). Keep it private and NEVER commit it —
 * `session*.json` is already in this repo's .gitignore.
 */
import { writeFile } from 'node:fs/promises';
import { SpxError, loginSpx } from 'spx-seller-api';

const outPath = process.argv[2];
const { SPX_USERNAME: username, SPX_PASSWORD: password, CHROME_PATH: chromePath } = process.env;
if (!outPath || !username || !password || !chromePath) {
  console.error(
    'Usage: SPX_USERNAME=… SPX_PASSWORD=… CHROME_PATH=… npx tsx examples/login-and-save-session.ts <session.json>',
  );
  process.exit(1);
}

try {
  const session = await loginSpx(
    { username, password },
    { chromePath, onEvent: (e) => console.log('login:', e.type === 'step' ? e.step : `${e.type} — ${e.reason}`) },
  );
  await writeFile(outPath, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`Saved session to ${outPath}`);
  console.warn('This file contains credentials — do not commit or share it.');
} catch (e) {
  console.error(e instanceof SpxError ? `${e.code}: ${e.message}` : e);
  process.exitCode = 1;
}
