# 设备端自有更新包分发设计索引

- 状态：active
- 负责人：Cloud
- 最后更新时间：2026-07-02
- 适用范围：Hermes Web UI 设备端 `source-deploy` / 一键部署脚本 / `systemd`

## 目标

本目录用于沉淀 Web UI 设备端自有更新包分发方案，覆盖以下问题：

- 为什么要从 GitHub tag archive 演进到自有下载源
- 更新包和 manifest 应如何定义
- 发布流程、设备侧安装流程、环境变量如何收敛
- 如何做到校验、失败自动回退，以及未来手动回滚
- 如何把方案拆成可执行的实施阶段，并确保全程透明可追溯

## 阅读顺序

1. `01-requirements.md`：背景、目标、非目标、约束、术语
2. `02-architecture.md`：整体架构、模块职责、权限模型、技术边界
3. `03-package-spec.md`：更新包格式、目录结构、命名、manifest schema
4. `04-release-flow.md`：发布与分发流程
5. `05-device-update-flow.md`：设备侧检测、下载、校验、安装、回退流程
6. `06-env-and-config.md`：环境变量和配置兼容策略
7. `07-implementation-plan.md`：分阶段实施与逐文件变更清单
8. `08-validation-and-rollback.md`：验证矩阵、失败回退、未来回滚路径
9. `09-manual-source-upgrade-sop.md`：设备端源码包手工升级、数据保护与回滚 SOP
10. `10-development-rules.md`：需求评审、开发、提测、发布、部署、应急与监督规则
11. `11-product-boundaries-and-dependencies.md`：项目级产品边界、依赖矩阵和责任主体
12. `12-runtime-module-split-plan.md`：bootstrap、日常更新、运行时修复、Agent 升级拆分路线
13. `13-update-events-audit.md`：近 3 次更新事件审计、问题清单与根因分类
14. `open-questions.md`：未决问题与待确认项
15. `change-log.md`：本轮设计过程记录

## 文档原则

- 单一事实源：本主题下的关键设计以本目录和 `docs/adr/` 为准。
- 决策留痕：重大取舍必须写入 ADR，而不是仅停留在计划文档中。
- 先设计后实现：进入执行前，必须先把已确认边界同步到工作文档和专项开发规则。
- 兼容优先：第一阶段设计必须兼容现有 `source-deploy` 链路。
- 透明可追溯：每份文档都记录状态、更新时间、依赖与未决项。
- 项目级对齐：当设备更新专项规则影响仓库级边界时，必须同步回写 `ARCHITECTURE.md`。

## 关键结论摘要

- 主服务继续以普通用户运行，不改为 `root` 常驻。
- 登录用户可以触发升级到当前官方稳定版。
- 高权限动作收敛到受控安装器，而不是扩大到整个 Web UI 进程。
- 设备更新新增 `device-package` 策略，逐步替代 GitHub archive 下载链路。
- 短期可保留 `npm` 作为版本发现源，长期演进到 manifest 单一事实源。
- MVP 先做校验和失败自动回退，后续再做指定版本回滚。
- Web UI、Hermes Agent、Device Runtime、Release And Distribution 是 4 个不同产品面，不允许继续混成一个万能更新模块。
- `deploy-source-armbian.sh` 的长期目标是拆分为 bootstrap、runtime reconcile 和显式 Agent upgrade，而不是继续堆叠环境变量模式。
- 页面内更新默认只处理 Web UI 版本切换，不再把 Hermes Agent 升级作为隐式副作用。

## 关联文档

- 现有运维手册：`docs/deploy-update-runbook.md`
- 现有源码部署：`docs/deploy-source-armbian.md`
- 现有发布说明：`docs/npm-release.md`
- 现场手工升级 SOP：`docs/update-distribution/09-manual-source-upgrade-sop.md`
- 架构决策记录：`docs/adr/README.md`
