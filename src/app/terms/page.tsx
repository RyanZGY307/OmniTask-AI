'use client';
import { useRouter } from 'next/navigation';

export default function TermsPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => router.back()} className="p-2 hover:bg-surface-hover rounded-card transition-colors">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">服务条款</h1>
        </div>
        <div className="glass-card p-6 space-y-6 text-sm text-muted leading-relaxed anim-fade-up anim-delay-1">
          <p className="text-xs text-muted">最后更新：2026年9月 · 生效日期：2026年9月</p>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">1. 服务描述</h2>
            <p>OmniTask 是一个基于人工智能的对话助手平台，提供多模型 AI 对话、图片生成、视频生成、代码编写等功能。我们通过订阅制和积分制提供服务。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">2. 账户责任</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>您必须提供真实、准确的注册信息</li>
              <li>您有责任保护账户安全，不要与他人共享密码</li>
              <li>您对账户下的所有活动负责</li>
              <li>发现账户被盗用应立即通知我们</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">3. 可接受使用</h2>
            <p>您同意不使用本服务进行以下活动：</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>生成违法、有害、威胁、侮辱、骚扰性内容</li>
              <li>侵犯他人知识产权</li>
              <li>传播恶意软件或进行网络攻击</li>
              <li>试图绕过安全措施或访问限制</li>
              <li>自动化批量请求以消耗他人资源</li>
              <li>使用 AI 生成内容冒充真人进行欺诈</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">4. 付款条款</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>所有价格以美元 (USD) 为基础货币，本地货币价格按实时汇率换算</li>
              <li>订阅按所选周期自动续费，直到您取消</li>
              <li>自购积分包永久有效；Pro 订阅每月赠送的积分有效期为 30 天（年付为 12 个每月批次）</li>
              <li>退款政策：已激活的会员服务不支持退款</li>
              <li>PayPal 付款需额外支付 4.4% 手续费（马币 TNG/ShopeePay 免手续费）</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">5. 知识产权</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>您使用 AI 生成的内容归您所有</li>
              <li>OmniTask 平台本身的代码、设计和商标归我们所有</li>
              <li>您上传的内容应确保拥有合法使用权</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">6. AI 输出免责声明</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>AI 生成的内容可能存在错误或不准确之处</li>
              <li>AI 输出不构成专业建议（法律、医疗、财务等）</li>
              <li>您应自行判断 AI 输出的准确性和适用性</li>
              <li>对于因依赖 AI 输出而造成的损失，我们不承担责任</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">7. 服务可用性</h2>
            <p>我们努力保持服务稳定运行，但不保证 100% 无中断。我们可能因维护、升级或不可抗力而暂停服务。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">8. 账户终止</h2>
            <p>我们保留在以下情况下暂停或终止您账户的权利：</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>违反本服务条款</li>
              <li>长期未使用（超过 12 个月未登录）</li>
              <li>涉嫌欺诈或滥用服务</li>
            </ul>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">9. 责任限制</h2>
            <p>在法律允许的最大范围内，我们对因使用本服务而产生的任何间接、偶然、特殊或后果性损害不承担责任。我们的总责任不超过您在过去 12 个月内支付的费用。</p>
          </section>
          <section>
            <h2 className="text-primary font-display font-semibold mb-2">10. 条款更新</h2>
            <p>我们可能不定期更新本条款。重大变更将通过应用内通知告知。继续使用服务即表示您接受更新后的条款。</p>
          </section>
        </div>
      </div>
    </div>
  );
}