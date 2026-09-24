# Token Platform WeChat Device Login

This device (Hermes / QuantHermes) can log in to a **Token Platform** account
(`https://api.quantclaw.vip`) by rendering a WeChat QR on the login page. After
the user scans it, the device syncs the account's model capabilities and binds a
device API key locally, then configures the Token Platform as the default LLM
provider.

## Flow

```
Hermes login page (browser)
  │ 1. user clicks 微信扫码登录 → WeChatQrPanel
  │ 2. POST https://api.quantclaw.vip/api/device-login/request
  │      { hardware_id, device_name }
  │    ── returns { login_id, appid, scope, state, redirect_uri, style } ──
  │ 3. loads wxLogin.js (res.wx.qq.com) and renders the REAL QR via
  │    new WxLogin({ self_redirect:true, id, appid, scope, redirect_uri,
  │                  state, style })   (NOT a qrcode-drawn page URL — that
  │                  made WeChat open the qrconnect page showing another QR)
  │ 4. polls GET /api/device-login/status?login_id=... every 3s
  │    user scans with WeChat → approves → status = approved
  │    ── returns { api_base, api_key, models, device } ──
  │ 5. POST /api/auth/device-login  (local Hermes server)
  │      { api_base, api_key, device_id, device_name, models }
  │    server fetches /api/device/self → profile {display_name, avatar_url}
  │    writes the WeChat avatar/name onto the local Hermes user
  │    ── returns { token, user, binding } ──
  │ 6. setApiKey(token) → POST /api/hermes/config/providers
  │    adds "token_platform" custom provider (base_url = {api_base}/v1)
  │ 7. router → /hermes/chat
```

On later boots, if a server-side binding exists, the login page shows
**恢复已绑定账号 ({account})** which calls `/api/auth/device-login/restore`
(no re-scan needed).

## Server pieces

- `packages/server/src/services/token-platform-client.ts` — thin client for the
  Token Platform APIs: `requestDeviceLogin`, `pollDeviceLoginStatus`,
  `fetchDeviceSelf`, `verifyDeviceApiKey`. Base URL overridable via
  `TOKEN_PLATFORM_BASE_URL` (default `https://api.quantclaw.vip`).
- `packages/server/src/services/device-binding.ts` — persists `device-id`
  (stable hardware UUID) and `device-binding.json` under the Web UI app home.
- `packages/server/src/controllers/auth.ts` — `deviceLogin`,
  `restoreDeviceLogin`, `getDeviceBinding`, `clearDeviceBindingController`.
- `packages/server/src/routes/auth.ts` — public routes
  `/api/auth/device-login`, `/api/auth/device-login/restore`,
  `/api/auth/device-binding` (GET); protected `DELETE /api/auth/device-binding`.

Local user provisioning: username is `tp_<token_platform user id>`. On first
run (no local users yet) the bound user is created as `super_admin`; if the
device already has local users it is created as `admin`. Re-scanning the same
Token Platform account reuses the same local user.

## Client pieces

- `packages/client/src/api/device-login.ts` — API helpers for request/poll/
  complete/restore.
- `packages/client/src/components/auth/WeChatQrPanel.vue` — QR + polling UI.
- `packages/client/src/composables/useDeviceBinding.ts` — boot-time restore.
- `packages/client/src/views/LoginView.vue` — scan section + restore button.
- i18n keys under `login.wechat*` and `login.deviceLogin*` in all 10 locales.

## Token Platform prerequisites

- `GET /api/device/self` authenticated by the device key
  (`Authorization: Bearer sk-...`), returns the bound user profile
  (reuses `buildSelfUserData`).
- CORS is open (`AllowAllOrigins`) so the browser can call the platform
  directly.
- `redirect_uri` for the WeChat QR points to the platform's own
  `/oauth?provider=wechat&login_id=...` (registered callback domain).
