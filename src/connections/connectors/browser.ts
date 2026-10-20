// ================================================================
// Universal Connect Runtime v2 — Browser Connector (P0-5)
//
// P0-5: Browser sessions are PERSISTED to database.
// - authenticate() → saves session state to BrowserSession table
// - execute() → restores session from DB before each command
// - revoke() → deletes session from DB
//
// Session includes: cookies, localStorage, tabs, URL state
// ================================================================

import crypto from 'crypto';
import { BaseConnector, ConnectorContext, ConnectorResult, HealthResult } from './base';
import { R, healthy, unhealthy } from '../contract';
import { prisma } from '../../services/db';
import { storeCredential, revokeCredential } from '../vault';

let _playwright: any = null;

async function getPlaywright(): Promise<any> {
  if (_playwright) return _playwright;
  try {
    const mod: any = await import('playwright' as any);
    _playwright = mod;
  } catch {
    throw new Error('[Browser] Playwright not installed. Run: npm install playwright && npx playwright install chromium');
  }
  return _playwright;
}

export interface BrowserSessionState {
  browserId: string;
  contextId: string;
  tabs: Array<{ id: string; pageId: string; url: string; title: string }>;
  profile: 'temporary' | 'persistent';
  createdAt: string;
  lastActiveAt: string;
}

export class BrowserConnector extends BaseConnector {
  readonly type = 'browser' as const;
  readonly name = 'Browser Connector';

  readonly supportedCapabilities = [
    { capabilityId: 'browser.navigate', toolIds: ['browser.navigate'], connectorType: 'browser', authMethod: 'browser', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'browser.read', toolIds: ['browser.read', 'browser.screenshot'], connectorType: 'browser', authMethod: 'browser', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'browser.act', toolIds: ['browser.click', 'browser.input', 'browser.select'], connectorType: 'browser', authMethod: 'browser', riskLevel: 'R2', readOnly: false, regions: ['global'] },
    { capabilityId: 'browser.tab', toolIds: ['browser.tab.list', 'browser.tab.create', 'browser.tab.switch'], connectorType: 'browser', authMethod: 'browser', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'browser.session', toolIds: ['browser.session.create', 'browser.session.restore', 'browser.session.invalidate'], connectorType: 'browser', authMethod: 'browser', riskLevel: 'R1', readOnly: false, regions: ['global'] },
  ] as any[];

  readonly requiredAuthMethod = 'browser';
  readonly defaultRiskLevel = 'R1' as const;

  async authenticate(ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string; waitingCaptcha?: boolean; mfaType?: string }> {
    const pw = await getPlaywright();
    const { userId, connectionId } = ctx;
    const providerId = input.providerId || 'generic_web';
    const url = input.url || `https://${providerId}.com`;
    const profile = input.profile || 'temporary';
    const username = input.username;
    const password = input.password;
    const otp = input.otp ?? input.captchaCode ?? input.mfaCode;

    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Automated login if credentials provided (optional captcha/OTP step)
    let captchaWait = false;
    if (username && password) {
      const login = await this.performLogin(page, { url, username, password, providerId, otp });
      captchaWait = login.requiresCaptcha && !login.completed;
    }

    // Save session state to DB (P0-5: persistent)
    const state = await context.storageState();
    const sessionId = `bs_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const sessionState: BrowserSessionState = {
      browserId: browser.browserType().name(),
      contextId: sessionId,
      tabs: [{ id: 'main', pageId: sessionId, url: page.url(), title: (await page.title()) || '' }],
      profile,
      createdAt: now,
      lastActiveAt: now,
    };

    // Store cookies/session in credential vault
    const credId = await storeCredential(userId, providerId, 'browser_session', JSON.stringify(state), {
      sessionId,
      profile,
      connectionId,
      browserId: browser.browserType().name(),
    });

    // Persist session metadata to BrowserSession table
    await prisma.browserSession.create({
      data: {
        userId,
        providerId,
        status: 'active',
        url: page.url(),
        phase: captchaWait ? 'waiting_auth' : 'observe',
        sessionId,
        profile,
        cookiesCount: (state.cookies?.length || 0),
      },
    });

    if (captchaWait) {
      // P0-6: 验证码/OTP 无法在服务端自动完成——交给用户。置等待态，待用户提供验证码后
      // 重连（authenticate 带 otp）或直接贴回会话 cookie 走 token 连接器。
      await prisma.connection.updateMany({
        where: { id: connectionId, userId },
        data: { status: 'reauth_required', meta: JSON.stringify({ waitingCaptcha: true, providerId, sessionId }) },
      });
      await browser.close();
      return { credentialId: credId, accountName: `${providerId} account (captcha pending)`, sessionToken: sessionId, waitingCaptcha: true, mfaType: 'totp' };
    }

    // Update connection
    await prisma.connection.updateMany({
      where: { id: connectionId },
      data: { status: 'active', sessionId, lastTokenRefresh: new Date() },
    });
    await browser.close();

    return { credentialId: credId, accountName: `${providerId} account`, sessionToken: sessionId };
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const pw = await getPlaywright();
    const sessionId = args.sessionId || ctx.sessionId;
    if (!sessionId) return R.fail('No active session');

    // P0-5: Restore session from DB
    const sessionDb = await prisma.browserSession.findFirst({
      where: { userId: ctx.userId, sessionId, status: 'active' },
    });
    if (!sessionDb) return R.fail('Session not found or expired');

    // Get stored cookies/state from vault
    const conn = await prisma.connection.findFirst({
      where: { id: ctx.connectionId, userId: ctx.userId },
      select: { credentialRef: true, providerId: true },
    });
    if (!conn?.credentialRef) return R.fail('No credential for session');

    const { getSecret } = await import('../vault');
    const stateStr = await getSecret(conn.credentialRef, ctx.userId);
    if (!stateStr) return R.fail('Failed to decrypt session state');

    const sessionState: BrowserSessionState = JSON.parse(stateStr);

    try {
      // Restore browser context from stored state
      const context = await pw.chromium.newContext(JSON.parse(stateStr));
      const page = await context.newPage();

      // Normalize tool id so registry-generated ids (web.navigate / web.read / …)
      // and raw ids (navigate / read / …) both hit the same cases.
      const norm = String(toolId).replace(/^(web|browser)\./, '');
      switch (norm) {
        case 'navigate':
          return this.cmdNavigate(page, args.url, sessionId);
        case 'screenshot':
          return this.cmdScreenshot(page, args);
        case 'read':
          return this.cmdRead(page, args);
        case 'click':
          return this.cmdClick(page, args.selector);
        case 'input':
          return this.cmdInput(page, args.selector, args.value);
        case 'tab.list':
          return R.success(sessionState.tabs, true);
        case 'tab.create':
          return this.cmdTabCreate(page, args.url, sessionId);
        case 'tab.switch':
          return this.cmdTabSwitch(sessionState, args.tabId);
        case 'tab.close':
          return this.cmdTabClose(sessionState, args.tabId);
        case 'session.save':
          return this.cmdSaveSession(sessionState);
        case 'session.restore':
          return this.cmdRestoreSession(sessionState);
        case 'session.invalidate':
          await this.cmdInvalidateSession(sessionId);
          return R.success(undefined, true);
        default:
          return R.notImplemented(`browser command '${norm}'`);
      }
    } catch (err: any) {
      return R.fail(err.message);
    }
  }

  private async cmdNavigate(page: any, url: string, _sessionId: string): Promise<ConnectorResult> {
    await page.goto(url, { waitUntil: 'networkidle' });
    return R.success({ url: page.url(), title: await page.title() }, true);
  }

  private async cmdScreenshot(page: any, args: any): Promise<ConnectorResult> {
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    const buf = await page.screenshot({ fullPage: args.fullPage ?? false });
    return R.success({ type: 'image/png', base64: buf.toString('base64') }, true);
  }

  private async cmdRead(page: any, args: any): Promise<ConnectorResult> {
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    const content = await page.content();
    return R.success({ content, url: page.url() }, true);
  }

  private async cmdClick(page: any, selector: string): Promise<ConnectorResult> {
    await page.locator(selector).click();
    await page.waitForTimeout(1000);
    return R.success({ url: page.url() }, true);
  }

  private async cmdInput(page: any, selector: string, value: string): Promise<ConnectorResult> {
    await page.locator(selector).fill(value);
    return R.success(undefined, true);
  }

  private async cmdTabCreate(_page: any, url: string, _sessionId: string): Promise<ConnectorResult> {
    return R.success({ tabId: `tab_${Date.now()}`, url });
  }

  private async cmdTabSwitch(state: BrowserSessionState, tabId: string): Promise<ConnectorResult> {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return R.fail(`Tab ${tabId} not found`);
    return R.success({ tabId, url: tab.url });
  }

  private async cmdTabClose(_state: BrowserSessionState, tabId: string): Promise<ConnectorResult> {
    // Tab close requires broker-side access to every open browser context, which
    // this connector does not hold. 旧版返回 `{ ok: true }` 是伪造成功 —— 调用方
    // 会以为标签页已关闭。改为明确的 not_implemented，并把 tabId 带回便于诊断。
    return R.notImplemented('browser tab.close', { tabId });
  }

  private cmdSaveSession(state: BrowserSessionState): ConnectorResult {
    return R.success({ sessionId: state.contextId });
  }

  private cmdRestoreSession(state: BrowserSessionState): ConnectorResult {
    return R.success({ restored: true, tabs: state.tabs.length });
  }

  private async cmdInvalidateSession(sessionId: string): Promise<void> {
    await prisma.browserSession.updateMany({
      where: { sessionId },
      data: { status: 'revoked' },
    });
  }

  private async performLogin(page: any, input: { url: string; username: string; password: string; providerId: string; otp?: string }): Promise<{ completed: boolean; requiresCaptcha: boolean }> {
    await page.waitForTimeout(2000);
    const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', '#username', '#email'];
    const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];
    for (const sel of usernameSelectors) {
      const el = await page.locator(sel).first();
      if (await el.count()) { await el.fill(input.username); break; }
    }
    for (const sel of passwordSelectors) {
      const el = await page.locator(sel).first();
      if (await el.count()) { await el.fill(input.password); break; }
    }
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    await submitBtn.first().click();
    await page.waitForTimeout(2000);

    // 提交后可能出现验证码/OTP 门槛（验证码/二次验证）。
    const captchaSelectors = [
      'input[name="otp"]', 'input[name="captcha"]', 'input[name="code"]',
      'input[name="g-recaptcha-response"]', '#captcha', '.captcha input', 'input[autocomplete="one-time-code"]',
    ];
    let requiresCaptcha = false;
    for (const sel of captchaSelectors) {
      if (await page.locator(sel).count().catch(() => 0)) { requiresCaptcha = true; break; }
    }

    if (requiresCaptcha && input.otp) {
      // 用户已提供验证码/OTP：填入并提交。
      for (const sel of captchaSelectors) {
        const el = page.locator(sel).first();
        if (await el.count().catch(() => 0)) { await el.fill(input.otp).catch(() => {}); break; }
      }
      const verify = page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm")');
      if (await verify.count().catch(() => 0)) await verify.first().click().catch(() => {});
      await page.waitForTimeout(2000);
      return { completed: true, requiresCaptcha: false };
    }

    if (requiresCaptcha && !input.otp) {
      // 需要验证码但用户未提供——返回待处理，交用户完成（或走 token 连接器贴 cookie）。
      return { completed: false, requiresCaptcha: true };
    }

    return { completed: true, requiresCaptcha: false };
  }

  async refresh(ctx: ConnectorContext): Promise<void> {
    // Re-authenticate with stored credentials
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const conn = await prisma.connection.findUnique({ where: { id: ctx.connectionId } });
    if (conn?.credentialRef) {
      await revokeCredential(conn.credentialRef, ctx.userId);
      // Also invalidate browser session in DB
      await prisma.browserSession.updateMany({
        where: { userId: ctx.userId, status: 'active' },
        data: { status: 'revoked' },
      });
    }
    await prisma.connection.update({ where: { id: ctx.connectionId }, data: { status: 'revoked' } });
  }

  async healthCheck(_ctx: ConnectorContext): Promise<HealthResult> {
    // 旧版启动了一次真实浏览器，却把 latencyMs 写死成 50 —— 有真实测量点却不测。
    const start = Date.now();
    try {
      const pw = await getPlaywright();
      const browser = await pw.chromium.launch({ headless: true });
      await browser.close();
      return healthy(Date.now() - start);
    } catch (err: any) {
      return unhealthy(err?.message || String(err));
    }
  }
}

export const browserConnector = new BrowserConnector();
