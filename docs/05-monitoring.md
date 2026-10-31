# 05 · 监控与告警

> **状态：配置就绪、正文占位（🟡）** —— `monitoring/` 下的 Compose 与 Prometheus/Grafana 配置已完成，说明文字待实测后填充。
> 对应论文章节：**第 4.6 节 运行监控**。

---

## 1. 组件与端口

| 组件 | 端口 | 访问地址 | 运行方式 |
| --- | --- | --- | --- |
| 服务端指标端点 | 9464 | `http://127.0.0.1:9464/metrics` | 宿主机直接运行（Node） |
| Prometheus | 9090 | `http://localhost:9090` | Docker（需 Docker Desktop） |
| Grafana | 3000 | `http://localhost:3000` | Docker（默认 `admin` / `admin`） |

端口均可通过根 `.env` 覆盖（`METRICS_PORT` / `PROMETHEUS_PORT` / `GRAFANA_PORT` / `GRAFANA_ADMIN_PASSWORD`）。

---

## 2. 启动与停止（配置已就绪，需 Docker Desktop）

```bash
# 启动
pnpm monitoring:up
# 等价命令
docker compose -f monitoring/docker-compose.yml up -d

# 查看状态
docker compose -f monitoring/docker-compose.yml ps

# 停止并保留数据卷
docker compose -f monitoring/docker-compose.yml down

# 停止并清理数据卷
docker compose -f monitoring/docker-compose.yml down -v
```

> Docker Desktop **当前未安装**，仅 Prometheus/Grafana 需要容器；服务端在宿主机运行，Prometheus 通过 `host.docker.internal:9464` 抓取。

---

## 3. 无 Docker 时的验证方式（✅ 可执行）

在服务端接入 `prom-client` 后，不启动 Prometheus 也能验证指标：

```bash
curl http://127.0.0.1:9464/metrics
```

Windows PowerShell：

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:9464/metrics").Content
```

---

## 4. 指标清单（待填充）

> 服务端使用 `prom-client` 注册，命名规范：`fps_<对象>_<动作/状态>_<单位>`。

| 指标 | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `fps_room_active` | Gauge | — | 当前活跃房间数 |
| `fps_player_online` | Gauge | `room` | 在线玩家数 |
| `fps_tick_duration_seconds` | Histogram | — | 单逻辑帧耗时 |
| `fps_message_total` | Counter | `type` | 接收消息总数 |
| `fps_message_rate_per_player` | Histogram | — | 单玩家每秒消息数 |
| `fps_violation_total` | Counter | `kind` | 违规事件数（见 `04-security-audit.md`） |
| `fps_audit_write_failure_total` | Counter | — | 审计写入失败数 |

**填充位置**：实现 `apps/server/src/monitoring/metrics.ts` 后回填真实指标名与标签。

---

## 5. Grafana 看板（待填充）

- 数据源已通过 `monitoring/grafana/provisioning/datasources/prometheus.yml` 自动注册（默认数据源）。
- 看板 JSON 放置目录：`monitoring/grafana/dashboards/`（当前仅有 `.gitkeep`），由 `provisioning/dashboards/dashboard.yml` 每 30 秒扫描导入。

计划看板：

1. **概览**：在线玩家、房间数、消息速率、帧耗时
2. **安全**：违规事件趋势、限流命中、审计写入失败
3. **性能**：P95/P99 延迟、CPU/内存（`process_*` 默认指标）

**填充位置**：导出 JSON 后登记文件名与截图（放 `docs/assets/`，后续创建）。

---

## 6. 告警规则（待填充）

> 计划文件：`monitoring/prometheus/alerts.yml`（在 `prometheus.yml` 的 `rule_files` 中启用）。
> 候选规则：帧耗时 P95 持续 5 分钟 > 50ms；违规事件 1 分钟内 > 20 次；审计写入失败 > 0；在线玩家骤降 50%。

**填充位置**：`## 6.` 正下方，附规则 YAML 与触发截图。

---

## 7. 待办清单

- [ ] 安装 Docker Desktop 并首次启动 Prometheus + Grafana
- [ ] 实现 `src/monitoring/metrics.ts` 并回填第 4 节指标表
- [ ] 导出看板 JSON 到 `monitoring/grafana/dashboards/`
- [ ] 编写告警规则并验证触发
