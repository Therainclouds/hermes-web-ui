# 工作日志 — 2026-09-03

## 用户身份系统重构（手机号 1:1 绑定）

### 背景
BOSS 要求实现超级管理员与微信号的 1:1 绑定，手机号作为微信↔本地账户的身份桥梁。此前微信号绑定是独立的多对多关系，缺乏与本地用户的强关联。

### 设计方案
- **身份桥梁**：手机号（Token Platform 用户资料已携带 `phone` 字段）
- **绑定规则**：严格 1:1 — 一个微信号只能绑定一个本地用户，一个手机号只能关联一个用户
- **登录流程**：微信扫码 → Token Platform 返回用户资料（含手机号） → 按手机号匹配已有用户 → 无匹配则自动创建
- **保护机制**：解绑微信前必须确保用户已有手机号（防止产生无身份的账户）
- **部署形态**：本地设备 + 云端，数据本地化存储

### 变更文件清单

#### 服务端（7 个文件）
| 文件 | 改动说明 |
|------|----------|
| `packages/server/src/db/hermes/schemas.ts` | users 表新增 `phone_number`、`wechat_bound` 列；新增 `USERS_INDEXES`（唯一部分索引）；新增 `schema_migrations` 表 + v1 migration `user_identity_refactor`（幂等 SQL，服务启动时自动执行） |
| `packages/server/src/db/hermes/users-store.ts` | `UserRecord` / `UserSummary` 接口加字段；新增 `normalizePhoneNumber()`、`findUserByPhoneNumber()`、`updateUserPhoneNumber()`、`setUserWeChatBound()`；`createUser()` / `updateUser()` 支持手机号参数 |
| `packages/server/src/db/hermes/wechat-bindings-store.ts` | 新增 `findUnboundUserByPhone()` — 按手机号查找未绑定的用户 |
| `packages/server/src/controllers/auth.ts` | `deviceLogin()` 重写为手机号 1:1 匹配流程（4 步：已有绑定 → 手机号匹配 → tp_用户名回退 → 自动创建）；新增 `bindPhone()` / `unbindPhone()` 端点；`clearDeviceBindingController()` 增加手机号保护校验；`createManagedUser()` / `updateManagedUser()` 支持手机号 |
| `packages/server/src/routes/auth.ts` | 注册 `POST /api/auth/bind-phone` 和 `DELETE /api/auth/phone` 到受保护路由 |

#### 客户端（5 个文件）
| 文件 | 改动说明 |
|------|----------|
| `packages/client/src/api/auth.ts` | `CurrentUser` / `ManagedUser` 接口加 `phone_number`、`wechat_bound`；新增 `bindPhone()` / `unbindPhone()` API 函数 |
| `packages/client/src/components/hermes/settings/AccountSettings.vue` | 个人设置页新增手机号区域：绑定 / 换绑 / 解绑操作 + 弹窗 |
| `packages/client/src/components/hermes/settings/UserManagementSettings.vue` | 管理员用户管理页：表格新增手机号列，创建/编辑弹窗新增手机号输入框 |
| `packages/client/src/i18n/locales/zh.ts` | 新增 `settings.phone.*` 13 个 key + `users.phone` |
| `packages/client/src/i18n/locales/en.ts` | 同上英文翻译 |

#### 测试修复（2 个文件）
| 文件 | 改动说明 |
|------|----------|
| `tests/server/auth-device-login-routes.test.ts` | mock 补齐 `bindPhone` / `unbindPhone` |
| `tests/server/auth-routes-avatar.test.ts` | mock 补齐 `bindPhone` / `unbindPhone` |

### 验证结果
- ✅ TypeScript 编译通过（server / client / node 三个 tsconfig）
- ✅ Auth 相关测试全部通过（35/35）
- ✅ `npm run build` 构建成功
- ⚠️ 其余失败测试（约 58 个文件）均为预存问题（Windows symlink EPERM、缺失 `app-connections` 模块、`MCU_DEVICES_TABLE` 未导出等），与本次改动无关

### Migration 说明
v1 migration `user_identity_refactor` 在 `initAllHermesTables()` 启动时自动执行，无需手动触发。内容包括：
1. 为 `users` 表添加 `phone_number TEXT` 列
2. 为 `users` 表添加 `wechat_bound INTEGER DEFAULT 0` 列
3. 创建 `phone_number` 唯一部分索引（排除 NULL 值）
4. 从 `wechat_bindings` 表迁移已有绑定关系到 `users` 表
5. 确保至少存在一个 `super_admin` 用户

### deviceLogin 流程（新版）
```
微信扫码 → Token Platform 返回 profile
  ├─ 1. platform_profile_id 已有绑定？→ 复用该用户
  ├─ 2. 手机号匹配到未绑定用户？→ 复用该用户
  │     └─ 手机号用户已 wechat_bound？→ 409 PHONE_ALREADY_BOUND
  ├─ 3. tp_<id> 用户名存在且未绑定？→ 复用（向后兼容）
  └─ 4. 自动创建新用户（带手机号，wechat_bound=true）
```
