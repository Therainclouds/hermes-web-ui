# Task 4 — Chunker

> Status: unblocked once Task 1 lands.

## Summary

Content-aware text splitter. Markdown respects heading boundaries
and falls back to paragraph breaks on oversized sections; plain text
uses a sliding window with overlap. Every chunk carries a stable
`contentHash = sha256(content)` so re-indexing can detect drift.

## Dependencies

- Task 1 (schema).

## Files

### Create

- `packages/server/src/services/knowledge/chunker.ts`
- `tests/server/knowledge-chunker.test.ts`

## Acceptance criteria

1. Markdown input is split at `##` / `###` boundaries.
2. A Markdown section longer than `KNOWLEDGE_CHUNK_FALLBACK_SIZE`
   (default 800 tokens) is further split at paragraph boundaries.
3. Plain text input uses a sliding window of
   `KNOWLEDGE_CHUNK_SIZE` (default 500 tokens) with
   `KNOWLEDGE_CHUNK_OVERLAP` (default 50 tokens).
4. Each chunk is returned with `{ content, tokenCount, contentHash }`
   where `contentHash = sha256(content)`.
5. Empty input produces zero chunks (not an error — caller treats as
   metadata-only per §10.2).
6. Token counts are computed with `js-tiktoken` / `cl100k_base`.
7. The chunker is pure: given the same text + config, it produces the
   same chunks in the same order.

## Implementation steps

1. **Define** the chunker interface:
   ```ts
   interface Chunk {
     content: string
     tokenCount: number
     contentHash: string  // sha256(content)
   }
   type ChunkKind = 'markdown' | 'plaintext'
   function chunkText(
     text: string,
     kind: ChunkKind,
     config: ChunkConfig
   ): Chunk[]
   ```
2. **Implement** the Markdown path:
   - Split on `/^##+ .*$/m` lines.
   - For each section: if `tokenCount(section) > fallbackSize`, re-split
     on paragraph boundaries (`/\n\n+/`).
   - Emit chunks in document order.
3. **Implement** the plain-text path:
   - Tokenize the whole text once (to find window boundaries in
     token-space, not char-space).
   - Slide: `[0, size)`, `[size - overlap, 2*size - overlap)`, ...
   - Each chunk's `content` is the substring corresponding to the
     token window; re-tokenize to get the exact `tokenCount`.
4. **Hash each chunk**: `createHash('sha256').update(content).digest('hex')`.
5. **Write tests**:
   - Markdown with clear `##` sections → one chunk per section.
   - Markdown with one huge section → split at paragraphs.
   - Plain text 1200 tokens → 3 chunks at default size/overlap.
   - Empty string → empty array.
   - Determinism: same input, same output twice.

## Configurable

All knobs come from `config.ts` (Task 6 defines the file; this task
should accept a `ChunkConfig` parameter so the orchestrator can pass
it in):

```ts
interface ChunkConfig {
  chunkSize: number       // default 500
  chunkOverlap: number    // default 50
  chunkFallbackSize: number // default 800
}
```

## Hard rules

- Token counting via `js-tiktoken` / `cl100k_base` only.
- Chunk id is not stable across re-indexing — that's fine; the
  `contentHash` is what detects drift.

## Suggested commit message

```
feat(knowledge): content-aware chunker (markdown + plaintext)

- Markdown splits at ## / ### boundaries; oversized sections fall back
  to paragraph breaks.
- Plain text uses a sliding window (default 500 tokens, 50 overlap).
- Each chunk carries contentHash = sha256(content) for drift detection.
- Token counts via js-tiktoken / cl100k_base (audit P2-8).

Refs: docs/knowledge-architecture.md §4.3
Refs: docs/knowledge/specs/task-04-chunker.md
```

## Out of scope

- Consuming the chunks (Task 5 embeds them; Task 6 writes them to DB).

## References

- Architecture doc §4.3 (chunking)
- Integration guide Task 4
