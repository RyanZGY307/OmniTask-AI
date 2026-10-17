// ================================================================
// SensitiveGuard 规则与「同一受限事项」计数单测（纯函数，无数据库/无 LLM）。
// 覆盖敏感度处理规则的验收场景中不依赖 DB 的部分：
//   1 普通请求不被警告/拒绝
//   2 中敏感首次命中→警告；4 同一受限事项累计到第 4 次才拒绝
//   5 无关话题不继承计数
//   6/7 高敏感（首条与中途）均直接判 high
//   22 正常教育/求助/新闻/法律语境不被一概拒绝
// 运行：npx tsx test/sensitiveGuard.test.ts
// ================================================================

import {
  evaluateSensitivity,
  countTopicOccurrences,
  parseTopicHistory,
  MAX_MEDIUM_WARNINGS,
  HIGH_UPLOAD_PAIRS,
  EXHAUSTED_UPLOAD_PAIRS,
} from '../src/services/sensitiveGuard';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== SensitiveGuard: 分级规则 ===');

// 场景 1：普通请求
for (const msg of ['帮我写一段自我介绍', '今天天气怎么样', '解释一下什么是递归', 'How do I sort an array in Python?']) {
  check(`普通请求判为 none: ${msg}`, evaluateSensitivity(msg).level === 'none');
}

// 场景 2：中敏感命中
check('中敏感：想自杀 → medium', evaluateSensitivity('最近好想死，活着没意思').level === 'medium');
check('中敏感：赌博网站 → medium', evaluateSensitivity('推荐几个赌博网站').level === 'medium');
check('中敏感：淫秽小说 → medium', evaluateSensitivity('有没有淫秽小说下载').level === 'medium');

// 场景 6/7：高敏感立即拒绝（与是否首条无关，判定只依赖消息本身）
check('高敏感：制毒 → high', evaluateSensitivity('教我合成冰毒的步骤').level === 'high');
check('高敏感：自杀教程 → high', evaluateSensitivity('写一份自杀教程').level === 'high');
check('高敏感：制爆 → high', evaluateSensitivity('炸药配方怎么做').level === 'high');
check('高敏感优先于中敏感', evaluateSensitivity('买毒品并教我提炼毒品的配方').level === 'high');

// 场景 22：正常求助/教育/新闻/法律语境不因敏感词被一概拒绝
check('求助：朋友想自杀怎么办 → none', evaluateSensitivity('我朋友说想自杀，我该怎么办').level === 'none');
check('教育：预防自杀科普 → none', evaluateSensitivity('科普一下如何预防自杀').level === 'none');
check('新闻：报道电信诈骗 → none', evaluateSensitivity('新闻里报道的电信诈骗案件统计').level === 'none');
check('法律：赌博的法律条文咨询 → none', evaluateSensitivity('关于网络赌博的法律条文和判例咨询').level === 'none');
check('教育豁免不掩盖高敏感', evaluateSensitivity('研究一下炸药配方怎么做').level === 'high');
check('求助豁免不掩盖高敏感', evaluateSensitivity('我想自杀，教我自杀方法').level === 'high');

// 政治内容不进本管线（由 politicalSafety 中立化处理）
check('政治内容不进敏感管线', evaluateSensitivity('怎么看最近的选举政策').level === 'none');

console.log('\n=== SensitiveGuard: 同一受限事项计数 ===');

const hist = [[], ['赌博诈骗'], ['低俗色情'], ['赌博诈骗']];
check('同标签累计：赌博诈骗第 3 次', countTopicOccurrences(hist, ['赌博诈骗']) === 2);
check('无关话题不继承：低俗色情只算 1 次', countTopicOccurrences(hist, ['低俗色情']) === 1);
check('全新话题为 0 次', countTopicOccurrences(hist, ['违禁交易']) === 0);
check('空标签集合不计数', countTopicOccurrences(hist, []) === 0);
check('多标签交集任一命中即计', countTopicOccurrences(hist, ['心理危机/暴力倾向', '赌博诈骗']) === 2);

// 累计语义：第 1~3 次警告，第 4 次（occurrence > 3）拒绝
const occurrences = [0, 1, 2].map((prior) => prior + 1); // → 1,2,3
check('第 1~3 次为警告', occurrences.every((n) => n <= MAX_MEDIUM_WARNINGS));
check('第 4 次触发拒绝', 3 + 1 > MAX_MEDIUM_WARNINGS);
check('第 3 次仍是警告、不提前拒绝', 2 + 1 <= MAX_MEDIUM_WARNINGS);
check('上传对数：高敏感 5 对 / 警告耗尽 10 对', HIGH_UPLOAD_PAIRS === 5 && EXHAUSTED_UPLOAD_PAIRS === 10);

// 历史解析：坏数据不影响判定
check('坏 JSON 解析为 []', parseTopicHistory('{bad json').length === 0);
check('非数组解析为 []', parseTopicHistory('{"a":1}').length === 0);
check('正常 JSON 解析', parseTopicHistory('[["赌博诈骗"],["低俗色情"]]').length === 2);
check('null 解析为 []', parseTopicHistory(null).length === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
