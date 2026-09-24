# ADR-0005：专家市场接入与 Profile 集成策略

## 状态

已接受

## 日期

2026-06-17

## 背景

项目计划接入一个云端“专家系统 / 专家团市场”，由云端管理后台维护专家目录、版本、发布状态和资源包分发，本地 `hermes-web-ui` 负责消费这些已发布内容。

在方案讨论过程中，需要明确以下关键问题：

- 专家和专家团是否应直接映射为真实登录用户
- 本地应如何保存专家安装状态
- 激活后的专家身份如何进入现有聊天、全局代理和后续群聊/任务体系
- 本地与云端之间如何划分职责

当前仓库已有如下事实：

- 登录用户与权限模型已经独立存在
- `profile` 已经是本地 AI 配置身份的核心承载对象
- `skills`、头像、部分运行时元信息天然与 `profile` 更贴近
- 聊天和全局代理链路已经围绕 `profile` 运转

因此需要一份明确的架构决策，避免后续把“登录账户”“专家身份”“Agent 角色”混在一起。

## 决策

### 1. 云端专家市场作为外部分发源接入

`hermes-web-ui` 不负责管理专家目录主数据，只作为消费端对接云端专家市场。

本地通过受控接口读取：

- 专家目录
- 专家详情
- 最新已发布版本
- 版本 manifest
- 下载地址与校验信息

### 2. 专家激活后映射为本地 Profile，而不是登录用户

下载并激活某个专家或专家团后，本地创建的是 `expert profile`，而不是新增真实登录用户。

理由：

- 登录用户承担鉴权和授权职责，不适合作为 AI 预设身份容器
- `profile` 已经天然承载 AI 身份、技能、头像、工作上下文等配置
- 将专家映射为用户会污染用户管理、权限审计和登录模型
- 用户体验上可以保留“像一个预设人物”的感受，但底层对象应保持为 `profile`

### 3. 用户自建 Profile 与专家 Profile 必须显式区分

本地需要在 `profile` 元数据上增加来源标记，用于区分：

- 普通用户自建 profile
- 由专家包激活生成的 expert profile

建议增加的语义字段：

- `sourceType = user_created | expert_package`
- `expertSlug`
- `installedVersion`

### 4. 模型配置由用户自行决定

专家包只提供：

- 角色设定
- system prompt
- 欢迎语
- 默认 skills
- 可选 memory seed
- 启动建议

专家包不绑定用户模型秘钥，也不覆盖用户现有 provider / model 配置。

### 5. 首版优先接入 Chat / Global Agent

首版不强求立即打通 Group Chat / Jobs / Kanban。

优先路径：

- Experts 目录页
- 下载并激活
- 创建 expert profile
- 进入 Chat / Global Agent 使用

后续再扩展到：

- 专家团协作 UI
- 任务编排
- 群聊团队房间

## 设计细节

### 本地职责

本地 `hermes-web-ui` 负责：

- 拉取云端专家目录
- 展示 Experts 列表与详情
- 下载 ZIP 包
- 校验 SHA256
- 解压与落盘
- 创建/更新 expert profile
- 记录安装状态
- 卸载与升级

### 云端职责

云端管理后台负责：

- 管理专家、专家团、分类、版本、发布状态
- 返回 catalog/detail/latest/manifest/download 能力
- 保存资源元数据与校验值

### 本地数据对象

建议新增两个核心对象：

#### `installed_experts`

记录安装状态。

建议字段：

- `id`
- `expert_slug`
- `expert_name`
- `kind`
- `installed_version`
- `status`
- `source_manifest_url`
- `installed_at`
- `updated_at`

#### `expert_profile_bindings`

记录专家包与 profile 的绑定关系。

建议字段：

- `id`
- `expert_slug`
- `profile_id`
- `profile_name`
- `installed_version`
- `created_at`

### 本地资源目录

建议落盘目录：

```text
<app-home>/experts/packages/<expert-slug>/<version>/
```

典型内容：

- `expert.json`
- `profile-template.json`
- `prompts/system.md`
- `skills.json`
- `assets/avatar.png`
- `starter-prompts.json`
- `team.json` 仅专家团需要

### Profile 元数据建议

建议在 profile 元数据层增加如下信息：

- `isExpertProfile: true`
- `expertSlug`
- `expertKind`
- `expertVersion`
- `sourceType: expert_package`

用于：

- 在 Profiles 页面打标签
- 在 Chat / Global Agent 中显示当前专家身份
- 升级或卸载时精准定位来源

## 安装流程

建议流程如下：

1. 用户进入 `Experts` 页面
2. 查看云端目录与详情
3. 点击“下载并激活”
4. 本地请求云端下载接口，拿到 `download_url + sha256 + size`
5. 下载 ZIP 到临时目录
6. 校验 SHA256
7. 解压到本地专家目录
8. 写入 `installed_experts`
9. 创建或更新 `expert profile`
10. 写入 `expert_profile_bindings`
11. 跳转 Chat / Global Agent

## 升级策略

升级专家时遵循“内容更新，不覆盖用户模型配置”的原则。

升级流程：

1. 检查云端是否有更新版本
2. 下载新包并校验
3. 替换本地资源目录
4. 更新 `installed_experts.installed_version`
5. 更新与 expert profile 相关的预设内容
6. 保留用户本地模型选择与自定义 provider 配置

## 卸载策略

卸载时只移除专家相关内容，不影响用户自建 profile。

卸载流程：

1. 删除专家资源目录
2. 删除安装记录
3. 删除 expert profile 绑定
4. 删除对应 expert profile

约束：

- 若用户已经把某 expert profile 深度改造成自定义 profile，后续可考虑“转存为普通 profile”，首版暂不支持

## 为什么不采用“专家即用户”

该方案被明确拒绝，原因如下：

- 会向真实用户体系注入大量不可登录的伪用户
- 会让用户管理页面与权限审计复杂化
- 会导致登录用户、房间 Agent、AI 预设身份三种概念混淆
- 不利于后续在本地端做“用户自建 profile”和“云端专家 profile”的边界管理

## 影响

### 正面影响

- 清晰隔离登录用户与 AI 身份
- 复用现有 profile 生态，降低接入成本
- 更容易接入 Chat / Global Agent
- 后续扩展 Group Chat / Jobs 时，仍可围绕 profile 演进

### 代价

- 需要新增本地安装状态表和绑定表
- 需要对 `profiles` 相关接口与前端显示做小幅增强
- 需要在升级流程中谨慎保留用户模型配置

## 首版范围

首版纳入：

- 云端目录读取
- 本地目录页展示
- 下载与校验
- 激活为 expert profile
- 在 Profiles 页面显示专家标记
- 从 Chat / Global Agent 启动

首版不纳入：

- 自定义专家市场
- 本地拖拽式团队编排
- 自动推荐最优专家
- 复杂团队执行可视化
- 多版本并存运行

## 后续演进

当基础接入稳定后，再考虑：

- 专家团映射到 Group Chat 房间模板
- 专家团任务流映射到 Jobs / Kanban
- 专家升级提示与一键升级
- 客户端缓存与离线可用策略
- 本地“复制专家为自定义 profile”

## 关联文档

- `G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_marketplace_design.md`
- `G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_marketplace_task_specs.md`
- `docs/project-structure.md`
- `docs/plans/expert_marketplace_local_task_specs.md`
- `docs/adr/README.md`
