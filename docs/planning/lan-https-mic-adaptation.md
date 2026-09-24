# 局域网 HTTPS 麦克风适配方案

> 状态：草案
> 创建：2026-07-17
> 关联：v0.7.4、meeting mode、`scripts/install-device-package.sh`、`scripts/hermes-web-ui.service`、`.github/device-package-release.json`

## 一、背景

Hermes Web UI v0.7.4 在 RK 设备上以局域网 HTTP 形式访问时，浏览器拒绝授予麦克风权限，导致会议模式（Meeting Mode）无法录音。原因是 Chromium 内核要求 `getUserMedia` 必须在 secure context 下调用，而 HTTP 局域网地址不属于 secure context。

设备规模庞大、且会时常更换网络（IP 不固定），故需一套能在远程更新链路下自适应完成 HTTPS 化、并自动适配 IP 变化的方案。

## 二、目标与边界

### 目标
- 局域网访问场景下，浏览器可正常弹出麦克风权限请求。
- 设备切换网络导致 IP 变化时，证书自动重新签发，无需人工介入。
- 通过现有远程更新链路，一次推送覆盖全部设备。

### 不在本方案范围
- 公网 HTTPS（依赖第三方 CA，本方案不涉及）。
- 跨 origin 共享登录态（`localStorage` 按 origin 隔离，本方案不解决）。
- 浏览器对私有 CA 签发证书可能存在的"您的连接不是私密连接"警告的彻底消除（首次访问仍需用户点击"高级 → 继续访问"）。

## 三、根本约束

| 约束 | 影响 | 应对 |
|------|------|------|
| 浏览器要求 secure context 才能调用 `getUserMedia` | HTTP 局域网直接拒绝 | 必须 HTTPS |
| `localStorage` 按 origin 隔离 | `localhost` 与 `192.168.x.x` 登录态不通 | 接受现状；HTTPS 部署后用户在同一 origin 完成登录即可 |
| 设备换网络 IP 变化 | 证书 SAN 中的 IP 过期 | 每台设备按当前 IP 自签 |
| 大量设备远程更新 | 维护成本 | mkcert CA 一次签发 + 远程推送 |

## 四、技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| CA 工具 | mkcert（开发机） | 简单、自动生成受信 CA |
| 服务端证书 | openssl 自签（设备本地） | 每台设备根据当前 IP 生成 |
| 部署方式 | 远程 device package | 已有现成链路，CA 一次推送 |
| HTTPS 启用 | Node `https.createServer` | 已有 Koa server，启动入口改 HTTPS |
| 触发时机 | systemd `ExecStartPre` + IP 变化 timer | 启动前 + 周期检测 |

## 五、实施步骤

### 第 1 步：开发机生成 CA（一次性）

```bash
mkcert -install
ls "$(mkcert -CAROOT)/rootCA.pem"   # 拿到 CA 路径
```

### 第 2 步：新增脚本

#### `scripts/generate-server-cert.sh`（设备本地）
- 检测当前主网卡 IP
- 对比 `.current_ip` 文件，IP 变化则重新签证书
- 签名 SAN：`IP:<当前IP>, IP:127.0.0.1, DNS:localhost`
- 证书有效期 3650 天
- 输出到 `${DEPLOY_DIR}/certs/server.{crt,key}`

#### `scripts/install-device-ca.sh`（设备首次执行）
- 把 `certs/rootCA.pem` 复制到 `/usr/local/share/ca-certificates/hermes-root.crt`
- 执行 `update-ca-certificates`
- 仅在文件实际变化时才执行，避免无谓重启

### 第 3 步：修改 `scripts/hermes-web-ui.service`
- 新增 `ExecStartPre=/opt/hermes-web-ui/scripts/generate-server-cert.sh`
- `ExecStartPost` 中调用 `install-device-ca.sh`（仅首次有效）

### 第 4 步：修改 `dist/server/index.js`
- 启动时检测 `certs/server.crt` + `server.key` 是否存在
- 存在则用 `https.createServer` 启动
- 启动失败 fallback 到 HTTP + console warning，保持可访问

### 第 5 步：更新 `.github/device-package-release.json`
- `packageAllowlist` 加入：
  - `certs/rootCA.pem`
  - `scripts/generate-server-cert.sh`
  - `scripts/install-device-ca.sh`
- 同步提升 `packageVersion`

### 第 6 步：远程更新
- 推送到 OSS
- 所有设备下次自动检测更新 → 下载 → 解压 → 安装 CA → 启动时自签证书 → 服务切 HTTPS

## 六、风险与缓解

| 风险 | 缓解 |
|------|------|
| CA 私钥泄露 | rootCA 仅开发机保存，永不进 client bundle |
| 设备 IP 频繁变化（如笔记本 WiFi 切换） | systemd timer 每 5 分钟检测一次，IP 变则重签 + reload |
| 证书 SAN 不匹配 | 生成脚本同时写 IP + 127.0.0.1 + localhost 三项 |
| `update-ca-certificates` 失败 | install-device-ca.sh 单独捕获失败，不阻塞启动 |
| 老设备无 `certs/` 目录 | install-device-package.sh 已支持 `certs/` 解压 |
| Node HTTPS 启动失败 | try/catch fallback 到 HTTP + warning，保持可访问 |

## 七、回退策略

- systemd `Restart=on-failure` 已有，自动重启。
- fallback HTTP 模式可继续访问，但浏览器禁用麦克风，UI 文案引导用户检查 `/var/log/hermes-web-ui/error.log`。
- 用户在 UI 看到"麦克风需 HTTPS"提示时，可一键定位日志。

## 八、验收标准

- [ ] 单台设备：开发机生成 CA → 推送到 OSS → 设备远程更新 → 服务启 HTTPS → `getUserMedia` 不再报 `NotAllowedError`。
- [ ] IP 变化：手动切换设备网络 → systemd timer 检测 → 重签 + reload → 浏览器再次访问无证书警告。
- [ ] 批量部署：100 台设备 → 一次远程更新 → 100 台全部切换 HTTPS。
- [ ] 证书 SAN：包含当前 IP + 127.0.0.1 + localhost，浏览器无"域名不匹配"警告。

## 九、后续工作

- 会议模式 UI 文案：把 `meeting.micInsecureContext` 中的"请在地址栏改为 https://"更新为"等待设备自动完成 HTTPS 配置"，减少小白用户的认知负担。
- API Key 跨 origin 共享：评估是否引入"局域网助手二维码扫描登录"机制，让手机扫码后自动把 token 写入 RK 浏览器 origin。

## 十、变更记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 草案 | 2026-07-17 | 初稿，基于 v0.7.4 会议室集成背景 |