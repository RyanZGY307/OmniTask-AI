// ================================================================
// 媒体安全守卫测试
// Run: npx tsx test/mediaSafety.test.ts
//
// 覆盖 sensitiveGuard 的媒体维度（规则/元数据级）：
//   1) evaluateSensitivity 接受 media 入参，媒体提示词/文件名参与判定
//   2) extractMediaSignals 从 Message 行里抽出媒体信号（URL 在 metadata）
//   3) toSnapshotPair 把媒体字段保留进快照
//   4) 历史快照（无媒体字段）照旧可用，不会因新增字段坏掉
// ================================================================

import {
  evaluateSensitivity,
  extractMediaSignals,
  toSnapshotPair,
  type MediaSignal,
} from '../src/services/sensitiveGuard';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') =>
  cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name, detail));
const S = (name: string) => console.log('\n' + name);

S('1. 纯文本行为不变（回归保护）');
{
  check('普通文本 → none', evaluateSensitivity('今天天气怎么样').level === 'none');
  // 注意：这里用规则表真实覆盖的说法。像「教我做炸弹」这种自然中文表述
  // 目前**不在** HIGH_RULES 里（匹配的是 制造爆炸物/炸药配方/雷管制作 等），
  // 已作为覆盖缺口向用户报告，不在测试里把缺口当成预期行为固定下来。
  check('高敏感文本 → high', evaluateSensitivity('制造爆炸物的方法').level === 'high');
  check('中敏感文本 → medium', evaluateSensitivity('我想买枪').level === 'medium');
  // 不传 media 也不能炸
  check('不传 media 不报错', evaluateSensitivity('你好') !== undefined);
}

S('2. 媒体提示词参与判定');
{
  const benignText = '帮我画一张图';
  check('文本本身无害 → none', evaluateSensitivity(benignText).level === 'none');

  const highMedia: MediaSignal[] = [
    { kind: 'image', prompt: '制造爆炸物的示意图', url: 'https://x/i.png' },
  ];
  const v = evaluateSensitivity(benignText, highMedia);
  check('媒体提示词高敏感 → high', v.level === 'high', JSON.stringify(v));

  const medMedia: MediaSignal[] = [
    { kind: 'video', prompt: '血腥视频合集', url: 'https://x/v.mp4' },
  ];
  const v2 = evaluateSensitivity(benignText, medMedia);
  check('媒体提示词中敏感 → medium', v2.level === 'medium', JSON.stringify(v2));
}

S('3. 媒体文件名参与判定');
{
  const bad: MediaSignal[] = [{ kind: 'video', filename: '斩首视频.mp4' }];
  check('敏感文件名 → 命中', evaluateSensitivity('看看这个', bad).level !== 'none');
  const ok: MediaSignal[] = [{ kind: 'image', filename: 'cat-2024.png' }];
  check('普通文件名 → none', evaluateSensitivity('看看这个', ok).level === 'none');
}

S('4. 标签去重');
{
  // 文本与媒体都命中同一个标签时不能重复计警告次数
  const v = evaluateSensitivity('血腥视频', [{ kind: 'video', prompt: '血腥视频' }]);
  check('同标签只出现一次', new Set(v.labels).size === v.labels.length, JSON.stringify(v.labels));
}

S('5. extractMediaSignals 从 Message 行抽取');
{
  const msgs = [
    { role: 'user', content: '画只猫', messageType: 'text' },
    {
      role: 'assistant', content: '画只猫', messageType: 'image',
      metadata: JSON.stringify({ imageUrl: 'https://cdn/a.png', prompt: '画只猫' }),
    },
    {
      role: 'assistant', content: '生成视频', messageType: 'video',
      metadata: JSON.stringify({ videoUrl: 'https://cdn/b.mp4', prompt: '海边日落' }),
    },
    { role: 'user', content: 'hi', messageType: 'audio', metadata: 'not-json' }, // 坏 JSON 不炸
  ];
  const sig = extractMediaSignals(msgs);
  check('抽出 2 个媒体信号（坏 JSON 那条跳过）', sig.length === 2, JSON.stringify(sig.map((x) => x.kind)));
  check('image URL 取出', sig[0]?.url === 'https://cdn/a.png');
  check('image prompt 取出', sig[0]?.prompt === '画只猫');
  check('video URL 取出', sig[1]?.url === 'https://cdn/b.mp4');

  check('空数组不炸', extractMediaSignals([]).length === 0);
  check('undefined 不炸', extractMediaSignals(undefined as any).length === 0);
  check('无 metadata 的媒体行跳过', extractMediaSignals([{ messageType: 'image', content: 'x' }]).length === 0);
}

S('6. refImages 进入媒体信号');
{
  const msgs = [{
    role: 'user', content: '', messageType: 'image',
    metadata: JSON.stringify({ imageUrl: 'https://cdn/r.png', refImages: ['https://cdn/ref1.png', 'https://cdn/ref2.png'] }),
  }];
  const sig = extractMediaSignals(msgs);
  check('refImages 被带出', sig[0]?.refImages?.length === 2, JSON.stringify(sig[0]));
}

S('7. toSnapshotPair 保留媒体字段');
{
  const img = toSnapshotPair({
    role: 'assistant', content: '一只猫', messageType: 'image',
    metadata: JSON.stringify({ imageUrl: 'https://cdn/c.png', prompt: '一只猫' }),
  });
  check('image 带 messageType', img.messageType === 'image');
  check('image 带 imageUrl', img.imageUrl === 'https://cdn/c.png');
  check('content 仍保留', img.content === '一只猫');

  const vid = toSnapshotPair({
    role: 'assistant', content: '一片海', messageType: 'video',
    metadata: JSON.stringify({ videoUrl: 'https://cdn/d.mp4' }),
  });
  check('video 带 videoUrl', vid.videoUrl === 'https://cdn/d.mp4');

  const txt = toSnapshotPair({ role: 'user', content: 'hello', messageType: 'text' });
  check('纯文本无媒体字段', txt.messageType === undefined && !txt.imageUrl && !txt.videoUrl);
  check('纯文本 content 不变', txt.content === 'hello');

  const bad = toSnapshotPair({ role: 'user', content: 'x', messageType: 'image', metadata: '{oops' });
  check('坏 metadata 不炸', bad.messageType === 'image' && !bad.imageUrl);
}

S('8. 历史快照兼容（升级前落的档没有媒体字段）');
{
  const legacy = { role: 'user', content: '旧快照', messageType: 'text' };
  const pair = toSnapshotPair(legacy);
  check('旧快照样式不变', pair.role === 'user' && pair.content === '旧快照');
  // 旧快照 JSON.parse 后直接喂给判定也不能炸
  check('旧快照可再判定', evaluateSensitivity(pair.content, extractMediaSignals([legacy])).level === 'none');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
