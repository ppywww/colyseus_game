# 02 · 开发指南

> **状态：已随 S1/S2 落地更新（🟢）** —— 环境、命令、编码约定均已实际验证。
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

## 2. 首次初始化（✅ 已执行完毕）

```bash
cd C:/Users/pengyu/Projects/colyseus-fps-prototype

pnpm install
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/client/.env.example apps/client/.env
```

> Git 身份、远程仓库（`git@github.com:ppywww/colyseus_game.git`）与 `main` / `develop` 分支均已就绪，无需重复初始化。

---

## 3. 常用开发命令（✅ 可执行）

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:server` | `tsx watch` 启动服务端（ws://localhost:2567） |
| `pnpm dev:client` | Vite 启动客户端（http://127.0.0.1:5173，ws 经代理转发到服务端） |
| `pnpm typecheck` | 全量类型检查（CI 同款，含 `src` 与 `tests`） |
| `pnpm test` | 运行全部测试（当前 59 项全过） |
| `pnpm build` | 构建 shared → server / client |
| `pnpm --filter @colyseus-fps/server start` | 以 `tsx` 直接运行 `src/index.ts`（非 watch，**无需先 build**） |
| `pnpm monitoring:up` | 启动 Prometheus + Grafana（需 Docker） |

> **注意：`pnpm-lock.yaml` 必须入库**。CI 使用 `pnpm install --frozen-lockfile`，且 `actions/setup-node`
> 的 `cache: pnpm` 依赖 lockfile 计算缓存 key；首次 push 前请先执行 `pnpm install` 生成并提交锁文件。

在单个子包内执行：

```bash
pnpm --filter @colyseus-fps/server dev

# 如需重装 Colyseus 依赖，必须固定 0.16 稳定线（与 colyseus.js 0.16 匹配）：
pnpm --filter @colyseus-fps/server add "@colyseus/core@0.16.26" "@colyseus/ws-transport@0.16.5" "@colyseus/schema@3.0.76"
pnpm --filter @colyseus-fps/client add colyseus.js@0.16
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

## 5. 分阶段开发路线

| 阶段 | 目标 | 涉及目录 | 状态 |
| --- | --- | --- | --- |
| S1 | 配置加载 + 日志 + 真实 Colyseus 房间 + 联机页面 | `src/config` `src/utils` `src/rooms` `src/state` `apps/client/src/net` | ✅ |
| S2 | Three.js 第一人称竞技场 + 位置同步 + 插值渲染 | `apps/client/src/game` `src/rooms/transform.ts` | ✅ |
| S3 | 服务端权威玩法：开火、命中判定、血量、死亡/重生、计分 | `src/rooms` `apps/client/src/game` | 🟡 下一步 |
| S4 | 对局体验：HUD 计分板、断线重连、回合结束与重开 | `src/rooms` `apps/client/src/game/hud.ts` | 🟡 |
| S5 | 安全增强：SQLite 审计、消息限流、异常行为记录、Prometheus 指标 | `src/audit` `src/monitoring` | 🟡 |
| S6 | 监控看板与告警 + 压力/弱网/安全测试 + 文档定稿 | `monitoring/` `docs/` | 🟡 |

### S1 实现要点（✅ 2026-11-01 验收）

- 服务端：`src/config/index.ts` 用 zod 校验环境变量；`src/utils/logger.ts` 提供 pino 结构化日志；
  `FPSBattleRoom` 处理加入/离开、显示名消毒、协议版本校验、Ping-Pong。
- 状态：`src/state/player.ts` `battle-state.ts` 用 Schema 3.x 装饰器定义（`@type`），随补丁自动同步。
- 客户端：`apps/client/src/net/connection.ts` 封装 colyseus.js；`main.ts` 为大厅页（连接、进房、玩家列表）。
- 验证：`apps/server/tests/room.test.ts` 用两个真实 WebSocket 客户端验证加入互见、消息往返、版本不符拒绝、离开同步。

### S2 实现要点（✅ 2026-11-01 验收）

- 协议：`packages/shared` 增加 `player_transform` 消息、场地/身高常量、yaw/pitch 归一化工具。
- 服务端：玩家状态扩展位置字段（float32 节省带宽）；出生点按黄金角分布；`src/rooms/transform.ts`
  对上报位置做 NaN/越界/seq 乱序校验钳制。
- 客户端：`apps/client/src/game/` 下实现竞技场（围墙/掩体箱/光照阴影）、指针锁定 FPS 控制
  （WASD/冲刺/跳跃/重力/AABB 碰撞）、远端胶囊体化身 + 100ms 插值缓冲、枪械视模型、HUD。
- 踩坑记录：
  - Colyseus 服务端/客户端必须同处 0.16 线（0.18 与 0.16 客户端座位预约格式不兼容）；
  - Schema 3.x 装饰器要求 tsconfig 开启 `experimentalDecorators` 且 `useDefineForClassFields: false`；
  - `Game` 必须在 `#game-container` 可见后构造，否则 canvas 初始 0×0 导致点击/锁定/按键全失效；
  - Windows 控制台渲染 UTF-8 日志需在启动时 `chcp 65001`，且子进程必须 `stdio: "inherit"` 才能生效。

**填充位置**：每完成一个阶段，按上面格式补“实现要点 + 关键代码位置 + 验证方式”。

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

- [x] 安装业务依赖并提交 `pnpm-lock.yaml`（S1/S2 已完成）
- [x] 填充第 5 节 S1/S2 实现要点
- [ ] S3：服务端权威玩法（开火/命中/血量/重生/计分）
- [ ] 客户端真实用例扩充（当前覆盖插值缓冲与移动物理）
- [ ] 填充第 6 节调试技巧并配图
- [ ] S5：审计 + 限流 + Prometheus 指标
- [ ] 生产路径如需纯 `node` 运行，按第 7.6 条切换 shared 为编译产物导出
