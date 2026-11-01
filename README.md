# colyseus-fps-prototype

> 本科毕业设计项目：**基于 Colyseus 框架的多人实时对战游戏及其安全增强设计与实现**

本项目是一个基于 **Node.js + TypeScript + Colyseus + Three.js** 的多人实时对战（FPS）游戏原型仓库，采用 **pnpm workspace** 单仓多包结构，目标是在 **Windows 原生环境**下完成开发、调试与演示。

工作占比规划：**游戏本体约 80%**，**安全增强约 20%**（SQLite 审计记录、Pino 结构化日志、Prometheus + Grafana 监控告警）。

---

## 1. 当前状态（S1 + S2 已完成，可实际联机游玩）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 工程与 CI | ✅ | pnpm workspace、TypeScript strict、GitHub Actions（Windows + Node 24 + pnpm） |
| `packages/shared` | ✅ | 协议版本、消息类型、场地/移动/插值常量、yaw/pitch 工具 |
| `apps/server` | ✅ S1/S2 | zod 配置校验、pino 结构化日志、`FPSBattleRoom`（加入/离开/协议校验）、玩家位置状态同步、transform 上报校验钳制 |
| `apps/client` | ✅ S2 | Vite + Three.js 第一人称竞技场：指针锁定 FPS 控制（WASD/冲刺/跳跃/碰撞）、远端玩家插值渲染、枪械视模型、HUD |
| 玩法（开火/血量/计分） | 🟡 未开始 | S3 服务端权威命中判定 |
| 安全增强（审计/限流） | 🟡 未开始 | S5：SQLite 审计 + 消息限流 |
| `monitoring` | 🟡 配置就绪 | 需 Docker Desktop，见 `docs/05-monitoring.md` |

已实现玩法：多浏览器标签页加入同一房间，互相可见（胶囊体化身 + 头顶名牌），移动/视角经服务端中继后以 100ms 插值缓冲渲染。

---

## 2. 技术栈

- **运行时**：Node.js 24.20.0（见 `.nvmrc`，推荐 fnm 管理）
- **包管理**：pnpm 12.16.1（`packageManager` 字段锁定）
- **语言**：TypeScript 7.x（`strict` 模式）
- **服务端**：Colyseus 0.16 稳定线（`@colyseus/core` 0.16.26 + `@colyseus/ws-transport` 0.16.5 + `@colyseus/schema` 3.0.76）、pino、zod
- **客户端**：Three.js + Vite + `colyseus.js` 0.16
- **测试**：Node.js 内置测试运行器（`node --test`），当前 59 项全过
- **安全增强（规划）**：SQLite 审计、prom-client + Prometheus + Grafana

> ⚠️ 服务端与客户端的 Colyseus 必须同为 0.16 线：0.18 服务端与 0.16 客户端的座位预约格式不兼容（已踩坑，见 `docs/02-development.md`）。

---

## 3. 目录结构

```
colyseus-fps-prototype/
├─ apps/
│  ├─ server/                 # Colyseus 权威服务端
│  │  ├─ src/
│  │  │  ├─ index.ts          # 入口：控制台 UTF-8 切换、Server 启动、优雅退出
│  │  │  ├─ config/           # zod 环境变量校验
│  │  │  ├─ rooms/            # FPSBattleRoom 生命周期与消息、transform 校验钳制
│  │  │  ├─ state/            # Schema 3.x 装饰器状态（玩家/房间）
│  │  │  ├─ audit/            # SQLite 审计（S5 安全增强，待实现）
│  │  │  ├─ monitoring/       # Prometheus 指标（S5，待实现）
│  │  │  └─ utils/            # pino 结构化日志
│  │  └─ tests/               # 配置 / transform / 双真实客户端集成测试
│  └─ client/                 # Three.js 第一人称客户端（Vite）
│     ├─ index.html
│     ├─ vite.config.ts       # ws 代理到 127.0.0.1:2567
│     ├─ src/
│     │  ├─ main.ts           # 大厅（连接/进房）与 Game 编排
│     │  ├─ net/              # colyseus.js 连接封装、状态类型
│     │  └─ game/             # game 编排、输入、物理、插值、地图、远端化身、视模型、HUD
│     └─ tests/               # 插值缓冲 / 移动物理单测
├─ packages/
│  └─ shared/                 # 前后端共享：常量、协议消息、工具函数
├─ monitoring/                # Prometheus + Grafana（Docker）
├─ docs/                      # 设计文档（架构 / 开发 / 测试 / 安全审计 / 监控）
├─ .github/workflows/ci.yml   # CI：安装 → typecheck → test → build
└─ package.json               # workspace 根（dev:server / dev:client / test / build …）
```

---

## 4. Windows 开发步骤

> 全程使用 **PowerShell** 或 **Git Bash**，路径统一使用正斜杠。

### 4.1 前置检查

```bash
node -v      # 期望 v24.20.0
pnpm -v      # 期望 12.16.1
```

若 `pnpm` 未加入 PATH，可用 `corepack enable` 激活（版本由 `packageManager` 字段锁定）。

### 4.2 安装依赖与环境变量

```bash
pnpm install
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/client/.env.example apps/client/.env
```

### 4.3 启动开发（两个终端）

```bash
pnpm dev:server   # 终端 1：ws://localhost:2567（tsx watch）
pnpm dev:client   # 终端 2：http://127.0.0.1:5173
```

打开 **两个浏览器标签页**，各自输入玩家名点「进入战场」，点击画面锁定鼠标：

- **WASD** 移动 · **Shift** 冲刺 · **空格** 跳跃 · **Esc** 释放鼠标
- 场地为圆形竞技场：围墙 + 13 个掩体箱（矮箱可跳上），带阴影与雾效
- 远端玩家经 100ms 插值缓冲平滑渲染，头顶显示名牌

### 4.4 类型检查、测试与构建

```bash
pnpm typecheck
pnpm test     # 59 项：shared 11 + client 22 + server 26
pnpm build
```

### 4.5 启动监控组件（需 Docker Desktop，可选）

```bash
pnpm monitoring:up
# Prometheus: http://localhost:9090
# Grafana   : http://localhost:3000 （默认账号 admin / admin）
```

---

## 5. 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装全部 workspace 依赖 |
| `pnpm dev:server` | 启动服务端（watch 模式） |
| `pnpm dev:client` | 启动客户端（Vite dev server） |
| `pnpm build` | 全量构建（shared → server / client） |
| `pnpm typecheck` | 全量 TypeScript 类型检查 |
| `pnpm test` | 运行全部测试 |
| `pnpm monitoring:up` | 启动 Prometheus + Grafana |
| `pnpm --filter @colyseus-fps/server <script>` | 在指定子包中执行命令 |

---

## 6. 仓库与分支模型

- **远程仓库**：`git@github.com:ppywww/colyseus_game.git`（SSH）
- **主分支**：`main`（受保护基线）；**开发主线**：`develop`
- **功能分支**：按阶段开 `feature/<阶段>` 分支，验收后 `--no-ff` 合入 `develop`；Bug 修复走 `fix/<问题>` 短分支
- **已完成的阶段**：S1（真实 Colyseus 房间 + 联机客户端）、S2（第一人称竞技场 + 位置同步）+ 输入/日志修复；详见 `docs/02-development.md` 第 5 节

---

## 7. 已知限制

1. **Docker Desktop 未安装**：监控组件无法在本机启动；不影响游戏开发。
2. **玩法未闭环**：尚无开火/命中/血量/死亡/重生/计分（S3 计划中）；当前位置为客户端直报，服务端仅校验钳制。
3. **安全增强未实现**：SQLite 审计、消息限流、异常行为记录均为 S5 内容。
4. **Windows 控制台**：服务端启动时会自动 `chcp 65001` 切换 UTF-8，若手动 `node` 运行且日志乱码，请先执行 `chcp 65001`。
5. **Windows 路径长度**：如遇 `ENAMETOOLONG`，执行 `git config --global core.longpaths true`。

---

## 8. 参考文档

- 架构设计：[docs/01-architecture.md](docs/01-architecture.md)
- 开发指南：[docs/02-development.md](docs/02-development.md)
- 测试方案：[docs/03-testing.md](docs/03-testing.md)
- 安全审计：[docs/04-security-audit.md](docs/04-security-audit.md)
- 监控告警：[docs/05-monitoring.md](docs/05-monitoring.md)
- 协作流程：[CONTRIBUTING.md](CONTRIBUTING.md)
