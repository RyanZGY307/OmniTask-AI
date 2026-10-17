// ================================================================
// Import Service — Bulk import from uploaded ZIP files
// Supports: skills, plugins, knowledge
// ================================================================

import AdmZip from 'adm-zip';
import { prismaKnowledge, prisma } from './db';

export interface ImportResult {
  success: number;
  failed: number;
  errors: string[];
  summary: Record<string, string>;
}

export async function importSkillsFromZip(zipBuffer: Buffer): Promise<ImportResult> {
  const result: ImportResult = { success: 0, failed: 0, errors: [], summary: {} };
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Structure: root-level manifest.json OR skill directories each with prompt.md + manifest.json
  const rootManifest = entries.find(e => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json'));
  const skillDirs = entries.filter(e => e.entryName.match(/^[^/]+\/prompt\.md$/) && !e.entryName.startsWith('__MACOSX'));
  const topLevelPromptFiles = entries.filter(e => e.entryName.endsWith('/prompt.md') && !e.entryName.startsWith('__MACOSX'));

  let skillsToProcess: Array<{ name: string; dirName: string; manifest?: any; promptBuffer?: Buffer }> = [];

  if (rootManifest && skillDirs.length === 0 && topLevelPromptFiles.length > 0) {
    // Flat structure: manifest.json at root + prompt files at root level
    try {
      const manifest = JSON.parse(rootManifest.getData().toString()) as any;
      if (Array.isArray(manifest.skills)) {
        for (const s of manifest.skills) {
          const promptFile = entries.find(e => e.entryName === (s.file || `${s.name}.md`));
          skillsToProcess.push({
            name: s.name,
            dirName: s.name,
            manifest: s,
            promptBuffer: promptFile?.getData(),
          });
        }
      }
    } catch {}
  } else if (skillDirs.length > 0) {
    // Directory-per-skill structure
    const processedDirs = new Set<string>();
    for (const entry of skillDirs) {
      const dirName = entry.entryName.split('/')[0];
      if (processedDirs.has(dirName)) continue;
      processedDirs.add(dirName);

      const manifestEntry = entries.find(e => e.entryName === `${dirName}/manifest.json`);
      const promptEntry = entries.find(e => e.entryName === `${dirName}/prompt.md`);
      let manifest: any = {};
      if (manifestEntry) {
        try { manifest = JSON.parse(manifestEntry.getData().toString()); } catch {}
      }
      skillsToProcess.push({
        name: manifest.name || dirName,
        dirName,
        manifest,
        promptBuffer: promptEntry?.getData(),
      });
    }
  } else {
    // No valid structure found
    result.errors.push('ZIP 结构无效：需要 manifest.json + prompt.md，或 skill 目录结构');
    return result;
  }

  for (const skill of skillsToProcess) {
    try {
      const promptContent = skill.promptBuffer
        ? skill.promptBuffer.toString('utf-8')
        : skill.manifest?.prompt || '';

      if (!promptContent.trim() && !skill.manifest?.prompt) {
        result.errors.push(`技能 ${skill.name}：缺少 prompt 内容`);
        result.failed++;
        continue;
      }

      // Use findFirst + create/update since Skill has no unique constraint on name
      const existingSkill = await prismaKnowledge.skill.findFirst({ where: { name: skill.name } });
      if (existingSkill) {
        await prismaKnowledge.skill.update({ where: { id: existingSkill.id }, data: {
          description: skill.manifest?.description,
          prompt: promptContent,
          category: skill.manifest?.category,
        }});
        // Admin import is a legal formal-Skill path: bump version + enqueue S1.
        const { enqueueSkillAnalysis } = await import('./skillPublishGuard');
        await enqueueSkillAnalysis(existingSkill.id, 'updated').catch(() => undefined);
      } else {
        const created = await prismaKnowledge.skill.create({ data: {
          name: skill.name,
          description: skill.manifest?.description,
          prompt: promptContent,
          category: skill.manifest?.category,
        }});
        // New Skill from admin import: enqueue S1 semantic analysis.
        const { enqueueSkillAnalysis } = await import('./skillPublishGuard');
        await enqueueSkillAnalysis(created.id, 'uploaded').catch(() => undefined);
      }

      result.success++;
      result.summary[skill.name] = 'upserted';
    } catch (err: any) {
      result.errors.push(`技能 ${skill.name}: ${err.message}`);
      result.failed++;
    }
  }

  return result;
}

export async function importPluginsFromZip(zipBuffer: Buffer): Promise<ImportResult> {
  const result: ImportResult = { success: 0, failed: 0, errors: [], summary: {} };
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Plugin structure: plugin directory with manifest.json + code/assets
  const pluginDirs = entries.filter(e =>
    e.entryName.match(/^[^/]+\/manifest\.json$/) && !e.entryName.startsWith('__MACOSX')
  );

  if (pluginDirs.length === 0) {
    // Try flat structure: single manifest.json at root
    const rootManifest = entries.find(e =>
      e.entryName === 'manifest.json' || e.entryName === './manifest.json'
    );
    if (!rootManifest) {
      result.errors.push('ZIP 结构无效：需要 manifest.json（在根目录或 plugin 子目录中）');
      return result;
    }
    try {
      const manifest = JSON.parse(rootManifest.getData().toString()) as any;
      const pluginName = manifest.name || 'unknown';
      const pluginDir = entries.filter(e =>
        !e.entryName.startsWith('__MACOSX') && e.entryName !== 'manifest.json'
      );

      const configEntries: Array<{ path: string; content: string }> = [];
      for (const e of pluginDir) {
        configEntries.push({ path: e.entryName, content: e.getData().toString('utf-8') });
      }

      const existing = await prisma.pluginInstance.findFirst({ where: { name: pluginName } });
      if (existing) {
        await prisma.pluginInstance.update({ where: { id: existing.id }, data: { config: JSON.stringify({ entries: configEntries, manifest }), version: manifest.version || '1.0.0', status: 'installed' } });
      } else {
        await prisma.pluginInstance.create({ data: { name: pluginName, version: manifest.version || '1.0.0', status: 'installed', config: JSON.stringify({ entries: configEntries, manifest }), userId: 'system' } });
      }
      result.success++;
      result.summary[pluginName] = 'upserted';
    } catch (err: any) {
      result.errors.push(`插件解析失败: ${err.message}`);
      result.failed++;
    }
    return result;
  }

  const processedDirs = new Set<string>();
  for (const entry of pluginDirs) {
    const dirName = entry.entryName.split('/')[0];
    if (processedDirs.has(dirName)) continue;
    processedDirs.add(dirName);

    try {
      const manifestEntry = entries.find(e => e.entryName === `${dirName}/manifest.json`);
      if (!manifestEntry) continue;
      const manifest = JSON.parse(manifestEntry.getData().toString()) as any;
      const pluginName = manifest.name || dirName;

      const pluginFiles = entries.filter(e =>
        e.entryName.startsWith(`${dirName}/`) &&
        e.entryName !== `${dirName}/manifest.json` &&
        !e.entryName.startsWith('__MACOSX/')
      );

      const configEntries: Array<{ path: string; content: string }> = [];
      for (const e of pluginFiles) {
        const relPath = e.entryName.replace(`${dirName}/`, '');
        configEntries.push({ path: relPath, content: e.getData().toString('utf-8') });
      }

      // Use findFirst + create/update since PluginInstance has no unique constraint on name
      const existingPlugin = await prisma.pluginInstance.findFirst({ where: { name: pluginName } });
      if (existingPlugin) {
        await prisma.pluginInstance.update({ where: { id: existingPlugin.id }, data: { config: JSON.stringify({ entries: configEntries, manifest }), version: manifest.version || '1.0.0', status: 'installed' } });
      } else {
        await prisma.pluginInstance.create({ data: { name: pluginName, version: manifest.version || '1.0.0', status: 'installed', config: JSON.stringify({ entries: configEntries, manifest }), userId: 'system' } });
      }

      result.success++;
      result.summary[pluginName] = 'upserted';
    } catch (err: any) {
      result.errors.push(`插件 ${dirName}: ${err.message}`);
      result.failed++;
    }
  }

  return result;
}

export async function importKnowledgeFromZip(zipBuffer: Buffer): Promise<ImportResult> {
  const result: ImportResult = { success: 0, failed: 0, errors: [], summary: {} };
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Find manifest
  const manifestEntry = entries.find(e =>
    e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
  );
  let manifest: any = {};
  if (manifestEntry) {
    try { manifest = JSON.parse(manifestEntry.getData().toString()); } catch {}
  }

  // Collect markdown files
  const mdFiles = entries.filter(e =>
    e.entryName.endsWith('.md') &&
    !e.entryName.startsWith('__MACOSX/') &&
    e.entryName !== 'manifest.json' &&
    !e.entryName.endsWith('/manifest.json')
  );

  if (mdFiles.length === 0) {
    result.errors.push('ZIP 中没有找到 .md 文件');
    return result;
  }

  // Build lookup for metadata per file
  const fileMeta: Record<string, any> = {};
  if (manifest.entries) {
    for (const entry of manifest.entries) {
      fileMeta[entry.file || entry.path] = entry;
    }
  }

  const folderId = manifest.folderId || null;
  const defaultCategory = manifest.category || 'general';

  for (const entry of mdFiles) {
    try {
      const content = entry.getData().toString('utf-8');
      const fileName = entry.entryName.split('/').pop() || 'untitled';
      const meta = fileMeta[fileName] || fileMeta[entry.entryName] || {};

      // Extract title from first heading or filename
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = meta.title || titleMatch?.[1]?.trim() || fileName.replace('.md', '');

      // Parse category from metadata frontmatter or content
      let category = meta.category || defaultCategory;
      const catMatch = content.match(/category:\s*(.+)$/m);
      if (catMatch) category = catMatch[1].trim();

      await prismaKnowledge.knowledgeBase.create({
        data: {
          title,
          content,
          category,
          folderId,
          evidenceLevel: meta.evidenceLevel || 'user_contributed',
          source: meta.source || 'zip_import',
        },
      });

      result.success++;
      result.summary[title] = 'imported';
    } catch (err: any) {
      result.errors.push(`知识条目 ${entry.entryName}: ${err.message}`);
      result.failed++;
    }
  }

  return result;
}

export async function importFromZip(
  zipBuffer: Buffer,
  type: 'skills' | 'plugins' | 'knowledge',
): Promise<ImportResult> {
  switch (type) {
    case 'skills':
      return importSkillsFromZip(zipBuffer);
    case 'plugins':
      return importPluginsFromZip(zipBuffer);
    case 'knowledge':
      return importKnowledgeFromZip(zipBuffer);
    default:
      return { success: 0, failed: 0, errors: [`未知类型: ${type}`], summary: {} };
  }
}

// ================================================================
// Single-file skill import: skill-<category>-<编号>.md
// ================================================================

/**
 * Import ONE skill from a single markdown file named skill-<category>-<编号>.md.
 *
 * - category is read from the filename; frontmatter `category:` may override.
 * - `name` defaults to the filename stem (e.g. "skill-research-01"),
 *   frontmatter `name:` may override.
 * - `description` from frontmatter `description:` (optional).
 * - The markdown body (after frontmatter) becomes the skill `prompt`.
 * - An empty `编号` or missing file name prefix yields an error, not a crash.
 *
 * The upsert + S1-enqueue flow mirrors importSkillsFromZip so both paths
 * behave identically for existing / new skills.
 */
export async function importSkillFromMarkdown(
  fileName: string,
  mdBuffer: Buffer,
): Promise<ImportResult> {
  const result: ImportResult = { success: 0, failed: 0, errors: [], summary: {} };

  const stem = fileName.replace(/\.md$/i, '');
  const m = stem.match(/^skill-(.+)-(\d+)$/i);
  if (!m) {
    result.errors.push(`文件名无效: ${fileName}。需符合 skill-<类型>-<编号>.md，类型=Skill 的 category，编号=正整数`);
    result.failed++;
    return result;
  }
  const categoryFromName = m[1];

  let text = mdBuffer.toString('utf-8');
  // Optional YAML frontmatter between leading "---" fences.
  let fmName: string | undefined;
  let fmDescription: string | undefined;
  let fmCategory: string | undefined;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const fmBody = fmMatch[1];
    text = text.slice(fmMatch[0].length);
    for (const line of fmBody.split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (key === 'name') fmName = val;
      else if (key === 'description') fmDescription = val;
      else if (key === 'category') fmCategory = val;
    }
  }

  const name = fmName || stem;
  const category = fmCategory || categoryFromName;
  const description = fmDescription ?? null;
  const prompt = text.trim();

  if (!prompt) {
    result.errors.push(`技能 ${name}：缺少 prompt 正文（markdown 内容为空）`);
    result.failed++;
    return result;
  }

  try {
    const existing = await prismaKnowledge.skill.findFirst({ where: { name } });
    if (existing) {
      await prismaKnowledge.skill.update({
        where: { id: existing.id },
        data: { description, prompt, category },
      });
      const { enqueueSkillAnalysis } = await import('./skillPublishGuard');
      await enqueueSkillAnalysis(existing.id, 'updated').catch(() => undefined);
    } else {
      const created = await prismaKnowledge.skill.create({
        data: { name, description, prompt, category },
      });
      const { enqueueSkillAnalysis } = await import('./skillPublishGuard');
      await enqueueSkillAnalysis(created.id, 'uploaded').catch(() => undefined);
    }
    result.success++;
    result.summary[name] = `upserted (${fileName})`;
  } catch (err: any) {
    result.errors.push(`技能 ${name}: ${err.message}`);
    result.failed++;
  }

  return result;
}
