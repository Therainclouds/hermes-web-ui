/**
 * Tests for the knowledge plugin content-aware chunker.
 */

import { describe, expect, it } from 'vitest'
import { chunkText, type ChunkConfig } from '../../packages/server/src/services/knowledge/chunker'

describe('chunker', () => {
  describe('empty input', () => {
    it('returns empty array for empty string', () => {
      expect(chunkText('', 'markdown')).toEqual([])
      expect(chunkText('', 'plaintext')).toEqual([])
    })

    it('returns empty array for whitespace-only string', () => {
      expect(chunkText('   \n\n  ', 'markdown')).toEqual([])
      expect(chunkText('   \n\n  ', 'plaintext')).toEqual([])
    })
  })

  describe('markdown chunking', () => {
    it('splits at ## heading boundaries', () => {
      const md = [
        '# Title',
        '',
        'Intro paragraph.',
        '',
        '## Section One',
        '',
        'Content of section one.',
        '',
        '## Section Two',
        '',
        'Content of section two.',
      ].join('\n')

      const chunks = chunkText(md, 'markdown')
      expect(chunks.length).toBeGreaterThanOrEqual(3)
      // Each chunk should have content, tokenCount, and contentHash.
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeGreaterThan(0)
        expect(chunk.tokenCount).toBeGreaterThan(0)
        expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it('splits at ### sub-headings too', () => {
      const md = [
        '## Parent Section',
        '',
        'Some content.',
        '',
        '### Child Section',
        '',
        'More content.',
      ].join('\n')

      const chunks = chunkText(md, 'markdown')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
    })

    it('splits oversized sections at paragraph boundaries', () => {
      // Create a markdown section with many paragraphs that exceeds the
      // fallback size.
      const paragraphs = Array.from({ length: 30 }, (_, i) =>
        `This is paragraph number ${i + 1} with enough text to push the section over the fallback limit for chunking purposes.`
      )
      const md = `## Big Section\n\n${paragraphs.join('\n\n')}`

      // Use a small fallback size to force splitting.
      const config: Partial<ChunkConfig> = {
        chunkSize: 50,
        chunkOverlap: 5,
        chunkFallbackSize: 100,
      }
      const chunks = chunkText(md, 'markdown', config)
      expect(chunks.length).toBeGreaterThan(1)
    })

    it('each chunk has a stable contentHash', () => {
      const md = '## Test\n\nHello world.'
      const a = chunkText(md, 'markdown')
      const b = chunkText(md, 'markdown')
      expect(a.length).toBe(b.length)
      for (let i = 0; i < a.length; i++) {
        expect(a[i].contentHash).toBe(b[i].contentHash)
        expect(a[i].content).toBe(b[i].content)
      }
    })
  })

  describe('plaintext chunking', () => {
    it('produces a single chunk for short text', () => {
      const text = 'Hello world. This is a short text.'
      const chunks = chunkText(text, 'plaintext', {
        chunkSize: 500,
        chunkOverlap: 50,
        chunkFallbackSize: 800,
      })
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toContain('Hello world')
    })

    it('produces multiple chunks for long text with overlap', () => {
      // Generate ~1200 tokens of text (roughly 4800 chars at ~4 chars/token).
      const words = Array.from({ length: 1200 }, (_, i) => `word${i}`)
      const text = words.join(' ')

      const chunks = chunkText(text, 'plaintext', {
        chunkSize: 500,
        chunkOverlap: 50,
        chunkFallbackSize: 800,
      })

      // ~1200 tokens / step=450 → 3-4 windows, plus a tail chunk.
      expect(chunks.length).toBeGreaterThanOrEqual(2)
      expect(chunks.length).toBeLessThanOrEqual(8)

      // Each chunk should have the right shape.
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeGreaterThan(0)
        expect(chunk.tokenCount).toBeGreaterThan(0)
        expect(chunk.tokenCount).toBeLessThanOrEqual(500)
        expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it('overlap creates shared content between consecutive chunks', () => {
      const words = Array.from({ length: 800 }, (_, i) => `token${i}`)
      const text = words.join(' ')

      const chunks = chunkText(text, 'plaintext', {
        chunkSize: 500,
        chunkOverlap: 100,
        chunkFallbackSize: 800,
      })

      expect(chunks.length).toBeGreaterThanOrEqual(2)

      // The second chunk should contain some tokens from the end of the first.
      const firstTokens = chunks[0].content.split(' ').slice(-5).join(' ')
      const secondContent = chunks[1].content
      // At least one of the last 5 tokens from the first chunk should appear
      // in the second chunk (overlap guarantee).
      const overlapFound = firstTokens.split(' ').some((t) => secondContent.includes(t))
      expect(overlapFound).toBe(true)
    })
  })

  describe('determinism', () => {
    it('produces identical output for the same input + config', () => {
      const text = 'Some text content. '.repeat(200)
      const config: Partial<ChunkConfig> = {
        chunkSize: 50,
        chunkOverlap: 10,
        chunkFallbackSize: 100,
      }

      const a = chunkText(text, 'plaintext', config)
      const b = chunkText(text, 'plaintext', config)

      expect(a).toEqual(b)
    })
  })

  describe('contentHash', () => {
    it('is sha256 of content', async () => {
      const { createHash } = await import('crypto')
      const chunks = chunkText('Hello world', 'plaintext')
      expect(chunks).toHaveLength(1)
      const expected = createHash('sha256').update(chunks[0].content).digest('hex')
      expect(chunks[0].contentHash).toBe(expected)
    })

    it('different content produces different hashes', () => {
      const a = chunkText('Hello world', 'plaintext')
      const b = chunkText('Goodbye world', 'plaintext')
      expect(a[0].contentHash).not.toBe(b[0].contentHash)
    })
  })
})
