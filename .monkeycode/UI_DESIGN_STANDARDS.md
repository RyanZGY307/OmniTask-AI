# Cortex UI 设计准则（固化版）

来源（2026-09-27 抓取并本地化）：
- Leonxlnx/taste-skill（design-taste-frontend + redesign-existing-projects）
- multica-ai/andrej-karpathy-skills（行为准则：Think / Simplicity / Surgical / Goal-Driven）
- uiverse-io/galaxy、guillermolg00/morphicons、DietrichGebert/ponytail（风格参考）

## Design Read（本项目）
聊天产品（chat + 管理后台），目标用户为中文开发者/普通用户，移动端优先。
语言：Liquid Glass（玻璃拟态，现有资产，保留并修好）+ 克制动效 + 高密度但分层清晰。
风格定调（三档）：VARIANCE 6（不对称轻一点）/ MOTION 4（spring 物理，少而准）/ DENSITY 5（移动端信息多，靠层级不靠留白）。

## 硬性规则（每次 UI 改动自查）
1. 单一 accent（#3B82F6 系），禁止引入新紫/霓虹渐变；阴影要带底色 hue，禁止纯黑大阴影。
2. 圆角一套体系：容器 14-16 / 卡片 12 / 输入 8 / 胶囊按钮；全文档混用前先查这张表。
3. 卡片只在"高度表达层级"时使用，否则用 border-t / divide-y / 留白分组；玻璃组件底色 alpha 不低于 0.3。
4. 按钮必须有 hover / active 反馈（translateY(-1px) 或 scale(0.98)），文本对比度 WCAG AA（正文 4.5:1，大字 3:1）。
5. 动画只动 transform / opacity；持续动画必须有理由（状态指示/反馈），能静则静；尊重 prefers-reduced-motion。
6. 移动端视口一律 100dvh（已用于聊天布局）；表单 label 在上、错误在下；不用 placeholder 当 label。
7. 数字用 tabular-nums / 等宽（积分、token、用量）。
8. 主题全站锁定（跟随 settings.appearance），禁止页面中段反色；切换加 0.35s 颜色过渡（已加）。
9. 图标统一一套 stroke width（现在 2 / 1.5 混用，新增时就近跟随该组件已有值）。
10. 空状态 / 加载（骨架屏，形似最终布局）/ 错误（内联）三态都要有。

## Karpathy 行为准则（写代码时）
- 想清楚再动手：假设要明说，歧义先问；有更简方案就提出来。
- 极简优先：单用代码不加抽象层，不为假设需求做"可配置"。
- 外科手术式改动：只动任务相关行，不顺手重构相邻代码；自己产生的孤儿要清理。
- 目标驱动：每个修复先定义"怎么算修好"（视觉/交互验收点），改完对照验证。

## 参考仓库（需要时查）
- uiverse-io/galaxy：3000+ 玻璃拟态组件（CSS/Tailwind），按 Buttons/Cards/Inputs... 分类，可直接取用单个组件的 CSS。
- guillermolg00/morphicons：SVG 图标变形动画，适合替换生硬的 icon 切换（如发送/停止可做成变形动画）。
- DietrichGebert/ponytail：极简"懒人资深"风格——一行能解决的不写十行。

## 应用优先级（redesign 杠杆排序）
1. 字体/字号层级 → 2. 配色收敛 → 3. 交互状态（hover/active）→ 4. 布局与间距 → 5. 替换通用组件 → 6. 补全三态 → 7. 排版细节打磨。
