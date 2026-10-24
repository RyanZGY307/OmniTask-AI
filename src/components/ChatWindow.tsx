'use client';
import { useEffect, useMemo, useRef, useState, Suspense, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import FileWorkspace from './FileWorkspace';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { getEffectiveTier, formatCredits, getModelDisplayName } from '@/lib/models';
import { useModelCatalog } from '@/store/modelCatalog';
import { useSettingsStore } from '@/store/settingsStore';
import { useT } from '@/lib/i18n';

// Lazy load heavy components to reduce initial bundle size
const ModelSelector = dynamic(
  () => import('./ModelSelector'),
  { ssr: false, loading: () => <div className="w-full h-full flex items-center justify-center bg-surface/90">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin" />
    </div> }
);
const MODES = [
  { key: 'fast', label: '快速', icon: '⚡', rememberable: false },
  { key: 'standard', label: '标准', icon: '💬', rememberable: false },
  { key: 'think', label: '思考', icon: '🧠', rememberable: false },
  { key: 'roleplay', label: '角色', icon: '🎭', rememberable: true },
  { key: 'teacher', label: '教师', icon: '📚', rememberable: true },
  { key: 'collab', label: '协作', icon: '🤝', rememberable: true },
  { key: 'deep-research', label: '深度研究', icon: '🔬', minTier: 'PRO', rememberable: false },
];

interface Props {
  conversationId: string | null;
  onNewConversation?: (id: string) => void;
}

export default function ChatWindow({ conversationId, onNewConversation }: Props) {
  const { user } = useAuthStore();
  const store = useChatStore();
  const tr = useT();
  const {
    currentMessages, isLoadingMessages, isStreaming, streamingContent,
    currentMode, currentModel, modelSwitchNotice, creditBalance, toastMessage,
    researchProgress, queueStatus, contextCompression,
    hasMoreOlder, isLoadingOlder, hasMoreNewer, isLoadingNewer,
  } = store;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const [editContent, setEditContent] = useState<string | null>(null);
  // 文件工作台：面板开关 + 待提取的消息（提取动作由 FileWorkspace 真正执行）
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [extractTarget, setExtractTarget] = useState<{ messageId: string } | null>(null);

  const onSaveMessageToWorkspace = (messageId: string) => {
    setExtractTarget({ messageId });
    setWorkspaceOpen(true);
  };
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const catalog = useModelCatalog();
  const fallbackModelKey = catalog.defaultKey || catalog.all[0]?.key;

  const tier = user ? getEffectiveTier(user) : 'STANDARD';

  useEffect(() => {
    if (user) {
      store.fetchAutoModelPool();
      store.fetchModePreferences();
    }
  }, [user?.id]);

  // 手动选模：Pro 用户未选时自动落到后端默认模型；免费版保持 'auto'（后端自动挑最快模型），胶囊显示「自动选择」。
  const isProTier = tier === 'PRO' || tier === 'ULTRA';
  useEffect(() => {
    if (isProTier && catalog.loaded && currentModel === 'auto' && fallbackModelKey) {
      store.setModel(fallbackModelKey);
    }
  }, [isProTier, catalog.loaded, fallbackModelKey, currentModel]);

  useEffect(() => { if (conversationId) store.fetchMessages(conversationId); }, [conversationId]);

  // 在聊天中查找：对已落库消息做本地子串匹配，跳转 + 闪烁高亮（.msg-flash）
  const matchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return currentMessages.filter((m) => (m.content || '').toLowerCase().includes(q)).map((m) => m.id);
  }, [searchQuery, currentMessages]);

  const jumpToMatch = (index: number) => {
    if (matchIds.length === 0) return;
    const clamped = ((index % matchIds.length) + matchIds.length) % matchIds.length;
    setSearchIndex(clamped);
    const el = document.getElementById(`msg-${matchIds[clamped]}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('msg-flash');
    void el.offsetWidth; // 重新触发动画
    el.classList.add('msg-flash');
  };

  useEffect(() => {
    if (searchOpen && searchQuery.trim() && matchIds.length > 0) jumpToMatch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchOpen]);

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); setSearchIndex(0); };

  // 首屏只加载最近 10 条；向上/下翻到边缘时自动再取一页。
  // pendingScroll 记录"这次 DOM 变化是哪一侧插入的"，供下面的 effect 决定
  // 视口怎么处理 —— 头部插入若不保持位置，刚读到的旧消息会把用户当前看的
  // 内容顶出视口，等于翻页翻丢了位置。
  const pendingScrollRef = useRef<'none' | 'older' | 'newer'>('none');
  const scrollAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const handleScrollTrack = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const distTop = el.scrollTop;
    pinnedToBottomRef.current = distBottom < 60;
    if (!conversationId) return;

    if (distTop < 80 && !isLoadingOlder && hasMoreOlder) {
      scrollAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      pendingScrollRef.current = 'older';
      store.loadOlderMessages(conversationId);
    } else if (distBottom < 80 && !isLoadingNewer && hasMoreNewer) {
      pendingScrollRef.current = 'newer';
      store.loadNewerMessages(conversationId);
    }
  };

  const lastMsgIdRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const pending = pendingScrollRef.current;
    if (pending !== 'none') {
      pendingScrollRef.current = 'none';
      if (pending === 'older') {
        // 头部插入了更早的消息：把视口锚回原处，不抢去底部。
        const anchor = scrollAnchorRef.current;
        scrollAnchorRef.current = null;
        if (anchor) el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
        return;
      }
      // 尾部插入了更新的消息：贴底则继续贴底，否则保持当前位置。
      if (pinnedToBottomRef.current) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      return;
    }

    if (!pinnedToBottomRef.current) return;
    const lastId = currentMessages.length ? currentMessages[currentMessages.length - 1].id : null;
    const isMessageBoundary = lastId !== lastMsgIdRef.current;
    lastMsgIdRef.current = lastId;
    el.scrollTo({ top: el.scrollHeight, behavior: isMessageBoundary ? 'smooth' : 'auto' });
  }, [currentMessages, streamingContent]);

  const handleSend = async (content: string) => {
    const startConv = async (): Promise<string> => {
      if (conversationId) return conversationId;
      const id = await store.createConversation();
      onNewConversation?.(id);
      return id;
    };
    if (currentMode === 'deep-research') {
      const convId = await startConv();
      setEditContent(null);
      store.startDeepResearch(convId, content);
      return;
    }
    const convId = await startConv();
    setEditContent(null);
    store.sendMessage(convId, content, currentMode, currentModel);
  };

  const currentModelName = currentModel === 'auto' ? '自动选择' : (getModelDisplayName(currentModel) || currentModel);
  const thinkLabel = currentMode === 'fast' ? '快速' : currentMode === 'think' ? '思考' : '标准';

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <CapsuleBar
        modelLabel={currentModelName}
        thinkLabel={thinkLabel}
        onOpenModelSelector={() => setModelSelectorOpen(true)}
        onOpenSidebar={() => window.dispatchEvent(new CustomEvent('open-chat-sidebar'))}
        onOpenSearch={() => { setSearchQuery(''); setSearchIndex(0); setSearchOpen(true); }}
        tier={tier}
        creditBalance={user?.creditBalance ?? creditBalance}
        conversationId={conversationId}
        onOpenWorkspace={() => setWorkspaceOpen(true)}
      />

      {searchOpen && conversationId && (
        <div className="absolute top-16 left-3 right-3 z-40 max-w-md">
          <div className="liquid-glass-strong rounded-card px-3 py-2.5 flex items-center gap-2 anim-fade-up">
            <span className="text-muted shrink-0 flex"><SearchIcon /></span>
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); jumpToMatch(searchIndex + (e.shiftKey ? -1 : 1)); }
                if (e.key === 'Escape') closeSearch();
              }}
              placeholder={tr('chat.findPh')}
              className="flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-muted/60"
            />
            {searchQuery.trim() ? (
              <>
                <span className="text-[11px] text-muted w-10 text-right shrink-0">{matchIds.length > 0 ? `${searchIndex + 1}/${matchIds.length}` : tr('chat.noResults')}</span>
                <button
                  onClick={() => jumpToMatch(searchIndex - 1)}
                  disabled={matchIds.length === 0}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-primary hover:bg-surface-hover disabled:opacity-30 transition-colors"
                  title="上一个"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                </button>
                <button
                  onClick={() => jumpToMatch(searchIndex + 1)}
                  disabled={matchIds.length === 0}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-primary hover:bg-surface-hover disabled:opacity-30 transition-colors"
                  title="下一个"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
              </>
            ) : null}
            <button onClick={closeSearch} className="text-muted hover:text-primary text-xs anim-press shrink-0">✕</button>
          </div>
        </div>
      )}

      {modelSelectorOpen && (
        <Suspense fallback={<div className="w-64 h-full bg-surface/90 absolute top-0 right-0 z-50 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin" />
        </div>}>
          <ModelSelector onClose={() => setModelSelectorOpen(false)} thinkOnly={!isProTier} />
        </Suspense>
      )}


      {modelSwitchNotice && (
        <div className="px-4 py-2 bg-warning/10 border-b border-warning/20 text-warning text-xs flex items-center justify-between anim-slide-down mt-14">
          <span>{modelSwitchNotice}</span>
          <button onClick={store.clearModelSwitch} className="text-warning hover:text-warning/70 anim-press">✕</button>
        </div>
      )}

      {/* ===== 上下文压缩提示 =====
          只在服务端报告真实压缩任务时出现（绑定 taskId），不伪造状态。
          文案一律用服务端下发的 contextCompression.text —— 前端不定义、
          不改写、不补充说明，保证 Chat 与 Agent 两侧表述一致。
          黑白极简：不用彩色语义色，压缩是中性过程而非警告/成功。 */}
      {contextCompression && (
        <div
          role="status"
          aria-live="polite"
          className="px-4 py-2 bg-foreground/5 border-b border-foreground/10 text-muted text-xs flex items-center gap-2 anim-slide-down mt-14"
        >
          <span className="w-3 h-3 border border-foreground/40 border-t-transparent rounded-full anim-spin shrink-0" aria-hidden="true" />
          <span>{contextCompression.text}</span>
        </div>
      )}

      {!conversationId ? (
        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md px-4 anim-fade-up">
              <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center anim-float">
                <span className="text-3xl font-display font-bold text-accent-figure">C</span>
              </div>
              <h2 className="text-2xl font-display font-bold text-primary mb-2 anim-fade-up anim-delay-1">欢迎使用 OmniTask</h2>
              <p className="text-muted text-sm leading-relaxed mb-6 anim-fade-up anim-delay-2">OmniTask，为你而生</p>
            </div>
          </div>
          <MessageInput onSend={handleSend} isLoading={isStreaming} onStop={store.stopGeneration} />
          <Toast message={toastMessage} onDismiss={store.clearError} canBuyCredits={isProTier} />
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-16 space-y-6" ref={scrollContainerRef} onScroll={handleScrollTrack}>
            {isLoadingMessages ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin" />
              </div>
            ) : (
              <>
                {researchProgress && (
                  <div className="liquid-glass p-4 mx-0 mb-4 anim-fade-up">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-primary font-medium">🔬 深度研究</span>
                      <span className="text-xs text-muted">{researchProgress.percent}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-surface rounded-full mb-2">
                      <div className="h-full bg-accent rounded-full transition-all duration-700"
                        style={{ width: `${researchProgress.percent}%`, transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }} />
                    </div>
                    <div className="text-xs text-muted">{researchProgress.message}</div>
                    {researchProgress.outline && (
                      <div className="mt-2 space-y-1">
                        {researchProgress.outline.map((item: string, i: number) => (
                          <div key={i} className="text-xs text-muted flex items-center gap-2">
                            <span className="text-accent">•</span> {item}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 历史压缩分隔条（任务书 14.3 末条 / 12.4）：
                    storage 压缩会真正删除已被摘要覆盖的原始消息。若不加任何
                    提示，用户来回滚动会看到对话从中间开始，无法区分
                    "消息丢了"与"历史已压缩"。这里渲染成中性分隔线，
                    不用气泡、不用角色样式，避免被误认为模型回复。 */}
                {/* 会话历史按需取：滚动到边缘会自动加载，这里保留一个手动
                    兜底入口 —— 键盘用户、或自动加载因并发/异常未触发时用。
                    正常用滚动就够了，两者取同一套游标，不会重复取。 */}
                {(hasMoreOlder || hasMoreNewer) && (
                  <div className="flex items-center justify-center py-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (hasMoreOlder) store.loadOlderMessages(conversationId!);
                        else if (hasMoreNewer) store.loadNewerMessages(conversationId!);
                      }}
                      disabled={isLoadingOlder || isLoadingNewer}
                      className="text-xs text-muted hover:text-accent transition-colors
                                 disabled:opacity-50 disabled:cursor-not-allowed
                                 flex items-center gap-2 px-3 py-1.5 rounded-full
                                 border border-foreground/10 hover:border-accent/40"
                    >
                      {(isLoadingOlder || isLoadingNewer) ? (
                        <>
                          <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full anim-spin" />
                          正在加载…
                        </>
                      ) : hasMoreOlder ? (
                        '↑ 加载更早的历史'
                      ) : (
                        '↓ 加载更新的历史'
                      )}
                    </button>
                  </div>
                )}
                {currentMessages.map((msg, i) => (
                  <div key={msg.id} id={`msg-${msg.id}`}>
                    {msg.messageType === 'compressed_history' && (
                      <div className="my-3 flex items-center gap-3 anim-fade-up" role="separator">
                        <span className="h-px flex-1 bg-foreground/10" aria-hidden="true" />
                        <span className="text-[11px] text-muted shrink-0">{msg.content}</span>
                        <span className="h-px flex-1 bg-foreground/10" aria-hidden="true" />
                      </div>
                    )}
                    {msg.messageType !== 'compressed_history' && <MessageBubble
                      message={msg}
                      isLast={i === currentMessages.length - 1 && !isStreaming}
                      onSaveToWorkspace={() => onSaveMessageToWorkspace(msg.id)}
                      onCopy={(c) => { navigator.clipboard.writeText(c); store.showToast('已复制'); }}
                      onEdit={(c) => setEditContent(c)}
                      onRetry={() => conversationId && store.retryMessage(conversationId)}
                    />}
                  </div>
                ))}

                {isStreaming && queueStatus?.inQueue && (
                  <div className="flex gap-3 anim-fade-up">
                    <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent flex items-center justify-center text-sm font-bold">⏱️</div>
                    <div className="liquid-glass px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-primary font-medium">服务器繁忙排队中</span>
                        <span className="text-xs text-accent">第 {queueStatus.position} 位</span>
                        <span className="text-xs text-muted">预计等待 {queueStatus.estimatedWaitSeconds}s</span>
                      </div>
                      <div className="w-full h-1 bg-surface-hover rounded-full mt-2 overflow-hidden">
                        <div className="h-full bg-accent anim-pulse-soft rounded-full" style={{ width: '100%' }} />
                      </div>
                    </div>
                  </div>
                )}

                {isStreaming && streamingContent && (
                  <MessageBubble
                    message={{ id: 'streaming', role: 'assistant', content: streamingContent, messageType: currentMode === 'deep-research' ? 'research' : 'text', createdAt: new Date().toISOString() }}
                    isStreaming
                  />
                )}

                {isStreaming && !streamingContent && !researchProgress && (
                  <div className="flex flex-col items-start anim-fade-up">
                    <div className="chat-model-text">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs chat-meta-model anim-pulse-soft">{currentModelName || 'AI 正在思考'}</span>
                        <div className="flex gap-1">
                          <div className="w-1.5 h-1.5 bg-accent rounded-full anim-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-1.5 h-1.5 bg-accent rounded-full anim-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-1.5 h-1.5 bg-accent rounded-full anim-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!isLoadingMessages && currentMessages.length === 0 && !isStreaming && (
                  <div className="text-center py-16 anim-fade-up">
                    <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-2xl">💬</div>
                    <p className="text-sm text-primary font-medium mb-1">这里还没有消息</p>
                    <p className="text-xs text-muted">从下方输入一句话开始对话。</p>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          <MessageInput onSend={handleSend} isLoading={isStreaming} initialContent={editContent || undefined} onStop={store.stopGeneration} />
          <Toast message={toastMessage} onDismiss={store.clearError} canBuyCredits={isProTier} />
        </div>
      )}

      {/* 文件工作台抽屉：创建/读取/修改/多文件/目录/ZIP 下载 */}
      {workspaceOpen && (
        <div className="absolute inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setWorkspaceOpen(false)} />
          <div className="relative h-full">
            <FileWorkspace
              conversationId={conversationId}
              open={workspaceOpen}
              onClose={() => setWorkspaceOpen(false)}
              extractTarget={extractTarget}
              onToast={(m) => store.showToast(m)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Toast({ message, onDismiss, canBuyCredits }: { message: string | null; onDismiss: () => void; canBuyCredits: boolean }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 anim-fade-up">
      <div className="liquid-glass-strong px-4 py-3 flex items-center gap-3 max-w-sm">
        <span className="text-sm text-primary">{message}</span>
        {canBuyCredits && message.includes('积分') && (
          <button
            onClick={() => window.location.href = '/pricing'}
            className="text-xs px-3 py-1 rounded-capsule bg-accent/20 text-accent hover:bg-accent/30 transition-colors whitespace-nowrap"
          >
            购买积分
          </button>
        )}
        <button onClick={onDismiss} className="text-muted hover:text-primary text-xs">✕</button>
      </div>
    </div>
  );
}

// ================================================================
// Top capsule bar（图 3 布局）:
//   [☰ 侧边栏] [模型/思考等级 胶囊]        [⋮ 菜单]
//  - ☰ 汉堡：点击滑出左侧边栏（对话列表 / 功能入口 / 设置）；
//   胶囊：Pro 显示「模型 + 思考等级」；免费版只显示思考等级；
//  ⋮ 菜单：顶部为升级入口（与菜单背景反色）+
//     会话操作（分享 / 置顶 / 添加到项目 / 在聊天中查找 / 删除）；
//     新对话页（无会话）则为应用级入口（主题切换 / 设置）。
//   菜单用 portal + fixed 定位渲染，不参与父容器布局。
//   应用级入口（设置 / 工具 / 后台管理 / 退出）已移至侧边栏。
// ================================================================
function CapsuleBar({
  modelLabel,
  onOpenModelSelector, onOpenSidebar, onOpenSearch,
  thinkLabel, tier, creditBalance,
  conversationId,
  onOpenWorkspace,
}: {
  modelLabel: string;
  onOpenModelSelector: () => void;
  onOpenSidebar: () => void;
  onOpenSearch: () => void;
  thinkLabel: string;
  tier: string;
  creditBalance: number;
  conversationId: string | null;
  onOpenWorkspace?: () => void;
}) {
  // Agent 模式：默认 'chat'（用户不切就保持普通对话）。
  // 目前只驱动下方 ⋮ 菜单里那个合并组件的视觉态，**尚未接入请求路径** ——
  // 接入前必须先定「哪些计算真正下沉到前端」（见 computePlacement.ts 的
  // R1-R4 规则：调 LLM / 向量 / 计费 / 审计都必须留服务端）。
  const [agentMode, setAgentMode] = useState<'chat' | 'agent'>('chat');
  const toggleAgentMode = () => setAgentMode((m) => (m === 'chat' ? 'agent' : 'chat'));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const router = useRouter();
  const { conversations, togglePin, deleteConversation, showToast } = useChatStore();
  const { appearance, setAppearance } = useSettingsStore();
  const tr = useT();
  const isPro = tier === 'PRO' || tier === 'ULTRA';

  const currentConv = conversationId ? conversations.find((c: any) => c.id === conversationId) : undefined;
  const isPinned = currentConv?.isPinned ?? false;

  const closeMenuAnd = (fn: () => void) => { fn(); setMenuOpen(false); };

  const handleShare = async () => {
    if (!conversationId) return;
    const url = `${window.location.origin}/chat/${conversationId}`;
    try {
      if (navigator.share) await navigator.share({ title: 'OmniTask', url });
      else { await navigator.clipboard.writeText(url); showToast(tr('chat.linkCopied')); }
    } catch { /* 用户取消分享 */ }
    setMenuOpen(false);
  };

  const handlePin = () => {
    if (!conversationId) return;
    togglePin(conversationId, isPinned);
    showToast(isPinned ? tr('chat.unpinnedToast') : tr('chat.pinnedToast'));
    setMenuOpen(false);
  };

  const handleDelete = () => {
    if (!conversationId) return;
    if (confirm(tr('side.deleteConfirm'))) {
      deleteConversation(conversationId);
      setMenuOpen(false);
      router.push('/chat');
    }
  };

  const handleComingSoon = (label: string) => {
    showToast(`${label}开发中，敬请期待`);
    setMenuOpen(false);
  };

  const convActions: { icon: JSX.Element; label: string; danger?: boolean; onClick: () => void }[] = [];
  if (conversationId) {
    convActions.push(
      { icon: <ShareIcon />, label: tr('chat.share'), onClick: handleShare },
      { icon: <PinIcon />, label: isPinned ? tr('chat.unpin') : tr('chat.pin'), onClick: handlePin },
      { icon: <FolderPlusIcon />, label: tr('chat.addToProject'), onClick: () => handleComingSoon(tr('chat.addToProject')) },
      { icon: <FileWorkspaceIcon />, label: '文件工作台', onClick: () => { onOpenWorkspace?.(); setMenuOpen(false); } },
      { icon: <SearchIcon />, label: tr('chat.findInChat'), onClick: () => { onOpenSearch(); setMenuOpen(false); } },
      { icon: <TrashIcon />, label: tr('chat.delete'), danger: true, onClick: handleDelete },
    );
  }

  // 新对话页（无会话）：会话操作无从谈起，菜单放应用级入口
  const appActions: { icon: JSX.Element; label: string; danger?: boolean; onClick: () => void }[] = [];
  if (!conversationId) {
    appActions.push(
      {
        icon: <ThemeIcon />,
        label: appearance === 'dark' ? tr('chat.themeLight') : tr('chat.themeDark'),
        onClick: () => { setAppearance(appearance === 'dark' ? 'light' : 'dark'); setMenuOpen(false); },
      },
      { icon: <SettingsIcon />, label: tr('chat.settings'), onClick: () => closeMenuAnd(() => router.push('/settings')) },
    );
  }
  const menuItems = conversationId ? convActions : appActions;

  // 菜单位置由按钮矩形算出并固定定位：菜单不再参与父容器布局，也不会被祖先裁切
  const openMenu = () => {
    const btn = menuBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const MARGIN = 12;
    const GAP = 8;
    // 估算面板高度（升级格子 + 条目），仅用于决定向上还是向下展开
    const estimated = 20 + 56 + (menuItems.length + 1) * 41;
    const spaceBelow = window.innerHeight - r.bottom - GAP - MARGIN;
    const spaceAbove = r.top - GAP - MARGIN;
    const openUp = estimated > spaceBelow && spaceAbove > spaceBelow;
    setMenuStyle({
      // 显式写 position：.liquid-glass-strong 自带 position:relative，会盖掉 Tailwind 的 fixed
      position: 'fixed',
      top: openUp ? Math.max(MARGIN, r.top - GAP - Math.min(estimated, spaceAbove)) : r.bottom + GAP,
      right: Math.max(MARGIN, window.innerWidth - r.right),
      maxHeight: Math.max(140, openUp ? spaceAbove : spaceBelow),
    });
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="absolute top-3 left-3 right-3 z-30 flex items-center gap-1.5">
      {/* 汉堡：滑出侧边栏 */}
      <button
        onClick={onOpenSidebar}
        className="w-11 h-11 flex items-center justify-center rounded-full bg-surface border border-border/60 shadow-md text-primary hover:border-accent/40 transition-all anim-press"
        title={tr('side.close')}
        aria-label={tr('side.close')}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round">
          <line x1="3" y1="7" x2="21" y2="7" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="17" x2="21" y2="17" />
        </svg>
      </button>

      {/* 胶囊：Pro = 模型 + 思考等级；免费版只显示思考等级（模型由后端自动选最快） */}
      <button
        onClick={onOpenModelSelector}
        className="flex items-center gap-1.5 px-3.5 min-h-[44px] rounded-capsule bg-surface border border-border/60 shadow-md text-xs font-medium text-primary hover:border-accent/40 transition-all max-w-[46vw] focus-ring"
        title={isPro ? tr('chat.modelSelect') : tr('chat.thinkLevel')}
      >
        <span className="truncate">
          {isPro ? (
            <>{modelLabel} <span className="text-muted/70 font-normal">{thinkLabel}</span></>
          ) : (
            <>{tr('chat.thinkLevel')} <span className="text-muted/70 font-normal">{thinkLabel}</span></>
          )}
        </span>
        <svg className="w-3 h-3 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* 右侧：⋮ 会话菜单 */}
      <div className="ml-auto flex items-center gap-1.5">
        <div className="relative">
          <button
            ref={menuBtnRef}
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
            className={`w-11 h-11 flex items-center justify-center rounded-full bg-surface border border-border/60 shadow-md text-primary hover:border-accent/40 transition-all anim-press focus-ring ${menuOpen ? 'border-accent/40' : ''}`}
            title={tr('chat.menu')}
            aria-label={tr('chat.menu')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01" />
            </svg>
          </button>
          {menuOpen && menuStyle && typeof document !== 'undefined' && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div
                role="menu"
                style={menuStyle}
                className="fixed z-50 w-56 liquid-glass-strong rounded-card overflow-y-auto anim-dropdown p-2.5"
              >
                {/* 模式与升级：**同一个组件的两个选项**（不是两个组件两个选项）。
                    · Pro 用户不显示「购买 Pro」，只剩「Agent 模式」单选项
                    · chat（默认）：Agent 格 = bg-surface/text-primary
                      → 浅色模式即白底黑字
                    · agent：Agent 格 = bg-primary/text-surface
                      → 与「购买 Pro」完全一致的反色组合，浅色模式即黑底白字
                    · 两态用同一对 token 互换，**天然保证字体与背景相反色**，
                      浅/深色模式下都不会出现字体消失
                    · 点击带弹性形变（anim-spring-toggle / anim-spring-elastic-in） */}
                <div key={agentMode} className="mb-2 rounded-xl overflow-hidden flex anim-spring-elastic-in">
                  {!isPro && (
                    <button
                      onClick={() => { closeMenuAnd(() => router.push('/pricing')); }}
                      className="flex-1 min-w-0 px-3.5 py-3 bg-primary text-surface flex items-center justify-between anim-press"
                      title={tr('chat.upgrade')}
                    >
                      <span className="text-sm font-semibold truncate">{tr('chat.upgrade')}</span>
                      <span className="text-[11px] opacity-70 shrink-0 ml-1.5">{tr('chat.upgradeShort')}</span>
                    </button>
                  )}
                  <button
                    role="menuitem"
                    aria-pressed={agentMode === 'agent'}
                    onClick={toggleAgentMode}
                    className={`flex-1 min-w-0 px-3.5 py-3 flex items-center justify-between anim-spring-toggle ${
                      agentMode === 'agent' ? 'bg-primary text-surface' : 'bg-surface text-primary'
                    } ${!isPro ? 'border-l border-border' : ''}`}
                    title={tr('chat.agentMode')}
                  >
                    <span className="text-sm font-semibold truncate">{tr('chat.agentMode')}</span>
                    <span className="text-[11px] opacity-70 shrink-0 ml-1.5">{agentMode === 'agent' ? tr('chat.agentOn') : tr('chat.agentOff')}</span>
                  </button>
                </div>
                {menuItems.length > 0 && (
                  <div className="space-y-0.5">
                    {menuItems.map((item) => (
                      <button
                        key={item.label}
                        role="menuitem"
                        onClick={item.onClick}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors ${item.danger ? 'text-error hover:bg-error/10' : 'text-primary hover:bg-surface-hover'}`}
                      >
                        <span className="w-5 flex justify-center text-current">{item.icon}</span>
                        <span className="flex-1 text-left truncate">{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>,
            document.body
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== ⋮ 菜单图标（顺序 / 样式同图 4） ====================
function ShareIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79A1 1 0 0 0 7 13.41v2.08c0 .32.16.63.44.8l1.54.91c.94.56.24 1.62.44 1.62h4.22c.2 0-.5-1.06.44-1.62l1.54-.91a1 1 0 0 0 .44-.8v-2.08a1 1 0 0 0-.89-.86A2 2 0 0 1 15 10.76V5H9z" />
    </svg>
  );
}
// ==================== 文件工作台图标 ====================
function FileWorkspaceIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M3 11h18" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <line x1="12" y1="10" x2="12" y2="14" /><line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function ThemeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
