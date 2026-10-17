import { PROVIDER_BASE_URLS } from '../config';
import { callAgnes } from './scenarioWorkers/agnesCaller';

// ==================== Intent Analysis (Gemini) ====================

export interface MediaIntent {
  intent: 'general' | 'image-gen' | 'video-gen';
  prompt: string;
  params: {
    model?: string;
    ratio?: string;
    resolution?: string; // '1K' | '2K' | '3K' | '4K'
    seconds?: number; // video only
  };
}

const INTENT_SYSTEM_PROMPT = `你是媒体意图分析器。分析用户消息，判断是否要生成图片或视频，并整理生成提示词与参数。
只输出 JSON，不要解释。

图片提示词整理结构：
- 文生图：[主体] + [场景/环境] + [风格] + [光照] + [构图] + [质量要求] + [细节描述]
- 图生图：[改变要求] + [新风格/场景] + [需添加或移除的元素] + [需保留的元素]
- 多图合成：[参考图角色] + [目标场景] + [图像间关系] + [风格/光照/构图]
- 高信息密度图像：视觉层次（主要主体、背景环境、重要细节、风格、声音与结构约束）
视频提示词整理结构：
1.主体与场景 2.动作与变化 3.镜头语言 4.视觉风格 5.声音与节奏

参数提取规则（从用户话语中提取，未提及则省略该字段）：
- model: agnes-image-2.0-flash / agnes-image-2.1-flash / agnes-image-2.5-flash / agnes-video-2.5-flash
- ratio: 1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9（用户说"宽屏/横屏"默认16:9，"竖屏/手机"默认9:16，未提及则省略）
- resolution: 1K / 2K / 3K / 4K（用户说1080P视为1K；未提及则省略）
- seconds: 4 / 5 / 8 / 10 / 12（仅视频；用户说"几秒"时提取；未提及则省略）

JSON 格式：
{"intent":"image-gen","prompt":"...","params":{"model":"...","ratio":"...","resolution":"...","seconds":5}}
非媒体请求：{"intent":"general","prompt":"","params":{}}`;

async function callGemini(messages: { role: string; content: string }[]): Promise<string> {
  // Agnes-backed (migrated off Gemini): media-intent parsing uses Agnes 2.5-flash.
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
  return callAgnes(system, user, { model: 'agnes-2.5-flash', temperature: 0.2, maxTokens: 400 });
}

export async function analyzeMediaIntent(message: string, context?: string): Promise<MediaIntent> {
  const fallback: MediaIntent = { intent: 'general', prompt: '', params: {} };
  const userText = context ? `上下文：${context}\n\n用户：${message}` : message;
  // Fast pre-screening avoids a Gemini call for messages that cannot be
  // media generation requests (keeps latency low and avoids misfiring on
  // general "图片/视频" mentions like "如何剪辑视频").
  const MEDIA_TRIGGERS = ['生成', '创作', '绘制', '画一', '画个', '画幅', '画张', '来一', '来张', '来段', '做一', '做个', '做段', '做出', '设计一张', '设计一个', '设计一段', '设计', '画一画', 'make', 'create', 'generate', 'draw', 'design'];
  const hasMediaNoun = /图片|图像|相片|照片|视频|动画|gif|image|video|photo|picture|海报|插画|壁纸/i.test(userText);
  const hasTrigger = MEDIA_TRIGGERS.some((t) => userText.toLowerCase().includes(t.toLowerCase()));
  const preScreened = hasMediaNoun && hasTrigger;
  try {
    if (!preScreened) return fallback;
    const raw = await callGemini([
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.intent !== 'image-gen' && parsed.intent !== 'video-gen') return fallback;
    return {
      intent: parsed.intent,
      prompt: String(parsed.prompt || message),
      params: parsed.params || {},
    };
  } catch (err) {
    // Agnes 不可用时，只要预筛命中，仍按媒体意图处理：用默认参数走确认
    // 卡片流程（生成使用 agnes 图像/视频模型），避免图像请求被误路由到
    // 纯文本模型。
    if (preScreened) {
      const isVideo = /视频|动画|gif/i.test(userText);
      console.warn('[MediaIntent] Agnes unavailable, using pre-screened intent:', (err as Error).message);
      return { intent: isVideo ? 'video-gen' : 'image-gen', prompt: message, params: {} };
    }
    console.warn('[MediaIntent] analysis failed, fallback to general:', (err as Error).message);
    return fallback;
  }
}

// ==================== Image Generation ====================
// model: 'agnes-image-2.0-flash' | 'agnes-image-2.1-flash' | 'agnes-image-2.5-flash'
// size: '1K' | '2K' | '3K' | '4K'（1080P 映射为 1K）
// ratio: '1:1' | '3:4' | '4:3' | '16:9' | '9:16' | '2:3' | '3:2' | '21:9'

export function normalizeImageSize(input?: string): string {
  if (!input) return '1K';
  const s = String(input).toUpperCase();
  if (s.includes('4K') || s.includes('2160')) return '4K';
  if (s.includes('3K')) return '3K';
  if (s.includes('2K') || s.includes('1440')) return '2K';
  // 1080P / 1K / 未指定 → 1K
  return '1K';
}

export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const;
export const IMAGE_RESolutions = ['1K', '2K', '3K', '4K'] as const;

export interface ImageGenOptions {
  model?: string;
  ratio?: string;
  resolution?: string;
  images?: string[]; // 参考图 URL/dataURI，用于图生图与多图合成
  responseFormat?: 'url' | 'b64_json';
}

export async function generateImage(
  prompt: string,
  options: ImageGenOptions = {},
): Promise<{ url: string }> {
  const model = options.model || 'agnes-image-2.5-flash';
  const ratio = options.ratio && (IMAGE_RATIOS as readonly string[]).includes(options.ratio) ? options.ratio : undefined;
  // 有比例时按档位请求（1K/2K/3K/4K），无比例时退回 1:1 像素尺寸
  const res = normalizeImageSize(options.resolution);
  const pixelFallback: Record<string, string> = { '1K': '1024x1024', '2K': '2048x2048', '3K': '3072x3072', '4K': '4096x4096' };
  const size = ratio ? res : (pixelFallback[res] || '1024x1024');
  const body: Record<string, any> = { model, prompt, size };
  if (ratio) body.ratio = ratio;
  if (options.images?.length) body.extra_body = { ...body.extra_body, image: options.images };
  body.extra_body = { ...(body.extra_body || {}), response_format: options.responseFormat || 'url' };
  const result = await callWithKeyRotation('agnes', async (apiKey) => {
    return fetch(`${PROVIDER_BASE_URLS.agnes}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  });

  if (!result.ok) {
    const errText = await result.text().catch(() => '');
    throw new Error(`Image generation failed: ${result.status} ${errText.slice(0, 200)}`);
  }
  const data = result.body?.data?.[0];
  const url = data?.url || (data?.b64_json ? `data:image/png;base64,${data.b64_json}` : '');
  if (!url) throw new Error('Image generation returned no result');
  return { url };
}

// ==================== Video Generation ====================
// model: 'agnes-video-2.5-flash'
// size: '720P'；seconds: 4|5|8|10|12；aspect_ratio: 6 种比例

export const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const VIDEO_SECONDS = [4, 5, 8, 10, 12] as const;

export interface VideoGenOptions {
  model?: string;
  seconds?: number;
  aspectRatio?: string;
  mode?: 'text' | 'keyframe' | 'reference';
  firstFrame?: string;
  lastFrame?: string;
  images?: string[];
  audios?: string[];
}

export async function generateVideo(
  prompt: string,
  options: VideoGenOptions = {},
): Promise<{ taskId: string; videoId: string }> {
  const model = options.model || 'agnes-video-2.5-flash';
  const seconds = VIDEO_SECONDS.includes(options.seconds as any) ? options.seconds : 5;
  const aspectRatio = options.aspectRatio && (VIDEO_RATIOS as readonly string[]).includes(options.aspectRatio) ? options.aspectRatio : '16:9';
  const body: Record<string, any> = {
    model,
    prompt,
    seconds: String(seconds),
    mode: options.mode || 'text',
    size: '720P',
    aspect_ratio: aspectRatio,
  };
  if (options.mode === 'keyframe') {
    if (options.firstFrame) body.first_frame = options.firstFrame;
    if (options.lastFrame) body.last_frame = options.lastFrame;
  } else if (options.mode === 'reference') {
    if (options.images?.length) body.images = options.images.slice(0, 5);
    if (options.audios?.length) body.audios = options.audios.slice(0, 3);
  }
  const result = await callWithKeyRotation('agnes', async (apiKey) => {
    return fetch(`${PROVIDER_BASE_URLS.agnes}/video/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  });

  if (!result.ok) {
    const errText = await result.text().catch(() => '');
    throw new Error(`Video generation failed: ${result.status} ${errText.slice(0, 200)}`);
  }
  const taskId = result.body?.task_id || result.body?.id || '';
  const videoId = result.body?.video_id || taskId;
  if (!taskId && !videoId) throw new Error('Video task id missing');
  return { taskId: taskId || videoId, videoId };
}

// 轮询：推荐 video_id + model_name（agnesapi 端点，不带 /v1 前缀）
export async function checkVideo(videoId: string, model = 'agnes-video-2.5-flash'): Promise<{ status: string; url?: string; progress?: number }> {
  const result = await callWithKeyRotation('agnes', async (apiKey) => {
    const qs = `video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
    return fetch(`${PROVIDER_BASE_URLS.agnesRoot}/agnesapi?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  });

  if (!result.ok) return { status: 'error' };
  return {
    status: result.body?.status || 'processing',
    url: result.body?.url,
    progress: result.body?.progress,
  };
}

// Minimal key rotation helper — delegates to the shared pool
async function callWithKeyRotation(provider: string, fn: (apiKey: string) => Promise<any>): Promise<any> {
  const { getApiKey } = await import('./apiKeyPool');
  const apiKey = await getApiKey(provider);
  return fn(apiKey);
}
