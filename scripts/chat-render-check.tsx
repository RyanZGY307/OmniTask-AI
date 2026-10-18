// 渲染级验证：把 MessageBubble 真的渲染成 HTML，然后检查产出的 DOM。
// 这比 grep 源码强——它证明的是"浏览器里出现的东西"，不是"文件里写了什么"。
// 注意：项目 tsconfig 是 jsx: preserve（Next 默认），走的自动 runtime，
// 组件里没有 import React；这里手动把 React 挂到 globalThis 再 require 组件，
// 才能让"经典 runtime"的编译产物找到 React。
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
(globalThis as any).React = React;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MessageBubble = require('../src/components/MessageBubble').default;

/** 去掉标签后取纯文本——语法高亮会把代码拆成很多 span，直接的 includes 会假阴性。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail); }
}

const userMsg = {
  id: 'm1', role: 'user' as const, content: '帮我写个排序函数\n\n```ts title="src/sort.ts"\nconst s = [3,1,2];\n```',
  messageType: 'text', model: undefined, createdAt: '2026-10-18T10:00:00.000Z',
};
const modelMsg = {
  id: 'm2', role: 'assistant' as const, content: '当然，这是实现：\n\n```ts title="src/sort.ts"\nconst s = [3,1,2];\n```\n\n[源码](https://example.com)',
  messageType: 'text', model: 'agnes-2.5-flash', tokenCount: 120, creditsCost: 2,
  createdAt: '2026-10-18T10:00:05.000Z',
};

console.log('\n1. 用户消息渲染');
const userHtml = renderToStaticMarkup(
  React.createElement(MessageBubble, { message: userMsg } as any),
);
// 头像特征：w-8 h-8 rounded-lg 且内容是单个字母
check('用户消息旁没有头像', !/w-8 h-8 rounded-lg/.test(userHtml), userHtml.slice(0, 200));
check('用户气泡用 chat-user-bubble（反色实底）', userHtml.includes('chat-user-bubble'), 
  /class="[^"]*"/.exec(userHtml)?.[0] ?? '');
check('用户气泡不用原来的 bg-surface-hover 中性卡', !userHtml.includes('bg-surface-hover'));

console.log('\n2. 模型消息渲染');
const modelHtml = renderToStaticMarkup(
  React.createElement(MessageBubble, { message: modelMsg } as any),
);
check('模型消息旁没有头像', !/w-8 h-8 rounded-lg/.test(modelHtml), 'avatar still rendered');
check('模型输出用 chat-model-text（无框）', modelHtml.includes('chat-model-text'));
check('模型输出没有玻璃卡（glass-card-sm）', !modelHtml.includes('glass-card-sm'));
check('模型输出没有 rounded-2xl 的卡片容器', !modelHtml.includes('rounded-2xl px-4 py-3'));
check('模型名不再是胶囊框（chat-model-tag）', modelHtml.includes('chat-model-tag'));
check('模型名标签没有 border 的框', !/chat-model-tag[^"]*"[^>]*border/.test(modelHtml));
check('正文仍渲染出来', modelHtml.includes('当然') && stripTags(modelHtml).includes('const s'), stripTags(modelHtml).slice(0, 80));
check('代码块仍渲染（一等 Artifact 保留容器）', modelHtml.includes('code-block-wrapper'));
check('代码块头部显示模型声明的真实文件名', modelHtml.includes('src/sort.ts'), stripTags(modelHtml).slice(0, 160));
check('未声明文件名的代码块不显示假名字', (() => {
  const noName = renderToStaticMarkup(React.createElement(MessageBubble, {
    message: { ...modelMsg, id: 'm3', content: '```ts\nconst a = 1;\n```' },
  } as any));
  return !/opacity-80/.test(noName);
})());

console.log('\n3. 头像相关的视觉标识彻底移除');
check('渲染产物里没有单字母头像标记（C / U）', !/>\s*[CU]\s*</.test(userHtml) && !/>\s*[CU]\s*</.test(modelHtml));
check('渲染产物里没有 🔬 研究头像', !userHtml.includes('>🔬<') && !/>🔬</.test(modelHtml.replace(/chat-model-tag[^>]*>🔬/g, '')));

console.log('\n4. 时间戳与次级信息走反色类');
check('模型侧 meta 用 chat-meta-model', modelHtml.includes('chat-meta-model'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
