// Adaptive DB keep-alive — the standby requirement, behaviourally.
//
// No live DB: the four Prisma clients are faked via Module._load interception,
// and DATABASE_URL_* are set before db.ts is imported (it throws at module
// scope when they are missing). What is under test is the CADENCE:
//   - 0 live clients  → relaxed idle cadence
//   - ≥1 live client  → tight active cadence (a frontend is watching)
//   - stopKeepAlive   → no further pings
//
// Unit of measurement is a ROUND (one sweep over all 4 datasources = 4 pings),
// so `pings.user` alone is the round counter; the other three are asserted to
// match it exactly (every datasource pinged every round, never skipped).
import Module from 'module';

// Must be set BEFORE db.ts is imported (resolveDbUrl throws otherwise).
process.env.DATABASE_URL_USER = 'postgres://fake-user';
process.env.DATABASE_URL_CONVERSATION = 'postgres://fake-conversation';
process.env.DATABASE_URL_KNOWLEDGE = 'postgres://fake-knowledge';
process.env.DATABASE_URL_OVERFLOW = 'postgres://fake-overflow';

const pings: Record<string, number> = {};
function fakePrisma(tag: string) {
  return class {
    $queryRaw = async () => { pings[tag] = (pings[tag] ?? 0) + 1; return [{ ok: 1 }]; };
    $connect = async () => {};
    $disconnect = async () => {};
  };
}
const clients: Record<string, any> = {
  '@prisma/client-user': fakePrisma('user'),
  '@prisma/client-conversation': fakePrisma('conversation'),
  '@prisma/client-knowledge': fakePrisma('knowledge'),
  '@prisma/client-overflow': fakePrisma('overflow'),
};
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (clients[request]) return { PrismaClient: clients[request] };
  return origLoad.apply(this, arguments as any);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One sweep of keep-alive = one ping per datasource. */
const rounds = () => pings.user ?? 0;
const allFourTracked = () =>
  ['user', 'conversation', 'knowledge', 'overflow'].every((t) => (pings[t] ?? 0) === rounds());

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { startKeepAlive, stopKeepAlive } = await import('../src/services/db');
  const { resetPresence, touchClient, dropClient } = await import('../src/services/clientPresence');

  // Production defaults are 60s idle / 15s active (4:1). Scaled down to the
  // same ratio so the test finishes in seconds. Measurement windows are all
  // WINDOW_MS long so relaxed/tight are directly comparable.
  //
  // Timing note: a new cadence only takes effect on the NEXT re-arm (the loop
  // re-schedules itself after each sweep), so a window must be longer than one
  // idle interval for a presence change to be visible. WINDOW_MS is ~3 idle
  // intervals for exactly that reason.
  const IDLE_MS = 200;
  const ACTIVE_MS = 50;
  const WINDOW_MS = 620;
  const idleCeiling = Math.ceil(WINDOW_MS / IDLE_MS) + 1;

  resetPresence();
  startKeepAlive(IDLE_MS, ACTIVE_MS);

  console.log('\n1. every datasource is pinged on arm');
  const bootRounds = rounds();
  check('one sweep happened on arm', bootRounds >= 1, String(bootRounds));
  check('all 4 datasources pinged on arm',
    ['user', 'conversation', 'knowledge', 'overflow'].every((t) => (pings[t] ?? 0) >= 1),
    JSON.stringify(pings));

  console.log(`\n2. with nobody watching → relaxed cadence (<= ${idleCeiling} rounds per ${WINDOW_MS}ms)`);
  const r0 = rounds();
  await sleep(WINDOW_MS);
  const idleRounds = rounds() - r0;
  check(`relaxed gave ${idleRounds} rounds`, idleRounds >= 1 && idleRounds <= idleCeiling, `rounds=${idleRounds}`);

  console.log(`\n3. a live frontend → tight cadence (${ACTIVE_MS}ms vs ${IDLE_MS}ms)`);
  touchClient('tab_live');
  const r1 = rounds();
  await sleep(WINDOW_MS);
  const activeRounds = rounds() - r1;
  check(`tight gave ${activeRounds} rounds over the same window (relaxed gave ${idleRounds})`,
    activeRounds > idleRounds, `active=${activeRounds} idle=${idleRounds}`);
  check('tight cadence actually swept several times, not once', activeRounds >= 3, `rounds=${activeRounds}`);
  check('all 4 datasources still pinged every round while tight', allFourTracked());

  console.log('\n4. the tab leaving → cadence relaxes again');
  dropClient('tab_live');
  const r2 = rounds();
  await sleep(WINDOW_MS);
  const relaxedRounds = rounds() - r2;
  check(`after the client left: ${relaxedRounds} rounds (tight gave ${activeRounds})`,
    relaxedRounds <= idleCeiling && relaxedRounds < activeRounds, `rounds=${relaxedRounds}`);

  console.log('\n5. stopKeepAlive stops the pings entirely');
  const r3 = rounds();
  stopKeepAlive();
  await sleep(WINDOW_MS);
  check(`no rounds after stop (delta=${rounds() - r3})`, rounds() - r3 === 0, String(rounds() - r3));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
