// ================================================================
// ChangeRequest 状态机（纯逻辑，无 DB 依赖）。
// 与 changeRequest.ts 的 DB 操作分离，便于单测与复用。
// ================================================================

import { CHANGE_TRANSITIONS } from './types';

export { CHANGE_TRANSITIONS };

export function canTransition(from: string, to: string): boolean {
  return (CHANGE_TRANSITIONS[from] ?? []).includes(to);
}
