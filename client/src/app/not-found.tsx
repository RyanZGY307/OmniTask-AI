import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-6 text-center">
      <div className="w-14 h-14 rounded-card bg-card border border-border flex items-center justify-center shadow-card mb-6">
        <span className="text-xl font-display font-bold text-accent">404</span>
      </div>
      <h1 className="text-2xl font-display font-bold text-primary mb-2">页面不存在</h1>
      <p className="text-sm text-muted mb-8 max-w-sm">
        你访问的链接可能已失效，或地址输入有误。
      </p>
      <Link
        href="/chat"
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-capsule bg-accent text-on-accent text-sm font-medium hover:bg-accent-hover transition-colors anim-press"
      >
        回到对话
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
      </Link>
    </div>
  );
}
