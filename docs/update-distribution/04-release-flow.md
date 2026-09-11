# 04. 发布与分发流程

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-10
- 依赖：`03-package-spec.md`、`docs/npm-release.md`

## 发布目标

让每个 `vX.Y.Z` tag 对应一组完整、可验证、可下载的设备端发布物，而不是依赖 GitHub 源码 archive 临时拼装更新链路。

## 第一阶段发布图

1. 开发完成并更新版本号。
2. 推送 `vX.Y.Z` tag。
3. CI 执行测试与构建。
4. 继续发布 npm 包，保持现有版本发现兼容。
5. 构建设备包 `hermes-web-ui-device-vX.Y.Z.tar.gz`。
6. 生成 `sha256` 和 `manifest.json`。
7. 上传设备包、摘要和 `manifest.json` 到 GitHub Release。
8. 更新 `release-manifests` 分支上的通道指针 `releases/stable/latest.json`。
9. 执行发布后校验：manifest 可访问、摘要一致、设备包结构合法。

## 建议职责划分

### npm publish workflow

职责：

- 发布 npm 包
- 保持现有版本检测链路可用

### device package release workflow

职责：

- 复用构建产物打包设备包
- 生成摘要与 manifest
- 上传到 GitHub Release
- 更新通道指针
- 执行发布后验证

## 下载源要求

- 第一阶段继续使用 GitHub，优先保证稳定性和发布闭环完整性。
- `latest.json` 入口应稳定、可镜像、可缓存。
- 目录结构固定，不依赖 GitHub archive URL 规则。
- 允许未来扩展多通道或多镜像。
- 下载速度优化不是本阶段目标，后续如需提速只替换 manifest 中的 `packageUrl`。

## 命名与地址建议

- `manifestBaseUrl`：`https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases`
- 最新稳定版：`https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases/stable/latest.json`
- 版本 manifest：`https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases/v0.6.13/manifest.json`
- 设备包：`https://github.com/<owner>/<repo>/releases/download/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz`

## 发布失败处理

- 若设备包上传失败，则不更新 `latest.json`。
- 若摘要校验失败，则整次发布视为失败。
- 若 `release-manifests` 分支推送失败，则整次发布视为失败，并保留 GitHub Release 资产但不视为稳定入口已切换。
- 若 npm 已发布但设备包未发布成功，需在变更日志中明确记录双轨不一致状态，并阻止切换默认策略。

## 透明追踪要求

- 每次发布应保留构建日志、摘要、manifest 和上传记录。
- 发布任务结果写入 CI artifact 或工作流 summary。
- 若出现回退或补发，必须在 `change-log.md` 记录原因与影响范围。
