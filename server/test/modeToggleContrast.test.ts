// ================================================================
// Agent 模式切换组件 — 反色与结构守卫测试
// Run: npx tsx test/modeToggleContrast.test.ts
//
// 用户明确要求：「所有字体必须与背景为相反色，否则会出现字体消失的问题」。
// 这条要求不该只活在注释里 —— 本测试解析真实源码与 CSS 变量，
// 把下面三条变成可执行断言：
//   A. 两个状态用的是**互换的同一对 token**，不是各写一个颜色
//      （一旦有人改成 bg-white/text-cream 就会失败）
//   B. --surface / --text-primary 在 :root 与 .dark **都有定义**，
//      且浅色模式下确实是「白底 + 近黑字」的高对比组合
//   C. 侧边栏已无 Agent 入口；菜单内是「一个容器两个选项」而非两个组件
// ================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

const REPO = join(__dirname, '..', '..', 'client');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

/** 把 #rgb/#rrggbb 转成亮度（0-1，越大越亮）。 */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG 对比度。 */
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

S('A. 两态必须是互换的同一对 token');
{
  const src = read('src/components/ChatWindow.tsx');
  const line = src.split('\n').find((l) => l.includes('agentMode === \'agent\'') && l.includes('text-surface'));
  check('找到 Agent 格的状态三元表达式', !!line, String(line));
  if (line) {
    check('agent 态用 bg-primary/text-surface', line.includes('bg-primary text-surface'), line.trim());
    const elsePart = line.split('bg-primary text-surface')[1] ?? '';
    check('chat 态用 bg-surface/text-primary（同一对 token 互换）',
      elsePart.includes('bg-surface text-primary'), elsePart.trim());
    // 关键不变量：不得出现任何硬编码颜色（会绕过主题、在另一主题下失效）
    check('未硬编码具体颜色（如 bg-white/text-black）',
      !/\b(?:bg|text)-(?:white|black|cream|neutral-\d)\b/.test(line), line.trim());
  }
  // 「购买 Pro」按钮必须与 agent 态用同一组合（用户要求「与购买pro选项一致」）。
  // 不能按「同一行」判断：className 在 671 行、tr('chat.upgrade') 在 674 行，
  // 按行匹配会漏。改为先取「合并组件整块」再在块内检查组合 + 文案。
  const bs = src.indexOf('模式与升级');
  const be = src.indexOf('{menuItems.length > 0 && (', bs);
  const blk = src.slice(bs, be);
  const proOk = blk.includes('bg-primary text-surface') && blk.includes("tr('chat.upgrade')");
  check('购买 Pro 与 agent 态用同一颜色组合（bg-primary/text-surface）', proOk,
    blk.includes('bg-primary text-surface') ? '组合在，但文案不在块内' : '块内无该组合');
}

S('B. CSS 变量在两种主题下都定义且高对比');
{
  const css = read('src/app/globals.css');
  const blocks: Record<string, string> = {};
  for (const sel of [':root', '.dark']) {
    const i = css.indexOf(sel + ' {');
    if (i >= 0) {
      const j = css.indexOf('\n}', i);
      blocks[sel] = css.slice(i, j);
    }
  }
  check(':root 块存在', !!blocks[':root']);
  check('.dark 块存在', !!blocks['.dark']);

  const get = (block: string, v: string) => {
    const m = blocks[block]?.match(new RegExp(`--${v}:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  for (const sel of [':root', '.dark']) {
    for (const v of ['surface', 'text-primary']) {
      check(`${sel} 定义了 --${v}`, !!get(sel, v), String(get(sel, v)));
    }
  }

  // 浅色模式：即用户说的「背景为白色」
  const lightSurface = get(':root', 'surface');
  const lightText = get(':root', 'text-primary');
  check('浅色 --surface 是纯白 #ffffff', lightSurface === '#ffffff', String(lightSurface));
  const cLight = contrast(lightSurface!, lightText!);
  check(`浅色 chat 态对比度 ${cLight.toFixed(1)}:1 >= 4.5（WCAG AA）`, cLight >= 4.5, `${cLight}`);

  const darkSurface = get('.dark', 'surface');
  const darkText = get('.dark', 'text-primary');
  check('深色 --surface 不是白色（避免深色模式白底）', darkSurface !== '#ffffff', String(darkSurface));
  const cDark = contrast(darkSurface!, darkText!);
  check(`深色 chat 态对比度 ${cDark.toFixed(1)}:1 >= 4.5`, cDark >= 4.5, `${cDark}`);

  // agent 态 = bg-primary/text-surface，是上面两个值的互换 → 对比度必然相同
  const pLight = get(':root', 'text-primary'), sLight = get(':root', 'surface');
  check('agent 态与 chat 态对比度相同（token 互换的必然结果）',
    Math.abs(contrast(pLight!, sLight!) - cLight) < 1e-9);
  // 「字体消失」判定阈值：低于 1.5 基本不可读
  check('两态对比度均远高于 1.5 的安全下限', cLight > 1.5 && cDark > 1.5, `light=${cLight} dark=${cDark}`);

  // 弹性动画必须真的存在
  check('定义了 anim-spring-toggle', /\.anim-spring-toggle\s*\{/.test(css));
  check('定义了 modeSpringIn keyframes', /@keyframes\s+modeSpringIn/.test(css));
  check('弹性曲线用了 --ease-ios-elastic（真实过冲回弹）',
    /--ease-ios-elastic/.test(css) && /anim-spring-toggle[\s\S]{0,200}--ease-ios-elastic/.test(css));
  check('anim-spring-toggle 有 :active 按压形变', /\.anim-spring-toggle:active/.test(css));
}

S('C. 结构：侧边栏已删 / 菜单内是一个容器两个选项');
{
  const side = read('src/components/Sidebar.tsx');
  check('侧边栏不再注册 agent 功能入口',
    !/features\.push\(\{\s*key:\s*'agent'/.test(side), '仍存在 agent 入项');
  check('侧边栏不再引用 t(\'side.agent\')', !side.includes("t('side.agent')"));
  check('侧边栏 handleAgent 已移除', !side.includes('handleAgent'));

  const cw = read('src/components/ChatWindow.tsx');
  // 一个容器、内含两个 button（Pro 隐藏时为一个）
  // 终点必须是 JSX 里那个 '{menuItems.length > 0 && ('（menuItems.length 在
  // 估算菜单高度的代码 581 行也出现过，用它当终点会得到空切片）
  const seg = cw.slice(cw.indexOf('模式与升级'), cw.indexOf('{menuItems.length > 0 && ('));
  const btnCount = (seg.match(/<button/g) || []).length;
  check('合并容器内恰有 2 个 button（购买 Pro + Agent 模式）', btnCount === 2, `实际 ${btnCount}`);
  check('Pro 用户隐藏购买 Pro（!isPro 条件渲染）', seg.includes('{!isPro && ('));
  check('默认状态为 chat（useState 初值）',
    /useState<'chat' \| 'agent'>\('chat'\)/.test(cw), '初值不是 chat');
  check('agentMode 状态在 CapsuleBar 内（渲染菜单的组件）',
    (() => {
      const barStart = cw.indexOf('function CapsuleBar(');
      const menuStart = cw.indexOf('模式与升级');
      const decl = cw.indexOf("useState<'chat' | 'agent'>('chat')");
      return barStart < decl && decl < menuStart;
    })());
}

S('D. i18n 键在全部语言包可解析');
{
  const out = readdirSync(join(REPO, 'src/lib/i18n/locales'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(REPO, 'src/lib/i18n/locales', f));
  let allOk = true;
  for (const f of out) {
    const s = readFileSync(f, 'utf8');
    for (const k of ['chat.agentMode', 'chat.agentOn', 'chat.agentOff']) {
      if (!s.includes(`'${k}'`)) { allOk = false; console.log(`     缺 ${f.split('/').pop()} → ${k}`); }
    }
  }
  check(`${out.length} 个语言包全部含三个新键`, allOk && out.length >= 30, `共 ${out.length} 个文件`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
