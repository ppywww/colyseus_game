# 贡献指南（CONTRIBUTING）

本仓库为本科毕业设计项目，协作流程在标准 Git 工作流基础上做了简化，以适应单人开发 + 导师评审的场景。

---

## 1. 分支策略

| 分支类型 | 命名 | 来源 | 合并目标 | 说明 |
| --- | --- | --- | --- | --- |
| 主分支 | `main` | — | — | 稳定可演示版本，每个里程碑从 `develop` 合并 |
| 开发分支 | `develop` | `main` | `main` | 日常集成分支，功能完成后汇入 |
| 功能分支 | `feature/<scope>-<brief>` | `develop` | `develop` | 新功能，如 `feature/room-matchmaking` |
| 修复分支 | `fix/<scope>-<brief>` | `develop` | `develop` | 缺陷修复，如 `fix/hit-detection-lag` |
| 文档分支 | `docs/<brief>` | `develop` | `develop` | 文档与论文素材，如 `docs/architecture-draft` |
| 实验分支 | `spike/<brief>` | `develop` | 不合并（可丢弃） | 技术验证，如 `spike/client-engine-compare` |

规则：

1. **禁止直接向 `main` 推送**，一切变更必须经过 `develop`。
2. `main` 只在里程碑节点合并（如“服务端联调完成”“安全模块完成”）。
3. 分支名**全小写英文 + 连字符**，不使用中文与空格。
4. 功能分支保持短生命周期（建议 ≤ 3 天），完成后及时删除远程分支。

```bash
# 新建功能分支
git checkout develop
git pull origin develop
git checkout -b feature/room-matchmaking

# 完成后推送
git push -u origin feature/room-matchmaking
```

---

## 2. 提交信息约定

采用 **Conventional Commits** 简化版：

```
<type>(<scope>): <subject>
```

**type 取值**

| type | 含义 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改变外部行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `docs` | 文档 |
| `chore` | 构建 / 依赖 / 配置 |
| `security` | 安全增强相关改动 |

**scope 取值**：`server` `client` `shared` `monitoring` `docs` `ci`。

**规范**

1. subject 使用中文或英文均可，但**同一仓库内保持一致**；建议中文一句式，结尾不加句号。
2. 一行不超过 72 字符。
3. 正文（可选）说明动机与影响，用空行与 subject 分隔。

**示例**

```
feat(server): 实现 FPSBattleRoom 房间与玩家加入逻辑
fix(server): 修正命中判定在高延迟下的时间回溯错误
security(audit): 新增 SQLite 审计表与写入队列
perf(server): 状态广播改用按视野裁剪的增量同步
docs(architecture): 补充服务端模块划分图说明
chore(ci): 在 Windows 运行器上启用 pnpm 缓存
```

---

## 3. Pull Request 要求

1. **标题**：与提交信息同格式，如 `feat(server): 实现房间匹配`。
2. **模板**：必须使用 `.github/PULL_REQUEST_TEMPLATE.md`，逐项填写。
3. **前置检查（提交前本地执行）**

   ```bash
   pnpm typecheck
   pnpm test
   ```

   两项都必须通过，CI（Windows + Node 24 + pnpm）同样会校验。
4. **内容要求**
   - 一个 PR 只做一件事，避免混入无关重构。
   - 新增/修改核心逻辑必须附对应测试或手工验证步骤。
   - 涉及协议变更（消息结构、状态字段）必须同步更新 `packages/shared` 与 `docs/01-architecture.md`。
   - 涉及安全模块必须更新 `docs/04-security-audit.md`。
5. **评审**
   - 单人开发时 PR 可自审合并，但必须在描述中写明“自审结论”。
   - 有导师/同学参与时，至少需要 1 个 Approve。
6. **合并方式**：`develop` 使用 **Squash and merge**，保持提交历史线性清晰；`main` 使用 **Merge commit** 保留里程碑节点。

---

## 4. 本地开发约定

- **Node 版本**：固定 24.20.0（见 `.nvmrc`），Windows 上可用 `nvm-windows` 或 `fnm` 切换。
- **包管理**：统一使用 `pnpm`，禁止混用 `npm install` / `yarn`（会破坏 workspace 锁文件）。
- **代码风格**：TypeScript `strict` 全开；缩进 2 空格、LF 行尾、UTF-8（由 `.editorconfig` 保证）。
- **相对导入**：ESM 下必须写完整扩展名（`import { foo } from "./foo.js"`）。
- **提交前**：编辑器保存时自动格式化，不引入 Prettier/ESLint 之外的格式化器（如需引入，单独提 PR）。
- **敏感信息**：任何密钥、真实 IP、内网地址不得入库，一律走 `.env` 并加入 `.gitignore`。

---

## 5. 问题反馈

- 缺陷：使用 `.github/ISSUE_TEMPLATE/bug_report.md`。
- 新需求：使用 `.github/ISSUE_TEMPLATE/feature_request.md`。
- 毕设进度类事项建议在 Issue 打 `milestone` 与 `thesis` 标签，便于按章节统计。
