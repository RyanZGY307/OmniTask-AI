# Universal Connect Runtime v2 — 完整实现文档

## 一、总体目标达成

| 指标 | 目标 | 实际 | 状态 |
|------|------|------|------|
| 总 Provider 数 | ≥200 | **734** | 通过 |
| 类别数 | 40 | **40/40** | 通过 |
| 每类别 ≥15 | 是 | **全部 ≥15** | 通过 |
| 地区覆盖 | 27+ | **71** | 通过 |
| TypeScript 错误 | 0 | **0** | 通过 |

## 二、架构总览

```
server/src/connections/
├── types.ts                  # ConnectorType, RiskLevel, AuthResult 等
├── providers.ts              # 向后兼容导出层
├── registry/global.ts        # 734 Provider 统一 Manifest
├── connectors/
│   ├── base.ts               # 抽象接口 + 工厂 + 选择器
│   ├── oauth.ts              # OAuth 2.0 (GitHub/Google/Slack/Discord...)
│   ├── api.ts                # API Key (OpenAI/Stripe/Slack...)
│   ├── browser.ts            # Playwright 浏览器自动化
│   ├── mcp.ts                # Model Context Protocol
│   ├── plugin.ts             # 插件沙箱系统
│   ├── generic_web.ts        # 通用 Web 回退
│   └── index.ts              # registerAllConnectors()
├── runtime/
│   ├── connectionManager.ts  # CRUD + 多账号 + MFA
│   ├── authManager.ts        # 密码认证 + Session 管理
│   ├── taskRunner.ts         # 长任务状态机
│   ├── fileBridge.ts         # 跨系统文件管理
│   ├── providerHealth.ts     # 健康检查 + 故障转移
│   └── discovery.ts          # 自然语言发现引擎
├── actions.ts                # 扩展：支持通用连接器
├── permissionEngine.ts       # 扩展 R3 风险等级
└── vault.ts                  # AES-256-GCM 密钥保险库
```

## 三、数据库新增表

- `PlatformManifest` — 21字段统一声明
- `ProviderHealth` — 健康日志
- `ConnectorRuntime` — 运行态
- `PluginInstance` / `MCPInstance` — 插件/MCP
- `FileBridge` — 文件桥接
- `TaskRun` — 任务状态机

扩展: Connection, ActionRequest, BrowserSession, ToolCall

## 四、Provider 分布（40类均≥15）

Top: e-commerce:40, payment:28, ai:26, local_services:24, job:23
所有类别最小值: 15

## 五、配置

1. 设置 PROVIDER_COST_TABLE_JSON（成本参数）
2. 安装 Playwright: `npm install playwright && npx playwright install chromium`
3. 运行迁移: `npx prisma migrate dev --schema prisma/schema-user.prisma`

## 六、成本计算（简化版）

不需要真实 Provider API 成本数据（fictional models）。

**公式：**
```
Protected Cost MYR = 套餐价格 USD × 4.50 × 1.15
Revenue MYR        = 套餐价格 USD × 市场汇率
毛利率              = (Revenue - Cost) / Revenue
```

- 4.50 = 固定成本汇率（USD→MYR）
- 1.15 = 成本保护系数（防汇率波动亏损）
- 市场汇率 = 每日从 open.er-api.com 获取的 USD/MYR 实时汇率

**动态调价逻辑：**
- 毛利率 < 20% → 所有价格 +5%
- 毛利率 > 40% → 所有价格 -5%
- 20%~40% → 维持不变
- 每天最多调整 1 次

**无需配置 PROVIDER_COST_TABLE_JSON**，成本直接由套餐价格推导。

## P0 修复记录 (2026-09-23)

| # | 问题 | 修复 |
|---|------|------|
| P0-1 | Connector Selector 盲目选择 | 改为精确匹配：providerId+capability+toolId+authMethod |
| P0-2 | GitHub 双执行风险 | executeAction 统一入口，GitHub 优先 return |
| P0-3 | 无 Capability Registry | 新增 registerToolMapping() + CAPABILITY_INDEX |
| P0-6 | MFA 任意 6 位通过 | 删除 verifyMfaCode()，改为 WAITING_USER 状态 |
| P0-7 | OAuth state/PKCE/refresh | 添加 validateState() + refreshToken() + PKCE |
| P0-9 | Session 精确恢复 | restoreSession 增加 accountId 参数 |
| P0-10 | Vault 允许 fallback | initVault(true) 在 production 启动失败 |
| P0-11 | Preview 泄漏敏感信息 | 新增 secretRedactor.ts，统一脱敏 |
| P1-2 | 重复 providerId (trello 等) | 清理 3 个重复，731 unique |

## 当前状态

- TypeScript: **0 错误**
- Build: **通过**
- Provider 数: **731** (唯一)
- 类别: **40/40** (全部 ≥15)
- 地区: **71**

## 剩余 P0 工作

- P0-4: Provider Support Level L0-L4 分级（需添加 implLevel 字段）
- P0-5: Browser Runtime 持久化（需集成 Playwright storageState）
- P0-8: Multi-account 重构（需新增 ConnectedAccount 表）
- P0-12: Verification 服务端真实验证（需各 connector 实现 postcondition check）
- P0-13: Plugin Connector 真实实现
- P0-14: MCP Connector 完整 lifecycle
- P0-15: FileBridge 真实 transfer + hash 校验
- P1-1: Task Runtime Worker 升级

## P0 修复完成记录 (第二轮)

| # | 问题 | 状态 | 改动文件 |
|---|------|------|----------|
| P0-4 | Provider Support Level L0-L4 | ✅ 完成 | types.ts (ImplLevel), registry/global.ts (computeImplLevel) |
| P0-12 | Verification 服务端真实验证 | ✅ 完成 | runtime/verification.ts (新增) |
| P0-13 | Plugin Connector 禁止 fake success | ✅ 完成 | connectors/plugin.ts (返回 NOT_IMPLEMENTED) |
| P0-14 | MCP Connector 真实 lifecycle | ✅ 完成 | connectors/mcp.ts (discoverTools, 真实 health check) |
| P0-15 | FileBridge 禁止直接 completed | ✅ 完成 | runtime/fileBridge.ts (verifyTransfer + status 流转) |
| P0-10 | Vault 生产安全 | ✅ 完成 | vault.ts (initVault forceCheck) |
| P0-11 | Secret Redaction | ✅ 完成 | runtime/secretRedactor.ts (新增) |

## 当前统计

```
Total Providers: 731 (全部唯一)
Categories: 40/40 (全部 ≥15)
Regions: 71

Impl Levels:
  L4 (Full):     0   — Native adapter + verification
  L3 (Advanced): 0   — API/OAuth + capabilities
  L2 (Functional): 320 — API or OAuth supported
  L1 (Connected): 411 — Browser only
  L0 (Catalog):   0   — Manifest only

TypeScript: 0 errors
Build: Pass
Client: TypeCheck pass
```

## 剩余工作 (下一轮)

1. **P0-5 Browser Runtime 持久化** — 需将 sessionState 序列化到 DB，服务器重启后恢复
2. **P0-8 Multi-account 重构** — 需新增 ConnectedAccount 表，修改 unique 约束
3. **P1-1 Task Runtime Worker** — 需实现 Queue → Worker → Step 执行引擎
4. **真实测试** — OAuth flow、Browser session persistence、MCP discovery

## 第二轮 P0 修复完成 (2026-09-23)

| # | 问题 | 状态 | 改动 |
|---|------|------|------|
| P0-4 | Provider Support Level L0-L4 | ✅ | types.ts 新增 ImplLevel + computeImplLevel() |
| P0-5 | Browser Runtime 持久化 | ✅ | browser.ts 改为 DB 存储 sessionState |
| P0-12 | Verification 服务端真实验证 | ✅ | runtime/verification.ts 新增 postcondition check |
| P0-13 | Plugin Connector fake success | ✅ | 返回 NOT_IMPLEMENTED 而非 fake success |
| P0-14 | MCP Connector 真实 lifecycle | ✅ | discoverTools() + 真实 health check |
| P0-15 | FileBridge 禁止直接 completed | ✅ | verifyTransfer() + status 流转 |

## 最终架构状态

```
TypeScript: 0 errors
Build: ✅ Pass
Client: ✅ Pass

Provider Registry:
  Total: 731 unique providers
  Categories: 40/40 (全部 ≥15)
  Regions: 71

Impl Level Distribution:
  L4 (Full/Native):       0
  L3 (Advanced/API+):     0
  L2 (Functional/API):  320
  L1 (Connected/Browser): 411
  L0 (Catalog Only):      0
```

## 关键设计决策

1. **Connector Selection**: 精确匹配 providerId + capability + toolId + authMethod + region + health
2. **Execution Path**: 统一入口 executeAction()，禁止双执行
3. **Secret Safety**: VAULT_KEY 必须设置（production），所有 preview 脱敏
4. **MFA**: 服务器不验证 MFA，返回 WAITING_USER 状态等待用户完成
5. **OAuth**: 严格 state 验证 + PKCE + token refresh
6. **Verification**: HTTP 200 ≠ verified，必须有 postcondition check
7. **Plugin/MCP**: 未实现的功能返回 NOT_IMPLEMENTED，禁止 fake success
8. **FileBridge**: 必须实际 transfer + hash 校验才能标记 completed

## 剩余工作 (下一轮)

- **P0-8 Multi-account 重构**: 需新增 ConnectedAccount 表，修改 unique 约束
- **P1-1 Task Runtime Worker**: 需实现 Queue → Worker → Step 执行引擎
- **真实测试**: OAuth flow、Browser session persistence、MCP discovery
