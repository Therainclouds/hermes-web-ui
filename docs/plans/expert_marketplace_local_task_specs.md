# Hermes 本地专家接入开发边界与任务 Specs

> 版本：v1.0  
> 更新时间：2026-06-20  
> 状态：可派工

---

## 1. 文档目标

本文档定义 `hermes-web-ui` 在“专家系统 / 专家团”项目中的本地端职责、技术收束边界与开发任务拆分，供前后端协同和排期使用。

本文档只覆盖本地消费端，不覆盖云端专家市场后台。

关联决策：

- `docs/adr/ADR-0005-expert-marketplace-profile-integration.md`

---

## 2. 开发边界

### 2.1 本仓库负责

本仓库负责：

- 拉取云端专家目录
- 展示 Experts 列表与详情
- 下载专家包
- SHA256 校验
- 解压与本地落盘
- 记录安装状态
- 激活为 `expert profile`
- 升级与卸载
- 从 Chat / Global Agent 启动专家身份

### 2.2 本仓库不负责

本仓库不负责：

- 云端专家目录管理
- 云端发布流程
- 专家版本创建
- 专家包内容编辑
- 专家市场运营管理

---

## 3. 技术收束边界

### 3.1 固定技术栈

本地实现保持当前真实技术栈：

- 前端：`Vue 3 + Pinia + Vue Router`
- 本地后端：`Koa BFF`
- 本地数据库：`SQLite`

### 3.2 固定身份模型

固定采用：

- `User = 登录账户`
- `Profile = 本地 AI 身份`
- `Expert Package = 云端专家安装包`
- `Expert Profile = 激活后的本地 profile`

明确禁止：

- 把专家写入真实登录用户体系

### 3.3 固定安装模型

固定安装链路：

```text
目录 -> 下载 -> SHA256 校验 -> 解压 -> 安装记录 -> 创建/更新 expert profile
```

### 3.4 固定首版入口

首版只接入：

- `Experts` 页面
- `Profiles`
- `Chat`
- `Global Agent`

首版不接入：

- `Group Chat`
- `Jobs`
- `Kanban`

### 3.5 固定升级原则

升级专家时：

- 更新专家资源与预设内容
- 保留用户已有模型配置

---

## 4. 验收总原则

- 不破坏现有 `profiles` 主链路
- 不污染真实登录用户体系
- 安装、升级、卸载过程可回滚
- 本地错误处理必须覆盖下载失败、校验失败、解压失败
- Profiles 页面能明确区分普通 profile 与 expert profile

---

## 5. 任务总览

| Spec | 名称 | 负责人建议 | 依赖 |
|------|------|------------|------|
| `SPEC-09` | 本地 Experts 目录页 | 前端 | 云端公开 API 就绪 |
| `SPEC-10` | 本地安装桥接接口 | 本地后端 | 云端下载接口 |
| `SPEC-11` | expert profile 激活 | 本地后端 | `SPEC-10` |
| `SPEC-12` | Chat / Global Agent 接入 | 前端 + 本地后端 | `SPEC-11` |
| `SPEC-13` | 升级与卸载闭环 | 本地后端 | `SPEC-11` |
| `SPEC-14` | QA 与回归验证 | QA | 主链路完成 |

---

## 6. SPEC-09 本地 Experts 目录页

### 背景

用户需要在本地 UI 中看到云端专家目录，才能进行下载和激活。

### 目标

新增目录式 `Experts` 页面。

### 范围

- 路由入口
- 目录列表
- 分类筛选
- 详情展示
- 已安装状态展示

### 改动范围

- `packages/client/src/router/index.ts`
- `packages/client/src/views/hermes/ExpertsView.vue`
- `packages/client/src/views/hermes/ExpertDetailView.vue`
- `packages/client/src/stores/hermes/experts.ts`
- `packages/client/src/api/hermes/experts.ts`

### 验收标准

- 用户可以浏览专家与专家团
- 可以看到是否已安装
- 页面不依赖手工刷新即可显示目录结果

### 不包含

- 不包含安装逻辑

---

## 7. SPEC-10 本地安装桥接接口

### 背景

前端不应直接下载和解压 ZIP 包，本地后端需要统一处理安装链路。

### 目标

实现 Koa 本地 experts 路由与安装服务。

### 范围

- 请求云端 download 接口
- 下载 ZIP
- 校验 SHA256
- 解压到本地目录
- 写入安装记录

### 改动范围

- `packages/server/src/routes/hermes/experts.ts`
- `packages/server/src/controllers/hermes/experts.ts`
- `packages/server/src/services/hermes/experts/*`
- `packages/server/src/db/hermes/experts-store.ts`

### 验收标准

- 输入专家版本后可以完成下载、校验和落盘
- 失败时不会留下半安装状态

### 不包含

- 不包含 profile 创建

---

## 8. SPEC-11 expert profile 激活

### 背景

安装完成后，专家必须映射为本地可用的 AI 身份。

### 目标

将已安装专家包激活为 `expert profile`。

### 范围

- 读取 `profile-template.json`
- 创建或更新 profile
- 写入 profile 来源标记
- 建立安装记录与 profile 绑定

### 建议数据对象

- `installed_experts`
- `expert_profile_bindings`

### 验收标准

- 激活后能在 Profiles 页面看到专家身份
- `expert profile` 与普通 profile 可区分
- 不创建真实登录用户

### 不包含

- 不包含聊天入口改造

---

## 9. SPEC-12 Chat / Global Agent 接入

### 背景

激活 expert profile 之后，用户需要立即可用，而不是停留在 profile 管理层。

### 目标

支持从 expert profile 直接进入聊天和全局代理。

### 范围

- Chat 启动时识别 expert profile
- Global Agent 启动时识别 expert profile
- UI 上显示当前专家身份标记

### 改动范围

- `packages/client/src/components/hermes/chat/ChatPanel.vue`
- `packages/client/src/views/hermes/GlobalAgentView.vue`
- 相关 profile / session store

### 验收标准

- 用户可基于 expert profile 开始会话
- 仍由用户自己控制模型与 provider

### 不包含

- 不包含 Group Chat / Jobs

---

## 10. SPEC-13 升级与卸载闭环

### 背景

专家内容是版本化资产，必须支持本地升级与卸载。

### 目标

实现升级、卸载和失败回滚。

### 范围

- 检测新版本
- 下载新版本并替换本地资源
- 保留用户模型配置
- 删除专家资源目录
- 删除安装记录与绑定

### 验收标准

- 升级后不丢用户模型配置
- 卸载不误删普通 profile
- 失败时可回到稳定状态

### 不包含

- 不做多版本并存运行

---

## 11. SPEC-14 QA 与回归验证

### 背景

该项目横跨云端和本地端，主路径较长，必须单独做回归验证。

### 目标

验证从云端发布到本地激活的主链路。

### 范围

- 目录读取
- 下载
- 验签
- 安装
- 激活
- 聊天启动
- 升级
- 卸载

### 验收标准

- 主路径全通过
- 异常路径至少覆盖下载失败、校验失败、解压失败

### 不包含

- 不做性能压测

---

## 12. 推荐分工

### 本地前端

- `SPEC-09`
- `SPEC-12`

### 本地后端

- `SPEC-10`
- `SPEC-11`
- `SPEC-13`

### QA

- `SPEC-14`

---

## 13. 执行顺序

推荐顺序：

1. `SPEC-09`
2. `SPEC-10`
3. `SPEC-11`
4. `SPEC-12`
5. `SPEC-13`
6. `SPEC-14`

---

## 14. 关联文档

- `docs/adr/ADR-0005-expert-marketplace-profile-integration.md`
- `docs/project-structure.md`
- `G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_marketplace_task_specs.md`

