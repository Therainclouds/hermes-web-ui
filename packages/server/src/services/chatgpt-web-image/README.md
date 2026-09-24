# ChatGPT web image bridge

Generates TRPG highlight images by driving the user's own **ChatGPT project** in a
real browser and downloading the finished PNG back, instead of calling an image
API. Opt-in: the TRPG panel only uses it when its **GPT** checkbox is ticked, so
the existing API providers keep working untouched.

## Why it is built this way

Three constraints shaped the design, each confirmed by hand:

1. **Cloudflare needs a headed browser.** A headless Chrome cannot clear the
   challenge on chatgpt.com, so the browser must be visible for a human to step
   in. This feature therefore *never* hides the window.
2. **The browser must not be launched by an automation library.** Chrome started
   through CDP automation sets `navigator.webdriver = true`, and Google then
   refuses the OAuth sign-in with *"this browser or app may not be secure"*.
   Launching Chrome directly keeps the flag `false`, so a normal login works.
3. **Chrome must run inside the desktop session.** Linux Chrome encrypts its
   cookie store (`v11`) with a key from the OS keyring. A Chrome started from a
   sandboxed service gets a different key, treats every cookie as corrupt and
   **purges the ones it cannot decrypt** — observed as a cookie store shrinking
   from 1339 rows to 34, losing `__Secure-next-auth.session-token`. That is why
   the bridge seeds its profile from the user's own Chrome and then launches
   Chrome as a normal desktop process.

## Login

The first run copies `Cookies`, `Preferences`, `Local Storage` and `Local State`
from the user's Chrome profile into the bridge profile, so it usually starts out
already signed in. If it reports `chatgpt_web_needs_human`, finish the login or
the Cloudflare check in the browser window that just opened; the session is
persisted in the bridge profile and is not needed again.

Seeding never overwrites a live bridge session, and can be disabled with
`CHATGPT_WEB_SEED_FROM_CHROME=false`.

## Configuration

Precedence: request field > environment > state file > default.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CHATGPT_WEB_PROJECT_URL` | — (required) | Project page new generations start from |
| `CHATGPT_WEB_CDP_PORT` | `9222` | Chrome DevTools port |
| `CHATGPT_WEB_CHROME_BIN` | auto-detected | Chrome/Chromium executable |
| `CHATGPT_WEB_USER_DATA_DIR` | `<state>/chatgpt-web/browser-profile` | Bridge Chrome profile |
| `CHATGPT_WEB_CHROME_USER_DATA_DIR` | platform default | Source profile to seed from |
| `CHATGPT_WEB_CHROME_PROFILE` | `Default` | Profile directory name inside it |
| `CHATGPT_WEB_SEED_FROM_CHROME` | `true` | Copy the login on first run |
| `CHATGPT_WEB_TIMEOUT_MS` | `300000` | Per-image budget |

The same keys can be placed in `<HERMES_WEB_UI_HOME>/chatgpt-web/config.json`,
for example:

```json
{ "projectUrl": "https://chatgpt.com/g/g-p-<id>-<name>/project" }
```

The TRPG panel's project-URL field (visible when the GPT box is ticked) sends a
per-request `project_url` and overrides both.

## API

- `POST /api/hermes/media/chatgpt-web-image`
  - `prompt` (string, required)
  - `reference_images` (1–4 PNG/JPEG/WebP data URIs, optional) — attached to the
    composer as real file uploads
  - `project_url`, `timeout_ms`, `output_path`, `return_base64`
  - `async: true` — start a background job and return `202 { job_id, state: 'queued' }`
    immediately instead of holding one request for the whole generation
  - Synchronous reply: `{ ok, images: [base64], conversation_id, width, height, duration_ms }`
    with `return_base64`, otherwise `{ ok, output_paths: [...] }`.
- `GET /api/hermes/media/chatgpt-web-image/jobs/:jobId` — poll an async job:
  `{ state: 'queued'|'running'|'done'|'failed', stage, durationMs, images?, error? }`.
  Finished jobs stay readable for one hour (last 30 kept) and are scoped to the
  profile that started them; a client that reconnects can still collect a slow
  result. The TRPG panel always uses this async form.
- `GET /api/hermes/media/chatgpt-web-status` — whether CDP is up, which port and
  profile are in use.

Error codes: `chatgpt_web_project_url_required` (400),
`chatgpt_web_n_unsupported` (400, `n > 1`),
`chatgpt_web_needs_human` (409), `chatgpt_web_browser_unavailable` (503),
`chatgpt_web_timeout` (504, retryable), `chatgpt_web_generation_failed` (502),
`chatgpt_web_job_not_found` (404, job expired or another profile).

## Behaviour notes

- One generation at a time: requests are queued, because a single browser tab
  carries the conversation. Async jobs therefore show `queued` until their turn.
- Each generation starts a **new conversation in the project** (the project page
  composer is used) so history never accumulates into the prompt.
- The image is read straight out of the page with a same-origin
  `fetch(url, { credentials: 'include' })` over CDP. Generated images live at
  `chatgpt.com/backend-api/estuary/content?id=…` with alt text starting
  `已生成图片` — *not* at `files.oaiusercontent.com`, and the UI download control
  is hover-only and not scriptable.
- `press Enter` does not submit; the send button needs a real pointer sequence
  (`mouseMoved` → `mousePressed` → `mouseReleased` with the `buttons` bitmask).
- The "conversation started" wait follows `timeout_ms` (floor 60s, cap 5min) and
  accepts either the new `/c/<id>` URL **or** the stop button, because ChatGPT
  sometimes starts generating before the address bar changes. A miss is reported
  as a retryable `chatgpt_web_timeout` (504), never a generic 502.
- A generation takes roughly 1.5–3 minutes and ignores canvas size / quality —
  those settings only apply to the API path.

## Verifying

```bash
npx vitest run tests/server/chatgpt-web-image.test.ts \
                 tests/server/chatgpt-web-image-controller.test.ts \
                 tests/client/trpg-image-request.test.ts

# Live check against an already-running, signed-in bridge browser:
CHATGPT_WEB_LIVE=1 \
CHATGPT_WEB_PROJECT_URL="https://chatgpt.com/g/g-p-<id>-<name>/project" \
npx vitest run tests/server/chatgpt-web-image-live.test.ts
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `chatgpt_web_needs_human` right after launch | Not signed in yet, or a Cloudflare check is waiting. Complete it in the window. |
| Page keeps redirecting to `/auth/login` | The bridge profile's cookies were purged. Delete `<state>/chatgpt-web/browser-profile` and let it seed again — and make sure the Web UI service runs in the desktop session, not in a container/sandbox. |
| `chatgpt_web_browser_unavailable` | Chrome not found (`CHATGPT_WEB_CHROME_BIN`), or no display for a headed window. |
| `chatgpt_web_timeout` | The browser was still working when the budget ran out. Raise `CHATGPT_WEB_TIMEOUT_MS`, or upload the picture by hand from the highlight card once ChatGPT finishes. |
| `chatgpt_web_job_not_found` | The job expired (1h) or the server restarted. Start a new generation. |
| Generation finished without an image | The model answered in text (refusal or clarification); the assistant's tail is returned as `detail`. |
| Same conversation growing | The bridge could not find/create a project tab; check `project_url` points at the project page. |

## Caveats

Automating chatgpt.com is outside OpenAI's terms of use and can put the account
at risk. It also depends on ChatGPT's DOM, which changes without notice: the
selectors live in one place (`CHATGPT_WEB_SELECTORS` in `driver.ts`) so they can
be repaired quickly.
