# 11. 产品边界、依赖关系与责任主体

- 状态：active
- 负责人：Cloud
- 最后更新时间：2026-07-02
- 依赖：`02-architecture.md`、`04-release-flow.md`、`05-device-update-flow.md`、`10-development-rules.md`

## 目标

本文件用于把近期更新过程中暴露出的“谁负责什么、谁不该负责什么”写成项目级边界，避免继续用一个万能更新模块混合处理多种产品职责。

## 产品面划分

### Web UI Product

- 范围：浏览器前端、Koa 服务、Web UI 状态目录、页面内更新入口、更新状态展示。
- 允许负责：
  - 发现新版本
  - 执行更新前检查
  - 写入 runner 请求
  - 展示阶段状态、失败信息、回滚结果
- 禁止负责：
  - 创建系统用户
  - 安装 Node
  - 写入 sudoers
  - 安装或修复 systemd
  - 隐式升级 Hermes Agent

### Hermes Agent Product

- 范围：Hermes runtime、wheel/venv、profiles、Agent CLI、相关依赖。
- 允许负责：
  - Agent 自身版本升级
  - profile 兼容性治理
  - Agent 运行时健康
- 禁止负责：
  - 替代 Web UI 更新流程
  - 接管宿主机初始化

### Device Runtime Product

- 范围：主机 OS、系统用户、部署目录、sudoers、systemd、系统依赖、设备健康恢复。
- 允许负责：
  - bootstrap
  - 宿主机准备
  - 权限修复
  - 服务注册与恢复
- 禁止负责：
  - 被普通页面更新链路隐式调用
  - 直接消费未校验的前端输入

### Release And Distribution Product

- 范围：Git tag、GitHub Release、OSS、manifest、latest.json、device package、npm package。
- 允许负责：
  - 生成交付物
  - 维护发布契约
  - 发布后校验资产可下载且摘要一致
- 禁止负责：
  - 修改设备运行时策略
  - 私自推断页面内更新行为

## 依赖方向

- `Web UI Product -> Release And Distribution Product`：允许，只能消费发布契约。
- `Web UI Product -> Device Runtime Product`：禁止直接依赖，只能通过受控 runner/installer seam 触达。
- `Web UI Product -> Hermes Agent Product`：允许读取版本和健康信息，不允许默认绑定升级动作。
- `Device Runtime Product -> Release And Distribution Product`：允许，用于拉取确定产物和执行校验。
- `Hermes Agent Product -> Release And Distribution Product`：允许，但应通过独立 manifest 或显式配置表达。

## 责任主体

- 产品团队：
  - 明确本次需求属于哪个产品面
  - 明确是否允许伴随升级 Hermes Agent
  - 明确现场回滚口径
- 开发团队：
  - 将边界固化为 controller、service、runner、script 的结构边界
  - 维护共享契约、错误码、日志结构和测试
- 运维团队：
  - 负责 bootstrap、宿主机依赖、systemd/sudoers、手工引导和回滚执行
  - 维护现场 SOP 和异常收集项
- 发布负责人：
  - 负责 tag、asset、manifest、latest、OSS 一致性
  - 负责发布后可下载性和摘要一致性验证

## 边界判定规则

- 若动作需要 root 常驻权限、用户创建、系统服务注册，则归属 `Device Runtime Product`。
- 若动作只是页面内检测新版本、展示进度、触发受控 runner，则归属 `Web UI Product`。
- 若动作是 wheel、venv、profile 或 CLI 生命周期变更，则归属 `Hermes Agent Product`。
- 若动作是资产、manifest、release 元数据生产和发布，则归属 `Release And Distribution Product`。

## 当前强制规则

- 页面内更新默认只更新 Web UI，不自动升级 Hermes Agent。
- Hermes Agent 升级必须在需求评审、发布说明和运行时开关三个层面都显式出现。
- bootstrap、runtime reconcile、repair、Agent upgrade 不能继续长期塞进同一个脚本职责里。
- 文档、workflow、controller、installer 必须共享同一发布契约语义。
