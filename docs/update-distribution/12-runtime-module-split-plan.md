# 12. 运行时模块拆分计划

- 状态：active
- 负责人：Cloud
- 最后更新时间：2026-07-02
- 依赖：`11-product-boundaries-and-dependencies.md`、`10-development-rules.md`

## 目标

把当前脚本体系从“一个入口处理所有事情”演进为明确职责的 4 条链路，减少单点脚本继续膨胀。

## 当前问题

- `deploy-source-armbian.sh` 同时承担 bootstrap、系统依赖安装、Node 安装、Hermes Agent 安装、Web UI 构建、systemd/sudoers 安装、更新 runner 安装与健康检查。
- `update-source-deploy.sh` 和 `install-device-package.sh` 在页面内更新场景下默认顺带升级 Hermes Agent，形成隐式副作用。
- 现场 SOP 需要额外提醒“保留端口”“不要直接 source env”“不要使用 stable/latest.json”，说明脚本边界无法自解释。

## 目标模块

### bootstrap

- 负责：首次安装、系统依赖、系统用户、sudoers、systemd、目录初始化。
- 不负责：普通版本更新、页面内更新编排。

### runtime reconcile

- 负责：把一个已知产物应用到现有运行时、重建产物、恢复服务健康。
- 不负责：宿主机初始化、版本发现。

### web-ui update

- 负责：版本发现、preflight、runner request、状态落盘、页面状态展示。
- 不负责：隐式升级 Hermes Agent、宿主机准备。

### hermes-agent upgrade

- 负责：独立升级 Agent wheel/venv 和相关兼容处理。
- 不负责：默认附着在所有 Web UI 更新之后。

## 拆分路线

### 第一阶段

- 保持现有脚本文件名不变。
- 新增显式开关，默认让页面内更新只执行 Web UI 更新。
- 保留 `DEPLOY_HERMES_AGENT_ONLY=true` 作为独立 Agent 升级入口。

### 第二阶段

- 从 `deploy-source-armbian.sh` 中拆出 bootstrap 子模块。
- 把 systemd/sudoers/用户创建相关逻辑下沉到 bootstrap 脚本或受控安装器。
- 把 `update-only` 模式明确限定为 runtime reconcile。

### 第三阶段

- 将 Web UI update、runtime reconcile、Agent upgrade 抽象成独立 adapter/step。
- 减少环境变量切模式，改为显式命令和清晰参数。

## 本轮已落地的约束

- 页面内 `source-deploy` / `device-package` 更新默认不升级 Hermes Agent。
- Hermes Agent 升级改为显式开关控制。
- runner allowlist 和服务端共享类型增加相关契约字段，避免脚本私自解释作用域。

## 验收标准

- 页面内更新不再默认触发 Agent 升级。
- Agent 升级可以作为独立步骤显式开启。
- bootstrap 相关职责没有继续向 controller 或页面内更新 service 反向渗透。
