/**
 * Tests for the knowledge plugin embedder.
 *
 * Uses a mock fetch function to simulate Tongyi API responses — no live
 * API calls in CI.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createEmbedder,
  createTongyiEmbedder,
  KnowledgeEmbedError,
  TongyiEmbedProvider,
  type EmbedProvider,
} from '../../packages/server/src/services/knowledge/embedder'

// --- Helpers ---

/** Create a mock Response object. */
function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** Build a Tongyi-shaped success response for N vectors of given dimension. */
function tongyiSuccessResponse(count: number, dim: number): unknown {
  const embeddings = Array.from({ length: count }, (_, i) => ({
    text_index: i,
    embedding: Array.from({ length: dim }, (_, j) => (i === j % count ? 1.0 : 0.0)),
  }))
  return { output: { embeddings } }
}

/** Create a mock fetch that returns responses in sequence. */
function sequentialFetch(responses: Response[]): typeof fetch {
  let i = 0
  return vi.fn(async () => {
    if (i >= responses.length) {
      throw new Error('No more mock responses')
    }
    return responses[i++]
  }) as unknown as typeof fetch
}

// --- Tests ---

describe('embedder', () => {
  describe('createEmbedder with a mock provider', () => {
    it('returns empty array for empty input', async () => {
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(),
      }
      const embedder = createEmbedder(provider)
      const result = await embedder.embed([])
      expect(result).toEqual([])
      expect(provider.embedBatch).not.toHaveBeenCalled()
    })

    it('passes single batch through for small input', async () => {
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(async (texts) =>
          texts.map(() => new Float32Array([1, 0, 0, 0])),
        ),
      }
      const embedder = createEmbedder(provider)
      const result = await embedder.embed(['hello', 'world'])
      expect(result).toHaveLength(2)
      expect(provider.embedBatch).toHaveBeenCalledTimes(1)
      expect(provider.embedBatch).toHaveBeenCalledWith(['hello', 'world'])
    })

    it('splits into batches of batchSize', async () => {
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(async (texts) =>
          texts.map(() => new Float32Array([1, 0])),
        ),
      }
      const embedder = createEmbedder(provider)
      // 25 chunks → 3 batches: 10 + 10 + 5
      const chunks = Array.from({ length: 25 }, (_, i) => `chunk-${i}`)
      const result = await embedder.embed(chunks)
      expect(result).toHaveLength(25)
      expect(provider.embedBatch).toHaveBeenCalledTimes(3)
      expect(provider.embedBatch).toHaveBeenNthCalledWith(1, chunks.slice(0, 10))
      expect(provider.embedBatch).toHaveBeenNthCalledWith(2, chunks.slice(10, 20))
      expect(provider.embedBatch).toHaveBeenNthCalledWith(3, chunks.slice(20, 25))
    })

    it('throws when provider returns fewer vectors than chunks', async () => {
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(async () => [new Float32Array([1, 0])]), // Always returns 1 vector
      }
      const embedder = createEmbedder(provider, { retries: 0 })
      await expect(embedder.embed(['a', 'b'])).rejects.toThrow(KnowledgeEmbedError)
    })

    it('retries with exponential backoff on 5xx', async () => {
      let attempts = 0
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(async (texts) => {
          attempts++
          if (attempts < 3) {
            throw new KnowledgeEmbedError('Server error', { statusCode: 500 })
          }
          return texts.map(() => new Float32Array([1, 0]))
        }),
      }
      // Use tiny backoff for test speed.
      const embedder = createEmbedder(provider, { retries: 3 })
      const result = await embedder.embed(['hello'])
      expect(result).toHaveLength(1)
      expect(attempts).toBe(3)
    })

    it('throws after exhausting retries', async () => {
      const provider: EmbedProvider = {
        batchSize: 10,
        embedBatch: vi.fn(async () => {
          throw new KnowledgeEmbedError('Permanent failure', { statusCode: 500 })
        }),
      }
      const embedder = createEmbedder(provider, { retries: 2 })
      await expect(embedder.embed(['hello'])).rejects.toThrow(KnowledgeEmbedError)
      // 1 initial + 2 retries = 3 total attempts
      expect(provider.embedBatch).toHaveBeenCalledTimes(3)
    })
  })

  describe('TongyiEmbedProvider', () => {
    it('sends correct request format', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(200, tongyiSuccessResponse(2, 4)),
      ])

      const provider = new TongyiEmbedProvider({
        apiKey: 'test-key',
        model: 'text-embedding-v3',
        dim: 1024,
        apiBase: 'https://dashscope.aliyuncs.com/api/v1',
        timeoutMs: 5000,
        fetchFn,
      })

      await provider.embedBatch(['hello', 'world'])

      expect(fetchFn).toHaveBeenCalledTimes(1)
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/embeddings')
      expect(init.method).toBe('POST')
      expect(init.headers['Authorization']).toBe('Bearer test-key')
      const body = JSON.parse(init.body)
      expect(body.model).toBe('text-embedding-v3')
      expect(body.input.texts).toEqual(['hello', 'world'])
      expect(body.parameters.dimension).toBe(1024)
    })

    it('parses Tongyi response into Float32Array vectors', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(200, tongyiSuccessResponse(2, 4)),
      ])

      const provider = new TongyiEmbedProvider({
        apiKey: 'test-key',
        model: 'text-embedding-v3',
        dim: 4,
        apiBase: 'https://dashscope.aliyuncs.com/api/v1',
        timeoutMs: 5000,
        fetchFn,
      })

      const result = await provider.embedBatch(['hello', 'world'])
      expect(result).toHaveLength(2)
      expect(result[0]).toBeInstanceOf(Float32Array)
      expect(result[0].length).toBe(4)
    })

    it('throws KnowledgeEmbedError on 5xx (retryable)', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(500, { message: 'Internal Server Error' }),
      ])

      const provider = new TongyiEmbedProvider({
        apiKey: 'test-key',
        model: 'text-embedding-v3',
        dim: 4,
        apiBase: 'https://dashscope.aliyuncs.com/api/v1',
        timeoutMs: 5000,
        fetchFn,
      })

      await expect(provider.embedBatch(['hello'])).rejects.toThrow(KnowledgeEmbedError)
    })

    it('throws KnowledgeEmbedError on 429 (retryable)', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '5' }),
      ])

      const provider = new TongyiEmbedProvider({
        apiKey: 'test-key',
        model: 'text-embedding-v3',
        dim: 4,
        apiBase: 'https://dashscope.aliyuncs.com/api/v1',
        timeoutMs: 5000,
        fetchFn,
      })

      await expect(provider.embedBatch(['hello'])).rejects.toThrow(KnowledgeEmbedError)
    })

    it('throws KnowledgeEmbedError on 400 (non-retryable)', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(400, { message: 'Bad Request' }),
      ])

      const provider = new TongyiEmbedProvider({
        apiKey: 'test-key',
        model: 'text-embedding-v3',
        dim: 4,
        apiBase: 'https://dashscope.aliyuncs.com/api/v1',
        timeoutMs: 5000,
        fetchFn,
      })

      await expect(provider.embedBatch(['hello'])).rejects.toThrow(KnowledgeEmbedError)
    })
  })

  describe('createTongyiEmbedder integration', () => {
    it('25 chunks → 3 HTTP requests (10+10+5)', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(200, tongyiSuccessResponse(10, 4)),
        mockResponse(200, tongyiSuccessResponse(10, 4)),
        mockResponse(200, tongyiSuccessResponse(5, 4)),
      ])

      const embedder = createTongyiEmbedder({
        apiKey: 'test-key',
        dim: 4,
        fetchFn,
      })

      const chunks = Array.from({ length: 25 }, (_, i) => `chunk-${i}`)
      const result = await embedder.embed(chunks)
      expect(result).toHaveLength(25)
      expect(fetchFn).toHaveBeenCalledTimes(3)
    })

    it('length mismatch throws KnowledgeEmbedError', async () => {
      // Provider returns 8 vectors for a batch of 10.
      const fetchFn = sequentialFetch([
        mockResponse(200, tongyiSuccessResponse(8, 4)),
      ])

      const embedder = createTongyiEmbedder({
        apiKey: 'test-key',
        dim: 4,
        retries: 0,
        fetchFn,
      })

      const chunks = Array.from({ length: 10 }, (_, i) => `chunk-${i}`)
      await expect(embedder.embed(chunks)).rejects.toThrow(KnowledgeEmbedError)
    })

    it('retries on 5xx then succeeds', async () => {
      const fetchFn = sequentialFetch([
        mockResponse(500, 'Internal Server Error'),
        mockResponse(500, 'Internal Server Error'),
        mockResponse(200, tongyiSuccessResponse(2, 4)),
      ])

      const embedder = createTongyiEmbedder({
        apiKey: 'test-key',
        dim: 4,
        retries: 3,
        fetchFn,
      })

      const result = await embedder.embed(['hello', 'world'])
      expect(result).toHaveLength(2)
      expect(fetchFn).toHaveBeenCalledTimes(3)
    })
  })
})
