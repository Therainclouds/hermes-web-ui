# 03. 更新包与 Manifest 规范

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-12
- 依赖：`02-architecture.md`、`docs/adr/ADR-0003-device-package-format.md`

## 包格式

第一阶段使用 `tar.gz` 作为设备包格式。

选择原因：

- 与当前 `source-deploy` 使用的 Linux 设备环境兼容性最好。
- 目标设备普遍原生具备 `tar` 能力。
- 实施成本低，不需要引入额外解包依赖。

## 文件命名

- 设备包：`hermes-web-ui-device-vX.Y.Z.tar.gz`
- 摘要：`hermes-web-ui-device-vX.Y.Z.tar.gz.sha256`
- 版本目录：`releases/vX.Y.Z/`
- 通道指针：`releases/stable/latest.json`

## 自有下载源目录结构

```text
GitHub Release assets:
  v0.6.13/
    hermes-web-ui-device-v0.6.13.tar.gz
    hermes-web-ui-device-v0.6.13.tar.gz.sha256
    manifest.json

release-manifests branch:
  releases/
    stable/
      latest.json
    beta/
      latest.json
    v0.6.13/
      manifest.json
      hermes-web-ui-device-v0.6.13.tar.gz.sha256
```

第一阶段说明：

- 实际设备包、`sha256` 和版本 `manifest.json` 由 GitHub Release 承载。
- 稳定入口 `latest.json` 和按版本归档的 manifest 元数据由 `release-manifests` 分支承载。
- `latest.json` 的内容与当前稳定版 manifest 保持同一 schema，避免客户端再做额外跳转解析。

## 设备包内容

设备包采用显式 allowlist 打包，发布契约定义在根目录 `.github/device-package-release.json` 的 `packageAllowlist` 字段。

第一阶段的 allowlist 固定为：

- `dist/client`
- `dist/server`
- `package.json`
- `package-lock.json`
- `scripts/deploy-source-armbian.sh`
- `scripts/hermes-web-ui.service`
- `scripts/install-device-package.sh`

含义：

- 设备包只携带运行时必需的构建产物、安装脚本与 systemd 模板。
- 发布流程必须拒绝任何未在 allowlist 中声明的额外文件。
- 若未来需要新增运行时文件，必须先更新发布契约、测试与文档，再允许进入设备包。

包内不应包含：

- `hermes_data`
- 用户上传数据
- 日志目录
- 本地缓存目录
- 设备个性化环境文件

## Manifest 字段

必选字段：

- `version`
- `channel`
- `packageType`
- `artifactFormat`
- `packageUrl`
- `sha256`
- `releasedAt`
- `compatibleNodeRange`
- `minCurrentVersion`

推荐字段：

- `sourceLabel`
- `notesUrl`
- `size`
- `buildId`
- `rollbackFromVersions`
- `healthcheckUrl`

## Manifest 示例

```json
{
  "version": "0.6.13",
  "channel": "stable",
  "packageType": "device-package",
  "artifactFormat": "tar.gz",
  "packageUrl": "https://github.com/example/hermes-web-ui/releases/download/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz",
  "sha256": "9d3b5c4f...",
  "releasedAt": "2026-06-07T12:00:00Z",
  "compatibleNodeRange": ">=23.0.0",
  "minCurrentVersion": "0.6.10",
  "sourceLabel": "Quanthermes Device Releases",
  "notesUrl": "https://github.com/example/hermes-web-ui/releases/tag/v0.6.13",
  "size": 12345678,
  "healthcheckUrl": "http://127.0.0.1:6060/health"
}
```

## 兼容规则

- `version` 必须是合法 semver。
- `packageType` 第一阶段固定为 `device-package`。
- `artifactFormat` 第一阶段固定为 `tar.gz`。
- `compatibleNodeRange` 不匹配时应拒绝安装。
- 当前版本低于 `minCurrentVersion` 时应拒绝安装并要求先升级到过渡版本。
- `WEBUI_UPDATE_MANIFEST_BASE_URL` 第一阶段应指向 `release-manifests` 分支下的 `releases/` 根路径，客户端通过 `channel/latest.json` 解析当前稳定入口。
- 设备包归档内容必须严格匹配 `packageAllowlist`，不能夹带额外脚本、说明文件或发布中间产物。

## 未来扩展

后续可增加：

- manifest 签名文件
- 多架构包命名
- 增量更新包
- 二进制 bundle 模式
