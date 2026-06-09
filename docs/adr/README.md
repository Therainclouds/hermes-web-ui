# ADR 索引

本目录记录设备端自有更新包分发相关的关键架构决策。

## 目录

- `ADR-0001-device-update-release-source.md`：设备更新的事实源与分发源选择
- `ADR-0002-device-update-permission-model.md`：用户可自助更新、安装器短时提权
- `ADR-0003-device-package-format.md`：设备更新包格式选择
- `ADR-0004-device-update-rollback-strategy.md`：失败自动回退与未来手动回滚策略

## 使用规则

- 关键决策必须记录到 ADR，而不是仅留在计划文档中。
- 若后续变更推翻既有决策，应新增后续 ADR，而不是静默改写历史。
