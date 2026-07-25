# 上线前风险治理清单

## Ubuntu 简化部署流程

代码改进完成后，在 Ubuntu 服务器进入 `baking-saas-backend` 目录，常规上线只需要：

```bash
docker compose up -d --build
```

Nginx 保持反代到本机后端：

```nginx
proxy_pass http://127.0.0.1:9527;
```

`docker-compose.yml` 已固定只监听 `127.0.0.1:9527`，Postgres 不开放宿主端口，所以不需要每次额外传 `--env-file .env.production`。真实配置集中维护在 `.env.production`。

后端容器启动时会自动等待数据库、执行 Prisma migration、执行生产 seed，并在这些步骤成功后启动应用。

## P0 上线安全配置

- CORS：生产环境必须配置 `CORS_ORIGINS`，多个正式域名用英文逗号分隔；开发环境仍允许本地跨域。
- Swagger：生产环境默认关闭；如需临时开启，必须同时设置 `SWAGGER_ENABLED=true`、`SWAGGER_USER`、`SWAGGER_PASSWORD`，并建议只对内网或 VPN 开放。
- 端口暴露：`docker-compose.yml` 固定只把后端绑定到 `127.0.0.1:9527`，由宿主机 Nginx 反代访问；Postgres 不映射宿主端口。
- 密钥：真实的 `POSTGRES_PASSWORD`、`DATABASE_URL`、`JWT_SECRET`、支付、短信、智能导入 API Key 只放服务器环境文件或 secret 管理系统，不提交到仓库。
- 覆盖检查：上线前执行 `docker compose config`，确认 `PAYMENT_PROVIDER` 是预期值，`DATABASE_URL` 指向 compose 内部 `db` 服务。短信未接腾讯云前可使用 `SMS_PROVIDER=disabled` + `MANUAL_SMS_VERIFICATION_ENABLED=true`，并由超级管理员端人工协助验证；接入腾讯云后再改为 `SMS_PROVIDER=tencent`。

## 完整 Nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:9527;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## P1 数据增长策略

- 已补索引：生产任务日期/状态、生产日志完成时间、任务清单角色/产品、原料消耗流水、导入任务状态、审计日志时间/结果。
- 审计日志：建议保留最近 180 天在线查询；更久数据按月导出到冷存储后清理。
- 导入诊断：`diagnosticExpiresAt` 到期后清理 `sourceData`、`sourceText`、模型原始输出，只保留任务状态和摘要。
- 生产日志：不建议上线初期删除，因为成本、用量趋势、追溯都依赖它；半年后按租户规模评估归档只读历史库。
- 生产任务快照：完成任务的 `recipeSnapshot` 是追溯依据，先保留；若体积增长明显，再设计按年月压缩或冷存储。

## P2 重接口优化队列

- 配方列表：`recipes.service.ts#findAll` 仍有较重 include，并逐个配方 `groupBy` 统计生产次数；下一步建议改为批量聚合所有产品的任务次数。
- 前置准备：`production-tasks.service.ts` 会按当天任务逐个组装执行数据和 BOM；先用新增索引托底，再观察慢日志决定是否加短 TTL 缓存。
- 统计接口：原料消耗、用量趋势、成本历史应在线上用真实数据跑 `EXPLAIN ANALYZE`，避免只凭空库判断。

## P3 前端一致性

- 关键操作后应确认 stale 标记：完成任务、任务改期、保存配方、切换当前版本、更新采购价、启用 SKU。
- 提交前校验：完成任务和版本切换这类多人敏感操作，建议后续增加 `updatedAt` 或版本号校验，发现过期则提示刷新。

## P4 监控与回滚

- 慢接口重点：配方列表、前置准备详情、BOM PDF、原料列表、消耗流水、成本趋势、智能导入。
- 日志：应用已记录慢请求路径、耗时和状态码，默认阈值 `SLOW_REQUEST_THRESHOLD_MS=1000`；数据库开启慢查询日志并从 500ms 起步观察。
- 回滚：每次上线前备份数据库；应用回滚使用上一版镜像；Prisma 迁移仅追加索引，回滚时可保留索引或手动 `DROP INDEX CONCURRENTLY`。
