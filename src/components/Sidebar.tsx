'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { formatCredits, getEffectiveTier } from '@/lib/models';
import { useT } from '@/lib/i18n';

export default function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const { conversations, fetchConversations, createConversation, deleteConversation, togglePin, showToast } = useChatStore();
  const { user, logout } = useAuthStore();
  const [creating, setCreating] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const asideRef = useRef<HTMLElement>(null);

  // React 18 不写入布尔 inert，直接操作属性：关闭的抽屉移出 Tab 序列与无障碍树
  useEffect(() => {
    asideRef.current?.toggleAttribute('inert', !isOpen && !isDesktop);
  }, [isOpen, isDesktop]);

  useEffect(() => {
    fetchConversations();
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const handleNewChat = async () => {
    setCreating(true);
    try { const id = await createConversation(); router.push(`/chat/${id}`); onClose(); }
    catch {} finally { setCreating(false); }
  };

  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  const tier = user ? getEffectiveTier(user) : 'STANDARD';
  const isPro = tier === 'PRO' || tier === 'ULTRA';

  // 功能列表入口：后台管理(admin) / Agent(Pro) / 项目 / 插件。
  // 功能本体稍后实现，此处先预留界面：点击给出状态提示。
  const handleAgent = () => {
    showToast(isPro ? t('side.agentDev') : t('side.agentPro'));
    onClose();
  };
  const handleProject = () => { showToast(t('side.projectDev')); onClose(); };
  const handlePlugins = () => { showToast(t('side.pluginsEmpty')); onClose(); };

  const features: { key: string; icon: JSX.Element; label: string; onClick: () => void }[] = [];
  if (isAdmin) features.push({ key: 'admin', icon: <ShieldIcon />, label: t('side.admin'), onClick: () => { router.push('/admin'); onClose(); } });
  features.push({ key: 'agent', icon: <BotIcon />, label: t('side.agent'), onClick: handleAgent });
  features.push({ key: 'project', icon: <FolderIcon />, label: t('side.projects'), onClick: handleProject });
  features.push({ key: 'plugin', icon: <PlugIcon />, label: t('side.plugins'), onClick: handlePlugins });
  features.push({ key: 'skills', icon: <BoltIcon />, label: t('side.skills'), onClick: () => { router.push('/skills'); onClose(); } });

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden anim-fade-in" onClick={onClose} />}
      <aside ref={asideRef} aria-hidden={!isOpen && !isDesktop} className={`fixed lg:static inset-y-0 left-0 z-50 w-72 bg-surface border-r border-border flex flex-col transition-transform duration-300 ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`} style={{ transitionTimingFunction: 'var(--ease-out-expo)' }}>
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-display font-bold text-accent tracking-tight">OmniTask</h1>
            <button onClick={onClose} className="lg:hidden flex h-11 w-11 items-center justify-center text-muted hover:text-primary anim-press" aria-label={t('side.close')}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <button onClick={handleNewChat} disabled={creating}
            className="w-full py-2.5 px-4 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-card transition-colors flex items-center justify-center gap-2 disabled:opacity-50 anim-hover-scale">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            {t('side.newChat')}
          </button>
          {user && tier !== 'STANDARD' && (
            <div className="mt-3 px-2 flex items-center justify-between">
              <span className="text-xs text-muted">{t('side.credits')}</span>
              <span className="credit-pill">{formatCredits(user.creditBalance || 0)}</span>
            </div>
          )}
        </div>

        {/* 功能入口：后台管理(admin) / Agent / 项目 / 插件 */}
        <div className="px-3 py-2 space-y-0.5 anim-stagger">
          {features.map((f) => (
            <button
              key={f.key}
              onClick={f.onClick}
              className="w-full flex items-center gap-2.5 px-3 min-h-[44px] rounded-card text-sm text-primary hover:bg-surface-hover transition-colors focus-ring"
            >
              <span className="w-5 flex justify-center text-muted">{f.icon}</span>
              <span className="flex-1 text-left">{f.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <div className="text-center text-muted py-8 text-sm">{t('side.noConversations')}</div>
          ) : (
            <>
              {conversations.filter(c => c.isPinned).length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1 text-xs text-muted font-medium">{t('side.pinned')}</div>
                  {conversations.filter(c => c.isPinned).map((conv, i) => (
                    <ConvItem key={conv.id} conv={conv} isActive={pathname?.includes(conv.id)} delay={i * 0.03}
                      onClick={() => { router.push(`/chat/${conv.id}`); onClose(); }}
                      onPin={() => togglePin(conv.id, conv.isPinned)}
                      onDelete={() => { if (confirm(t('side.deleteConfirm'))) { deleteConversation(conv.id); if (pathname?.includes(conv.id)) router.push('/chat'); } }} />
                  ))}
                </div>
              )}
              <div className="px-3 py-1 text-xs text-muted font-medium">{t('side.recent')}</div>
              {conversations.filter(c => !c.isPinned).map((conv, i) => (
                <ConvItem key={conv.id} conv={conv} isActive={pathname?.includes(conv.id)} delay={i * 0.03}
                  onClick={() => { router.push(`/chat/${conv.id}`); onClose(); }}
                  onPin={() => togglePin(conv.id, conv.isPinned)}
                  onDelete={() => { if (confirm(t('side.deleteConfirm'))) { deleteConversation(conv.id); if (pathname?.includes(conv.id)) router.push('/chat'); } }} />
              ))}
            </>
          )}
        </div>

        <div className="p-4 border-t border-border space-y-1">
          <button onClick={() => { router.push('/settings'); onClose(); }}
            className="w-full min-h-[44px] px-3 text-sm text-muted hover:text-primary hover:bg-surface-hover rounded-card transition-colors flex items-center gap-2.5 focus-ring">
            <span className="w-5 flex justify-center"><GearIcon /></span> {user?.username || t('side.settings')}
          </button>
          <button onClick={() => { logout(); router.push('/onboarding'); }}
            className="w-full min-h-[44px] px-3 text-sm text-muted hover:text-error hover:bg-surface-hover rounded-card transition-colors flex items-center gap-2.5 focus-ring">
            <span className="w-5 flex justify-center"><LogoutIcon /></span> {t('side.signOut')}
          </button>
        </div>
      </aside>
    </>
  );
}

function ConvItem({ conv, isActive, onClick, onPin, onDelete, delay }: any) {
  return (
    <div onClick={onClick}
      className={`group flex items-center gap-2 px-3 py-2.5 rounded-card cursor-pointer mb-1 transition-colors anim-fade-up liquid-glass-draggable ${isActive ? 'bg-surface-hover text-primary' : 'text-primary/80 hover:bg-surface-hover hover:text-primary'}`}
      style={{ animationDelay: `${delay}s`, opacity: 0 }}>
      {conv.isPinned && <span className="text-xs">📌</span>}
      <span className="truncate text-sm flex-1">{conv.title}</span>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
        <button onClick={(e) => { e.stopPropagation(); onPin(); }} className="p-1 hover:text-accent rounded text-xs anim-press">📌</button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1 hover:text-error rounded text-xs anim-press">🗑</button>
      </div>
    </div>
  );
}

// ==================== 功能列表图标 ====================
function ShieldIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function BotIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
function PlugIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" />
      <path d="M18 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
function LogoutIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}