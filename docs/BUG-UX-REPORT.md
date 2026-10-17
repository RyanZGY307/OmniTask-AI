# Cortex AI — Bug/UX 报告（2026-10-10）

评测对象：`cortex-ai-omega-lemon.vercel.app`（= main 最新构建；用户提供的 `cortex-fb5v348oo` 等 5 个 `cortex-*-ryanzgy307` 域名均为**冻结的旧预览构建 + Vercel Authentication 登录墙**，无头浏览器无法通过，故以生产域名做等价走查，修复交付 main）。
测试账号：管理员账号（凭据不落库、不落日志）。

## 一、阻断/高优先级问题

### P0-1 深色模式对话文字「消失」
- **现象**：切深色模式后，助手气泡/卡片内的正文几乎不可见。
- **复现**：`/chat` → 发送任意消息 → 设置切深色 → 气泡内文字消失。
- **根因**：`.dark` 覆盖了 `--text-primary` 为浅色，但**从未覆盖 `--card` / `--card-border`**——而 `:root` 里的 `--card` 是深色 `#17181c`。于是暗色下卡片仍是深底、文字也是浅色应可见……真正问题是 `:root` 的卡片被错配成**深色卡 + 浓黑阴影**（本应属深色模式），导致：浅色模式下卡片是深底 + 黑字（等值问题），且 `--card` 语义混乱。`.markdown-content` 也没有任何颜色声明，正文继承链在主题切换时不稳定。
- **修复**：`:root` 卡片改回**白卡 + 柔和投影**（浅色语义）；`.dark` 明确 `--card:#17181c` / `--card-border:#26272e` + 柔光背光；`.markdown-content` 显式 `color: var(--text-primary)`，并补代码块/列表/标题配色。

### P1-1 积分显示不一致（菜单显示 0，抽屉显示 1234）
- **根因**：菜单用 `chatStore.creditBalance`（会话内累计，初始 0），抽屉用 `user.creditBalance`（1234）。
- **修复**：统一取 `user.creditBalance`（无则回落 store）。

### P1-2 设置/订阅页「版本」显示为旧值（ULTRA 账号显示 STANDARD/免费版）
- **根因**：`localStorage` 里的 `cortex_user` 是首次登录时的旧快照，token 校验成功后未刷新。
- **修复**：根路由 `/auth/me` 成功后同步 `user` 到 store；订阅页进入时 `fetchUser()`。

### P1-3 首字延迟：冷启动 44.6s
- **现象**：免费版首次发消息 44.6s 才见回复；热态 <0.1s（实测）。
- **根因**：Render 免费实例闲置休眠，冷启动 ~40s；前端无「正在唤醒实例」提示，用户以为卡死。
- **修复**：文案层面前端已有排队提示；建议沿用，并在报告中标注（根本解法是升级实例或加保活，属运维决策）。

### P1-4 管理后仪表盘统计全为 0（Pro/Ultra 用户、API Key 总数）
- **根因**：`/admin/dashboard` 只返回 6 个字段，前端 `stats.proUsers ?? 0` 静默兜底；`/admin/api-keys` 端点根本不存在（前端 catch 吞掉）。
- **修复**：dashboard 补齐 paidUsers/proUsers/ultraUsers/todayMessages/todayRevenue/pendingPayments/activeConversations；新增 `/admin/api-keys`（复用 `getKeyPoolStats`）。

## 二、中低优先级

### P2-4 支付「取消订单」点击无反应
- **根因**：前端调 `POST /payment/orders/:id/cancel`，但后端无该端点，前端 `catch {}` 静默吞错。
- **修复**：后端补 cancel 端点（仅 AWAITING_PAYMENT/PROOF_UPLOADED/AI_REVIEWING 可取消）；前端失败时显示错误提示。

### P2-1 菜单自动关闭过早
打开 ⋮ 菜单后做任何 DOM 变化/短等待即自动关闭，导致难以点击次要项。

### P2-2 `settings` H1 竖排
窄屏下「设置」标题被压成竖排（宽度约束问题）。

### P2-3 自助注册无入口
onboarding 只有「Continue」自动注册/登录，缺明确的登录/注册切换与找回密码入口（`/login`、`/register`、`/forgot-password` 页面存在但未在 onboarding 暴露）。

### P3-3 自动标题过短/空泛
- **现象**：部分会话标题变成「一」「5」等无意义短词。
- **修复**：提示词改为「6–14 字」并拒绝纯数字/单字/「新对话/你好」；不合格则退回消息前 20 字。

### P3-1 空输入 API 层会创建空「新对话」
前端已拦截，但 API 收到空 message 仍建 `{title:'新对话'}` 会话。

### P3-2 预览域名泛滥
5 个 `cortex-*-ryanzgy307.vercel.app` 冻结旧构建且带登录墙，易误用（建议清理 alias）。

## 三、2026-10-11 全站审计补充（v2.0）

测试范围：生产域名 `https://cortex-ai-omega-lemon.vercel.app`；管理员现有会话，原订阅 STANDARD；手机视口 375×666 与 412×914；后端 `/api/health` 返回四个数据库均健康。未新建用户、未切换订阅、未创建付款订单或真实付款。

### AUD-11-01 移动端聊天侧栏按钮无法打开菜单（P1）
- **页面/组件**：`/chat`，`ChatWindow`、`Sidebar`、`ChatLayout`
- **复现**：移动端聊天页面点击顶栏“打开侧边栏”；侧栏保持 `translateX(-288px)`，按钮不可见。
- **证据**：线上首屏 375×666 截图：`~/.aicode/browser-screenshots/audit-chat-mobile-current.jpg`；代码核对聊天布局和聊天窗口各自渲染 Sidebar、维护独立 `sidebarOpen`，顶栏只更新 ChatWindow 的状态，外层 Sidebar 状态仍为关闭。生产截图只用于记录旧版问题，不作为修复版验证。
- **影响**：移动端无法从会话访问新对话、历史、设置等侧栏入口。
- **修复方案/状态**：聊天窗口派发 `open-chat-sidebar` 事件，由布局唯一侧栏状态打开；删除聊天窗口内的重复 Sidebar。
- **复验（已上线，通过）**：生产 412×914 点击顶栏汉堡后侧栏 `left=0` 可见、`aria-hidden=false`、遮罩出现；点击抽屉关闭按钮后 `left=-288`、遮罩移除。注：无头浏览器会把 CSS 过渡时间轴冻结在 0，量测前需临时禁用该元素的 transition。

### AUD-11-02 关闭的移动抽屉仍可键盘访问（P1）
- **页面/组件**：`/chat` 与 `/admin/*`，`Sidebar`、`AdminSidebar`
- **复现**：移动端抽屉关闭时，以键盘逐项 Tab；侧栏按钮仍有 `tabIndex=0`，坐标全部在视口外且未标记隐藏。
- **影响**：键盘焦点进入视觉不可见的控件，用户无法判断焦点位置；屏幕阅读器可能读取关闭菜单内容。
- **修复方案/状态**：首次用 `inert={true}` 修复无效——React 18 不写入布尔 `inert`（线上实测属性缺失）；改为 `useRef` + `toggleAttribute('inert', …)` 直接操作属性，并保留 `aria-hidden`；抽屉关闭按钮与管理后台汉堡触控区域增至 44px。
- **复验（已上线，通过）**：生产关闭态 `aside[inert]` 属性存在，对它内部按钮调用 `focus()` 不生效（聚焦被阻断），关闭态 `aria-hidden=true`；打开态两者均消除。

### AUD-11-03 设置页开关触控目标不足且缺少 switch 语义（P2）
- **页面/组件**：`/settings` 偏好设置
- **复现**：语音输入、联网搜索开关实际框为 44×24px；浅/深色选项约 48×24px。
- **影响**：低于 44×44px 触控建议，且 toggle 未暴露 `role=switch`/`aria-checked`。
- **修复方案/状态**：开关触控外框调整至 44×44px，添加 switch 语义与可访问名称；浅/深选项最小触控尺寸 44px。
- **复验（已上线，通过）**：生产 412×914 实测「语音输入」「联网搜索」均为 44×44px、`role=switch`、`aria-checked` 有值；「浅色/深色」为 48×44px。

### AUD-11-04 用量页显示无来源的 94.2% 缓存命中率（P2）
- **页面/组件**：`/settings` → 用量统计，`server/src/routes/settings.ts`
- **复现**：请求中没有缓存统计记录时，界面仍展示“缓存命中率 94%”；源码在前后端均填入固定 0.942。
- **影响**：将默认常量呈现为用户真实运营指标，误导用户；Token 指标原标签还明确标注为“假”。
- **修复方案/状态**：无缓存数据返回 null，前端显示“—”；空区间的成功率同样不再默认显示 100%；Token 统计标签改为“Token 用量（展示值）”。
- **复验（已上线，通过）**：生产用量统计页现显示「缓存命中率 —」、标签「Token 用量（展示值）」；同时确认“调用成功率 93%”由真实调用记录推导，不是常量。

### AUD-11-05 数据库瞬时故障被当成登录失效，会话被清除（P1）
- **页面/组件**：`server/src/middleware/auth.ts`（配合 `client/src/lib/api.ts`）
- **复现**：会话有效期间访问 `/settings/tokens`，页面被重定向到 `/onboarding?phase=auth`，`localStorage.cortex_token` 被删除，需重新登录。
- **证据**：Render 运行日志同一分钟内 `Invalid prisma.user.findUnique() invocation` → `Error in connector: Error querying the database: FATAL: no more connections allowed (max_client_conn)`（2026-10-11T10:31:32Z）。鉴权中间件的 `try/catch` 把 JWT 校验与数据库查询包在同一段里，任何异常都返回 401「登录已过期」，前端随即清 token 并硬跳转。
- **影响**：一次瞬时的数据库/连接池抖动会登出所有在线用户并丢弃本地会话；用户看到的是“登录已过期”，与真实原因不符，属高影响可复现缺陷。
- **修复方案/状态**：JWT 校验失败仍返回 401；数据库查询失败改为 503「服务暂时不可用」并记录原始错误，前端只在 401 时清除会话。已构建并部署。
- **复验**：待复现条件（连接池抖动）出现时确认返回 503 而非 401；已在代码路径上区分两类失败。

### AUD-11-06 Layerbase 连接池连接耗尽与空闲回收（P1）
- **页面/组件**：`server/src/services/db.ts`、Render 环境变量 `DATABASE_URL_*`
- **证据**：运行日志反复出现 `prisma:error Error in PostgreSQL connection: … message: "client_idle_timeout"`，其后出现 `FATAL: no more connections allowed (max_client_conn)`。四个 Prisma 客户端均使用默认连接池（约 CPU 数×2+1），而生产连接串未设置任何上限参数，另有每 60 秒的 keep-alive 查询。
- **影响**：连接池被打满后所有查询失败，直接触发 AUD-11-05；服务表现为“随机掉线”。
- **修复方案/状态**：`resolveDbUrl` 在连接串未指定时附加 `connection_limit=5&pool_timeout=20`（可用环境变量逐库覆盖）；重试中间件新增对 `no more connections allowed`、`max_client_conn`、`client_idle_timeout`、`Connection terminated` 等瞬时错误的重试。已构建并部署。
- **复验（已上线）**：部署后日志中已无新的 `max_client_conn` 错误（部署前每 5 分钟一次，仅保留启动交接瞬间 1 次）；`client_idle_timeout` 仍持续出现（属连接池回收空闲连接的正常行为），现已进入自动重试。仍需持续观察，不以单次观察宣告根治。
- **未覆盖**：尚未验证长期高频请求下是否再次耗尽。

### 本轮未覆盖的项（原因）
- **桌面 1440px / 平板 1024 / 768 视口**：内置浏览器窗口固定为手机尺寸（`screen 376×835`、`dpr 3.25`，实测 `innerWidth` 375–413），无设备仿真；改用同源 iframe 平台加载本地构建时页面未水合（React 未接管，始终停在连接门控），iframe 方案不可靠，已放弃并清理临时文件。
- **认证后页面**（`/settings/tokens`、`/settings/payment`、`/settings/connections`、`/settings/feedback`、`/admin/*` 内容、管理员抽屉 inert、对话历史与搜索弹层）：本轮会话被 AUD-11-05 缺陷清除，重新登录需用户凭据；尝试用平台引导管理员凭据通过 `/auth/login`（不会自动建号）亦返回 401，未创建任何账号。
- **多模态与付费链路写操作**：受本轮“只读完成、不改账务”边界限制，未发送对话、未上传文件、未触发生图/生视频/语音合成、未创建订单或付款。
- **报告/规范同步**：`docs/DESIGN-SPEC.md` 已补触控与无数据指标条款；本轮新增的鉴权/连接池条款待补。

### 交付追踪
- 本轮实现提交：`c306727`（AUD-11-01~04 初版）、`8206efa`（inert 修正 + 触控尺寸）、`a7d3d91`（AUD-11-05/06 鉴权与连接池）。均已推送到 `main` 并部署：Vercel 生产 alias 指向新构建，Render 服务重新上线。
- 已复验并在生产确认：AUD-11-01、AUD-11-02、AUD-11-03、AUD-11-04。
- 待复验：AUD-11-05/06（需连接池抖动复现或持续观察日志）、桌面 1440px / 平板 1024 / 768 视口、认证后其余页面、多模态写操作与付费链路。
- 本轮检查截图：`~/.aicode/browser-screenshots/audit-chat-mobile-current.jpg`（修复前，375×666）、`~/.aicode/browser-screenshots/regress-chat-mobile.jpg`（修复后，412×914）。
- 排除项：每次页面加载都能看到 `Cannot read properties of null (reading 'appendChild')`（源码固定第 43 行），在本地 dev 与生产、静态与动态页面完全相同，属浏览器自动化注入脚本所致，不计入应用缺陷。

## 四、已确认正常（历史回归基线）

### 2026-10-11 只读线上补充
- 生产后端 `/api/health` 返回 200，user/conversation/knowledge/overflow 四个数据库均健康；未授权的用量与管理 API 返回 401。
- 生产页面路由 `/`、`/onboarding`、`/login`、`/register`、`/forgot-password`、`/chat`、`/pricing`、`/subscription`、`/payment`、设置及其子页、`/tools`、`/skills`、`/privacy`、`/terms`、`/admin` 及管理子路由均返回 HTTP 200。
- 在可用的 412×914 浏览器视口下，`/pricing`、`/payment`、`/privacy`、`/terms` 未发现横向溢出；支付页面仅检查套餐选择页，没有创建订单、显示/转发收款二维码或提交付款凭证。
- 桌面 1440px、平板 1024/768px、认证后设置页/管理员页面、有效订阅矩阵、对话生成和多模态写操作未完成；浏览器当前只提供移动视口与现有管理员生产会话，且本轮采用只读安全边界。
- 当前本地改动尚未部署。**不将旧报告中的历史“正常”清单视为本轮已回归通过。**
- 流式对话、代码块、多语言 + emoji、超长输入、上下文记忆（同会话暗号召回）、模型轮询（Agnes ↔ Gemini）、免费 0 积分、404 页、/tools 门控、/skills 空态、自动会话标题、同设备自动登录。
- 商业链路走查：`/pricing` 套餐对比/积分阶梯/FAQ 折叠正常；`/payment` 套餐→支付方式（TNG/ShopeePay/支付宝/PayPal）→创建订单→付款提醒→上传证明 全链路完整，文案清晰（5 分钟/无小窗遮挡/金额收款人交易号可见）。
- 响应式：admin 侧栏手机抽屉 + 表格卡片化（本轮新增）；深色/浅色点缀色反转（本轮新增）。
