// 量化验证"对话气泡体系"的三条硬规则在深/浅两套主题下的真实对比度。
// 这不是自我宣称成功：这里算的是 WCAG 2.1 对比度，用 globals.css 里的真实令牌值。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** 取某个选择器块里某个自定义属性的值（只读 :root / .dark 顶层声明）。 */
function tokensIn(selector: '.root' | '.dark'): Record<string, string> {
  const out: Record<string, string> = {};
  const blockRe = selector === '.root' ? /:root\s*\{([\s\S]*?)\n\}/ : /\.dark\s*\{([\s\S]*?)\n\}/;
  const block = blockRe.exec(css);
  if (!block) throw new Error(`selector ${selector} not found in globals.css`);
  for (const line of block[1].split('\n')) {
    const m = /(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function toRgb(input: string): [number, number, number] {
  const hex = input.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) return [0, 1, 2].map((i) => parseInt(short[1][i] + short[1][i], 16)) as [number, number, number];
  throw new Error(`cannot parse color: ${input}`);
}

/** WCAG 相对亮度 */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** 前景以 alpha 叠加到底色上（模拟 opacity 降级的文字） */
function over(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as [number, number, number];
}

let pass = 0;
let fail = 0;
function check(name: string, ratio: number, min: number) {
  const ok = ratio >= min;
  if (ok) pass++; else fail++;
  const label = ok ? 'PASS' : 'FAIL';
  console.log(`  [${label}] ${name} — ${ratio.toFixed(2)}:1 (需要 ≥ ${min}:1)`);
}

for (const theme of ['light', 'dark'] as const) {
  const t = tokensIn(theme === 'light' ? '.root' : '.dark');
  const bg = toRgb(t['--bg']);
  const accent = toRgb(t['--accent']);
  const onAccent = toRgb(t['--on-accent']);
  const textPrimary = toRgb(t['--text-primary']);
  console.log(`\n=== ${theme} ===`);

  // 规则 2：模型输出无框，正文直接落在页背景上。正文必须与页背景相反。
  check('模型正文 --text-primary 对页背景 --bg', contrast(textPrimary, bg), 7);
  // 规则 2 的次级信息：同一反色家族按 0.72 透明度降级（chat-meta-model）
  check('模型次级信息 0.72 透明度对页背景', contrast(over(textPrimary, bg, 0.72), bg), 4.5);
  // 规则 3：用户气泡 = 背景的反色，字 = 那块底的反色
  check('用户气泡底 --accent 与页背景 --bg 是相反色（互为高对比）', contrast(accent, bg), 7);
  check('用户气泡字 --on-accent 对气泡底 --accent', contrast(onAccent, accent), 7);
  check('用户气泡链接 --on-accent 对气泡底 --accent', contrast(onAccent, accent), 4.5);
  check('用户气泡次级信息 0.72 透明度对气泡底', contrast(over(onAccent, accent, 0.72), accent), 4.5);
  // 代码块自成表面
  const codeBg = toRgb(t['--code-bg']);
  check('代码块字 #e4e6ef 对 --code-bg', contrast([0xe4, 0xe6, 0xef], codeBg), 7);
}

// CSS 结构完整性：改动过的大文件括号必须平衡，且新类都真的定义了
const braces = { open: (css.match(/\{/g) || []).length, close: (css.match(/\}/g) || []).length };
check(`globals.css 大括号平衡 (${braces.open}/${braces.close})`, braces.open === braces.close ? 1 : 0, 1);

const required = ['.chat-user-bubble', '.chat-model-text', '.chat-alert', '.chat-model-tag',
  '.chat-meta-user', '.chat-meta-model', '.chat-user-bubble a'];
for (const cls of required) {
  const re = new RegExp(cls.replace('.', '\\.').replace(/\s+/g, '\\s+') + '\\s*(?:,|\\{)');
  const ok = re.test(css);
  if (ok) pass++; else fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${cls} 已在 globals.css 定义${ok ? '' : '（缺失！）'}`);
}

// 反向验证：气泡容器上不允许出现玻璃卡类（模型输出真的没有"对话框"）
const bubbleHasGlass = /\.chat-model-text\s*\{[^}]*glass-card/.test(css);
if (bubbleHasGlass) fail++; else pass++;
console.log(`  [${bubbleHasGlass ? 'FAIL' : 'PASS'}] .chat-model-text 不引用任何玻璃卡/背景`);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
