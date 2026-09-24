# Task 5 — Embedder

> Status: unblocked once Task 1 lands.

## Summary

Cloud embedding client. v1 ships with one provider (Tongyi
`text-embedding-v3`, 1024-dim), behind a pluggable `EmbedProvider`
interface so DeepSeek / OpenAI / local can be added later as single
files. Batches of 10 chunks per request (DashScope hard limit).
Retries with exponential backoff.

## Dependencies

- Task 1 (schema).
- A Tongyi API key for manual testing (CI uses recorded fixtures).

## Files

### Create

- `packages/server/src/services/knowledge/embedder.ts`
- `tests/server/knowledge-embedder.test.ts`
- `tests/server/fixtures/knowledge/embedder-tongyi-response.json`
  (recorded fixture)

## Acceptance criteria

1. `embedder.embed(chunks: string[]): Promise<Float32Array[]>` calls
   the configured cloud provider and returns one vector per chunk.
2. Batching: a call with 25 chunks is broken into 3 requests
   (10 + 10 + 5 for Tongyi; never exceeds `batchSize`).
3. Retries with exponential backoff on 5xx / timeout / 429
   (3 attempts, 1s / 2s / 4s).
4. After 3 failures, throws `KnowledgeEmbedError` with the provider's
   status code and message.
5. The test uses recorded HTTP fixtures — no live Tongyi calls in CI.
6. **The embedder never silently returns fewer vectors than chunks.**
   Length mismatch throws — silent mismatch corrupts the vec0 index
   irrecoverably.

## Implementation steps

1. **Define** the provider interface:
   ```ts
   interface EmbedProvider {
     embedBatch(texts: string[]): Promise<Float32Array[]>
     readonly batchSize: number
   }
   interface Embedder {
     embed(chunks: string[]): Promise<Float32Array[]>
   }
   function createEmbedder(provider: EmbedProvider, config: EmbedConfig): Embedder
   ```
2. **Implement** `TongyiEmbedProvider`:
   - Endpoint: `${apiBase}/services/embeddings` (DashScope v3 path).
   - Headers: `Authorization: Bearer ${apiKey}`.
   - Body: `{ model, input: { texts }, parameters: { dimension } }`.
   - Parse response: `output.embeddings[].embedding` is an array of
     numbers — convert each to `Float32Array`.
   - Respect `Retry-After` header on 429.
3. **Implement** the batch-and-retry loop in `createEmbedder`:
   - Split chunks into batches of `provider.batchSize`.
   - For each batch: attempt up to `retries` times with backoff.
   - Concatenate results; assert `results.length === chunks.length`
     before returning — throw otherwise.
4. **Write tests**:
   - Mock HTTP (via `nock` or a local fixture server).
   - Record a real Tongyi response → save as JSON → replay in CI.
   - 25-chunk call → 3 HTTP requests (10 + 10 + 5).
   - 5xx × 3 → throws `KnowledgeEmbedError` with status code.
   - Response with fewer vectors than chunks → throws.

## Config

```ts
interface EmbedConfig {
  provider: string       // default 'tongyi'
  model: string          // default 'text-embedding-v3'
  dim: number            // default 1024
  apiKey: string         // from env or secrets file
  apiBase: string        // default 'https://dashscope.aliyuncs.com/api/v1'
  batchSize: number      // default 10, max 10 for Tongyi v3
  timeoutMs: number      // default 30000
  retries: number        // default 3
}
```

## Hard rules

- **Never silently return fewer vectors than chunks.** Length
  mismatch is a throw, not a warning.
- Batch size for Tongyi v3 is **10 hard limit** — do not exceed it
  (audit, verified against DashScope docs).
- API key must come from env or
  `$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env` — never log it,
  never store in `updates/policy.json` (§10.5).
- P1 follow-up (not in v1): process-wide 429 backoff state so one
  429 stops all embed calls for the retry window instead of each
  task retrying independently.

## Suggested commit message

```
feat(knowledge): Tongyi embedder with batch/retry semantics

- Pluggable EmbedProvider interface; v1 ships Tongyi text-embedding-v3.
- Batch size 10 (DashScope hard limit); retries with 1s/2s/4s backoff.
- Length mismatch between input and output throws KnowledgeEmbedError.
- Tests use recorded HTTP fixtures — no live API calls in CI.

Refs: docs/knowledge-architecture.md §4.4
Refs: docs/knowledge/specs/task-05-embedder.md
```

## Out of scope

- Process-wide 429 backoff state (P1 follow-up from fourth-pass
  audit).
- Budget enforcement (reserved, not enforced in v1).
- Alternative providers — the interface supports them;
  implementation is a single-file addition.

## References

- Architecture doc §4.4 (embedding)
- Architecture doc §10.1 (config)
- Architecture doc §10.5 (API key storage)
- Integration guide Task 5
