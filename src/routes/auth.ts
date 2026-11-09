import { Router, Request, Response } from 'express';
import { prisma } from '../services/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { effectiveRole } from '../services/adminRole';
import { checkAdminPin } from '../services/adminPin';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

// ==================== 暴力破解防护 ====================
// 登录/重置类端点按 IP 限流：15 次/5 分钟（39.14 阶段0止血 R-04）。
// 阈值刻意宽松——项目仍在内测，避免影响正常调试；真正上线前应同时改为按
// email+IP 双维度计数并接入 Redis/DB（多实例各自计数会有绕过空间）。
const authAttemptLimiter = rateLimit(5 * 60 * 1000, 15);

// ==================== Register ====================

router.post('/register', authAttemptLimiter, async (req: Request, res: Response) => {
  try {
    const { email, username, password, region, language, currency } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '请填写所有必填字段' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }

    const normEmail = String(email).trim().toLowerCase();

    // 1) Email already registered → never create a new account. Verify the
    //    supplied password against the EXISTING account: correct → sign in,
    //    wrong → ask the user to check username/password.
    //    Case-insensitive email match isn't available directly, so we fetch
    //    by the raw value and also match on normalized email.
    const emailHit = await prisma.user.findMany({
      where: { OR: [{ email: String(email).trim() }, { email: normEmail }] },
      take: 5,
    });
    const existingByEmail =
      emailHit.find((u) => u.email.toLowerCase() === normEmail) ?? emailHit[0];
    if (existingByEmail) {
      let isValid = false;
      if (existingByEmail.passwordHash.startsWith('reset:')) {
        const originalHash = existingByEmail.passwordHash.split(':').slice(2).join(':');
        isValid = await bcrypt.compare(password, originalHash);
        if (isValid) {
          await prisma.user.update({ where: { id: existingByEmail.id }, data: { passwordHash: originalHash } });
        }
      } else {
        isValid = await bcrypt.compare(password, existingByEmail.passwordHash);
      }
      if (isValid) {
        if (!existingByEmail.isActive) {
          return res.status(403).json({ error: '账号已被禁用' });
        }
        const role0 = effectiveRole(existingByEmail.username, existingByEmail.role);
        const token = jwt.sign({ id: existingByEmail.id, role: role0 }, env.JWT_SECRET, { expiresIn: '30d' });
        await prisma.user.update({ where: { id: existingByEmail.id }, data: { updatedAt: new Date() } });
        return res.status(200).json({
          token,
          existing: true,
          user: {
            id: existingByEmail.id,
            email: existingByEmail.email,
            username: existingByEmail.username,
            avatar: existingByEmail.avatar,
            role: role0,
            region: existingByEmail.region,
            language: existingByEmail.language,
            currency: existingByEmail.currency,
            subscriptionTier: existingByEmail.subscriptionTier,
            subscriptionEnd: existingByEmail.subscriptionEnd,
            creditBalance: existingByEmail.creditBalance,
          },
        });
      }
      return res.status(409).json({ error: '此邮箱已注册，请检查用户名和密码后重新登录' });
    }

    // 2) Username already registered (email is new) → never auto-register.
    const rawUsername = username ? String(username).trim() : '';
    let regUsername = rawUsername.toLowerCase();
    if (regUsername) {
      const usernameHit = await prisma.user.findMany({
        where: { OR: [{ username: rawUsername }, { username: regUsername }] },
        take: 5,
      });
      if (usernameHit.length > 0) {
        return res.status(409).json({ error: '此用户名已注册，请检查邮箱和密码后重新登录' });
      }
    } else {
      regUsername = normEmail.split('@')[0];
      const usernameHit = await prisma.user.findMany({
        where: { OR: [{ username: regUsername }, { username: regUsername.toLowerCase() }] },
        take: 5,
      });
      if (usernameHit.length > 0) {
        return res.status(409).json({ error: '此用户名已注册，请检查邮箱和密码后重新登录' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email: String(email).trim(), username: regUsername, passwordHash,
        region: region || 'CN',
        language: language || 'zh-CN',
        currency: currency || 'USD',
      },
    });

    const token = jwt.sign(
      { id: user.id, role: user.role },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        subscriptionTier: user.subscriptionTier,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '注册失败' });
  }
});

// ==================== Enter (unified login-or-register) ====================

router.post('/enter', authAttemptLimiter, async (req: Request, res: Response) => {
  try {
    const { username, email, password, region, language, currency } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }

    // Email/username matching is case-insensitive (normalized lookup) so
    // "Test@x.com" and "test@X.com" resolve to the same account — this is
    // what prevents the "register again creates a new account" bug.
    const normEmail = String(email).trim().toLowerCase();
    const rawUsername = username ? String(username).trim() : '';
    const normUsername = rawUsername.toLowerCase();

    const emailCandidates = await prisma.user.findMany({
      where: { OR: [{ email: String(email).trim() }, { email: normEmail }] },
      take: 5,
    });
    let existing = emailCandidates.find((u) => u.email.toLowerCase() === normEmail) ?? emailCandidates[0];
    if (!existing && normUsername) {
      const byUsername = await prisma.user.findMany({
        where: { OR: [{ username: rawUsername }, { username: normUsername }] },
        take: 5,
      });
      existing = byUsername.find((u) => u.username.toLowerCase() === normUsername) ?? byUsername[0];
    }
    if (existing) {
      let isValid = false;
      if (existing.passwordHash.startsWith('reset:')) {
        const originalHash = existing.passwordHash.split(':').slice(2).join(':');
        isValid = await bcrypt.compare(password, originalHash);
        if (isValid) {
          await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: originalHash } });
        }
      } else {
        isValid = await bcrypt.compare(password, existing.passwordHash);
      }
      if (!isValid) {
        return res.status(401).json({ error: '邮箱或密码错误' });
      }
      if (!existing.isActive) {
        return res.status(403).json({ error: '账号已被禁用' });
      }

      const token = jwt.sign({ id: existing.id, role: existing.role }, env.JWT_SECRET, { expiresIn: '30d' });
      await prisma.user.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });

      return res.json({
        token,
        created: false,
        user: {
          id: existing.id,
          email: existing.email,
          username: existing.username,
          avatar: existing.avatar,
          role: existing.role,
          region: existing.region,
          language: existing.language,
          currency: existing.currency,
          subscriptionTier: existing.subscriptionTier,
          subscriptionEnd: existing.subscriptionEnd,
          creditBalance: existing.creditBalance,
        },
      });
    }

    // Email missing → auto-register. Username lookup normalizes case so a
    // case-variant of an existing username cannot slip past the check.
    let registerUsername = rawUsername || normEmail.split('@')[0];
    const candidateUsernames = [registerUsername, registerUsername.toLowerCase()];
    const taken = await prisma.user.findMany({
      where: { username: { in: candidateUsernames } },
      take: 5,
    });
    if (taken.length > 0) {
      // conflict on chosen/auto name: if user picked it, fail clearly; if
      // auto-derived, suffix
      if (rawUsername) {
        return res.status(400).json({ error: '用户名已被使用' });
      }
      registerUsername = `${normEmail.split('@')[0]}_${crypto.randomBytes(3).toString('hex')}`;
      const stillTaken = await prisma.user.findMany({
        where: { username: { in: [registerUsername, registerUsername.toLowerCase()] } },
        take: 5,
      });
      if (stillTaken.length > 0) {
        return res.status(400).json({ error: '无法生成可用用户名，请重试' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email: String(email).trim(), username: registerUsername, passwordHash,
        region: region || 'CN',
        language: language || 'zh-CN',
        currency: currency || 'USD',
      },
    });

    const token = jwt.sign({ id: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      created: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        region: user.region,
        language: user.language,
        currency: user.currency,
        subscriptionTier: user.subscriptionTier,
      },
    });
  } catch (err) {
    console.error('Enter error:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// ==================== Login ====================

router.post('/login', authAttemptLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    // Login is case-insensitive on email/username so a user who typed
    // "Test@X.com" can still log in to an account stored as "test@x.com".
    const rawEmail = String(email).trim();
    const user = (
      await prisma.user.findMany({
        where: {
          OR: [
            { email: { in: [rawEmail, rawEmail.toLowerCase()] } },
            { username: { in: [rawEmail, rawEmail.toLowerCase()] } },
          ],
        },
        take: 5,
      })
    )[0];

    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    if (user.passwordHash.startsWith('reset:')) {
      const originalHash = user.passwordHash.split(':').slice(2).join(':');
      const isValid = await bcrypt.compare(password, originalHash);
      if (!isValid) {
        return res.status(401).json({ error: '邮箱或密码错误' });
      }
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: originalHash } });
    } else {
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: '邮箱或密码错误' });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    const role = effectiveRole(user.username, user.role);
    const token = jwt.sign(
      { id: user.id, role },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { updatedAt: new Date() },
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        role,
        region: user.region,
        language: user.language,
        currency: user.currency,
        subscriptionTier: user.subscriptionTier,
        subscriptionEnd: user.subscriptionEnd,
        creditBalance: user.creditBalance,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// ==================== Get Current User ====================

router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true, email: true, username: true, avatar: true, gender: true, role: true,
        region: true, language: true, currency: true,
        subscriptionTier: true,
        subscriptionEnd: true, creditBalance: true, frozenCredits: true,
        createdAt: true, updatedAt: true,
      },
    });

    if (!user) return res.status(404).json({ error: '用户不存在' });
    // ADMIN_USERNAMES 名单中的账号在响应中同样体现为管理员 role
    res.json({ user: { ...user, role: effectiveRole(user.username, user.role) } });
  } catch {
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// ==================== Admin Page PIN Gate ====================
// 进入后台管理页的第二道门槛：除管理员身份外，还需输入部署环境变量
// ADMIN_ACCESS_PIN 中的六位数密码。仅管理员账号可调用本接口校验。

router.post('/admin-verify', authMiddleware, adminAuth, (req: AuthRequest, res: Response) => {
  const result = checkAdminPin(req.body?.pin);
  if (result === 'unconfigured') {
    return res.status(503).json({ error: '服务端未配置 ADMIN_ACCESS_PIN，请检查部署环境变量' });
  }
  if (result !== 'ok') return res.status(401).json({ error: '密码错误' });
  res.json({ ok: true });
});

// ==================== Update Profile ====================

router.put('/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { username, avatar, region, language, currency, gender } = req.body;
    const updateData: any = {};

    if (username) {
      const existing = await prisma.user.findFirst({
        where: { username, id: { not: req.user!.id } },
      });
      if (existing) return res.status(400).json({ error: '用户名已被使用' });
      updateData.username = username;
    }
    if (avatar !== undefined) updateData.avatar = avatar;
    if (region) updateData.region = region;
    if (language) updateData.language = language;
    if (currency) updateData.currency = currency;
    if (gender !== undefined) { const g = String(gender || ''); if (g === '' || g === 'male' || g === 'female') updateData.gender = g || null; }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: updateData,
      select: {
        id: true, email: true, username: true, avatar: true, gender: true, role: true,
        region: true, language: true, currency: true,
        subscriptionTier: true,
        subscriptionEnd: true, creditBalance: true,
      },
    });

    res.json({ user });
  } catch {
    res.status(500).json({ error: '更新失败' });
  }
});

// ==================== Change Password ====================

router.put('/password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '请填写当前密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少6位' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) return res.status(401).json({ error: '当前密码错误' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

    res.json({ success: true, message: '密码已更新' });
  } catch {
    res.status(500).json({ error: '修改密码失败' });
  }
});

// ==================== Forgot Password ====================

router.post('/forgot-password', authAttemptLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '请输入邮箱' });

    const user = await prisma.user.findUnique({ where: { email } });

    res.json({ success: true, message: '如果该邮箱已注册，重置链接已发送' });

    if (!user) return;

    const resetToken = crypto.randomBytes(32).toString('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: `reset:${resetToken}:${user.passwordHash}` },
    });

    // 令牌不回显到日志：日志可被转发/备份/他人查看，等于把账号接管凭证公开。
    // 生产环境应改为邮件发送；本地调试可用 FORGOT_PASSWORD_DEBUG=1 显式开启打印。
    if (process.env.FORGOT_PASSWORD_DEBUG === '1') {
      console.log(`[PASSWORD RESET] Token for ${email}: ${resetToken}`);
      console.log(`[PASSWORD RESET] URL: ${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`);
    }

  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ success: true, message: '如果该邮箱已注册，重置链接已发送' });
  }
});

// ==================== Reset Password ====================

router.post('/reset-password', authAttemptLimiter, async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: '缺少参数' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const users = await prisma.user.findMany({
      where: { passwordHash: { contains: `reset:${token}:` } },
    });

    if (users.length === 0) {
      return res.status(400).json({ error: '重置链接无效或已过期' });
    }

    const user = users[0];

    if (!user.passwordHash.startsWith(`reset:${token}:`)) {
      return res.status(400).json({ error: '重置链接无效' });
    }

    const newHash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    res.json({ success: true, message: '密码已重置，请使用新密码登录' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: '重置失败' });
  }
});

// ==================== Verify Email ====================

router.get('/verify-email', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.query.userId || '');
    // 只允许确认自己的邮箱：不能凭 userId+任意 token 激活他人账号。
    // （当前未接入邮件服务，注册流程不发验证链接；接入后应改为签名 token 校验）
    if (!userId || userId !== req.user!.id) return res.status(403).json({ error: '无权验证该账号' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });

    res.json({ success: true, message: '邮箱已验证' });
  } catch {
    res.status(500).json({ error: '验证失败' });
  }
});

// ==================== Admin Invite: Check Token ====================

router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const invite = await prisma.adminInvite.findUnique({ where: { token: String(req.params.token) } });
    if (!invite || invite.isUsed || new Date() > invite.expiresAt) {
      return res.status(400).json({ error: '邀请无效或已过期' });
    }
    res.json({ valid: true, email: invite.email });
  } catch {
    res.status(500).json({ error: '验证失败' });
  }
});

// ==================== Admin Invite: Accept ====================

router.post('/accept-invite', async (req: Request, res: Response) => {
  try {
    const { token, username, password } = req.body;
    if (!token || !username || !password) return res.status(400).json({ error: '缺少参数' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const invite = await prisma.adminInvite.findUnique({ where: { token } });
    if (!invite || invite.isUsed || new Date() > invite.expiresAt) {
      return res.status(400).json({ error: '邀请无效或已过期' });
    }

    const email = invite.email || `admin_${Date.now()}@cortex.local`;

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existingUser) return res.status(400).json({ error: '用户名或邮箱已被使用' });

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email, username, passwordHash,
        role: 'ADMIN',
        isActive: true,
      },
    });

    await prisma.adminInvite.update({
      where: { token },
      data: { isUsed: true, usedBy: user.id },
    });

    const jwtToken = jwt.sign(
      { id: user.id, role: user.role },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    );

    res.status(201).json({
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: '创建管理员失败' });
  }
});

// ==================== Logout ====================

router.post('/logout', (_req: Request, res: Response) => {
  res.json({ success: true, message: '已退出登录' });
});

// ==================== Account Deletion (GDPR-style) ====================

router.delete('/account', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: '管理员账号不能自助注销，请联系超级管理员' });
    }

    // 级联删除（Prisma onDelete: Cascade 自动生效）：
    // 对话/消息/记忆/积分流水/支付记录均挂在 user 上，删除 User 行即全部清除。
    await prisma.user.delete({ where: { id: userId } });

    res.json({ success: true, message: '账号已注销' });
  } catch (err: any) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: '注销失败：' + (err?.message || '请稍后重试') });
  }
});

// ==================== SSO: Google / GitHub ====================
// 无 DB schema 改动：按 provider 邮箱 find-or-create。
// 新 SSO 用户的 passwordHash 是随机 hex（sso: 前缀）→ 无法密码登录，只能 SSO。

function ssoClientBase(): string {
  const u = env.CLIENT_URL;
  return u && u !== '*' ? u.replace(/\/+$/, '') : 'http://localhost:3000';
}

function ssoRedirectUri(provider: 'google' | 'github'): string {
  if (provider === 'github') return env.GITHUB_OAUTH_REDIRECT_URI || `${ssoClientBase()}/auth/callback/github`;
  return env.GOOGLE_OAUTH_REDIRECT_URI || `${ssoClientBase()}/auth/callback/google`;
}

function ssoUserView(u: any) {
  return {
    id: u.id, email: u.email, username: u.username, avatar: u.avatar,
    role: u.role, region: u.region, language: u.language, currency: u.currency,
    subscriptionTier: u.subscriptionTier, subscriptionEnd: u.subscriptionEnd,
    creditBalance: u.creditBalance,
  };
}

function issueSsoJwt(user: any) {
  return jwt.sign({ id: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '30d' });
}

async function ssoFindOrCreate(email: string, usernameSeed: string) {
  const normEmail = String(email).trim().toLowerCase();
  const existing = await prisma.user.findFirst({ where: { email: normEmail } });
  if (existing) {
    if (!existing.isActive) throw new Error('账号已被禁用');
    return { user: existing, created: false };
  }
  const base =
    (usernameSeed || normEmail.split('@')[0] || 'user')
      .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
  let username = base;
  for (let i = 0; i < 4; i++) {
    const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
    if (!taken) break;
    username = `${base}-${crypto.randomInt(1000, 9999)}`;
  }
  const user = await prisma.user.create({
    data: {
      email: normEmail,
      username,
      passwordHash: 'sso:' + crypto.randomBytes(32).toString('hex'),
    },
  });
  return { user, created: true };
}

router.get('/oauth/available', (_req, res) => {
  res.json({ google: !!env.GOOGLE_CLIENT_ID, github: !!env.GITHUB_CLIENT_ID });
});

router.post('/oauth/:provider/start', (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (provider !== 'google' && provider !== 'github') {
    return res.status(400).json({ error: '不支持的登录方式' });
  }
  if (provider === 'google' && !env.GOOGLE_CLIENT_ID) {
    return res.status(501).json({ error: 'Google 登录尚未在服务端配置' });
  }
  if (provider === 'github' && !env.GITHUB_CLIENT_ID) {
    return res.status(501).json({ error: 'GitHub 登录尚未在服务端配置' });
  }

  // state = ts.nonce.hmac(JWT_SECRET)：无状态 CSRF 防护，10 分钟有效
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(`sso|${provider}|${nonce}`).digest('hex');
  const state = `${ts}.${nonce}.${sig}`;

  let url: string;
  if (provider === 'google') {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
    u.searchParams.set('redirect_uri', ssoRedirectUri('google'));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    url = u.toString();
  } else {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
    u.searchParams.set('redirect_uri', ssoRedirectUri('github'));
    u.searchParams.set('scope', 'read:user email');
    u.searchParams.set('state', state);
    url = u.toString();
  }
  res.json({ url });
});

router.post('/oauth/callback', async (req: Request, res: Response) => {
  try {
    const { provider, code, state } = req.body;
    if (provider !== 'google' && provider !== 'github' || !code || !state) {
      return res.status(400).json({ error: '登录请求不完整' });
    }
    const [ts, nonce, sig] = String(state).split('.');
    if (!ts || !nonce || !sig || Number(ts) < Date.now() - 10 * 60 * 1000) {
      return res.status(400).json({ error: '登录会话已过期，请重试' });
    }
    const expect = crypto.createHmac('sha256', env.JWT_SECRET).update(`sso|${provider}|${nonce}`).digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return res.status(400).json({ error: '登录状态校验失败' });
    }

    let accessToken = '';
    let email: string | null = null;
    let name = '';

    if (provider === 'google') {
      if (!env.GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google 登录尚未在服务端配置' });
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: ssoRedirectUri('google'),
        }),
      });
      const td: any = await tr.json().catch(() => ({}));
      if (!tr.ok || !td.access_token) return res.status(401).json({ error: '无法完成 Google 登录授权' });
      accessToken = td.access_token;
      const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const ud: any = await ur.json().catch(() => ({}));
      if (!ur.ok || !ud.email) return res.status(401).json({ error: '无法获取 Google 账号信息' });
      email = ud.email;
      name = ud.name || '';
    } else {
      if (!env.GITHUB_CLIENT_ID) return res.status(501).json({ error: 'GitHub 登录尚未在服务端配置' });
      const tr = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: ssoRedirectUri('github'),
        }),
      });
      const td: any = await tr.json().catch(() => ({}));
      if (!tr.ok || !td.access_token) return res.status(401).json({ error: '无法完成 GitHub 登录授权' });
      accessToken = td.access_token;
      const ur = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
      });
      const ud: any = await ur.json().catch(() => ({}));
      if (!ur.ok) return res.status(401).json({ error: '无法获取 GitHub 账号信息' });
      email = ud.email; // 可能为 null（未设置/未验证邮箱）
      name = ud.name || ud.login;
      if (!email) email = `${ud.login}@users.noreply.github.com`;
    }

    const { user, created } = await ssoFindOrCreate(email!, name);
    if (!created) {
      await prisma.user.update({ where: { id: user.id }, data: { updatedAt: new Date() } }).catch(() => {});
    }
    res.json({ token: issueSsoJwt(user), user: ssoUserView(user), created });
  } catch (err: any) {
    console.error('SSO callback error:', err);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// GitHub PAT 兜底：用户直接提供 personal access token
router.post('/github/token', async (req: Request, res: Response) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: '请填写 GitHub Token' });
    const ur = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (ur.status === 401) return res.status(401).json({ error: 'GitHub Token 无效或已过期' });
    const ud: any = await ur.json().catch(() => ({}));
    if (!ur.ok) return res.status(401).json({ error: 'GitHub Token 校验失败' });
    const finalEmail = ud.email || `${ud.login}@users.noreply.github.com`;
    const { user, created } = await ssoFindOrCreate(finalEmail, ud.login);
    if (!created) {
      await prisma.user.update({ where: { id: user.id }, data: { updatedAt: new Date() } }).catch(() => {});
    }
    res.json({ token: issueSsoJwt(user), user: ssoUserView(user), created });
  } catch (err: any) {
    console.error('GitHub PAT login error:', err);
    res.status(500).json({ error: 'GitHub Token 登录失败，请稍后重试' });
  }
});

export default router;