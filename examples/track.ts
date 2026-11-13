/**
 * Track a parcel — no session needed.
 *
 *   npx tsx examples/track.ts SPXVN0123456789
 */
import { getTracking, trackingUrl } from 'spx-seller-api';

const tn = process.argv[2];
if (!tn) {
  console.error('Usage: npx tsx examples/track.ts <tracking number>');
  process.exit(1);
}

const t = await getTracking(tn);
console.log(`${t.trackingNumber}: ${t.statusGroup ?? 'unknown'} — ${trackingUrl(tn)}`);
for (const r of t.records.filter((x) => x.visible)) {
  console.log(new Date(r.time * 1000).toISOString(), r.code, r.name, r.location ?? '');
}
