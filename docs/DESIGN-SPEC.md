# Cortex AI — 设计规范（Design Tokens）

## 色彩

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f8f9fc` | `#0a0a0c` | 页面底色 |
| `--surface` | `#ffffff` | `#111114` | 侧栏/次级面 |
| `--surface-hover` | `#f1f3f8` | `#1a1a1f` | 悬停态 |
| `--card` | `#ffffff` | `#141519` | 卡片/气泡面 |
| `--card-border` | `#e2e5ed` | `rgba(255,255,255,.09)` | 卡片描边（发丝） |
| `--border` | `#e2e5ed` | `#1e1e24` | 分隔线 |
| `--text-primary` | `#0a0a0c` | `#f0ece4` | 正文 |
| `--text-muted` | `#4b5563` | `#a8a29e` | 次要文字 |
| `--accent` | `#0a0a0c` | `#f0ece4` | 强调色 = 与背景相反（浅=近黑 / 深=暖白） |
| `--accent-hover` | `#2a2a30` | `#ffffff` | 强调色悬停 |
| `--accent-dim` | `#8b8b95` | `#6f6f78` | 弱化强调 |
| `--on-accent` | `#ffffff` | `#0a0a0c` | accent 填充面之上的文字 |
| `--code-bg` | `#1e1e24` | `#111114` | 代码块底 |

语义色：success `#22c55e` / error `#ef4444` / warning `#f59e0b`。

配色规则：颜色只承担语义（success/warning/error）与图表数据编码；界面强调不再靠色相，改用字重、对比与留白。所有 accent 填充面（按钮/头像/气泡）必须用 `--on-accent` 而非 `text-white`，否则反色后出现同色字。

字号：`--fs-caption 11` / `--fs-xs 12` / `--fs-sm 13` / `--fs-base 14` / `--fs-lg 16` / `--fs-xl 20` / `--fs-display 28`。工具类：`.caps-label`（小标题）、`.num`（等宽数字）、`.focus-ring`（焦点环）。

## 阴影与光效

- 浅色（极简投影 + 发丝描边）：`--card-shadow: 0 1px 2px rgba(16,24,40,.04), 0 4px 14px rgba(16,24,40,.06)`；大卡 `.05/.10`。
- 深色（发丝高光 + 柔和黑阴影，不再用白色背光）：`--card-shadow: 0 1px 0 rgba(255,255,255,.04), 0 8px 24px rgba(0,0,0,.5)`；大卡 `.05/.6`。
- 焦点：浅色 `0 0 0 3px rgba(10,10,12,.14)`；深色 `0 0 0 3px rgba(240,236,228,.18)`。

## 圆角

`DEFAULT 10` / `lg 14` / `xl 20` / `2xl 28` / `3xl 36` / `card 20` / `card-lg 32` / `hero 44` / `capsule 9999`。

## 字体

- display：Sora · body：DM Sans · mono：JetBrains Mono。

## 动效（克制：150–300ms）

- 时长令牌：`--dur-150/200/300`；过渡默认 200ms。
- 缓动：`ios-spring cubic-bezier(.34,1.56,.64,1)`、`ios-out (.22,1,.36,1)`、`expo (.16,1,.3,1)`。
- 保留：按压弹性、拖拽拉扯形变与回弹位移、圆角、柔和阴影。
- 入场：非线性 stagger —— 容器加 `.anim-stagger`（子项 0/40/80…ms 依次入场），单元素用 `.anim-fade-up` + `.anim-delay-1..5`（60–300ms 阶梯）。
- 移除：液态玻璃（`backdrop-filter`）、「组件效果设置」。

## 组件状态

- 悬停：面 `--surface-hover` + 上浮 2px；深色叠加 `--glow-focus`。
- 按压：缩小 2%；禁用：opacity 50%。
- 卡片类名保留 `glass-card*` / `liquid-glass*`（约束改动面），语义已改为「普通卡片」。

## 无障碍与响应式

- 正文对比度浅色 ≥ 12:1、深色 ≥ 13:1；交互元素 `--glow-focus` 焦点环。
- 断点：手机 375 / 平板 768 / 桌面 1280；容器 `max-w-*` + `px-4`。
- 触控目标至少 44×44px；移动端关闭的抽屉需从键盘顺序与可访问树隐藏，打开时恢复可访问。
- 切换控件使用 `role="switch"`、`aria-checked` 和可访问名称；设置项在深色/浅色均须核对对比度。
- 无来源的统计数据不得填入演示值；数据不存在时显示“—”或明确空态。
- 语义标签：标题 h1-h3、按钮 `<button>`、输入正确 `autocomplete`。

## 失败语义

- 401 只表示身份问题（未带凭证 / 凭证无效 / 账号停用）；前端仅在 401 时清除本地会话。
- 后端或数据库不可用返回 5xx（如 503），前端不得据此登出用户，应展示可重试的错误态。
- 每个数据库数据源显式声明连接上限（`connection_limit` / `pool_timeout`），连接池类瞬时错误必须可重试。
