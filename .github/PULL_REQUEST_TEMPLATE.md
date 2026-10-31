## 变更类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `refactor` 重构
- [ ] `perf` 性能优化
- [ ] `test` 测试
- [ ] `docs` 文档
- [ ] `chore` 构建/依赖/配置
- [ ] `security` 安全增强

## 关联 Issue

<!-- 例如：Closes #12 -->

## 变更说明

<!-- 一句话说明做了什么，以及为什么这么做 -->

## 影响范围

- [ ] `apps/server`
- [ ] `apps/client`
- [ ] `packages/shared`
- [ ] `monitoring`
- [ ] `docs`
- [ ] `.github` / CI

## 协议 / 状态 / 配置变更

- [ ] 本次变更**不涉及**消息结构、状态字段或环境变量变更
- [ ] 涉及变更，已同步更新 `packages/shared` 与 `apps/server/.env.example`
- [ ] 涉及变更，已同步更新 `docs/01-architecture.md`（安全相关还需更新 `docs/04-security-audit.md`）

## 自查清单

- [ ] 本地已执行 `pnpm typecheck` 且通过
- [ ] 本地已执行 `pnpm test` 且通过
- [ ] 新增/修改的核心逻辑已补充测试或手工验证步骤
- [ ] 未提交 `.env`、`data/*.db`、`logs/` 等本地文件
- [ ] 提交信息符合 Conventional Commits 约定

## 验证方式

<!-- 写清复现/验证步骤，例如：pnpm dev:server 后打开 http://localhost:2567 观察 xxx -->

## 截图 / 录屏（可选）

<!-- 客户端与看板类变更请附截图 -->
