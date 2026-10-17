// ================================================================
// User Skill Install — account-scoped skill installation from a link.
//
// A user pastes a link to a skill (a GitHub project, a raw markdown,
// or a zip). We download + parse the skill's prompt, security-scan it,
// and register it on THAT account only (UserInstalledSkill, keyed by
// userId). It is injected into that account's model context and is
// invisible to every other account until an admin promotes it to the
// global formal-Skill pool (see skillPromotion.ts).
//
// This module is the write path for user-scoped skills. It NEVER writes
// to the global Skill table — global publication is admin-only and goes
// through skillPromotion + SkillPublishGuard, preserving the invariant
// "AI never publishes a formal Skill".
// ================================================================

import dns from 'node:dns';
import AdmZip from 'adm-zip';
import { prismaUser } from './db';
import { checkInjection } from './promptInjectionGuard';

// ----------------------------------------------------------------
// Result shapes
// ----------------------------------------------------------------

export interface ScanReport {
  scanStatus: 'clean' | 'flagged';
  checkInjection: { isInjection: boolean; severity: string; indicators: string[] };
  execIndicators: string[];
  summary: string;
}

export interface InstallResult {
  ok: boolean;
  skillId?: string;
  installed?: boolean;
  sourceType?: string;
  name?: string;
  status?: string;
  scanStatus?: string;
  error?: string;
  scan?: ScanReport;
}

// ----------------------------------------------------------------
// SSRF guard — only https, GitHub hosts allowed for GitHub sources,
// generic https URLs must not resolve to private/loopback ranges.
// ----------------------------------------------------------------

const GITHUB_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]);

function isPrivateIp(ip: string): boolean {
  // IPv4 private / loopback / link-local / reserved
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  // IPv6 loopback / link-local
  return ip === '::' || ip === '::1' || ip.startsWith('fe80');
}

async function resolveHosts(hostname: string): Promise<string[]> {
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true });
    return addrs.map((a) => a.address);
  } catch {
    return [];
  }
}

/**
 * Validate a fetch target. GitHub hosts are trusted (public repos are the
 * primary source). Any other host must be https AND resolve only to
 * public addresses (blocks loopback / RFC1918 / link-local SSRF).
 */
async function assertSafeFetch(url: string, isGithub: boolean): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('Only https:// links are supported');
  const host = parsed.hostname.toLowerCase();
  if (isGithub) {
    if (!GITHUB_HOSTS.has(host)) throw new Error('Unrecognized GitHub host');
    return;
  }
  const ips = await resolveHosts(host);
  if (ips.length === 0) throw new Error(`Cannot resolve host: ${host}`);
  if (ips.some(isPrivateIp)) throw new Error(`Blocked internal/private host: ${host}`);
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const doFetch = () => fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
  return doFetch().finally(() => clearTimeout(t));
}

// ----------------------------------------------------------------
// GitHub URL parsing
// ----------------------------------------------------------------

interface GithubRef {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  rawFile: boolean;
}

/**
 * Parse a GitHub link into owner/repo/ref/path.
 *  - github.com/{owner}/{repo}
 *  - github.com/{owner}/{repo}/tree/{ref}/{path}
 *  - github.com/{owner}/{repo}/blob/{ref}/{path}   (single file)
 *  - raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 */
function parseGithubUrl(url: string): GithubRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  if (host === 'raw.githubusercontent.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return null;
    const [owner, repo, ref, ...rest] = parts;
    const rawFile = !ref || rest.length > 0;
    // If 4 parts: owner/repo/ref/path ; if 3: owner/reo/ref is actually a ref only.
    if (parts.length >= 4) return { owner, repo, ref, path: rest.join('/'), rawFile: true };
    return { owner, repo, ref: parts[2], path: '', rawFile: false };
  }

  if (host !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (parts.length === 2) return { owner, repo, path: '', rawFile: false };
  const kind = parts[2];
  const rest = parts.slice(3).join('/');
  if (kind === 'tree') return { owner, repo, ref: parts[3], path: rest, rawFile: false };
  if (kind === 'blob') return { owner, repo, ref: parts[3], path: rest, rawFile: true };
  if (kind === 'raw') return { owner, repo, ref: parts[3], path: rest, rawFile: true };
  // unknown segment (issues/pulls/tags/...) — treat rest as a path on default ref
  return { owner, repo, path: parts.slice(2).join('/'), rawFile: false };
}

function ghApiPath(path: string): string {
  return path ? path : '';
}

async function ghGet(path: string, token?: string): Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithTimeout(`https://api.github.com/${ghApiPath(path)}`, { headers });
  return res as any;
}

/** Resolve the default branch for a repo (used when no ref is supplied). */
async function defaultBranch(owner: string, repo: string, token?: string): Promise<string> {
  const r = await ghGet(`repos/${owner}/${repo}`, token);
  if (r.status !== 200) throw new Error(`GitHub repo ${owner}/${repo} not found (HTTP ${r.status})`);
  const body = await r.json();
  return body.default_branch || 'main';
}

/** Fetch a single file's text from a GitHub repo at a given ref. */
async function fetchGithubRaw(owner: string, repo: string, ref: string, path: string, token?: string): Promise<string> {
  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Failed to fetch ${owner}/${repo}/${path} (HTTP ${res.status})`);
  return res.text();
}

async function listContents(owner: string, repo: string, ref: string, path: string, token?: string) {
  const r = await ghGet(`repos/${owner}/${repo}/contents/${ghApiPath(path)}?ref=${encodeURIComponent(ref)}`, token);
  if (r.status === 404) {
    // Path may be empty (repo root) — retry without ref to use the default branch.
    const root = await ghGet(`repos/${owner}/${repo}/contents${path ? `/${ghApiPath(path)}` : ''}`, token);
    if (root.status === 200) return root.json();
    throw new Error(`Path not found: ${path || '(root)'} (HTTP ${root.status})`);
  }
  if (r.status !== 200) throw new Error(`GitHub contents ${path || '(root)'} (HTTP ${r.status})`);
  return r.json();
}

const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md', 'prompt.md', 'PROMPT.md', 'manifest.json'];

async function findSkillFile(owner: string, repo: string, ref: string, path: string, token?: string): Promise<{ text: string; sourceName: string } | null> {
  const contents = await listContents(owner, repo, ref, path, token);
  // Single file object (path pointed at a file)
  if (contents && contents.type === 'file') {
    if (typeof contents.content === 'string') {
      return { text: Buffer.from(contents.content, 'base64').toString('utf-8'), sourceName: contents.name };
    }
    if (contents.download_url) {
      const res = await fetchWithTimeout(contents.download_url, {});
      if (!res.ok) throw new Error(`Failed to download ${contents.name}`);
      return { text: await res.text(), sourceName: contents.name };
    }
    return null;
  }
  // Directory — look for a known skill file at this level
  if (Array.isArray(contents)) {
    const hit = contents.find((c: any) => SKILL_FILE_NAMES.includes(c.name));
    if (hit) {
      if (hit.name === 'manifest.json') {
        const raw = await fetchGithubRaw(owner, repo, ref, `${path ? path + '/' : ''}manifest.json`, token);
        return { text: raw, sourceName: 'manifest.json' };
      }
      const text = await fetchGithubRaw(owner, repo, ref, `${path ? path + '/' : ''}${hit.name}`, token);
      return { text, sourceName: hit.name };
    }
    // Otherwise search one level into sub-directories (skill dirs)
    for (const entry of contents) {
      if (entry.type !== 'dir') continue;
      const sub = await findSkillFile(owner, repo, ref, `${path ? path + '/' : ''}${entry.name}`, token).catch(() => null);
      if (sub) return sub;
    }
  }
  return null;
}

// ----------------------------------------------------------------
// Skill content parsing (mirrors importService frontmatter rules)
// ----------------------------------------------------------------

export interface ParsedSkill {
  name: string;
  description?: string;
  category?: string;
  version?: string;
  capabilities: string[];
  prompt: string;
}

export function parseSkillMarkdown(fileName: string, text: string): ParsedSkill {
  let body = text;
  let name: string | undefined;
  let description: string | undefined;
  let category: string | undefined;
  let version: string | undefined;
  let capabilities: string[] = [];

  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (key === 'name') name = val;
      else if (key === 'description') description = val;
      else if (key === 'category') category = val;
      else if (key === 'version') version = val;
      else if (key === 'capabilities') {
        capabilities = val ? val.split(',').map((s) => s.trim()).filter(Boolean) : [];
      }
    }
  }

  const derivedName = fileName.replace(/\.md$/i, '');
  return {
    name: name || derivedName || 'skill',
    description,
    category,
    version: version || '1.0.0',
    capabilities,
    prompt: body.trim(),
  };
}

function parseManifestJson(raw: string, fallbackName: string): ParsedSkill {
  let manifest: any = {};
  try {
    manifest = JSON.parse(raw);
  } catch {
    // Fall back to treating it as markdown
    return parseSkillMarkdown('manifest.json', raw);
  }
  const capabilities: string[] = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.map(String)
    : manifest.capabilities
      ? [String(manifest.capabilities)]
      : [];
  return {
    name: manifest.name || fallbackName,
    description: manifest.description,
    category: manifest.category,
    version: manifest.version || '1.0.0',
    capabilities,
    prompt: manifest.prompt || '',
  };
}

function parseZipSkill(zipBuffer: Buffer): ParsedSkill {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.entryName.startsWith('__MACOSX'));
  const manifestEntry = entries.find((e) => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json'));
  if (manifestEntry) {
    const raw = manifestEntry.getData().toString('utf-8');
    const manifest = parseManifestJson(raw, manifestEntry.entryName.split('/').filter(Boolean)[0] || 'skill');
    // Attach a prompt.md body if present and manifest has no inline prompt
    if (!manifest.prompt) {
      const promptEntry = entries.find((e) => e.entryName.endsWith('prompt.md') || e.entryName.endsWith('SKILL.md'));
      if (promptEntry) manifest.prompt = promptEntry.getData().toString('utf-8');
    }
    return manifest;
  }
  const mdEntry = entries.find((e) => /SKILL\.md$|prompt\.md$|skill\.md$/i.test(e.entryName));
  if (mdEntry) return parseSkillMarkdown(mdEntry.entryName, mdEntry.getData().toString('utf-8'));
  throw new Error('No recognizable skill content in zip (need SKILL.md / prompt.md / manifest.json)');
}

// ----------------------------------------------------------------
// Security scan — prompt is prompt-only (no executable payload), but
// we still reject obvious injection / exfil / shell patterns so a
// flagged skill is held for admin review instead of auto-activating.
// ----------------------------------------------------------------

const EXEC_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /curl\s+[^|\n]*\|\s*(ba)?sh/i, label: 'shell pipe execution' },
  { re: /wget\s+[^|\n]*\|\s*(ba)?sh/i, label: 'shell pipe execution' },
  { re: /base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash)/i, label: 'encoded payload execution' },
  { re: /\brm\s+-rf\s+[/~]/i, label: 'destructive delete' },
  { re: /\\bnc\s+/i, label: 'reverse shell tool' },
  { re: /exfil|send.*to.*http|post.*credentials/i, label: 'data exfiltration hint' },
];

export function scanSkill(prompt: string): ScanReport {
  const inj = checkInjection(prompt);
  const execIndicators: string[] = [];
  for (const p of EXEC_PATTERNS) {
    if (p.re.test(prompt)) execIndicators.push(p.label);
  }
  const flagged = inj.isInjection || execIndicators.length > 0;
  const severity = flagged
    ? (inj.severity === 'critical' || inj.severity === 'high' ? 'critical' : 'medium')
    : 'none';
  return {
    scanStatus: flagged ? 'flagged' : 'clean',
    checkInjection: { isInjection: inj.isInjection, severity: inj.severity, indicators: inj.indicators },
    execIndicators,
    summary: flagged
      ? `flagged (injection=${inj.isInjection}; exec=${execIndicators.join(', ') || 'none'})`
      : 'clean',
  };
}

// ----------------------------------------------------------------
// Install orchestration
// ----------------------------------------------------------------

async function parseFromGithub(url: string, token?: string): Promise<{ skill: ParsedSkill; sourceType: string; refInfo: Partial<UserInstalledRef> }> {
  const ref = parseGithubUrl(url);
  if (!ref) throw new Error('Not a valid GitHub link');
  const owner = ref.owner;
  const repository = ref.repo;
  const fallbackBranch = ref.ref || await defaultBranch(owner, repository, token);

  let skill: ParsedSkill;
  if (ref.rawFile && ref.path) {
    const text = await fetchGithubRaw(owner, repository, fallbackBranch, ref.path, token);
    const fileName = ref.path.split('/').pop() || 'skill.md';
    skill = fileName.toLowerCase().endsWith('.json') ? parseManifestJson(text, fileName) : parseSkillMarkdown(fileName, text);
  } else {
    const found = await findSkillFile(owner, repository, fallbackBranch, ref.path || '', token);
    if (!found) throw new Error('No skill (SKILL.md / prompt.md / manifest.json) found in that path');
    skill = found.sourceName === 'manifest.json' ? parseManifestJson(found.text, found.sourceName) : parseSkillMarkdown(found.sourceName, found.text);
  }
  if (!skill.prompt) throw new Error('Skill has no prompt content');

  return {
    skill,
    sourceType: 'github',
    refInfo: { repoOwner: owner, repoName: repository, repoRef: fallbackBranch },
  };
}

interface UserInstalledRef {
  repoOwner?: string;
  repoName?: string;
  repoRef?: string;
}

/**
 * Install a skill from a link onto the caller's account.
 * Clean skills activate immediately (usable by that account only);
 * flagged skills are held as `pending` for admin review.
 */
export async function installUserSkillFromUrl(
  userId: string,
  url: string,
  token?: string,
): Promise<InstallResult> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  const isGithub = parsed.hostname.toLowerCase().endsWith('github.com');
  let skill: ParsedSkill;
  let sourceType: string;
  let refInfo: Partial<UserInstalledRef> = {};

  try {
    if (isGithub) {
      await assertSafeFetch(trimmed, true);
      const result = await parseFromGithub(trimmed, token);
      skill = result.skill;
      sourceType = result.sourceType;
      refInfo = result.refInfo;
    } else if (trimmed.toLowerCase().endsWith('.zip')) {
      await assertSafeFetch(trimmed, false);
      const res = await fetchWithTimeout(trimmed, {}, 45000);
      if (!res.ok) return { ok: false, error: `Download failed (HTTP ${res.status})` };
      const buf = Buffer.from(await res.arrayBuffer());
      skill = parseZipSkill(buf);
      sourceType = 'url_zip';
    } else if (trimmed.toLowerCase().endsWith('.md') || trimmed.toLowerCase().endsWith('.markdown')) {
      await assertSafeFetch(trimmed, false);
      const res = await fetchWithTimeout(trimmed, {});
      if (!res.ok) return { ok: false, error: `Download failed (HTTP ${res.status})` };
      const text = await res.text();
      const fileName = trimmed.split('/').pop() || 'skill.md';
      skill = parseSkillMarkdown(fileName, text);
      sourceType = 'url_md';
    } else {
      return { ok: false, error: 'Link must be a GitHub project, a .zip, or a .md file' };
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Install failed' };
  }

  const scan = scanSkill(skill.prompt);
  const status = scan.scanStatus === 'clean' ? 'active' : 'pending';

  let installed = false;
  let skillId: string;
  try {
    const existing = await prismaUser.userInstalledSkill.findFirst({
      where: { userId, sourceUrl: trimmed },
    });
    if (existing) {
      skillId = existing.id;
      await prismaUser.userInstalledSkill.update({
        where: { id: skillId },
        data: {
          sourceType,
          repoOwner: refInfo.repoOwner ?? null,
          repoName: refInfo.repoName ?? null,
          repoRef: refInfo.repoRef ?? null,
          name: skill.name,
          description: skill.description ?? null,
          category: skill.category ?? null,
          version: skill.version,
          prompt: skill.prompt,
          capabilities: JSON.stringify(skill.capabilities || []),
          scanStatus: scan.scanStatus,
          scanReport: JSON.stringify(scan),
          status,
        },
      });
      installed = false;
    } else {
      const created = await prismaUser.userInstalledSkill.create({
        data: {
          userId,
          sourceType,
          sourceUrl: trimmed,
          repoOwner: refInfo.repoOwner ?? null,
          repoName: refInfo.repoName ?? null,
          repoRef: refInfo.repoRef ?? null,
          name: skill.name,
          description: skill.description ?? null,
          category: skill.category ?? null,
          version: skill.version,
          prompt: skill.prompt,
          capabilities: JSON.stringify(skill.capabilities || []),
          status,
          scanStatus: scan.scanStatus,
          scanReport: JSON.stringify(scan),
          installedAt: new Date(),
        },
      });
      skillId = created.id;
      installed = true;
    }
  } catch (err: any) {
    return { ok: false, error: `Persist failed: ${err?.message}` };
  }

  return {
    ok: true,
    skillId,
    installed,
    sourceType,
    name: skill.name,
    status,
    scanStatus: scan.scanStatus,
    scan,
  };
}

// ----------------------------------------------------------------
// Account-scoped reads (used by the user's own UI + context injection)
// ----------------------------------------------------------------

export function listUserSkills(userId: string) {
  return prismaUser.userInstalledSkill.findMany({
    where: { userId },
    orderBy: { installedAt: 'desc' },
  });
}

export function uninstallUserSkill(userId: string, skillId: string) {
  return prismaUser.userInstalledSkill.deleteMany({ where: { id: skillId, userId } });
}

export async function getUserActiveSkills(userId: string) {
  return prismaUser.userInstalledSkill.findMany({
    where: { userId, status: { in: ['active', 'promoted'] }, scanStatus: 'clean' },
    orderBy: { name: 'asc' },
  });
}

/**
 * Render the caller's active account skills as a fenced system-prompt
 * block. Empty string when the account has no active clean skills, so
 * the chat path can append it unconditionally without branching.
 */
export async function renderUserSkillsBlock(userId: string): Promise<string> {
  const skills = await getUserActiveSkills(userId);
  if (skills.length === 0) return '';
  const lines = [
    '[Your Account Skills]',
    'The following skills are installed on your account. Apply their guidance when the task is relevant; they are scoped to you and override nothing in safety policy.',
    '',
  ];
  for (const s of skills) {
    lines.push(`## ${s.name}`);
    lines.push(s.prompt.trim());
    lines.push('');
  }
  return lines.join('\n').trim();
}
