# 06. 环境变量与配置设计

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-10
- 依赖：`01-requirements.md`、`02-architecture.md`

## 设计原则

- 新配置使用结构化语义，避免继续堆叠无上下文字符串。
- 第一阶段兼容现有 `WEBUI_UPDATE_*` 变量。
- 仅允许部署层和运维层设置更新源与通道，不开放前端动态修改。

## 兼容保留变量

- `WEBUI_UPDATE_ENABLED`
- `WEBUI_UPDATE_SOURCE_LABEL`
- `WEBUI_UPDATE_STRATEGY`
- `WEBUI_UPDATE_SCRIPT`
- `WEBUI_UPDATE_PACKAGE`
- `WEBUI_UPDATE_REGISTRY`
- `WEBUI_UPDATE_REPO`

## 新增变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEBUI_UPDATE_MANIFEST_URL` | 空 | 完整 manifest 地址，优先级最高 |
| `WEBUI_UPDATE_MANIFEST_BASE_URL` | 空 | `latest.json` 稳定入口前缀，第一阶段建议指向 `release-manifests` 分支的 `releases/` 根路径 |
| `WEBUI_UPDATE_CHANNEL` | `stable` | 更新通道 |
| `WEBUI_UPDATE_PACKAGE_TYPE` | `device-package` | 更新策略对应包类型 |
| `WEBUI_UPDATE_VERIFY_SHA256` | `true` | 是否强制校验摘要 |
| `WEBUI_UPDATE_STAGING_DIR` | `${DEPLOY_DIR}/.releases/staging` | 下载与解包临时目录 |
| `WEBUI_UPDATE_BACKUP_DIR` | `${DEPLOY_DIR}/.releases/backups` | 备份目录 |
| `WEBUI_UPDATE_HEALTHCHECK_URL` | `http://127.0.0.1:${PORT}/health` | 更新后的健康检查地址 |
| `WEBUI_UPDATE_HEALTHCHECK_TIMEOUT` | `60` | 健康检查超时秒数 |
| `WEBUI_UPDATE_KEEP_BACKUP_COUNT` | `3` | 保留最近备份数量 |
| `WEBUI_UPDATE_PERMISSION` | `self-service` | 权限模型，默认允许登录用户触发稳定版更新 |

## 配置优先级建议

1. `WEBUI_UPDATE_MANIFEST_URL`
2. `WEBUI_UPDATE_MANIFEST_BASE_URL + WEBUI_UPDATE_CHANNEL`
3. 兼容旧的 `WEBUI_UPDATE_PACKAGE + WEBUI_UPDATE_REGISTRY` 检测链路

当仅配置 `WEBUI_UPDATE_MANIFEST_BASE_URL` 时，服务端会按以下规则拼接稳定入口：

```text
${WEBUI_UPDATE_MANIFEST_BASE_URL}/${WEBUI_UPDATE_CHANNEL}/latest.json
```

## 服务端配置收敛方向

建议在 `config.update` 中形成以下结构：

```ts
update: {
  enabled: boolean,
  strategy: 'npm-package' | 'source-deploy' | 'device-package',
  sourceLabel: string,
  channel: string,
  manifestUrl: string,
  manifestBaseUrl: string,
  packageType: 'device-package',
  verifySha256: boolean,
  healthcheckUrl: string,
  healthcheckTimeout: number,
  permission: 'self-service' | 'owner-only' | 'admin-only'
}
```

## 推荐默认值

- 主服务默认继续兼容旧部署。
- 新设备上线时推荐直接使用：
  - `WEBUI_UPDATE_STRATEGY=device-package`
  - `WEBUI_UPDATE_CHANNEL=stable`
  - `WEBUI_UPDATE_VERIFY_SHA256=true`
  - `WEBUI_UPDATE_PERMISSION=self-service`

## 不建议暴露到前端的配置

- manifest 真实下载地址
- 摘要校验开关
- 历史版本切换能力
- 回滚保留数量
