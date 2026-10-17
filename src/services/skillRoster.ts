// ================================================================
// Skill Roster — admin cross-account view of every installed skill.
//
// A user's installs are private (see userSkillInstall.ts). The roster
// is the ONLY admin surface that can see all accounts at once. It is
// pure read: listing, filtering, and summary counts. Promotion /
// rejection live in skillPromotion.ts and the admin routes.
// ================================================================

import { prismaUser } from './db';

export interface RosterFilters {
  status?: string;      // pending | active | rejected | promoted
  scanStatus?: string;  // clean | flagged | pending
  sourceType?: string;  // github | url_zip | url_md | manual
  ownerEmail?: string;  // search by owner
  search?: string;      // search by skill name
  page?: number;
  limit?: number;
}

export interface RosterRow {
  skill: any;
  owner: { id: string; username: string; email: string } | null;
  capabilities: string[];
}

/** Summary counts across all accounts — drives the roster dashboard. */
export async function rosterSummary() {
  const [byStatus, total, flagged] = await Promise.all([
    prismaUser.userInstalledSkill.groupBy({ by: ['status'], _count: { _all: true } }),
    prismaUser.userInstalledSkill.count(),
    prismaUser.userInstalledSkill.count({ where: { scanStatus: 'flagged' } }),
  ]);
  const statusCounts: Record<string, number> = { pending: 0, active: 0, rejected: 0, promoted: 0 };
  for (const g of byStatus) statusCounts[g.status] = g._count._all;
  return { total, flagged, statusCounts };
}

/**
 * List every account's installed skills (paged). Owner identity is
 * attached after the fact — User and UserInstalledSkill live in the
 * same datasource here, but the owner join is kept manual so the
 * query stays cheap and the owner fields are explicitly selected.
 */
export async function rosterList(filters: RosterFilters = {}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(200, Math.max(1, filters.limit || 50));
  const skip = (page - 1) * limit;

  const where: Record<string, any> = {};
  if (filters.status) where.status = filters.status;
  if (filters.scanStatus) where.scanStatus = filters.scanStatus;
  if (filters.sourceType) where.sourceType = filters.sourceType;
  if (filters.search) where.name = { contains: filters.search, mode: 'insensitive' };
  if (filters.ownerEmail) {
    const owners = await prismaUser.user.findMany({
      where: { email: { contains: filters.ownerEmail, mode: 'insensitive' } },
      select: { id: true },
    });
    where.userId = { in: owners.map((o) => o.id) };
  }

  const [rows, total] = await Promise.all([
    prismaUser.userInstalledSkill.findMany({ where, skip, take: limit, orderBy: { installedAt: 'desc' } }),
    prismaUser.userInstalledSkill.count({ where }),
  ]);

  // Attach owner identity (cross-datasource-safe: explicit select)
  const ownerIds = [...new Set(rows.map((r) => r.userId))];
  const owners = ownerIds.length
    ? await prismaUser.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, username: true, email: true } })
    : [];
  const byId = new Map(owners.map((o) => [o.id, o]));

  const roster: RosterRow[] = rows.map((skill) => ({
    skill,
    owner: byId.get(skill.userId) || null,
    capabilities: (() => {
      try {
        return JSON.parse(skill.capabilities || '[]');
      } catch {
        return [];
      }
    })(),
  }));

  return { roster, total, page, pages: Math.ceil(total / limit) };
}

/** Single install detail + owner, for the roster drill-down. */
export async function rosterDetail(skillId: string) {
  const skill = await prismaUser.userInstalledSkill.findUnique({ where: { id: skillId } });
  if (!skill) return null;
  const owner = await prismaUser.user.findUnique({
    where: { id: skill.userId },
    select: { id: true, username: true, email: true },
  });
  return { skill, owner };
}
