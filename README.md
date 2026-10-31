# colyseus-fps-prototype

> 本科毕业设计项目：**基于 Colyseus 框架的多人实时对战游戏及其安全增强设计与实现**

本项目是一个基于 **Node.js + TypeScript + Colyseus** 的多人实时对战（FPS）游戏原型仓库，采用 **pnpm workspace** 单仓多包结构，目标是在 **Windows 原生环境**下完成开发、调试与演示。

工作占比规划：**游戏本体约 80%**，**安全增强约 20%**（SQLite 审计记录、Pino 结构化日志、Prometheus + Grafana 监控告警）。

---

## 1. 当前状态（骨架阶段）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 目录与工程配置 | ✅ 已完成 | pnpm workspace、TypeScript、EditorConfig、Git 属性 |
| `apps/server` | 🟡 占位 | 仅打印启动信息，Colyseus 房间逻辑待实现 |
| `apps/client` | 🟡 占位 | 渲染引擎/客户端方案在原型阶段确定后再引入 |
| `packages/shared` | 🟡 占位 | 仅导出共享常量（如 `GAME_TICK_RATE`） |
| `monitoring` | 🟡 配置就绪 | Docker Compose 配置已写好，需 Docker Desktop 才能启动 |
| `docs` | 🟡 大纲占位 | 各文档已有大纲，随开发推进填充 |
| CI | ✅ 已就绪 | GitHub Actions：Windows + Node 24 + pnpm |

> 本阶段**未安装任何依赖**，也**未初始化 Git 仓库**，请按下方步骤自行执行。

---

## 2. 技术栈

- **运行时**：Node.js 24.20.0（见 `.nvmrc`）
- **包管理**：pnpm 12.16.1（workspace）
- **语言**：TypeScript 7.x（`strict` 模式）
- **开发运行**：`tsx`（无需先编译，直接运行 `.ts`）
- **服务端框架**：Colyseus（后续安装）
- **客户端**：待定（Three.js / Babylon.js / PlayCanvas 三选一，原型阶段确定）
- **安全增强**：SQLite 审计、Pino 日志、prom-client + Prometheus + Grafana
- **测试**：Node.js 内置测试运行器（`node --test`）

---

## 3. 目录结构

```
colyseus-fps-prototype/
├─ apps/
│  ├─ server/                 # Colyseus 服务端（权威服务器）
│  │  ├─ src/
│  │  │  ├─ index.ts          # 入口（当前为占位）
│  │  │  ├─ rooms/            # 房间定义：生命周期、消息处理
│  │  │  ├─ state/            # Colyseus Schema 状态定义
│  │  │  ├─ handlers/         # 消息处理器（移动、开火、命中判定等）
│  │  │  ├─ config/           # 配置加载与校验（环境变量）
│  │  │  ├─ audit/            # SQLite 审计记录（安全增强）
│  │  │  ├─ monitoring/       # Prometheus 指标暴露（安全增强）
│  │  │  └─ utils/            # 通用工具（日志、校验、限流）
│  │  ├─ tests/               # 服务端单测
│  │  ├─ data/                # SQLite 数据库文件（已 gitignore）
│  │  └─ logs/                # 运行日志（已 gitignore）
│  └─ client/                 # 客户端（引擎待定）
│     ├─ index.html
│     ├─ src/
│     │  ├─ main.ts           # 入口（当前为占位）
│     │  ├─ net/              # Colyseus 客户端连接与状态同步
│     │  ├─ scenes/           # 场景与实体
│     │  ├─ ui/               # HUD、计分板、结算界面
│     │  └─ input/            # 键鼠输入采集
│     └─ public/              # 静态资源
├─ packages/
│  └─ shared/                 # 前后端共享：常量、类型、协议定义
│     └─ src/index.ts
├─ monitoring/                # Prometheus + Grafana（Docker）
│  ├─ docker-compose.yml
│  ├─ prometheus/prometheus.yml
│  └─ grafana/provisioning/
├─ docs/                      # 设计文档（架构 / 开发 / 测试 / 安全审计 / 监控）
├─ tests/                     # 跨端测试：integration / performance / manual
├─ .github/                   # CI 工作流与 PR / Issue 模板
└─ package.json               # workspace 根
```

---

## 4. Windows 开发步骤

> 全程使用 **PowerShell** 或 **Git Bash**，路径统一使用正斜杠。

### 4.1 前置检查

```bash
node -v      # 期望 v24.20.0
pnpm -v      # 期望 12.16.1
git --version
```

若 `pnpm` 未加入 PATH，可用 `npx pnpm@12.16.1 -v` 验证。

### 4.2 配置 Git 身份（当前未配置，必须执行）

```bash
git config --global user.name  "Your Name"
git config --global user.email "your.email@example.com"
```

### 4.3 安装依赖（本阶段仅安装工程化依赖）

```bash
cd C:/Users/pengyu/WorkBuddy/2026-10-31-01-05-27/colyseus-fps-prototype
pnpm install
```

随后按开发阶段逐步添加业务依赖（**按需执行，避免一次性全量下载**）：

```bash
# 阶段一：Colyseus 服务端
pnpm --filter @colyseus-fps/server add colyseus @colyseus/schema

# 阶段二：日志与配置
pnpm --filter @colyseus-fps/server add pino pino-pretty zod

# 阶段三：安全审计（SQLite）
pnpm --filter @colyseus-fps/server add better-sqlite3
pnpm --filter @colyseus-fps/server add -D @types/better-sqlite3

# 阶段四：监控指标
pnpm --filter @colyseus-fps/server add prom-client

# 阶段五：客户端（引擎确定后再执行，示例为 Three.js + Vite）
pnpm --filter @colyseus-fps/client add colyseus.js three
pnpm --filter @colyseus-fps/client add -D vite @types/three
```

> `better-sqlite3` 为原生模块，Windows 上需要 Visual Studio 生成工具；若编译失败，改用 `node:sqlite`（Node 24 内置）或 `sql.js`。

### 4.4 复制环境变量

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
```

### 4.5 启动开发

```bash
# 单独启动服务端（tsx watch 热重载）
pnpm dev:server

# 单独启动客户端
pnpm dev:client
```

### 4.6 类型检查与测试

```bash
pnpm typecheck
pnpm test
```

### 4.7 启动监控组件（需 Docker Desktop）

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
| `pnpm dev:client` | 启动客户端 |
| `pnpm build` | 全量构建（按依赖顺序） |
| `pnpm typecheck` | 全量 TypeScript 类型检查 |
| `pnpm test` | 运行全部测试 |
| `pnpm monitoring:up` | 启动 Prometheus + Grafana |
| `pnpm --filter @colyseus-fps/server <script>` | 在指定子包中执行命令 |
| `pnpm -r exec -- <cmd>` | 在每个子包中执行同一命令 |

---

## 6. GitHub 仓库初始化（占位说明）

> 当前尚未执行任何 git 命令，以下步骤供后续手动执行。

> **前置条件（必做）**：先完成第 4.3 节的 `pnpm install`，确认根目录已生成 **`pnpm-lock.yaml`**。
> CI 使用 `pnpm install --frozen-lockfile`，且 `actions/setup-node` 的 `cache: pnpm` 依赖 lockfile 计算缓存 key；
> **缺少 lockfile 时 CI 必然失败**。请确保 `pnpm-lock.yaml` 随首次提交一起入库。

```bash
cd C:/Users/pengyu/WorkBuddy/2026-10-31-01-05-27/colyseus-fps-prototype

# 确认锁文件已生成
ls pnpm-lock.yaml

git init
git add .
git commit -m "chore: 初始化毕设项目骨架（pnpm workspace + TypeScript）"

# 在 GitHub 网页端创建空仓库（不要勾选 README / .gitignore / license）后执行：
git remote add origin https://github.com/<your-name>/colyseus-fps-prototype.git
git branch -M main
git push -u origin main

# 创建长期开发分支
git checkout -b develop
git push -u origin develop
```

**建议**：毕设仓库设为 Private，避免未完成的论文代码外泄；答辩前再按需转 Public。

---

## 7. 已知限制

1. **Docker Desktop 未安装**：`monitoring/docker-compose.yml` 已配置完成但无法在本机启动；安装 Docker Desktop 后执行 `pnpm monitoring:up` 即可。未启动监控组件时，服务端 `/metrics` 端点可单独用 `curl http://localhost:9464/metrics` 验证。
2. **Git 全局身份未配置**：`user.name` / `user.email` 为空，无法提交，需按第 4.2 节配置。
3. **客户端引擎未确定**：`apps/client` 目前为纯 TypeScript 占位，不依赖任何渲染库；确定方案后需调整 `package.json` 的 `dev` / `build` / `preview` 脚本。
4. **业务依赖未安装**：Colyseus、Pino、SQLite 驱动等均未安装，`apps/server/src/index.ts` 当前只打印启动信息，不包含真实游戏逻辑。
5. **Windows 路径长度**：建议不要把仓库放到过深的目录，避免 Windows 260 字符路径上限问题；如遇到，可执行 `git config --global core.longpaths true`。

---

## 8. 参考文档

- 架构设计：[docs/01-architecture.md](docs/01-architecture.md)
- 开发规范：[docs/02-development.md](docs/02-development.md)
- 测试方案：[docs/03-testing.md](docs/03-testing.md)
- 安全审计：[docs/04-security-audit.md](docs/04-security-audit.md)
- 监控告警：[docs/05-monitoring.md](docs/05-monitoring.md)
- 协作流程：[CONTRIBUTING.md](CONTRIBUTING.md)
