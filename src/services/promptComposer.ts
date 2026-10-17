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
  { group: 'output', categories: ['output', 'memory', 'user_style'], header: '[OUTPUT & USER STYLE]' },
];

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

  // Group atoms by priority group
  const groupContent = new Map<string, string[]>();
  for (const pg of PRIORITY_GROUPS) groupContent.set(pg.group, []);

  for (const id of selectedAtoms) {
    const atom = versions[id];
    const category = ((atom as any).category || 'core') as string;
    // Find which group this category belongs to
    let targetGroup = 'system';
    for (const pg of PRIORITY_GROUPS) {
      if (pg.categories.includes(category)) {
        targetGroup = pg.group;
        break;
      }
    }
    groupContent.get(targetGroup)!.push(atom.instruction);
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
  const compositionHash = simpleHash(finalPrompt);

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

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
