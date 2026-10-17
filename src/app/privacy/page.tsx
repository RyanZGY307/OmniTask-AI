'use client';
import { useRouter } from 'next/navigation';

export default function PrivacyPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => router.back()} className="p-2 hover:bg-surface-hover rounded-card transition-colors">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">隐私政策</h1>
        </div>
        <div className="glass-card p-6 space-y-6 text-sm text-muted leading-relaxed anim-fade-up anim-delay-1">
          <p className="text-xs text-muted">最后更新：2026年9月 · 生效日期：2026年9月</p>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">1. 数据所有权</h2>
            <p>您在 OmniTask 中创建的所有对话、上传的文件和生成的内容归您所有。您有权随时查看、导出或删除您的所有数据。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">2. 我们收集的数据</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>账号信息：</strong>邮箱、用户名、地区、语言偏好、货币偏好</li>
              <li><strong>对话数据：</strong>您与 AI 的对话内容、上传的文件、生成的代码和图片</li>
              <li><strong>使用数据：</strong>模型使用频率、Token 消耗、积分交易记录</li>
              <li><strong>付款信息：</strong>付款金额、支付方式、交易状态（我们不存储银行卡号）</li>
              <li><strong>设备信息：</strong>浏览器类型、操作系统（用于安全防护）</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">3. 数据用途</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>提供 AI 对话服务和相关功能</li>
              <li>处理付款和维护账户安全</li>
              <li>改进服务质量（不使用对话内容训练 AI 模型）</li>
              <li>遵守法律法规要求</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">4. 第三方共享</h2>
            <p>您的对话内容会发送至您选择的 AI 模型提供商（如 OpenAI、Google、DeepSeek、Xiaomi、Agnes AI）以生成回复。这些提供商均有各自的数据处理政策。</p>
            <p className="mt-2">我们不会将您的数据出售给广告商或数据经纪人。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">5. AI 模型训练</h2>
            <p><strong>您的对话数据不会用于训练任何 AI 模型。</strong>所有 AI 模型提供商通过 API 调用处理，API 模式下提供商不会使用您的数据进行模型训练。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">6. 数据存储与安全</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>数据存储在 PostgreSQL 数据库中</li>
              <li>所有数据传输使用 HTTPS 加密</li>
              <li>系统日志在 30 天后自动删除</li>
              <li>密码使用 bcrypt 单向加密存储</li>
            </ul>
            <p className="mt-2">为保护用户与平台安全，触及明确定义的高风险规则的对话会在用户界面明确标记，并将触发事件所在会话的最近 5 条（直接拒绝）或最多 10 条（多次警告后）消息保存至受限的安全审计存储。此类记录仅授权的管理员在合规审计目的下可访问，默认保留 180 天后自动删除，且不会用于构建您的个人资料或长期记忆。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">7. 您的权利</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>查看：</strong>随时查看您的所有个人数据和对话记录</li>
              <li><strong>导出：</strong>导出所有对话记录为文本文件</li>
              <li><strong>删除：</strong>删除单条对话、清除所有数据或注销账号</li>
              <li><strong>更正：</strong>修改您的账号信息和个人偏好</li>
              <li><strong>撤回同意：</strong>随时撤回对数据处理的同意</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">8. Cookie</h2>
            <p>我们仅使用必要的 Cookie 用于维持登录状态，不使用追踪 Cookie 或广告 Cookie。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">9. 未成年人保护</h2>
            <p>我们的服务不面向 13 岁以下未成年人。如果我们发现误收集了未成年人的数据，将会立即删除。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">10. 政策更新</h2>
            <p>我们可能会不定期更新本政策。重大变更时会通过应用内通知告知您。继续使用我们的服务即表示您同意更新后的政策。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">11. 联系我们</h2>
            <p>如有隐私相关问题，请通过应用内的"问题反馈"功能联系我们。</p>
          </section>
        </div>
      </div>
    </div>
  );
}