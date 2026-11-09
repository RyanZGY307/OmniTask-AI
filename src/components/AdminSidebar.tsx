'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

// 响应式后台侧栏：桌面（lg+）常驻；手机/平板/折叠屏收起为抽屉，由顶栏汉堡按钮唤出。
export default function AdminSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // 路由变化后自动收起抽屉（移动端）
  useEffect(() => { setOpen(false); }, [pathname]);

  // React 18 不写入布尔 inert，直接操作属性：关闭的抽屉移出 Tab 序列与无障碍树
  useEffect(() => {
    asideRef.current?.toggleAttribute('inert', !open && !isDesktop);
  }, [open, isDesktop]);

  const links = [
    { path: '/admin', label: '仪表盘', tab: 'dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    { path: '/admin', label: 'Observability', tab: 'observability', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
    { path: '/admin/models', label: '模型管理', tab: null, icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18 0h-2m2-6h-2M5 5l14 14M19 5L5 19' },
    { path: '/admin/users', label: '用户管理', tab: null, icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z' },
    { path: '/admin/flagged', label: '标记对话', tab: null, icon: 'M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-2 4 2 4h-8.5l-1-1H5' },
    { path: '/admin/prompts', label: '提示词管理', tab: null, icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
    { path: '/admin/logs', label: '日志系统', tab: null, icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    { path: '/admin/knowledge', label: '知识库', tab: null, icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
    { path: '/admin/skills', label: 'Skill 管理', tab: null, icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    { path: '/admin/payments', label: '付款审核', tab: null, icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
    { path: '/admin/feedback', label: '反馈管理', tab: null, icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
    { path: '/admin/evolution', label: '进化引擎', tab: null, icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    { path: '/admin/rsi', label: '受控RSI', tab: null, icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
    { path: '/admin/observability', label: '系统观测中心', tab: null, icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 012 2h2a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  ];

  const isActive = (link: typeof links[0]) => {
    if (link.tab) {
      return pathname === '/admin' && (
        (typeof window !== 'undefined' && window.location.hash === '#' + link.tab) ||
        (link.tab === 'dashboard' && (typeof window === 'undefined' || !window.location.hash || window.location.hash === '#'))
      );
    }
    return pathname === link.path;
  };

  const panel = (
    <>
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-lg font-display font-bold text-accent-figure">OmniTask Admin</h1>
          <p className="text-xs text-muted mt-1">{user?.username} · {user?.role}</p>
        </div>
        <button onClick={() => setOpen(false)} className="lg:hidden flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-primary" aria-label="关闭菜单">✕</button>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {links.map((link, i) => {
          const active = isActive(link);
          const handleClick = () => {
            if (link.tab) {
              if (pathname === '/admin') {
                window.dispatchEvent(new CustomEvent('admin-navigate', { detail: link.tab }));
                window.history.replaceState(null, '', link.tab === 'dashboard' ? '/admin' : `/admin#${link.tab}`);
              } else {
                router.push(link.tab === 'dashboard' ? '/admin' : `/admin#${link.tab}`);
              }
            } else {
              router.push(link.path);
            }
            setOpen(false);
          };

          return (
            <button
              key={link.label}
              onClick={handleClick}
              className={`w-full flex items-center gap-3 px-3 py-3 lg:py-2.5 rounded-card text-sm transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 liquid-glass-interactive ${
                active ? 'bg-accent/10 text-accent-figure border border-accent/15' : 'text-muted hover:text-primary'
              }`}
              style={{ animationDelay: `${i * 0.04}s`, transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={link.icon} />
              </svg>
              <span className="truncate">{link.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="p-3 border-t border-border space-y-1">
        <button onClick={() => { router.push('/chat'); setOpen(false); }}
          className="w-full flex items-center gap-3 px-3 py-3 lg:py-2.5 rounded-card text-sm text-muted hover:text-primary transition-colors liquid-glass-interactive">
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          返回对话
        </button>
        <button onClick={() => { logout(); router.push('/onboarding'); }}
          className="w-full flex items-center gap-3 px-3 py-3 lg:py-2.5 rounded-card text-sm text-muted hover:text-error transition-colors">
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          退出
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* 移动端顶栏（含汉堡），桌面隐藏 */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 h-12 flex items-center gap-3 px-3 bg-bg/95 backdrop-blur border-b border-border">
        <button onClick={() => setOpen(true)} className="w-11 h-11 flex items-center justify-center rounded-full text-primary hover:bg-surface-hover" aria-label="打开菜单">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span className="text-sm font-display font-semibold text-primary">OmniTask Admin</span>
      </div>

      {/* 移动端遮罩 */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/50 anim-fade-in" onClick={() => setOpen(false)} />
      )}

      {/* 侧栏：桌面常驻（w-64），移动端抽屉 */}
      <aside
        ref={asideRef}
        aria-hidden={!open && !isDesktop}
        className={`fixed lg:static top-0 left-0 z-50 h-full w-72 lg:w-64 liquid-glass-sidebar flex flex-col transition-transform duration-300 ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
        style={{ transform: open ? 'translateX(0px)' : undefined }}
      >
        {panel}
      </aside>
    </>
  );
}
