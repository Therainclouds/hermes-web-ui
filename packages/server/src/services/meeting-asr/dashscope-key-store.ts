import fs from 'fs/promises'
import path from 'path'

/**
 * DashScope API key 的持久化恢复（拆分自 meeting-asr/index.ts，行为保持一致）。
 *
 * Recover the DashScope API key from persistent storage when the caller
 * didn't pass one inline. The Python backend stores secrets in two files
 * under dataDir, and we must check both:
 *
 *   - config.json: written by the Node controller's /api/config proxy and
 *     by updateLLMConfig(). Key lives at `llm.api_key` or `asr.dashscope_api_key`.
 *   - config.env: written by Python `storage.update_config()` as shell-style
 *     `DASHSCOPE_API_KEY=sk-...` lines, consumed by `config.py` at import
 *     time via python-dotenv.
 *
 * Before this fix, the fallback only read config.json, so auto-restart or
 * first-start-after-deploy failed with "DASHSCOPE_API_KEY is not configured"
 * whenever the key had been persisted exclusively via the Python path
 * (config.env) — which is the common case after the user saves ASR config
 * from the UI.
 */
export async function readStoredDashScopeKey(dataDir: string): Promise<string | null> {
  // 1. config.json (JSON)
  try {
    const configPath = path.join(dataDir, 'config.json')
    const raw = await fs.readFile(configPath, 'utf-8')
    const stored = JSON.parse(raw)
    const key = stored?.asr?.dashscope_api_key || stored?.llm?.api_key
    if (key) return key
  } catch { /* file missing or invalid JSON */ }

  // 2. config.env (shell-style KEY=VALUE lines)
  try {
    const envPath = path.join(dataDir, 'config.env')
    const raw = await fs.readFile(envPath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() === 'DASHSCOPE_API_KEY') {
        let val = trimmed.slice(eq + 1).trim()
        // Strip surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (val) return val
      }
    }
  } catch { /* file missing */ }

  return null
}
