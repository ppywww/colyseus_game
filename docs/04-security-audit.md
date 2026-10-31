# 04 · 安全增强设计与审计

> **状态：大纲占位（🟡）** —— 威胁模型与审计表结构已规划，实现细节随 S6 阶段填充。
> 对应论文章节：**第 3.4 / 4.5 节 安全增强设计与实现**（约占工作量 20%）。

---

## 1. 安全目标

1. **可追溯**：任何关键操作（登录、加入房间、开火命中、异常消息）都能回溯到具体会话与时间。
2. **可检测**：异常行为（刷包、篡改、重放）能被指标捕获并触发告警。
3. **可防御**：服务端权威校验 + 速率限制，客户端不可信。
4. **低侵入**：安全模块以钩子/中间件接入，不污染游戏主逻辑。

---

## 2. 威胁模型（待填充）

> 建议按 STRIDE 分类，逐项给出「威胁 / 攻击面 / 现有措施 / 风险等级 / 待办」。

| 类别 | 典型威胁 | 现有措施 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| Spoofing | 伪造玩家身份加入房间 | 待定：连接令牌校验 | 高 | 🟡 |
| Tampering | 客户端上报虚假伤害/位置 | 待定：服务端权威判定 + 位移距离校验 | 高 | 🟡 |
| Repudiation | 否认恶意行为 | 待定：SQLite 审计记录 | 中 | 🟡 |
| Information Disclosure | `/metrics` 暴露内部信息 | 待定：仅内网监听 | 中 | 🟡 |
| Denial of Service | 高频消息/大包刷爆服务端 | 待定：速率限制 + 消息体上限 | 高 | 🟡 |
| Elevation of Privilege | 客户端伪造管理员指令 | 待定：指令白名单 | 中 | 🟡 |

**填充位置**：第 2 节表格下方补充 300 字威胁分析说明。

---

## 3. 服务端权威校验（待填充）

> 计划实现的校验点：
> 1. **位移合理性**：两帧间位移 > `maxSpeed * dt * 容差` 判定为瞬移，回滚并记审计。
> 2. **射击频率**：与武器射速比对，超限丢弃。
> 3. **命中判定**：服务端以服务端状态做 raycast，不采信客户端上报的命中结果。
> 4. **消息序号**：单调递增，重放旧序号直接丢弃。
> 5. **消息体大小**：超过 `MAX_MESSAGE_BYTES`（默认 2048）断开连接。

**填充位置**：`## 3.` 正下方，附伪代码与参数取值依据。

---

## 4. SQLite 审计设计（待填充）

审计表草案（实现后需与 `apps/server/src/audit/` 中的建表 SQL 保持一致）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `ts` | INTEGER | 事件时间戳（毫秒 epoch） |
| `room_id` | TEXT | 房间 ID |
| `player_id` | TEXT | 玩家/会话 ID（可为 NULL） |
| `event_type` | TEXT | 事件类型（join/leave/shoot/hit/violation/...） |
| `severity` | TEXT | info / warn / error |
| `payload` | TEXT | JSON 结构化详情 |
| `client_ip` | TEXT | 来源 IP（注意隐私合规） |
| `created_at` | TEXT | 写入时间（ISO8601） |

索引建议：`(event_type, ts)`、`(player_id, ts)`、`(severity, ts)`。

**填充位置**：本小节补建表 SQL、写入策略（同步 vs 异步批量）、保留与清理策略（`AUDIT_RETENTION_DAYS`）。

---

## 5. 日志设计（待填充）

- 使用 **Pino**：结构化 JSON 输出，生产环境写 `logs/`，开发环境 `pino-pretty`。
- 统一字段：`ts` `level` `msg` `roomId` `playerId` `traceId`。
- 日志级别通过 `LOG_LEVEL` 控制；安全事件固定 `warn` 以上。
- **敏感信息脱敏**：IP 与令牌需脱敏后再落盘。

**填充位置**：本小节补日志样例与字段规范表。

---

## 6. 监控与告警（待填充）

> 与 `05-monitoring.md` 联动。计划指标：

| 指标名 | 类型 | 告警阈值（建议） |
| --- | --- | --- |
| `fps_room_active` | Gauge | — |
| `fps_player_online` | Gauge | — |
| `fps_message_rate_per_player` | Histogram | P95 > 30/s 告警 |
| `fps_violation_total` | Counter | 1 分钟内 > 20 次告警 |
| `fps_audit_write_failure_total` | Counter | > 0 立即告警 |
| `fps_tick_duration_seconds` | Histogram | P95 > 50ms 告警 |

**填充位置**：本小节补指标命名规范与告警规则 YAML（放 `monitoring/prometheus/alerts.yml`）。

---

## 7. 隐私与合规（待填充）

> 需说明：审计数据仅本地留存、IP 脱敏、保留期满自动清理、毕设演示不涉及真实个人信息。

**填充位置**：`## 7.` 正下方。

---

## 8. 待办清单

- [ ] 完成第 2 节威胁模型分析
- [ ] 实现第 3 节服务端权威校验并登记参数
- [ ] 落地第 4 节审计表并补充建表 SQL
- [ ] 落地第 5 节日志规范
- [ ] 编写第 6 节告警规则
- [ ] 补全第 7 节隐私说明
