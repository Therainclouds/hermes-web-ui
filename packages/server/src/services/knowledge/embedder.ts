/**
 * Cloud embedding client for the knowledge plugin.
 *
 * v1 ships with one provider (Tongyi `text-embedding-v3`, 1024-dim) behind
 * a pluggable `EmbedProvider` interface so alternative providers can be added
 * as single-file additions.
 *
 * Hard rules (from spec task-05-embedder.md):
 *   - Tongyi batch size is 10 hard limit (DashScope docs).
 *   - Length mismatch between input chunks and output vectors is a throw,
 *     not a warning — silent mismatch corrupts the vec0 index irrecoverably.
 *   - API key must come from env or secrets file, never logged.
 */

// --- Error class ---

export class KnowledgeEmbedError extends Error {
  readonly statusCode?: number
  readonly providerMessage?: string

  constructor(message: string, options?: { statusCode?: number; providerMessage?: string; cause?: unknown }) {
    super(message)
    this.name = 'KnowledgeEmbedError'
    this.statusCode = options?.statusCode
    this.providerMessage = options?.providerMessage
    if (options?.cause) {
      this.cause = options.cause
    }
  }
}

// --- Provider interface ---

export interface EmbedProvider {
  /** Embed a single batch of texts. Must return one vector per input text. */
  embedBatch(texts: string[]): Promise<Float32Array[]>
  /** Maximum batch size for this provider. */
  readonly batchSize: number
}

// --- Embedder config ---

export interface EmbedConfig {
  provider: string
  model: string
  dim: number
  apiKey: string
  apiBase: string
  batchSize: number
  timeoutMs: number
  retries: number
}

export const DEFAULT_EMBED_CONFIG: EmbedConfig = {
  provider: 'tongyi',
  model: 'text-embedding-v3',
  dim: 1024,
  apiKey: '',
  apiBase: 'https://dashscope.aliyuncs.com/api/v1',
  batchSize: 10,
  timeoutMs: 30_000,
  retries: 3,
}

// --- Embedder interface ---

export interface Embedder {
  embed(chunks: string[]): Promise<Float32Array[]>
}

// --- Batch-and-retry wrapper ---

/**
 * Wrap an EmbedProvider with batching and exponential-backoff retry.
 *
 * - Splits input into batches of provider.batchSize.
 * - Retries each batch up to config.retries times with 1s/2s/4s backoff.
 * - Asserts output length matches input length — throws otherwise.
 */
export function createEmbedder(provider: EmbedProvider, config: Partial<EmbedConfig> = {}): Embedder {
  const cfg = { ...DEFAULT_EMBED_CONFIG, ...config }

  return {
    async embed(chunks: string[]): Promise<Float32Array[]> {
      if (chunks.length === 0) return []

      const results: Float32Array[] = []
      const batchSize = provider.batchSize

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize)
        const vectors = await retryWithBackoff(
          () => provider.embedBatch(batch),
          cfg.retries,
        )

        if (vectors.length !== batch.length) {
          throw new KnowledgeEmbedError(
            `Provider returned ${vectors.length} vectors for ${batch.length} chunks — length mismatch is fatal`,
            { providerMessage: 'vector count mismatch' },
          )
        }

        results.push(...vectors)
      }

      // Final safety check: total output must match total input.
      if (results.length !== chunks.length) {
        throw new KnowledgeEmbedError(
          `Embedding produced ${results.length} vectors for ${chunks.length} chunks`,
          { providerMessage: 'total vector count mismatch' },
        )
      }

      return results
    },
  }
}

// --- Retry with exponential backoff ---

const BACKOFF_BASE_MS = 1000

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Don't retry after the last attempt.
      if (attempt >= maxRetries) break

      // Calculate backoff delay.
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt)
      await sleep(delay)
    }
  }

  // All retries exhausted — re-throw the last error.
  if (lastError instanceof KnowledgeEmbedError) throw lastError
  throw new KnowledgeEmbedError(
    `Embedding failed after ${maxRetries + 1} attempts`,
    { cause: lastError },
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Tongyi provider ---

export interface TongyiProviderOptions {
  apiKey: string
  model: string
  dim: number
  apiBase: string
  timeoutMs: number
  /** Optional fetch override for testing. */
  fetchFn?: typeof fetch
}

/**
 * Tongyi (DashScope) text-embedding-v3 provider.
 *
 * Endpoint: POST ${apiBase}/services/embeddings
 * Body: { model, input: { texts }, parameters: { dimension, text_type } }
 * Response: output.embeddings[].embedding (array of numbers)
 */
export class TongyiEmbedProvider implements EmbedProvider {
  readonly batchSize = 10
  private readonly opts: TongyiProviderOptions
  private readonly fetchFn: typeof fetch

  constructor(opts: TongyiProviderOptions) {
    this.opts = opts
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.opts.apiBase}/services/embeddings`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          input: { texts },
          parameters: {
            dimension: this.opts.dim,
            text_type: 'document',
          },
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new KnowledgeEmbedError(`Tongyi request failed: ${(err as Error).message}`, {
        cause: err,
      })
    }

    clearTimeout(timer)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const isRetryable = response.status >= 500 || response.status === 429

      if (isRetryable) {
        throw new KnowledgeEmbedError(
          `Tongyi returned ${response.status}: ${body.slice(0, 200)}`,
          { statusCode: response.status, providerMessage: body.slice(0, 500) },
        )
      }

      throw new KnowledgeEmbedError(
        `Tongyi returned non-retryable ${response.status}: ${body.slice(0, 200)}`,
        { statusCode: response.status, providerMessage: body.slice(0, 500) },
      )
    }

    const json = (await response.json()) as {
      output?: { embeddings?: Array<{ embedding: number[]; text_index: number }> }
      message?: string
    }

    if (!json.output?.embeddings) {
      throw new KnowledgeEmbedError('Tongyi response missing output.embeddings', {
        providerMessage: JSON.stringify(json).slice(0, 500),
      })
    }

    // Sort by text_index to maintain order (DashScope may return out of order).
    const sorted = [...json.output.embeddings].sort(
      (a, b) => a.text_index - b.text_index,
    )

    return sorted.map(
      (e) => new Float32Array(e.embedding),
    )
  }
}

// --- Factory ---

export function createTongyiEmbedder(config: Partial<EmbedConfig> & { apiKey: string; fetchFn?: typeof fetch }): Embedder {
  const cfg = { ...DEFAULT_EMBED_CONFIG, ...config }
  const provider = new TongyiEmbedProvider({
    apiKey: cfg.apiKey,
    model: cfg.model,
    dim: cfg.dim,
    apiBase: cfg.apiBase,
    timeoutMs: cfg.timeoutMs,
    fetchFn: config.fetchFn,
  })
  return createEmbedder(provider, cfg)
}
