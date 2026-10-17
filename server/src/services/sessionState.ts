// ================================================================
// Session State — In-memory agent session management
// ================================================================

export interface SessionState {
  sessionId: string;
  userId: string;
  agentId: string;
  taskType: string;
  status: 'initializing' | 'running' | 'completed' | 'failed';
  currentPhase: string;
  iteration: number;
  maxIterations: number;
  tokenBudget: number;
  tokensUsed: number;
  creditBudget: number;
  creditsUsed: number;
  startedAt: Date;
  events: { timestamp: Date; type: string; detail: any }[];
}

const sessions = new Map<string, SessionState>();

export function createSession(userId: string, agentId: string, taskType: string): SessionState {
  const id = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const session: SessionState = {
    sessionId: id, userId, agentId, taskType,
    status: 'initializing', currentPhase: 'classification',
    iteration: 0, maxIterations: 10,
    tokenBudget: 100000, tokensUsed: 0,
    creditBudget: 5000, creditsUsed: 0,
    startedAt: new Date(), events: [],
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function updateSession(id: string, updates: Partial<SessionState>): void {
  const s = sessions.get(id);
  if (s) Object.assign(s, updates);
}

// Bound each session's event log so long-running sessions cannot grow
// without limit (memory-leak guard); oldest events are dropped first.
const MAX_EVENTS_PER_SESSION = 200;

export function addSessionEvent(id: string, type: string, detail: any): void {
  const s = sessions.get(id);
  if (!s) return;
  s.events.push({ timestamp: new Date(), type, detail });
  if (s.events.length > MAX_EVENTS_PER_SESSION) {
    s.events.splice(0, s.events.length - MAX_EVENTS_PER_SESSION);
  }
}

export function cleanupSessions(maxAgeMs = 3600000): void {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.startedAt.getTime() > maxAgeMs) sessions.delete(id);
  }
}