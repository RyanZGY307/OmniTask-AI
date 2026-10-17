import { prisma } from './db';
import { cleanupOldTraces } from './trace';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export async function log(level: LogLevel, action: string, detail?: string, userId?: string, model?: string, duration?: number, tokens?: number) {
  try {
    await prisma.logEntry.create({
      data: { level, action, detail: detail || null, userId: userId || null, model: model || null, duration: duration || null, tokens: tokens || null },
    });
  } catch (err) {
    console.error(`[LOG ${level}] ${action}: ${detail}`);
  }
}

export async function cleanupOldLogs() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await prisma.logEntry.deleteMany({ where: { createdAt: { lt: sevenDaysAgo } } });
    if (result.count > 0) console.log(`[LOG CLEANUP] Deleted ${result.count} old log entries`);
  } catch (err) {
    console.error('[LOG CLEANUP] Error:', err);
  }
}

export async function runCleanupCycle() {
  await cleanupOldLogs();
  await cleanupOldTraces();
}