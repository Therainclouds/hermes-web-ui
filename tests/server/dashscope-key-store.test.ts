import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readStoredDashScopeKey } from '../../packages/server/src/services/meeting-asr/dashscope-key-store'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dashscope-key-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('readStoredDashScopeKey', () => {
  it('reads the key from config.json (asr.dashscope_api_key first, then llm.api_key)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      asr: { dashscope_api_key: 'sk-asr-key' },
      llm: { api_key: 'sk-llm-key' },
    }), 'utf-8')
    expect(await readStoredDashScopeKey(dir)).toBe('sk-asr-key')

    const dir2 = await tempDir()
    await writeFile(join(dir2, 'config.json'), JSON.stringify({
      llm: { api_key: 'sk-llm-key' },
    }), 'utf-8')
    expect(await readStoredDashScopeKey(dir2)).toBe('sk-llm-key')
  })

  it('falls back to config.env when config.json has no key (the v0.7.17 regression)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({ llm: {} }), 'utf-8')
    await writeFile(join(dir, 'config.env'), [
      '# written by python storage.update_config()',
      'DASHSCOPE_API_KEY=sk-from-env',
      'PARAFORMER_MODEL=paraformer-realtime-v2',
    ].join('\n'), 'utf-8')

    expect(await readStoredDashScopeKey(dir)).toBe('sk-from-env')
  })

  it('strips surrounding quotes from the config.env value', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.env'), 'DASHSCOPE_API_KEY="sk-quoted"\n', 'utf-8')
    expect(await readStoredDashScopeKey(dir)).toBe('sk-quoted')

    const dir2 = await tempDir()
    await writeFile(join(dir2, 'config.env'), "DASHSCOPE_API_KEY='sk-single'\n", 'utf-8')
    expect(await readStoredDashScopeKey(dir2)).toBe('sk-single')
  })

  it('ignores comments, other keys and empty values in config.env', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.env'), [
      '#DASHSCOPE_API_KEY=commented-out',
      'DASHSCOPE_API_KEY_FALLBACK=not-this-one',
      'OTHER_KEY=x',
      'DASHSCOPE_API_KEY=',
    ].join('\n'), 'utf-8')
    expect(await readStoredDashScopeKey(dir)).toBeNull()
  })

  it('returns null when neither file exists or is parseable', async () => {
    expect(await readStoredDashScopeKey(await tempDir())).toBeNull()

    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), '{not valid json', 'utf-8')
    expect(await readStoredDashScopeKey(dir)).toBeNull()
  })
})
