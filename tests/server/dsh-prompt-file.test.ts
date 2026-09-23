import { describe, expect, it } from 'vitest'
import {
  hermesPromptDocument,
  upsertManagedPromptBlock,
  writeManagedPromptFile,
  HERMES_PROMPT_BLOCK_BEGIN,
  HERMES_PROMPT_BLOCK_END,
} from '../../packages/server/src/services/coding-agents/prompt-file'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Managed prompt file', () => {
  it('builds a prompt document with begin/end markers', () => {
    expect(hermesPromptDocument('hello world')).toBe(
      `${HERMES_PROMPT_BLOCK_BEGIN}\nhello world\n${HERMES_PROMPT_BLOCK_END}\n`,
    )
  })

  it('replaces an existing block in place', () => {
    const existing = `# Top\n${HERMES_PROMPT_BLOCK_BEGIN}\nold\n${HERMES_PROMPT_BLOCK_END}\n# Bottom\n`
    const next = upsertManagedPromptBlock(existing, 'new')
    expect(next).toContain('# Top')
    expect(next).toContain('# Bottom')
    expect(next).toContain('new')
    expect(next).not.toContain('old')
  })

  it('appends a fresh block when none exists', () => {
    const next = upsertManagedPromptBlock('untouched content', 'hello')
    expect(next).toContain('untouched content')
    expect(next).toContain('hello')
  })

  it('writes the managed block to disk and creates parent dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-prompt-'))
    try {
      const path = join(dir, 'nested', 'AGENTS.md')
      await writeManagedPromptFile(path, 'studio instructions')
      const content = await readFile(path, 'utf-8')
      expect(content).toContain('studio instructions')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves user-authored content around an existing block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-prompt-'))
    try {
      const path = join(dir, 'AGENTS.md')
      await writeManagedPromptFile(path, 'first')
      await writeManagedPromptFile(path, 'second')
      const content = await readFile(path, 'utf-8')
      expect(content).toContain('second')
      expect(content).not.toContain('first')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})