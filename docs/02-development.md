# 02 · 开发指南

> **状态：大纲占位（🟡）** —— 环境步骤已可用，各模块的详细开发步骤随进度填充。
> 对应论文章节：**第 4 章 系统实现**（工程部分）。

---

## 1. 环境要求（✅ 已验证）

| 工具 | 版本 | 路径/说明 |
| --- | --- | --- |
| Git | 2.56.0.windows.3 | `C:\Users\pengyu\AppData\Local\Programs\GitPortable\cmd` |
| Node.js | v24.20.0 | 见 `.nvmrc` |
| npm / npx | 11.19.0 | 随 Node 附带 |
| pnpm | 12.16.1 | `packageManager` 字段已锁定 |
| TypeScript | 7.0.2 | 全局 `tsc` 可用，仓库内以本地依赖为准 |
| tsx | 4.23.15 | 全局可用，仓库内以本地依赖为准 |
| Python | 3.13.16 | 可选（脚本工具用） |
| VS Code | 1.142.0 | 推荐安装 ESLint / EditorConfig 插件 |
| Docker Desktop | 未安装 | 仅监控组件需要，见 `05-monitoring.md` |

---

## 2. 首次初始化（✅ 可执行）

```bash
cd C:/Users/pengyu/WorkBuddy/2026-10-31-01-05-27/colyseus-fps-prototype

git config --global user.name  "Your Name"
git config --global user.email "your.email@example.com"

pnpm install
cp .env.example .env
cp apps/server/.env.example apps/server/.env
```

---

## 3. 常用开发命令（✅ 可执行）

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:server` | `tsx watch` 启动服务端 |
| `pnpm dev:client` | 启动客户端占位脚本 |
| `pnpm typecheck` | 全量类型检查（CI 同款，含 `src` 与 `tests`） |
| `pnpm test` | 运行测试（Node 内置 test runner，覆盖 server 与 shared） |
| `pnpm build` | 构建 shared → server / client |
| `pnpm --filter @colyseus-fps/server start` | 以 `tsx` 直接运行 `src/index.ts`（非 watch，**无需先 build**） |
| `pnpm monitoring:up` | 启动 Prometheus + Grafana（需 Docker） |

> **注意：`pnpm-lock.yaml` 必须入库**。CI 使用 `pnpm install --frozen-lockfile`，且 `actions/setup-node`
> 的 `cache: pnpm` 依赖 lockfile 计算缓存 key；首次 push 前请先执行 `pnpm install` 生成并提交锁文件。

在单个子包内执行：

```bash
pnpm --filter @colyseus-fps/server dev
pnpm --filter @colyseus-fps/server add colyseus @colyseus/schema
```

---

## 4. 编码约定（✅ 已定）

1. **ESM 导入必须写扩展名**：`import { foo } from "./foo.js"`（`module: NodeNext` 强制要求）。
2. **严格类型**：`strict` 全开，禁止 `any`；跨端数据结构统一放 `packages/shared`。
3. **命名**：目录与文件名全小写英文 + 连字符（`fps-battle-room.ts`），类名 PascalCase，函数与变量 camelCase，常量 UPPER_SNAKE。
4. **注释**：导出类与公共方法必须有 JSDoc 风格注释，复杂算法需要行内说明。
5. **错误处理**：禁止吞异常；边界校验失败要记录结构化日志（含 `roomId` / `playerId`）。
6. **配置**：任何硬编码数值统一提到 `packages/shared` 或 `src/config/`。

---

## 5. 分阶段开发路线（待填充）

| 阶段 | 目标 | 涉及目录 | 状态 |
| --- | --- | --- | --- |
| S1 | 配置加载 + 日志 + 空房间跑通 | `src/config` `src/utils` `src/rooms` | 🟡 |
| S2 | 玩家加入/离开 + 状态Schema | `src/state` | 🟡 |
| S3 | 移动 + 开火 + 命中判定 | `src/handlers` | 🟡 |
| S4 | 死亡/重生/计分/结算 | `src/rooms` `src/state` | 🟡 |
| S5 | 客户端连接 + 渲染 | `apps/client/src/*` | 🟡 |
| S6 | 安全：审计 + 日志 + 限流 | `src/audit` `src/monitoring` | 🟡 |
| S7 | 监控看板与告警 | `monitoring/` | 🟡 |

**填充位置**：每完成一个阶段，补一段“实现要点 + 关键代码位置 + 验证方式”。

---

## 6. 调试技巧（待填充）

> 待补充：
> - Colyseus Playground（`http://localhost:2567`）的使用截图与说明
> - 多开客户端模拟：`pnpm dev:client` 多次启动（后续改为同页面多标签 + 参数化）
> - 人为制造延迟：Chrome DevTools Network Throttling / `clumsy`（Windows 弱网工具）
> - 审计库查询：`sqlite3 data/audit.db "select * from audit_event limit 10"`

**填充位置**：`## 6.` 正下方。

---

## 7. Windows 特有注意事项（✅ 已定）

1. **路径长度**：如遇 `ENAMETOOLONG`，执行 `git config --global core.longpaths true`。
2. **行尾**：仓库统一 LF（`.gitattributes`），`.cmd/.bat/.ps1` 保持 CRLF。
3. **原生模块**：`better-sqlite3` 需 VS Build Tools；失败时改用 Node 24 内置 `node:sqlite`。
4. **端口占用**：`netstat -ano | findstr :2567` 查占用，`taskkill /PID <pid> /F` 结束。
5. **PowerShell 执行策略**：脚本无法执行时用 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
6. **shared 包以 TS 源码形式被引用**（`exports` 指向 `src/index.ts`），因此：
   - `dev` / `start` / `typecheck` / `test` / `build` 开箱即用，无需先编译 shared；
   - 但直接 `node dist/index.js` 会因 Node 不支持剥离 `node_modules` 下的 TS 类型而失败
     （报错 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），
     故服务端 `start` 脚本使用 `tsx src/index.ts`，与 `dev` 保持同源。
   - 若将来要改用纯 `node dist/index.js`，需把 `packages/shared` 的 `exports`/`main`/`types`
     统一改为指向 `dist/index.js` 与 `dist/index.d.ts`，并在根脚本中保证 shared 先构建。

---

## 8. 待办清单

- [ ] 安装业务依赖（按 README 第 4.3 节分阶段执行），并提交 `pnpm-lock.yaml`
- [ ] 填充第 5 节各阶段实现要点
- [ ] 填充第 6 节调试技巧并配图
- [ ] 客户端引入引擎后扩充 `apps/client/tests/` 的真实用例（当前仅入口与常量冒烟）
- [ ] 生产路径如需纯 `node` 运行，按第 7.6 条切换 shared 为编译产物导出
