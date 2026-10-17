import { create } from 'zustand';
import { apiGet, apiPost, apiPatch, apiDelete, getApiUrl } from '@/lib/api';

const API_URL = getApiUrl();

// 单次生成的 AbortController：stopGeneration() 通过它中止流式请求。
let activeStreamAbort: AbortController | null = null;

// 媒体确认卡片 metadata
export interface MediaConfirmMeta {
  kind: 'image-gen' | 'video-gen' | 'audio-gen' | 'office-gen';
  status: 'pending' | 'confirmed' | 'failed';
  prompt: string;
  params: {
    model?: string;
    ratio?: string;
    resolution?: string;
    seconds?: number;
    // audio-gen only
    format?: string;
    voiceDesign?: string;
    contentOverview?: string;
    spokenText?: string;
    styleInstruction?: string;
    voiceReferenceId?: string;
    voiceId?: string;
    // office-gen only
    artifactType?: string;
    pageOrSlideCount?: number;
    documentType?: string;
    audience?: string;
    style?: string;
    title?: string;
    sourceArtifactHint?: boolean;
    /** 引用/修改既有文件时后端解析出的真实 artifact id */
    sourceArtifactId?: string;
    operation?: string;
    targetRef?: { type: string; index?: number; name?: string };
  };
  resultMessageId?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageType: string;
  model?: string;
  mode?: string;
  metadata?: any;
  tokenCount?: number;
  creditsCost?: number;
  createdAt: string;
}

interface Conversation {
  id: string;
  title: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

interface ResearchProgress {
  stage: string;
  message: string;
  percent: number;
  outline?: string[];
}

interface QueueStatus {
  inQueue: boolean;
  position: number;
  totalInQueue: number;
  estimatedWaitSeconds: number;
}

interface ChatState {
  conversations: Conversation[];
  currentMessages: Message[];
  isLoadingMessages: boolean;
  isStreaming: boolean;
  streamingContent: string;
  currentMode: string;
  currentModel: string;
  modelSwitchNotice: string | null;
  creditBalance: number;
  lastCost: number;
  toastMessage: string | null;
  error: string | null;
  queueStatus: QueueStatus | null;
  researchProgress: ResearchProgress | null;
  autoModelPool: Record<string, boolean>;
  modeModelPreferences: Record<string, string>;
  modelPoolPanelOpen: boolean;
    currentImageModel: string;
    currentVideoModel: string;
    mediaConfirming: boolean;

    fetchConversations: () => Promise<void>;
    fetchMessages: (conversationId: string) => Promise<void>;
    createConversation: () => Promise<string>;
    deleteConversation: (id: string) => Promise<void>;
    togglePin: (id: string, isPinned: boolean) => Promise<void>;
    sendMessage: (conversationId: string, content: string, mode: string, model: string, signal?: AbortSignal) => Promise<void>;
    stopGeneration: () => void;
    startDeepResearch: (conversationId: string, topic: string) => Promise<void>;
    downloadCode: (messageId: string) => Promise<void>;
    retryMessage: (conversationId: string) => Promise<void>;
    confirmMedia: (confirmMessageId: string, params: Record<string, any>) => Promise<any>;
    confirmAudio: (confirmMessageId: string, params: Record<string, any>) => Promise<any>;
    confirmOffice: (confirmMessageId: string, params: Record<string, any>) => Promise<any>;
    convertOffice: (sourceArtifactId: string, targetFormat: string) => Promise<any>;
    pollVideoMessage: (messageId: string, onProgress?: (p: number | null) => void, onDone?: (url: string) => void, onFail?: () => void) => void;
  setMode: (mode: string) => void;
  setModel: (model: string) => void;
  clearModelSwitch: () => void;
  showToast: (message: string) => void;
  clearError: () => void;
  fetchAutoModelPool: () => Promise<void>;
  toggleAutoModel: (modelKey: string) => Promise<void>;
  setAutoModelPool: (pool: Record<string, boolean>) => Promise<void>;
  fetchModePreferences: () => Promise<void>;
  saveModePreference: (mode: string, model: string) => Promise<void>;
  clearModePreference: (mode: string) => Promise<void>;
   setModelPoolPanelOpen: (open: boolean) => void;
  setImageModel: (model: string) => void;
  setVideoModel: (model: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentMessages: [],
  isLoadingMessages: false,
  isStreaming: false,
  streamingContent: '',
  currentMode: 'standard',
  currentModel: 'auto',
  modelSwitchNotice: null,
  creditBalance: 0,
  lastCost: 0,
  toastMessage: null,
  error: null,
  queueStatus: null,
  researchProgress: null,
  autoModelPool: {},
  modeModelPreferences: {},
    modelPoolPanelOpen: false,
    currentImageModel: 'agnes-image-2.5-flash',
    currentVideoModel: 'agnes-video-2.5-flash',
    mediaConfirming: false,

  fetchConversations: async () => { try { const data = await apiGet('/chat/conversations'); set({ conversations: data.conversations }); } catch {} },
  fetchMessages: async (conversationId: string) => { set({ isLoadingMessages: true }); try { const data = await apiGet(`/chat/conversations/${conversationId}/messages`); set({ currentMessages: data.messages }); } catch {} finally { set({ isLoadingMessages: false }); } },
  createConversation: async () => { const data = await apiPost('/chat/conversations', {}); get().fetchConversations(); return data.conversation.id; },
  deleteConversation: async (id: string) => { try { await apiDelete(`/chat/conversations/${id}`); set({ conversations: get().conversations.filter(c => c.id !== id) }); } catch {} },
  togglePin: async (id: string, isPinned: boolean) => { try { await apiPatch(`/chat/conversations/${id}`, { isPinned: !isPinned }); get().fetchConversations(); } catch {} },

  sendMessage: async (conversationId: string, content: string, mode: string, model: string, signal?: AbortSignal) => {
    const ctrl = new AbortController();
    activeStreamAbort = ctrl;
    // 外部 signal 中止时转发到内部 controller
    const onExternalAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    set({ isStreaming: true, streamingContent: '', error: null, modelSwitchNotice: null });
    try {
      const token = localStorage.getItem('cortex_token');
      const res = await fetch(`${API_URL}/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content, mode, model }),
        signal,
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); set({ isStreaming: false, error: err.error || '发送失败' }); return; }
      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await res.json();
        if (data.type === 'media_confirm') {
          // 先显示用户消息占位，再刷新拉取确认卡片
          get().fetchMessages(conversationId);
          set({ isStreaming: false });
          return;
        }
        if (data.type === 'safety_refusal') {
          // 敏感内容拒答：刷新消息（已落拒答+标记），同步会话列表（新会话可能出现）
          get().fetchMessages(conversationId);
          get().fetchConversations();
          get().showToast(data?.refusalMessage?.content || '该内容涉及敏感话题，本次不予回答');
          set({ isStreaming: false });
          return;
        }
        if (data.type === 'image' || data.type === 'video' || data.type === 'tool') { get().fetchMessages(conversationId); set({ isStreaming: false }); return; }
      }
      const reader = res.body?.getReader();
      if (!reader) { set({ isStreaming: false }); return; }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) { reader.cancel().catch(() => {}); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === 'chunk' && parsed.content) {
              set({ streamingContent: get().streamingContent + parsed.content, queueStatus: null });
            }
            else if (parsed.type === 'queue') {
              if (parsed.status === 'queued') {
                set({ queueStatus: { inQueue: true, position: parsed.position, totalInQueue: parsed.totalInQueue, estimatedWaitSeconds: parsed.estimatedWaitSeconds } });
              } else if (parsed.status === 'processing') {
                set({ queueStatus: null });
              }
            }
            else if (parsed.type === 'queue_update') {
              set({ queueStatus: { inQueue: true, position: parsed.position, totalInQueue: parsed.totalInQueue, estimatedWaitSeconds: parsed.estimatedWaitSeconds } });
            }
            else if (parsed.type === 'model_switch') {
              const from = parsed.from || '原模型';
              const to = parsed.to || parsed.model || '备用模型';
              if (from === to) { set({ modelSwitchNotice: null }); return; }
              set({ modelSwitchNotice: `模型已切换：${from} → ${to}` });
              // auto-dismiss so the warning bar does not permanently occupy the top
              setTimeout(() => { if (get().modelSwitchNotice) set({ modelSwitchNotice: null }); }, 8000);
            }
            else if (parsed.type === 'model_queued') {
              set({ modelSwitchNotice: '该模型调用繁忙，已自动排队等待放行' });
              setTimeout(() => { if (get().modelSwitchNotice) set({ modelSwitchNotice: null }); }, 8000);
            }
            else if (parsed.type === 'model_throttled') {
              set({ modelSwitchNotice: parsed.status === 'blocked' ? '该模型当前暂不可用，请稍后再试或选择其他模型' : '该模型调用繁忙且排队超时，请稍后再试' });
              setTimeout(() => { if (get().modelSwitchNotice) set({ modelSwitchNotice: null }); }, 10000);
            }
            else if (parsed.type === 'credit_update') set({ creditBalance: parsed.balance, lastCost: parsed.cost });
            else if (parsed.type === 'credit_warning') set({ toastMessage: parsed.message });
            else if (parsed.type === 'done') get().fetchMessages(conversationId);
            else if (parsed.type === 'error') set({ error: parsed.content });
          } catch {}
        }
      }
    } catch (err: any) {
      // user-initiated stop: do not surface as an error
      if (ctrl.signal.aborted || err?.name === 'AbortError') { set({ streamingContent: '' }); return; }
      set({ error: err.message || '发送失败' });
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      activeStreamAbort = null;
      set({ isStreaming: false, streamingContent: '', queueStatus: null });
    }
  },

  stopGeneration: () => {
    activeStreamAbort?.abort();
  },

  startDeepResearch: async (conversationId: string, topic: string) => {
    set({ isStreaming: true, streamingContent: '', error: null, researchProgress: { stage: 'starting', message: '正在启动深度研究...', percent: 0 } });
    try {
      const token = localStorage.getItem('cortex_token');
      const res = await fetch(`${API_URL}/chat/deep-research`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ topic, conversationId }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); set({ isStreaming: false, error: err.error || '深度研究失败', researchProgress: null }); return; }
      const reader = res.body?.getReader();
      if (!reader) { set({ isStreaming: false, researchProgress: null }); return; }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const step = JSON.parse(line.slice(6));
            if (step.type === 'progress') set({ researchProgress: step.data });
            else if (step.type === 'plan') set({ researchProgress: { stage: 'plan', message: `研究计划：${step.data.subtopicCount} 个子主题`, percent: 10, outline: step.data.outline } });
            else if (step.type === 'subtopic_complete') set({ streamingContent: (get().streamingContent || '') + `\n\n## ${step.data.title}\n${step.data.findingsPreview}...` });
            else if (step.type === 'complete') set({ streamingContent: step.data.report });
            else if (step.type === 'done') get().fetchMessages(conversationId);
          } catch {}
        }
      }
    } catch (err: any) { set({ error: err.message || '深度研究失败' }); } finally { set({ isStreaming: false, streamingContent: '', researchProgress: null }); }
  },

  downloadCode: async (messageId: string) => {
    try {
      const token = localStorage.getItem('cortex_token');
      const res = await fetch(`${API_URL}/chat/download-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ messageId }) });
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="?(.+?)"?$/)?.[1] || 'code.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
    } catch (err: any) { set({ toastMessage: err.message || '下载失败' }); }
  },

  retryMessage: async (conversationId: string) => { try { await apiPost(`/chat/conversations/${conversationId}/retry`, {}); get().fetchMessages(conversationId); } catch {} },

  setMode: (mode: string) => {
    const prefs = get().modeModelPreferences;
    const pref = prefs[mode];
    set({ currentMode: mode, currentModel: pref || 'auto' });
  },
  setModel: (model: string) => set({ currentModel: model }),
  clearModelSwitch: () => set({ modelSwitchNotice: null }),
  showToast: (message: string) => { set({ toastMessage: message }); setTimeout(() => set({ toastMessage: null }), 3000); },
  clearError: () => set({ error: null, toastMessage: null }),

  // Auto model pool
  fetchAutoModelPool: async () => { try { const data = await apiGet('/settings/model-pool'); if (data.pool) set({ autoModelPool: data.pool }); } catch {} },
  toggleAutoModel: async (modelKey: string) => {
    const pool = { ...get().autoModelPool };
    pool[modelKey] = pool[modelKey] === false ? true : false;
    set({ autoModelPool: pool });
    try { await apiPost('/settings/model-pool', { pool }); } catch {}
  },
  setAutoModelPool: async (pool: Record<string, boolean>) => {
    set({ autoModelPool: pool });
    try { await apiPost('/settings/model-pool', { pool }); } catch {}
  },

  // Mode preferences
  fetchModePreferences: async () => { try { const data = await apiGet('/settings/mode-preferences'); if (data.preferences) set({ modeModelPreferences: data.preferences }); } catch {} },
  saveModePreference: async (mode: string, model: string) => {
    const prefs = { ...get().modeModelPreferences, [mode]: model };
    set({ modeModelPreferences: prefs });
    try { await apiPost('/settings/mode-preferences', { preferences: prefs }); } catch {}
  },
  clearModePreference: async (mode: string) => {
    const prefs = { ...get().modeModelPreferences };
    delete prefs[mode];
    set({ modeModelPreferences: prefs });
    try { await apiPost('/settings/mode-preferences', { preferences: prefs }); } catch {}
  },

    setModelPoolPanelOpen: (open: boolean) => set({ modelPoolPanelOpen: open }),
   setImageModel: (model: string) => set({ currentImageModel: model }),
   setVideoModel: (model: string) => set({ currentVideoModel: model }),

    // ===== Media confirm / video poll =====
    confirmMedia: async (confirmMessageId: string, params: Record<string, any>) => {
      set({ mediaConfirming: true, error: null });
      try {
        const data = await apiPost('/chat/media/confirm', { confirmMessageId, params });
        // 拉取最新消息（含确认卡片状态更新 + 结果消息），并返回给调用方用于轮询
        if (data.conversationId) get().fetchMessages(data.conversationId);
        set({ mediaConfirming: false });
        return data;
      } catch (err: any) {
        set({ mediaConfirming: false, error: err.message || '生成失败' });
        return null;
      }
    },
    confirmAudio: async (confirmMessageId: string, params: Record<string, any>) => {
      set({ mediaConfirming: true, error: null });
      try {
        const data = await apiPost('/chat/media/audio-generate', { confirmMessageId, params });
        // 同步生成：结果消息直接已落库。拉取最新消息 + 返回给调用方
        // 展示播放器 / 下载。失败时 data.ok === false + errorType。
        if (data.conversationId) get().fetchMessages(data.conversationId);
        set({ mediaConfirming: false });
        return data;
      } catch (err: any) {
        set({ mediaConfirming: false, error: err.message || '音频生成失败' });
        return null;
      }
    },
    confirmOffice: async (confirmMessageId: string, params: Record<string, any>) => {
      set({ mediaConfirming: true, error: null });
      try {
        const data = await apiPost('/chat/office/generate', { confirmMessageId, params });
        if (data.conversationId) get().fetchMessages(data.conversationId);
        set({ mediaConfirming: false });
        return data;
      } catch (err: any) {
        set({ mediaConfirming: false, error: err.message || '生成失败' });
        return null;
      }
    },
    convertOffice: async (sourceArtifactId: string, targetFormat: string) => {
      set({ mediaConfirming: true, error: null });
      try {
        const data = await apiPost('/chat/office/convert', { sourceArtifactId, targetFormat });
        set({ mediaConfirming: false });
        return data;
      } catch (err: any) {
        set({ mediaConfirming: false, error: err.message || '转换失败' });
        return null;
      }
    },
   pollVideoMessage: (messageId: string, onProgress?: (p: number | null) => void, onDone?: (url: string) => void, onFail?: () => void) => {
     const token = localStorage.getItem('cortex_token');
     const poll = async () => {
       try {
         const res = await fetch(`${API_URL}/chat/media/video/${messageId}`, { headers: { Authorization: `Bearer ${token}` } });
         if (!res.ok) { onFail?.(); return; }
         const data = await res.json();
         if (data.status === 'done') { onDone?.(data.url); return; }
         if (data.status === 'failed' || data.status === 'error') { onFail?.(); return; }
         onProgress?.(data.progress ?? null);
         setTimeout(poll, 1500);
       } catch { setTimeout(poll, 3000); }
     };
     setTimeout(poll, 1500);
   },
}));
