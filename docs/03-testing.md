# 03 · 测试方案

> **状态：大纲占位（🟡）** —— 测试分层已确定，用例随功能填充。
> 对应论文章节：**第 5 章 系统测试**。

---

## 1. 测试分层

| 层级 | 位置 | 工具 | 目标 |
| --- | --- | --- | --- |
| 单元测试 | `packages/shared/tests/`、`apps/server/tests/` | `node --test` + `node:assert` | 常量、纯函数与状态变更逻辑 |
| 集成测试 | `tests/integration/` | `node --test` + Colyseus 测试客户端 | 房间加入、消息往返、断线重连 |
| 性能/压力测试 | `tests/performance/` | 自研压测脚本 / Colyseus loadtest | 并发房间数、消息吞吐、延迟分布 |
| 手工测试 | `tests/manual/` | 检查清单（Markdown） | 观感、手感、异常交互 |

当前已存在的最小用例（`pnpm -r test` 三个包都会执行，无静默跳过）：

- `packages/shared/tests/shared.test.ts`：共享常量一致性（帧率推导、人数上限、协议版本）
- `apps/server/tests/smoke.test.ts`：骨架自检（shared 可见性 + Node 版本要求）
- `apps/client/tests/smoke.test.ts`：入口占位文件存在 + 共享常量在客户端可见（不依赖渲染库）

> 注意：子包若没有 `test` 脚本，`pnpm -r test` 会**静默跳过**该包，容易被误认为"已全部测过"；
> 新增子包/子测试目录时请同步添加 `test` 脚本（统一用 `node --import tsx --test "tests/**/*.test.ts"`）。

---

## 2. 运行方式（✅ 可执行）

```bash
pnpm test                                   # 全部子包
pnpm --filter @colyseus-fps/server test     # 仅服务端
node --import tsx --test "tests/**/*.test.ts"
```

命令说明：使用 **Node.js 24 内置测试运行器**，`tsx` 作为 loader 直接运行 TypeScript，不额外引入 Jest/Vitest，减少依赖体积。

**测试文件的类型保护**：`src` 与 `tests` 的 TS 配置是分开的——
构建用 `tsconfig.json`（`include: src`，`rootDir: src`，产出 `dist`），
检查用 `tsconfig.test.json`（`include: src + tests`，`noEmit`，`rootDir: .`）。
这样 `pnpm typecheck` 既能检查测试文件，又不会把测试编译进 `dist`。

---

## 3. 单元测试范围（待填充）

> 需覆盖的被测对象（每实现一项后在本表登记用例文件名）：

| 模块 | 典型用例 | 用例文件 |
| --- | --- | --- |
| 共享常量 | 帧率与帧间隔一致、上限取值合理 | ✅ `packages/shared/tests/shared.test.ts` |
| 配置加载 | 缺失必填项时报错、默认值正确 | 待建 `apps/server/tests/config.test.ts` |
| 状态 Schema | 玩家加入/离开后状态一致 | 待建 |
| 命中判定 | 射线命中、掩体遮挡、距离衰减 | 待建 |
| 限流器 | 超阈值拒绝、窗口恢复 | 待建 |
| 审计写入 | 字段完整、批量落盘、异常不丢 | 待建 |

**填充位置**：第 3 节表格及下方“用例设计说明”。

---

## 4. 集成测试设计（待填充）

> 计划覆盖场景：
> 1. 玩家 A/B 加入同一房间，状态互相可见
> 2. 玩家移动后，其他客户端收到增量更新
> 3. 玩家开火 → 服务端判定 → 广播命中结果
> 4. 玩家断线 → 超时移除 → 状态收敛
> 5. 房间满员后拒绝加入并给出错误码

**填充位置**：`## 4.` 正下方，需附时序说明与断言清单。

---

## 5. 性能与压力测试（待填充）

> 指标基线（待实测后填入真实值）：

| 指标 | 目标值 | 实测值 | 测试工具 |
| --- | --- | --- | --- |
| 单房间并发玩家 | 10 | 待测 | 自研脚本 |
| 单进程房间数 | 20+ | 待测 | 自研脚本 |
| 状态广播延迟 P95 | < 80ms | 待测 | 客户端时间戳统计 |
| 每秒消息吞吐 | > 2000 msg/s | 待测 | 压测脚本 |
| 内存占用（10 房 100 人） | < 512MB | 待测 | `process.memoryUsage()` |

**填充位置**：第 5 节表格 + 压测脚本路径 + 结果截图（放 `docs/assets/`，该目录后续创建）。

---

## 6. 安全测试（待填充）

> 与 `04-security-audit.md` 联动，计划用例：
> - 伪造高频移动包 → 期望被限流并记录审计
> - 篡改伤害值/瞬移 → 期望服务端校验拦截
> - 重放旧消息 → 期望因时间戳/序号校验失败
> - 未授权访问 `/metrics` → 期望仅监听内网或需鉴权

**填充位置**：`## 6.` 正下方，每用例给出「攻击手法 / 期望结果 / 实际结果 / 结论」。

---

## 7. 手工测试清单（待填充）

> `tests/manual/` 下计划文件：`connectivity.md`（连接与重连）、`gameplay.md`（玩法手感）、`ui.md`（界面）、`monitoring.md`（看板与告警）。
> 每份清单格式：编号 / 前置条件 / 操作步骤 / 期望结果 / 实际结果 / 是否通过。

**填充位置**：`## 7.` 正下方与 `tests/manual/`。

---

## 8. CI 中的测试（✅ 已配置）

`.github/workflows/ci.yml` 在 Windows 运行器上执行：`pnpm install → pnpm typecheck → pnpm test`，任一失败则 PR 不可合并。

---

## 9. 待办清单

- [ ] 完成第 3 节单元用例文件并建立断言规范
- [ ] 编写第 4 节集成测试
- [ ] 编写第 5 节压测脚本并采集真实基线数据
- [ ] 编写第 6 节安全测试用例
- [ ] 编写第 7 节手工测试清单
