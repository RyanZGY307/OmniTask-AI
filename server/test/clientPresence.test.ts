// clientPresence — pure presence bookkeeping (no DB, no timers).
import {
  activeClientCount,
  activeClients,
  dropClient,
  keepAliveIntervalMs,
  pruneClients,
  resetPresence,
  touchClient,
  KEEPALIVE_ACTIVE_MS,
  KEEPALIVE_IDLE_MS,
  MAX_PRESENCE_ENTRIES,
  PRESENCE_TTL_MS,
} from '../src/services/clientPresence';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const T0 = 1_000_000;

  console.log('\n1. touchClient registers a live client');
  resetPresence();
  touchClient('tab_a', T0);
  check('one client is live', activeClientCount(PRESENCE_TTL_MS, T0) === 1, String(activeClientCount()));
  check('id is retained', eq(activeClients(PRESENCE_TTL_MS, T0), ['tab_a']));

  console.log('\n2. the same tab heartbeating twice is still ONE client');
  touchClient('tab_a', T0 + 5_000);
  check('count stays 1, not 2', activeClientCount(PRESENCE_TTL_MS, T0 + 5_000) === 1);

  console.log('\n3. multiple tabs each count');
  touchClient('tab_b', T0 + 6_000);
  check('two distinct tabs → 2', activeClientCount(PRESENCE_TTL_MS, T0 + 6_000) === 2);

  console.log('\n4. empty / whitespace ids are ignored');
  resetPresence();
  touchClient('', T0);
  touchClient('   ', T0);
  touchClient(undefined as any, T0);
  touchClient(null as any, T0);
  check('no client registered from blank ids', activeClientCount(PRESENCE_TTL_MS, T0) === 0);

  console.log('\n5. a silent tab stops counting after the TTL');
  resetPresence();
  touchClient('tab_a', T0);
  check('exactly at the TTL still counts as live',
    activeClientCount(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS) === 1);
  check('one ms past the TTL → not live',
    activeClientCount(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS + 1) === 0,
    'closed/crashed tabs must not wedge the standby state on');
  check('a fresh heartbeat revives it', (touchClient('tab_a', T0 + PRESENCE_TTL_MS + 1),
    activeClientCount(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS + 1) === 1));

  console.log('\n6. pruneClients removes only expired entries');
  resetPresence();
  touchClient('dead', T0);                          // last seen a full TTL ago
  touchClient('live', T0 + PRESENCE_TTL_MS);        // heartbeated just now
  const removed = pruneClients(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS + 10);
  check('removed only the dead one', removed === 1, String(removed));
  check('kept the live one', activeClientCount(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS + 10) === 1);
  check('re-pruning is idempotent', pruneClients(PRESENCE_TTL_MS, T0 + PRESENCE_TTL_MS + 20) === 0);

  console.log('\n7. dropClient removes one id explicitly');
  resetPresence();
  touchClient('a', T0);
  touchClient('b', T0);
  check('drop a returns true', dropClient('a') === true);
  check('drop a missing id returns false', dropClient('a') === false);
  check('b survives', activeClientCount(PRESENCE_TTL_MS, T0) === 1);

  console.log('\n8. keep-alive cadence follows presence');
  check('nobody watching → relaxed idle cadence',
    keepAliveIntervalMs(0) === KEEPALIVE_IDLE_MS, String(keepAliveIntervalMs(0)));
  check('one live frontend → tight active cadence',
    keepAliveIntervalMs(1) === KEEPALIVE_ACTIVE_MS, String(keepAliveIntervalMs(1)));
  check('many live frontends → same tight cadence (not tighter)',
    keepAliveIntervalMs(500) === KEEPALIVE_ACTIVE_MS);
  check('active cadence is strictly tighter than idle (standby only speeds up)',
    KEEPALIVE_ACTIVE_MS < KEEPALIVE_IDLE_MS);

  console.log('\n9. frontend standby poll must stay inside the server TTL');
  // The client polls every 20s (client/src/lib/standby.ts STANDBY_POLL_MS); if
  // the TTL were shorter than that, a healthy tab would flap in and out of
  // "live" and the pooler would sleep between heartbeats.
  check('server TTL (45s) > frontend standby poll (20s)', PRESENCE_TTL_MS > 20_000,
    `ttl=${PRESENCE_TTL_MS}`);

  console.log('\n10. malformed client ids are rejected (unauthenticated header)');
  resetPresence();
  touchClient('ok_tab-1', T0);
  check('a well-formed id registers', activeClientCount(PRESENCE_TTL_MS, T0) === 1);
  // 注意：'null'/'undefined' 不在列——它们是合法字母数字 id，设计上就该接受；
  // 只有"形态违规"（空、超长、空白/分号/尖括号/路径字符）才拒绝。
  for (const bad of ['', '   ', 'x'.repeat(65), 'a b', 'a;b', 'a\nb', 'a\tb', '<script>', '../../etc']) {
    touchClient(bad, T0);
  }
  check('none of the malformed ids registered',
    activeClientCount(PRESENCE_TTL_MS, T0) === 1, `count=${activeClientCount(PRESENCE_TTL_MS, T0)}`);
  touchClient('a'.repeat(64), T0);
  check('an exactly-64-char id is accepted', activeClientCount(PRESENCE_TTL_MS, T0) === 2);

  console.log('\n11. the registry cannot be grown without bound');
  resetPresence();
  for (let i = 0; i < MAX_PRESENCE_ENTRIES; i++) touchClient(`flood_${i}`, T0);
  check('table filled to the cap', activeClientCount(PRESENCE_TTL_MS, T0) === MAX_PRESENCE_ENTRIES,
    String(activeClientCount(PRESENCE_TTL_MS, T0)));
  touchClient('one_more', T0);
  check('a NEW id is refused once the cap is reached',
    activeClientCount(PRESENCE_TTL_MS, T0) === MAX_PRESENCE_ENTRIES,
    String(activeClientCount(PRESENCE_TTL_MS, T0)));
  touchClient('flood_7', T0 + 1);
  check('an EXISTING id can still be refreshed at the cap',
    activeClients(PRESENCE_TTL_MS, T0 + 1).includes('flood_7'));
  check('cap is a bounded number', MAX_PRESENCE_ENTRIES > 0 && MAX_PRESENCE_ENTRIES <= 10_000);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
