# Meeting + ASR 隐患排查报告与预防措施

> 范围：本次会话（v0.7.7）复盘的说话人分离 + ASR 功能引发的全项目安全/稳定性体检。
> 版本：v1.0（2026-07-22）
> 受影响组件：Vite 构建产物 / Koa CSP / Python ASR 后端 / Frontend Store / 部署脚本。

---

## 第 1 章 — 本次问题分类与成因

### 1.1 本次 Bug 列表

| 编号 | 类别 | 标题 | 严重度 |
|------|------|------|--------|
| B-1 | 构建产物 | Vite 将 `pcm-worklet.ts` 内联为 `data:` URL，被 CSP 拦截 → `addModule()` 抛 `AbortError` | 🔴 致命 |
| B-2 | 部署/扩展 | 前端 `updateASRConfig` 后 Python 子进程不重启，OSS 签名错误持续 | 🔴 致命 |
| B-3 | CSP | CSP 缺少 `worker-src` 指令，且 `script-src` 不含 `data: blob:` | 🔴 致命 |
| B-4 | 后端崩溃 | OSS 模式 stop 时调用未定义的 `_process_chunk` → NameError | 🔴 致命 |
| B-5 | 端到端 | OSS 签名不匹配（密钥错填）导致 `SignatureDoesNotMatch`，无重试/无降级 | 🟡 中 |
| B-6 | 部署脚本 | ARM64 缺 `python3-venv`、`python3-dev`、`gcc`、`build-essential` | 🟡 中 |
| B-7 | 配置漂移 | `.venv/` 整个虚拟环境被错误提交到 git | 🟡 中 |
| B-8 | 配置漂移 | `.dev-data/` 缓存目录未 `.gitignore` | 🟢 低 |

### 1.2 成因分类

| 成因类型 | 涉及 Bug |
|----------|----------|
| **构建链路脆弱性** | B-1（Vite 默认行为 + 缺乏防回归断言） |
| **配置语义偏差** | B-2（环境变量进程级 vs 全局；UI 改了不该改的） |
| **缺失的边界指令** | B-3（CSP 没有 `worker-src`，依赖默认 fallback） |
| **死代码/重构遗漏** | B-4（`_process_chunk` 函数引用了重命名后的 `_process_chunk_async`） |
| **缺少错误处理标准** | B-5（签名错误未结构化分类，前端无法提示用户改密钥） |
| **镜像基础包不全** | B-6（宿主机依赖清单不完整） |
| **Git 规范未明示** | B-7、B-8（`.gitignore` 早期未覆盖） |

### 1.3 影响范围

| 影响维度 | 受影响范围 |
|----------|------------|
| **用户可感知** | 录音失败 / 无实时文字 / 无说话人标签 / OSS 配置无效 |
| **构建/部署** | 设备首启失败 / ARM64 wheel 下载失败回退到源码编译 / venv 创建失败 |
| **代码库健康** | `.venv/` 污染历史 / `.dev-data/` 泄露本地凭证 |
| **长期维护** | CSP/构建产物回归无自动化保障；下次重构可能再炸 |

---

## 第 2 章 — 同类风险全面排查

### 2.1 高风险清单（须修复）

| 编号 | 风险 | 文件:行 | 状态 |
|------|------|---------|------|
| R-1 | CSP `script-src` 含 `'unsafe-inline'`、`data:`、`blob:` 关闭脚本 XSS 最强保护 | `security.ts:111` | **未修** |
| R-2 | CSP `worker-src` 含 `blob:`、`data:`，Monaco 实际只需 `'self'`，可收紧 | `security.ts:112` | **部分修了**（保留 `data: blob:` 兜底） |
| R-3 | ASR Python 子进程透传 `process.env`，env 变更必须重启 Python 进程 | `meeting-asr/index.ts:253`、`config.py:23-80` | **已修**（自动重启） |
| R-4 | `audio_buffer` 生产者侧未持锁，依赖隐式不变量（`_drain_chunk` 内无 await） | `diarize_endpoint.py:578, 677` | **未修** |
| R-5 | `JSON.parse(localStorage...)` 多处无 try/catch，损坏存档导致组件崩溃 | `HistoryView.vue:400`、`ChatInput.vue:462`、`meeting.ts:127,195`、`useDefaultWorkspace.ts:23,79` | **未修** |
| R-6 | Python `except Exception: pass` 大量存在（55 处），无日志输出 | `bridge_pool.py`、`bridge_runtime.py` 等 | **未修** |
| R-7 | 关键异步失败（保存分析结果、删除音频、保存音频）仅 console.error，无 UI 反馈 | `useMeetingAgent.ts:582`、`meeting.ts:180/305/368`、`MeetingView.vue:809`、`chat.ts:985` | **未修** |
| R-8 | `versions.json` 仍含 `"0.7.6"` | `packages/website/public/versions.json:21` | **低（属历史）** |

### 2.2 中风险清单（建议修复）

| 编号 | 风险 | 文件:行 | 状态 |
|------|------|---------|------|
| R-9 | `dashscope` / `aliyunsdkcore` / `crcmod` 在 ARM64 上若有 wheel miss 需源码编译 | `requirements.txt:1-9` | **已缓解**（加了 `python3-dev`、`gcc`） |
| R-10 | Python `except Exception: pass` 在 55 处 | 跨多文件 | **未修** |
| R-11 | Python `os.environ` 启动时一次性读取，运行时改 env 失效 | `config.py:23-80` | **已修**（自动重启） |
| R-12 | `audio_buffer.extend` 写操作无锁 | `diarize_endpoint.py:578, 677` | **未修** |
| R-13 | `.venv/` 早期被 git 跟踪 | 整个 `.venv/` 目录 | **已修**（`git rm --cached`） |

### 2.3 低风险清单（暂不动）

- `connect-src` 含 `http: https: ws: wss:`（允许外联）
- `img-src` 含 `https:`
- Service Worker 在 `public/notification-sw.js`

---

## 第 3 章 — 修复方案

### 3.1 必修项（建议在 v0.7.8 一起修）

#### Fix 1: `localStorage JSON.parse` 统一保护（消 R-5）

建立公共工具：

```ts
// packages/client/src/utils/safe-storage.ts
export function safeGetJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function safeSetJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    console.warn(`[safe-storage] Failed to persist ${key}:`, err)
    return false
  }
}
```

应用点（替换 5 处直接 `JSON.parse(localStorage.getItem(...))`）：
- `HistoryView.vue:400`
- `ChatInput.vue:462`
- `meeting.ts:127, 195`
- `useDefaultWorkspace.ts:23, 79`
- `chat.ts:312`

#### Fix 2: Python `except Exception` 统一打 log（消 R-6）

```python
# 在 packages/server/src/services/agent-bridge/python/bridge_pool.py 等
# 全部 except Exception: pass 改为：
except Exception as exc:
    log.debug("bridge_pool: skipped during %s: %s", phase, exc)
```

或通过 `contextlib.suppress(Exception, logger=log.debug)` 抽公共 helper。

#### Fix 3: 关键异步失败统一上 UI（消 R-7）

建立 toast / notification 通道（Naive UI `useMessage`），所有 `console.error` 改为 `message.error(t('meeting.error.xxx'))`。会议模块的 4 个 catch 点优先改：

| 文件 | 改成 |
|------|------|
| `useMeetingAgent.ts:582` | `message.error(t('meeting.error.saveReportFailed'))` |
| `meeting.ts:180/305/368` | 失败时设置 `errorState.value = ...`，UI 显示 |
| `MeetingView.vue:809` | 同上 |
| `chat.ts:985` | `message.warning(t('chat.error.workspaceLoadFailed'))` |

#### Fix 4: CSP 渐进收紧（消 R-1, R-2）

**阶段一（v0.7.8 立即做）**：移除 `script-src` 的 `data:` blob:`，worklet 走静态路径后已不需要：

```diff
- "script-src 'self' 'unsafe-inline' data: blob:",
+ "script-src 'self' 'unsafe-inline'",
```

**阶段二（v0.8.0 评估）**：尝试去掉 `'unsafe-inline'`，逐个替换为 nonce/hash 注入。

### 3.2 选修项（按优先级排期）

| 编号 | 修复 | 工作量 |
|------|------|--------|
| O-1 | `audio_buffer` 加生产者侧锁（消 R-12） | XS |
| O-2 | `versions.json` 清理 0.7.6（消 R-8） | XS |
| O-3 | Python `requirements.txt` 拆分 `[runtime]` 与 `[build]`（消 R-9 残项） | S |
| O-4 | Monaco worker 改 `?worker` 插件路径，去掉 `worker-src blob:` | S |

---

## 第 4 章 — 自动化测试用例补充

### 4.1 单元测试（Vitest）

#### T-1：MeetingView 静态 worklet URL 守卫（消 B-1）

```ts
// tests/client/views/meeting-worklet-url.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MeetingView from '@/views/hermes/MeetingView.vue'

describe('MeetingView AudioWorklet URL', () => {
  it('addModule receives a static URL string', () => {
    const src = require('fs').readFileSync(
      'src/views/hermes/MeetingView.vue', 'utf-8'
    )
    expect(src).toMatch(/addModule\(["']\/audio\/pcm-worklet\.js["']\)/)
    // 反向断言：禁止 data: URL 和 new URL(...import.meta.url) 写法
    expect(src).not.toMatch(/new URL\(.*pcm-worklet[^?]*import\.meta\.url\)/)
    expect(src).not.toMatch(/addModule\(["']data:/)
  })
})
```

#### T-2：CSP 指令完整断言（消 B-3）

```ts
// tests/server/security-policy.test.ts — 追加
expect(csp).toMatch(/worker-src[^;]*'self'[^;]*blob:/i)
expect(csp).toMatch(/script-src[^;]*'self'/i)
expect(csp).toMatch(/connect-src[^;]*ws:|wss:/i)
expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/)
```

#### T-3：localStorage 损坏处理（消 R-5）

```ts
// tests/client/stores/meeting-store.test.ts
import { setActivePinia, createPinia } from 'pinia'
import { useMeetingStore } from '@/stores/hermes/meeting'

describe('meeting store loadASRConfig', () => {
  it('falls back to defaults when localStorage is corrupted', () => {
    localStorage.setItem('hermes.meeting.asrConfig', '{not valid json')
    setActivePinia(createPinia())
    const store = useMeetingStore()
    store.loadASRConfig()
    expect(store.asrConfig.dashscopeApiKey).toBe('')
    expect(store.asrConfig.paraformerModel).toBe('paraformer-realtime-v2')
  })
})
```

### 4.2 Python 单元测试（unittest / pytest-asyncio）

```python
# tests/python/test_meeting_asr_fallback.py
class TestASRFallback:
    def test_fallback_when_no_oss(self, monkeypatch):
        monkeypatch.delenv("OSS_BUCKET", raising=False)
        from app.config import settings
        assert settings.oss_configured is False
        assert settings.fallback_mode is True

    def test_oss_mode_when_all_keys_set(self, monkeypatch):
        monkeypatch.setenv("OSS_BUCKET", "bkt")
        monkeypatch.setenv("OSS_ACCESS_KEY_ID", "kid")
        monkeypatch.setenv("OSS_ACCESS_KEY_SECRET", "secret")
        from app.config import settings
        assert settings.oss_configured is True
        assert settings.fallback_mode is False
```

### 4.3 构建产物守卫（消 B-1）

```js
// scripts/guard-no-inline-data-urls.mjs
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'dist/client/assets/js'
const offenders = []

for (const file of await readdir(ROOT)) {
  if (!file.endsWith('.js')) continue
  const content = await readFile(join(ROOT, file), 'utf-8')
  if (content.includes('data:application/octet-stream') ||
      content.match(/data:[a-z]+\/[^,]*;base64,[A-Za-z0-9+/=]{200,}/)) {
    offenders.push(file)
  }
}

if (offenders.length > 0) {
  console.error('[guard] data: URLs detected in:', offenders)
  process.exit(1)
}
console.log('[guard] No large base64 data: URLs in client JS')
```

集成到 `package.json`：`"build:verify": "node scripts/guard-no-inline-data-urls.mjs"`，CI 跑 `npm run build && npm run build:verify`。

### 4.4 E2E 补充（消 B-5）

```ts
// tests/e2e/meeting-oss-error.spec.ts
test('OSS signature error shows actionable toast', async ({ page }) => {
  await page.route('**/api/meeting-asr/start', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ status: 'running', oss: 'ok' }),
    })
  )
  await page.route('**/api/meeting-asr/upload', (route) =>
    route.fulfill({
      status: 403,
      body: JSON.stringify({
        code: 'SignatureDoesNotMatch',
        message: 'The request signature we calculated does not match...',
      }),
    })
  )

  await page.goto('/hermes/meeting')
  await page.getByTestId('start-recording').click()
  await expect(page.getByText(/OSS Access Key Secret 不正确/)).toBeVisible()
})
```

---

## 第 5 章 — 代码评审强制校验节点

### 5.1 PR 模板新增章节

在 `.github/pull_request_template.md` 增加：

```markdown
## 安全与稳定性自检

- [ ] 涉及 `data:` URL / Worker / Worklet 的变更已通过 `npm run build:verify`
- [ ] 涉及 Python 子进程的变更已确认 env 注入语义（启动时读 vs 运行时读）
- [ ] 涉及 localStorage 的变更已用 `safeGetJSON` / `safeSetJSON` 包裹
- [ ] 涉及 `.catch(...)` 的变更已检查是否需要 UI 反馈（toast/error state）
- [ ] 涉及 CSP / `security.ts` 的变更已更新 `tests/server/security-policy.test.ts`
```

### 5.2 CI 流水线必跑

| 检查 | 触发条件 | 命令 |
|------|----------|------|
| `harness:check` | 所有 PR | `npm run harness:check` |
| `build:verify` | 涉及 client/dist 的 PR | `npm run build && npm run build:verify` |
| `test:coverage` | 涉及 meeting/asr/security 的 PR | `npm run test:coverage` |
| `test:e2e` | 涉及录制/播放/UI 流程的 PR | `npm run test:e2e` |
| Python 单测 | 涉及 `python-backend/app/*.py` 的 PR | `pytest tests/python/` |

### 5.3 AGENTS.md 强约束（新增段落）

```markdown
## Hard Rules (additional)

- **构建产物**：禁止在 `new URL('.../*.ts', import.meta.url)` 中引用
  worklet/worker 源文件；必须用 `public/` 静态资源或 `?url` import。
- **CSP**：`security.ts` 变更必须同步更新 `tests/server/security-policy.test.ts`
  并在 PR 描述中列出所有指令变化。
- **localStorage**：禁止裸 `JSON.parse(localStorage.getItem(...))`，
  必须用 `safeGetJSON` / `safeSetJSON`。
- **Python 子进程**：env 变量是启动时读取，运行期变更需要重启进程；
  在 Node 端修改 `env` 后必须配套实现子进程自动重启逻辑。
```

---

## 第 6 章 — 长期治理建议

### 6.1 错误处理标准化

| 层级 | 标准 |
|------|------|
| 前端 `.catch()` | 必须分流：UI 反馈 / 重试 / 上报，禁 `console.error` 一笔带过 |
| Python `except` | 禁裸 `pass`；必须 `log.debug/warning/error(...)` 至少一条 |
| Koa `ctx.throw` | 必须显式 `status` + `expose: true`，前端才能拿到可读 `message` |

### 6.2 文档与代码同步

- `docs/harness/validation.md` 增加"meeting-asr 变更必跑项"小节
- `docs/harness/pr-review.md` 链接本文件作为 B-1/B-3 类问题的判例
- `AGENTS.md` 新增第 5.3 章的 Hard Rules

### 6.3 监控与告警

部署后建议接入：
- `meeting_asr_service_crashed_total`（Python 进程崩溃计数）
- `meeting_asr_oss_upload_403_total`（签名错误计数，超过阈值告警）
- `meeting_asr_csp_violation_total`（浏览器 CSP 违规上报，启用 `report-uri`）

---

## 第 7 章 — 检查清单（执行状态）

| 项 | 状态 | 负责 |
|----|------|------|
| B-1 worklet public/ 化 | ✅ v0.7.7 | 已修 |
| B-2 OSS 配置自动重启 | ✅ v0.7.7 | 已修 |
| B-3 CSP worker-src | ✅ v0.7.7 | 已修 |
| B-4 `_process_chunk` NameError | ✅ v0.7.7 | 已修 |
| B-5 OSS 签名错误 UI 反馈 | 🟡 T-4 e2e 待加 | 下一迭代 |
| B-6 ARM64 依赖 | ✅ v0.7.7 | 已修 |
| B-7 `.venv/` git 历史 | ✅ v0.7.7 | 已修 |
| B-8 `.dev-data/` 排除 | ✅ v0.7.7 | 已修 |
| R-5 localStorage 统一保护 | 🟡 T-3 待加 | 下一迭代 |
| R-6 Python `except` log | 🟡 全局重构 | 长期 |
| R-7 异步失败 UI 反馈 | 🟡 T-3 待加 | 下一迭代 |
| R-1 CSP 收紧 | 🟡 评估中 | v0.8.0 |
| R-12 audio_buffer 锁 | 🟡 O-1 | 低优 |
| 构建产物守卫脚本 | 🟡 T-build:verify | 下一迭代 |

---

## 附录 A — 完整变更清单（v0.7.7）

| 文件 | 改动 |
|------|------|
| `packages/client/public/audio/pcm-worklet.js` | 新建 worklet 静态副本 |
| `packages/client/src/views/hermes/MeetingView.vue` | addModule 改静态路径 / OSS UI 区块 / startASRService 传 OSS |
| `packages/client/src/stores/hermes/meeting.ts` | ASRConfig 加 OSS 字段 + loadASRConfig 默认 |
| `packages/client/src/utils/meeting-asr-api.ts` | MeetingASRConfig 加 OSS 字段 |
| `packages/client/src/i18n/locales/{zh,en}.ts` | OSS 文案 + 0.7.7 changelog |
| `packages/client/src/data/changelog.ts` | 0.7.7 条目 |
| `packages/server/src/services/meeting-asr/index.ts` | MeetingASRConfig OSS 字段 + 自动重启 |
| `packages/server/src/services/meeting-asr/python-backend/app/diarize_endpoint.py` | `_process_chunk` → `_process_chunk_async` + 锁 |
| `vite.config.ts` | `base: '/'` 显式声明 |
| `packages/server/src/security.ts` | `script-src` + 新增 `worker-src` |
| `release/device-host-dependencies.json` | 新增 python3-venv/dev + gcc + build-essential |
| `.gitignore` | `.dev-data/` + `.venv/` |
| `package.json` / `packages/desktop/package.json` / `.github/device-package-release.json` | 0.7.6 → 0.7.7 |

// [Cloud] 隐患排查报告与预防措施文档完成。