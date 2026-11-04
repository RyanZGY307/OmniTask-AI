// Runner 注册表：7 种架构模式（Free 3 + Pro 4），由 agentLoop 按选择结果派发。
import type { PatternId } from './types';
import type { PatternRunner } from '../runner';
import { singleAgentRunner } from './singleAgent';
import { reactRunner } from './react';
import { planExecuteRunner } from './planExecute';
import { multiAgentRunner } from './multiAgent';
import { routeSkillRunner } from './routeSkill';
import { blackboardRunner } from './blackboard';
import { graphWorkflowRunner } from './graphWorkflow';

const RUNNERS: Record<PatternId, PatternRunner> = {
  single_agent: singleAgentRunner,
  react: reactRunner,
  plan_execute: planExecuteRunner,
  multi_agent: multiAgentRunner,
  route_skill: routeSkillRunner,
  blackboard: blackboardRunner,
  graph_workflow: graphWorkflowRunner,
};

export function getRunner(id: PatternId): PatternRunner {
  const r = RUNNERS[id];
  if (!r) throw new Error(`unknown pattern: ${id}`);
  return r;
}

export { RUNNERS };
