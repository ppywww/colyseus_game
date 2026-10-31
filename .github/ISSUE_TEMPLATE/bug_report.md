---
name: 缺陷报告
about: 记录游戏中出现的异常行为或崩溃
title: "[BUG] "
labels: bug
assignees: ""
---

## 缺陷描述

<!-- 简明描述问题现象 -->

## 复现步骤

1. 启动服务端：`pnpm dev:server`
2. 启动客户端：`pnpm dev:client`
3. ...
4. 观察到问题

## 期望结果

<!-- 正常情况下应该发生什么 -->

## 实际结果

<!-- 实际发生了什么，附日志/截图 -->

## 影响范围

- [ ] 服务端（`apps/server`）
- [ ] 客户端（`apps/client`）
- [ ] 共享层（`packages/shared`）
- [ ] 监控 / 审计
- [ ] CI / 工程配置

## 环境信息

- 操作系统：Windows（版本）
- Node.js：`node -v`
- pnpm：`pnpm -v`
- 浏览器 / 客户端版本：
- 分支与提交：`git rev-parse --short HEAD`

## 日志与附件

<!-- 粘贴关键日志（Pino JSON 或服务端控制台输出），注意脱敏 IP 与令牌 -->
