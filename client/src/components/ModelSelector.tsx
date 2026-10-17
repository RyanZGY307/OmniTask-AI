'use client';
// ================================================================
// 模型选择面板（右滑窄面板）。按产品要求：
//   - 自动选择子系统已删除：无「自动」选项。
//   - 免费版（STANDARD）：后端自主决定 + 多供应商/API 轮询，用户仅选「思考等级」。
//   - Pro：手动选择。模型列表按厂商（ChatGPT/Claude/Gemini…）分组，
//     点开厂商才显示其可调用模型（后端去前缀显示名 + A→Z 排序 + 分页）。
// 模型/厂商数据来自 GET /api/models（admin 在 /admin/models 录入）。
// ================================================================

import { useState, useEffect, useMemo } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { getEffectiveTier, THINK_LEVELS } from '@/lib/models';
import { useModelCatalog } from '@/store/modelCatalog';
import { useT } from '@/lib/i18n';

export type ThinkLevel = 'fast' | 'standard' | 'thinking';

interface ModelRef {
  displayName: string;
  costPer1k?: number;
  provider?: string;
  vendor?: string;
  load?: 'ok' | 'hot' | 'busy' | 'blocked';
}

// 负载标签（与积分消耗并列显示）
function loadLabel(load?: string): { text: string; cls: string } | null {
  switch (load) {
    case 'blocked': return { text: '暂不可用', cls: 'text-error' };
    case 'busy': return { text: '需排队', cls: 'text-warning' };
    case 'hot': return { text: '调用量高', cls: 'text-warning/80' };
    default: return null;
  }
}

interface Props {
  onClose: () => void;
  /** 免费版：面板只提供思考等级选择（模型由后端自动选最快） */
  thinkOnly?: boolean;
}

function creditChip(costPer1k?: number): string {
  if (!costPer1k || costPer1k <= 0) return '';
  return `［${Math.round(costPer1k * 1000)}♦︎/1M token］`;
}

export default function ModelSelector({ onClose, thinkOnly = false }: Props) {
  const { user } = useAuthStore();
  const { currentModel, currentMode, setModel, setMode, showToast } = useChatStore();
  const catalog = useModelCatalog();
  const tr = useT();

  // 每次打开面板刷新一次实时目录（廉价、已合并）
  useEffect(() => { import('@/store/modelCatalog').then((m) => m.refreshModelCatalog()); }, []);

  // Pro：未选时自动落到具体模型；免费版保持 'auto'（自动选择）。
  useEffect(() => {
    const t = user ? getEffectiveTier(user) : 'STANDARD';
    const pro = t === 'PRO' || t === 'ULTRA';
    if (pro && catalog.loaded && currentModel === 'auto' && catalog.all.length > 0) {
      setModel(catalog.groups[0]?.defaultKey || catalog.all[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.loaded, catalog.all.length, user]);

  const tier = user ? getEffectiveTier(user) : 'STANDARD';
  const isPro = tier === 'PRO' || tier === 'ULTRA';

  // 显示名/积分查找：实时目录（admin 录入）为唯一来源
  const modelRef = useMemo(() => {
    const map: Record<string, ModelRef> = {};
    for (const m of catalog.all) {
      map[m.key] = { displayName: m.displayName, costPer1k: m.costPer1k, provider: m.provider, vendor: m.vendor, load: m.load };
    }
    return map;
  }, [catalog.all]);

  const groups = catalog.groups;
  const currentGroup = currentModel !== 'auto' && currentModel ? groups.find((g) => g.keys.includes(currentModel)) : undefined;
  const currentThink: ThinkLevel =
    currentMode === 'fast' ? 'fast' : currentMode === 'think' ? 'thinking' : 'standard';

  // 同一时刻只展开一个小卡片：某厂商 key 或 null
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const [thinkOpen, setThinkOpen] = useState(false);

  const openGroupFor = (vendor: string) => {
    setThinkOpen(false);
    setOpenTarget(openTarget === vendor ? null : vendor);
  };
  const pickModel = (key: string) => {
    setModel(key);
    setOpenTarget(null);
  };
  const pickThink = (level: ThinkLevel) => {
    setMode(level === 'thinking' ? 'think' : level);
    setThinkOpen(false);
  };

  const currentModelName =
    currentModel === 'auto' ? '自动' : modelRef[currentModel]?.displayName || currentModel;

  const cardGroup: any = groups.find((g) => g.vendor === openTarget) || currentGroup;

  return (
    <div
      className="absolute top-0 right-0 h-full w-[264px] max-w-[85vw] z-50 bg-surface/95 backdrop-blur-xl border-l border-border shadow-2xl flex flex-col anim-slide-in-right"
      style={{ animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={thinkOnly ? tr('chat.thinkLevel') : tr('chat.modelSelect')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <span className="text-sm font-medium text-primary">{thinkOnly ? tr('chat.thinkLevel') : tr('chat.modelSelect')}</span>
        <button onClick={onClose} className="text-muted hover:text-primary text-xs anim-press">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {!thinkOnly && (isPro ? (
          groups.length > 0 && (
            <>
              <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-primary">模型</div>
              {groups.map((g) => (
                <GroupBlock
                  key={g.vendor}
                  group={g}
                  open={openTarget === g.vendor}
                  onToggle={() => openGroupFor(g.vendor)}
                  onPickModel={pickModel}
                  modelRef={modelRef}
                  currentModel={currentModel}
                />
              ))}
            </>
          )
        ) : (
          <>
            <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-primary">模型</div>
            {/* 免费版：仅两个选项 —— 自动选择（默认，系统选最快模型）＋ 其他模型 [Pro] */}
            <button
              onClick={() => { pickModel('auto'); }}
              className={`w-full flex items-center px-3 py-2.5 rounded-card text-sm transition-all duration-200 ${currentModel === 'auto' ? 'bg-accent/10 text-accent' : 'text-primary hover:bg-surface-hover'}`}
            >
              <span className="flex-1 min-w-0 text-left truncate font-medium">{tr('chat.modelAuto')}</span>
              <span className="text-[10px] text-muted/70 shrink-0 mr-2">系统选最快模型</span>
              <CheckSlot>{currentModel === 'auto' && <Check />}</CheckSlot>
            </button>
            <button
              onClick={() => { showToast(tr('chat.upgradeUnlock')); }}
              className="w-full flex items-center px-3 py-2.5 rounded-card text-sm text-primary hover:bg-surface-hover transition-all duration-200"
            >
              <span className="flex-1 min-w-0 text-left truncate font-medium">{tr('chat.otherModels')}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-capsule bg-accent/15 text-accent font-semibold shrink-0 mr-2">Pro</span>
            </button>
          </>
        ))}

        {/* 思考等级 — 免费版亦可用 */}
        <ThinkLevelRow
          value={THINK_LEVELS.find((t) => t.key === currentThink)?.label ?? '标准'}
          open={thinkOpen}
          current={currentThink}
          onToggle={() => { setThinkOpen(!thinkOpen); setOpenTarget(null); }}
          onPick={pickThink}
        />
      </div>

      {/* footer note */}
      {isPro ? (
        <div className="px-4 py-2.5 border-t border-border/60 text-[10px] text-muted/70">
          Pro 版：手动选择模型 · 免费模型不耗积分，旗舰模型按 1M token 计积分
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-border/60 text-[10px] text-muted/70">
          {tr('chat.freeNote')}
        </div>
      )}
    </div>
  );
}

// ==================== 厂商分组行 ====================
function GroupBlock({
  group, open, onToggle, onPickModel, modelRef, currentModel,
}: {
  group: any; open: boolean; onToggle: () => void; onPickModel: (key: string) => void;
  modelRef: Record<string, ModelRef>; currentModel: string;
}) {
  const gl = loadLabel(group.load);
  const rows = group.models?.length
    ? group.models
    : (group.keys || []).map((k: string) => ({ key: k, displayName: modelRef[k]?.displayName || k, costPer1k: modelRef[k]?.costPer1k, load: modelRef[k]?.load }));
  return (
    <RowShell
      label={group.label}
      pill={<>
        <CostPill label={group.costLabel} />
        {gl && <span className={`ml-1 text-[10px] ${gl.cls}`}>{gl.text}</span>}
      </>}
      active={open}
      onClick={onToggle}
    >
      {open && (
        <div className="pt-1.5 pb-0.5 space-y-0.5">
          {rows.map((m: any) => {
            const key = m.key;
            const chip = creditChip(m.costPer1k);
            const ll = loadLabel(m.load ?? modelRef[key]?.load);
            const isCurrent = currentModel === key;
            return (
              <button
                key={key}
                onClick={(e) => { e.stopPropagation(); onPickModel(key); }}
                className={`w-full flex items-center px-3 py-2 rounded-card text-xs transition-all duration-200 ${
                  isCurrent ? 'bg-accent/10 text-accent' : 'text-muted hover:text-primary hover:bg-surface-hover'
                }`}
              >
                <span className="flex-1 min-w-0 text-left truncate font-medium">{m.displayName}</span>
                {ll && <span className={`text-[10px] shrink-0 mr-2 ${ll.cls}`}>{ll.text}</span>}
                {chip && <span className="text-[10px] text-muted/70 shrink-0 mr-2">{chip}</span>}
                <CheckSlot>{isCurrent && <Check />}</CheckSlot>
              </button>
            );
          })}
        </div>
      )}
    </RowShell>
  );
}

// ==================== 思考等级行 + 小卡片 ====================
function ThinkLevelRow({
  value, open, current, onToggle, onPick,
}: {
  value: string; open: boolean; current: ThinkLevel; onToggle: () => void; onPick: (level: ThinkLevel) => void;
}) {
  const tr = useT();
  return (
    <RowShell label={tr('chat.thinkLevel')} value={value} active={open} onClick={onToggle}>
      {open && (
        <div className="pt-1.5 pb-0.5 space-y-0.5">
          {THINK_LEVELS.map((t) => (
            <button
              key={t.key}
              onClick={(e) => { e.stopPropagation(); onPick(t.key as ThinkLevel); }}
              className={`w-full flex items-center px-3 py-2 rounded-card text-xs transition-all duration-200 ${
                current === t.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-primary hover:bg-surface-hover'
              }`}
            >
              <span className="flex-1 text-left font-medium">{t.label}</span>
              <CheckSlot>{current === t.key && <Check />}</CheckSlot>
            </button>
          ))}
        </div>
      )}
    </RowShell>
  );
}

// ==================== 行原语 ====================
function RowShell({ label, value, pill, active, onClick, children }: {
  label: string; value?: string; pill?: React.ReactNode; active?: boolean; onClick?: () => void; children?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-2 rounded-card transition-all duration-200 ${active ? 'bg-surface-hover/70' : 'hover:bg-surface-hover/60'}`}
    >
      <div className="flex items-center">
        <span className="flex-1 min-w-0 text-xs font-medium text-primary truncate">{label}</span>
        {value !== undefined && (
          <span className="text-[11px] text-muted/80 truncate max-w-[42%] shrink-0 text-right">{value}</span>
        )}
        {pill}
        <ChevronSlot up={active} />
      </div>
      {children}
    </button>
  );
}

function CostPill({ label }: { label: string }) {
  const free = label === '免费';
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-capsule shrink-0 ${free ? 'bg-success/10 text-success' : 'bg-accent/10 text-accent'}`}>
      {label}
    </span>
  );
}

function ChevronSlot({ up }: { up?: boolean }) {
  return (
    <span className="w-4 shrink-0 flex justify-end">
      <svg
        className={`h-3 w-3 text-muted transition-transform duration-300 ${up ? 'rotate-180' : ''}`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  );
}

function CheckSlot({ children }: { children?: React.ReactNode }) {
  return <span className="w-4 shrink-0 flex justify-end text-accent text-xs">{children}</span>;
}

function Check() {
  return <span>✓</span>;
}
