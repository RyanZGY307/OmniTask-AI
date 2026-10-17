# OmniTask

OmniTask，为你而生 — 智能 AI 助手平台（免费版 / Pro 版双轨，积分制）

## 功能

- AI 对话：SSE 流式、思考等级（快速/标准/思考）、深度研究、代码打包下载
- 模型网关：多供应商（Agnes/Gemini/ChatGPT/DeepSeek/Xiaomi）；免费版后端跨供应商×API 纯轮询 + 三级速率闸门（单 API/运营商/模型，RPM/TPM/RPD/TPD/并行，超限自动排队与状态提示）；Pro 版按厂商手选模型、按 token 消耗积分
- 生成能力：图片 / 视频 / TTS / Office 文档（表格/演示）
- 联网搜索：Perplexity（基础搜索）→ Google CSE → Tavily → DuckDuckGo（无限兜底）
- 双层知识库 + RAG，知识组织与自愈（刷新调度/精度门）
- 记忆系统：短期注入、长期记忆、文件记忆、上下文压缩（90% 触发，免费简略/Pro 详细）
- 语气与语言学习：模仿风格写入系统提示词、区域说话习惯、新领域新手判定
- 网页自动化：浏览器连接（Playwright 无头 Chromium，自动登录/验证码委托/会话持久化）、多类 Token 连接（bearer/oauth_access/api_key/basic/cookie/custom）、OAuth 连接（30+ provider）；凭据 AES-256-GCM 金库 + 权限引擎（R0 只读/R1/R2 分级，R2+ 用户审批）
- 技能（Skill）：账号级链接安装（SSRF+注入扫描，仅本人使用）；admin 后台筛选并提升到全局；正式技能 AI 不可直接发布
- 登录：邮箱/密码（find-or-create）+ SSO（Google / GitHub OAuth，需配置 client id；GitHub PAT 兜底）
- 支付与计费：支付宝 / PayPal / ShopeePay / TNG 凭证上传 + Agnes 视觉 OCR 自动初审 + 人工审批；动态定价引擎（每日 margin 任务 + 汇率）

## 技术栈

- 前端：Next.js 14 + Tailwind CSS + Zustand（设计令牌：浅色软阴影 / 深色柔光、克制动效）
- 后端：Node.js + Express + Prisma（4 个 PrismaClient）
- 数据库：4 个 Layerbase Postgres（user / conversation / knowledge / overflow；pooler 有休眠机制，启动需唤醒，应用每分钟保活）
- 部署：Vercel（前端）+ Render（后端，手动触发部署）
- AI 网关：Agnes（`apihub.agnes-ai.com`，主力 `agnes-2.5-flash` / `agnes-3.0-flash`，模型 id 必须小写）

## 仓库结构

```
client/   Next.js 前端（页面在 src/app，模型选择面板 ModelSelector + modelCatalog）
server/   Express 后端
  src/routes/        26 个路由文件（/api/auth、/api/chat、/api/models、/api/connections、
                     /api/actions、/api/skills、/api/admin…）
  src/services/      子系统（记忆/知识/进化/语气学习/模型网关/限速/skill/支付/研究/worker 池）
  src/connections/   凭据连接层（vault / permissionEngine / connectors: browser·token·oauth·github）
  prisma/            4 套 schema（user/conversation/knowledge/overflow）+ 迁移 SQL
headroom-py/         纯 Python token 压缩 MCP（独立于主程序）
```

## 环境变量（server/.env）

- `DATABASE_URL_USER` / `DATABASE_URL_CONVERSATION` / `DATABASE_URL_KNOWLEDGE` / `DATABASE_URL_OVERFLOW`（Layerbase pooler，sslmode=require）
- `JWT_SECRET`、`VAULT_KEY`（生产缺失即启动失败）
- `PERPLEXITY_API_KEY`（可选，搜索首选）
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（可选，SSO；缺则前端隐藏按钮，端点 501 优雅降级）
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（可选，SSO）；可选 `*_OAUTH_REDIRECT_URI`（默认 `{CLIENT_URL}/auth/callback/{provider}`，需在 OAuth 应用注册）
- `CLIENT_URL`（CORS 与 OAuth redirect 基地址）

## 运维约定

1. 部署前**先唤醒 4 个数据库**（pooler 休眠，首连延迟 10–30s，属正常现象勿误判）；
2. 提交**只提交 main 分支**；Render 手动触发部署；
3. 子系统 AI 调用只用 Agnes 2.5/3.0-flash（经 `callAgnes` 统一层，模型名小写），能代码化就不用 AI；
4. AI 调用合并执行，每分钟 ≤7 次。