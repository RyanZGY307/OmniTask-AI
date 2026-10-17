// ================================================================
// Adaptive Refresh Interval — D2 backoff state machine (pure fn).
// No DB / no env reads so the full state machine is unit-testable.
// ================================================================

export interface AdaptiveIntervalInput {
  // previous interval in months (the one the last refresh ran under)
  prevIntervalMonths: number;
  // outcome of the last refresh
  lastStatus:
    | 'UNCHANGED'
    | 'MINOR_CHANGE'
    | 'MATERIAL_CHANGE'
    | 'CONFLICT'
    | 'SOURCE_GONE'
    | 'UNVERIFIED'
    | 'REFRESH_FAILED'
    | 'CANNOT_VERIFY';
  // D2: consecutive failure count BEFORE this refresh (REFRESH_FAILED adds one)
  consecutiveFailureCountBefore: number;
  // unchanged streak BEFORE this refresh (UNCHANGED adds one, others reset)
  unchangedStreakBefore: number;
  // D2 config: after this many consecutive failures, drop to LOW + pause
  maxConsecutiveFailures: number;
  // D2 config: how many cycles to pause after hitting the failure cap
  pauseCyclesAfterMaxFailures: number;
  // refresh cadence config (months)
  stableSteps: number[]; // e.g. [1, 2, 3, 6, 12]
  hotStep: number; // e.g. 0.5 (two weeks) while fact is hot/changing
  // current month granularity cycle ("YYYY-MM"); used to schedule next refresh
  currentCycle: string;
}

export interface AdaptiveIntervalResult {
  newIntervalMonths: number;
  priority: 1 | 2 | 3 | 4; // 1 CRITICAL | 2 HIGH | 3 NORMAL | 4 LOW
  consecutiveFailureCount: number; // after this refresh
  unchangedStreak: number; // after this refresh
  pausedUntil: Date | null; // when paused, the earliest time to dispatch again
  nextRefreshAt: Date; // absolute next dispatch time
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + Math.round(months * 12));
  return d;
}

function addMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60_000);
}

// Determines next refresh plan from last outcome. Pure: same input -> same output.
export function computeAdaptiveInterval(input: AdaptiveIntervalInput): AdaptiveIntervalResult {
  const {
    prevIntervalMonths,
    lastStatus,
    consecutiveFailureCountBefore,
    unchangedStreakBefore,
    maxConsecutiveFailures,
    pauseCyclesAfterMaxFailures,
    stableSteps,
    hotStep,
    currentCycle,
  } = input;

  const now = new Date();
  // cycle start = 1st of the cycle month; nextRefreshAt is computed from "now"
  // plus the new interval so it reflects the actual schedule.

  let newIntervalMonths = prevIntervalMonths;
  let priority: 1 | 2 | 3 | 4 = 3;
  let consecutiveFailureCount = consecutiveFailureCountBefore;
  let unchangedStreak = unchangedStreakBefore;
  let pausedUntil: Date | null = null;

  switch (lastStatus) {
    case 'REFRESH_FAILED': {
      // D2: failures do not accumulate unchangedStreak nor downgrade cadence.
      consecutiveFailureCount += 1;
      const hitCap = consecutiveFailureCount >= maxConsecutiveFailures;
      if (hitCap) {
        // drop to LOW and pause for N cycles; pause window = N * stableSteps[0]
        priority = 4;
        const pauseCycleMinutes = Math.round(stableSteps[0] * 30 * 24 * 60);
        pausedUntil = addMinutes(now, pauseCyclesAfterMaxFailures * pauseCycleMinutes);
      }
      // next attempt: if paused, at pausedUntil; else keep prev interval.
      const base = pausedUntil ? pausedUntil : now;
      const nextRefreshAt = pausedUntil
        ? pausedUntil
        : addMonths(now, prevIntervalMonths);
      newIntervalMonths = prevIntervalMonths;
      return {
        newIntervalMonths,
        priority,
        consecutiveFailureCount,
        unchangedStreak, // unchanged
        pausedUntil,
        nextRefreshAt: nextRefreshAt > base ? nextRefreshAt : base,
      };
    }
    case 'UNCHANGED':
    case 'MINOR_CHANGE': {
      // D2: both reset consecutive failures; UNCHANGED and MINOR_CHANGE both
      // accumulate the stable streak (MINOR_CHANGE = formatting tweak, fact intact).
      consecutiveFailureCount = 0;
      unchangedStreak += 1;
      // step up cadence along stableSteps while streak keeps growing
      // streak=1 -> 2nd step, streak=2 -> 3rd step, etc.
      const stepIndex = Math.min(unchangedStreak, stableSteps.length - 1);
      newIntervalMonths = stableSteps[stepIndex];
      priority = 3;
      break;
    }
    case 'MATERIAL_CHANGE': {
      // fact changed -> reset streak, hot cadence for one cycle
      consecutiveFailureCount = 0;
      unchangedStreak = 0;
      newIntervalMonths = hotStep;
      priority = 2;
      break;
    }
    case 'CONFLICT':
    case 'SOURCE_GONE':
    case 'UNVERIFIED':
    case 'CANNOT_VERIFY': {
      // needs verification -> escalate; reset failure count, keep streak
      consecutiveFailureCount = 0;
      newIntervalMonths = hotStep; // verify sooner
      priority = 2;
      break;
    }
    default:
      newIntervalMonths = prevIntervalMonths;
      break;
  }

  const nextRefreshAt = addMonths(now, newIntervalMonths);
  return {
    newIntervalMonths,
    priority,
    consecutiveFailureCount,
    unchangedStreak,
    pausedUntil,
    nextRefreshAt,
  };
}

// Convenience: D3 filter — whether a fact's refresh state should be dispatchable.
export function isRefreshDispatchable(state: {
  archived: boolean;
  pausedUntil: Date | null;
  lifecycleStatus: string;
  verificationStatus: string;
}): boolean {
  if (state.archived) return false;
  if (state.pausedUntil && state.pausedUntil.getTime() > Date.now()) return false;
  // D3: only ACTIVE lifecycle + verification states that can still be repaired
  const lifecycleOk = state.lifecycleStatus === 'ACTIVE';
  const verificationOk = ['VERIFIED', 'SUPPORTED', 'CONFLICTED', 'UNVERIFIED'].includes(
    state.verificationStatus,
  );
  return lifecycleOk && verificationOk;
}

// current cycle string "YYYY-MM"
export function currentCycleStr(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export { addMonths };
