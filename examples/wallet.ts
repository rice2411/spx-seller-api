/**
 * Print the wallet balance and the latest COD transactions.
 *
 *   npx tsx examples/wallet.ts ./session.json
 */
import { readFile } from 'node:fs/promises';
import { SpxClient, SpxError, type SpxSession } from 'spx-seller-api';

const session = JSON.parse(await readFile(process.argv[2] ?? './session.json', 'utf8')) as SpxSession;
const spx = new SpxClient(session);

try {
  const me = await spx.baseInfo();
  const accountId = String(me.account_id);
  const wallet = await spx.balance(accountId);
  console.log(`${me.store_name}: balance ${wallet.balance}`);

  const tx = await spx.transactions({ bizAccountId: accountId, types: [1], size: 10 });
  for (const t of (tx.list as Record<string, unknown>[] | undefined) ?? []) {
    console.log(new Date(Number(t.tran_time) * 1000).toISOString(), t.tracking_number, t.transaction_amount);
  }
} catch (e) {
  if (e instanceof SpxError && e.code === 'SESSION_EXPIRED') console.error('Session expired — log in again.');
  else console.error(e);
  process.exitCode = 1;
}
