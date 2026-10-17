// ================================================================
// Prompt Composer — deterministic assembly with strict section isolation
// ================================================================
// Priority: Core > Safety > Privacy > Truth > System > Runtime >
//           Task > Domain > Knowledge > Agent > Skill > Tool > Memory > User Style > Output
//
// Isolation:
//   SYSTEM INSTRUCTIONS  (Core, Safety, Privacy, System, Runtime)
//   TASK INSTRUCTIONS    (Task, Domain, Agent, Skill, Tool, Memory, User Style, Output)
//   RETRIEVED KNOWLEDGE  (untrusted data, cannot override system)
//   USER CONTENT
//   FILES
//   WEB CONTENT
//
// Truth Standard is ALWAYS the last section.
// ================================================================

import { getActiveVersions } from './promptRegistry';
import { KERNEL_TRUTH, KERNEL_INTENT_UNDERSTANDING } from './kernel';

export interface ComposeResult {
  final_prompt: string;
  selected_atoms: string[];
  removed_atoms: string[];
  conflicts: any[];
  dependencies: any[];
  composition_hash: string;
  sections: Record<string, string>;
}

// Priority groups in strict order
const PRIORITY_GROUPS: Array<{ group: string; categories: string[]; header: string }> = [
  { group: 'system', categories: ['core', 'safety', 'privacy'], header: '[SYSTEM INSTRUCTIONS]' },
  { group: 'runtime', categories: ['runtime', 'scenario'], header: '[RUNTIME CONTEXT]' },
  { group: 'task', categories: ['task', 'domain'], header: '[TASK INSTRUCTIONS]' },
  { group: 'knowledge', categories: ['knowledge', 'research'], header: '[RETRIEVED KNOWLEDGE]' },
  { group: 'verification', categories: ['verification'], header: '[VERIFICATION]' },
  { group: 'agent', categories: ['agent', 'skill', 'tool'], header: '[AGENT / SKILLS]' },
  // Safety net: content whose category is not in the taxonomy must NOT fall
  // into 'system' (the highest-trust block). It is isolated here instead.
  { group: 'unclassified', categories: [], header: '[UNCLASSIFIED INSTRUCTIONS]' },
  { group: 'output', categories: ['output', 'memory', 'user_style'], header: '[OUTPUT & USER STYLE]' },
];

// Resolve an atom's category to a group. A MISSING/empty category means the
// atom predates categorisation and is treated as core; an UNRECOGNISED
// non-empty category is untrusted taxonomy drift and is quarantined in
// 'unclassified' rather than being promoted into [SYSTEM INSTRUCTIONS].
function resolveGroup(category: unknown): string {
  const cat = typeof category === 'string' ? category.trim() : '';
  if (!cat) return 'system';
  for (const pg of PRIORITY_GROUPS) {
    if (pg.categories.includes(cat)) return pg.group;
  }
  return 'unclassified';
}

export async function composePrompt(
  atomIds: string[],
  runtimeContext: Record<string, any>,
  opts?: {
    knowledgeSection?: string;
    userContentSection?: string;
    filesSection?: string;
    webContentSection?: string;
    versions?: Record<string, { version: string; instruction: string; priority?: number }>;
  },
): Promise<ComposeResult> {
  const versions = opts?.versions || await getActiveVersions();
  const selectedAtoms = atomIds.filter(id => versions[id]);
  const removedAtoms = atomIds.filter(id => !versions[id]);

  // Group atoms by priority group. Atoms are visited in the ORDER GIVEN so
  // the resulting composition is deterministic for a fixed atomIds input.
  const groupContent = new Map<string, string[]>();
  for (const pg of PRIORITY_GROUPS) groupContent.set(pg.group, []);

  for (const id of selectedAtoms) {
    const atom = versions[id];
    groupContent.get(resolveGroup((atom as any).category))!.push(atom.instruction);
  }

  // Build sections in strict order
  const sections: Record<string, string> = {};
  const sectionOrder: string[] = [];

  for (const pg of PRIORITY_GROUPS) {
    const items = groupContent.get(pg.group)!;
    if (items.length > 0) {
      sections[pg.group] = `${pg.header}\n\n${items.join('\n\n')}`;
      sectionOrder.push(pg.group);
    }
  }

  // Inject runtime context into runtime group
  if (Object.keys(runtimeContext).length > 0) {
    const rtContent = formatRuntimeContext(runtimeContext);
    if (sections['runtime']) {
      sections['runtime'] += `\n\n${rtContent}`;
    } else {
      sections['runtime'] = `[RUNTIME CONTEXT]\n${rtContent}`;
      sectionOrder.splice(1, 0, 'runtime');
    }
  }

  // Inject optional sections (Knowledge, User Content, Files, Web)
  if (opts?.knowledgeSection) {
    sections['knowledge_external'] = opts.knowledgeSection;
    sectionOrder.push('knowledge_external');
  }
  if (opts?.userContentSection) {
    sections['user_content'] = opts.userContentSection;
    sectionOrder.push('user_content');
  }
  if (opts?.filesSection) {
    sections['files'] = opts.filesSection;
    sectionOrder.push('files');
  }
  if (opts?.webContentSection) {
    sections['web_content'] = opts.webContentSection;
    sectionOrder.push('web_content');
  }

  // Intent Understanding supplement — independent, always-sent section.
  // Placed before the Truth Standard, which must remain the last section.
  sections['intent'] = KERNEL_INTENT_UNDERSTANDING;
  sectionOrder.push('intent');

  // Truth Standard is ALWAYS last
  sections['truth'] = KERNEL_TRUTH;
  sectionOrder.push('truth');

  // Assemble
  const allSections = sectionOrder.map(key => sections[key]).filter(Boolean);
  const finalPrompt = allSections.join('\n\n---\n\n');
  const compositionHash = simpleHash(canonicalizeForHash(finalPrompt));

  return {
    final_prompt: finalPrompt,
    selected_atoms: selectedAtoms,
    removed_atoms: removedAtoms,
    conflicts: [],
    dependencies: [],
    composition_hash: compositionHash,
    sections,
  };
}

function formatRuntimeContext(ctx: Record<string, any>): string {
  const lines: string[] = [];
  if (ctx.language) lines.push(`Language: ${ctx.language}`);
  if (ctx.region) lines.push(`Region: ${ctx.region}`);
  if (ctx.user_tier) lines.push(`User Tier: ${ctx.user_tier}`);
  if (ctx.knowledge_required !== undefined) lines.push(`Knowledge Required: ${ctx.knowledge_required}`);
  if (ctx.verification_required !== undefined) lines.push(`Verification Required: ${ctx.verification_required}`);
  if (ctx.output_type) lines.push(`Expected Output: ${ctx.output_type}`);
  if (ctx.depth) lines.push(`Depth: ${ctx.depth}`);
  if (ctx.files && ctx.files.length > 0) lines.push(`Files: ${ctx.files.join(', ')}`);
  lines.push(`Current Time: ${new Date().toISOString()}`);
  return lines.join('\n');
}

// The runtime context carries a wall-clock timestamp, which the model needs but
// which would make composition_hash differ on every single request and defeat
// its use as a persisted final_prompt_hash for trace correlation. Hash the
// canonical (timestamp-stripped) form so the hash identifies the COMPOSITION.
const VOLATILE_CONTEXT_LINE = /^Current Time: .*$/gm;

export function canonicalizeForHash(prompt: string): string {
  return prompt.replace(VOLATILE_CONTEXT_LINE, '');
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
