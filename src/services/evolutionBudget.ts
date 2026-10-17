import { prismaUser, prismaKnowledge } from './db';
const USER_DAILY_LIMIT = 50;

export function getTokenCosts() {
  return { signalAttribution: 1, gate2Evaluate: 2, gate3Evaluate: 3 };
}

async function getOrCreateBudget(date: Date) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let budget = await prismaKnowledge.evolutionBudget.findUnique({ where: { date: dayStart } });
  if (!budget) {
    budget = await prismaKnowledge.evolutionBudget.create({ data: { date: dayStart, systemPoolTotal: 10000, systemPoolUsed: 0 } });
  }
  return budget;
}

export async function getTodayBudget() {
  return getOrCreateBudget(new Date());
}

export async function setSystemPoolTotal(total: number) {
  const budget = await getOrCreateBudget(new Date());
  return prismaKnowledge.evolutionBudget.update({ where: { id: budget.id }, data: { systemPoolTotal: total } });
}

export async function checkSystemPool(tokensNeeded: number) {
  const budget = await getOrCreateBudget(new Date());
  const remaining = budget.systemPoolTotal - budget.systemPoolUsed;
  return { allowed: remaining >= tokensNeeded, remaining };
}

export async function consumeSystemPool(tokens: number) {
  const budget = await getOrCreateBudget(new Date());
  await prismaKnowledge.evolutionBudget.update({ where: { id: budget.id }, data: { systemPoolUsed: { increment: tokens } } });
}

export async function checkUserBudget(userId: string) {
  const user = await prismaUser.user.findUnique({ where: { id: userId } });
  if (!user) return { allowed: false, remaining: 0 };
  const now = new Date();
  if (now > user.evoSignalsReset) {
    await prismaUser.user.update({
      where: { id: userId },
      data: { evoSignalsToday: 0, evoSignalsReset: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) },
    });
    return { allowed: true, remaining: USER_DAILY_LIMIT };
  }
  return { allowed: user.evoSignalsToday < USER_DAILY_LIMIT, remaining: USER_DAILY_LIMIT - user.evoSignalsToday };
}

export async function consumeUserBudget(userId: string) {
  await prismaUser.user.update({ where: { id: userId }, data: { evoSignalsToday: { increment: 1 } } });
}

export async function incrementBudgetCounter(field: string) {
  const budget = await getOrCreateBudget(new Date());
  await prismaKnowledge.evolutionBudget.update({ where: { id: budget.id }, data: { [field]: { increment: 1 } } });
}