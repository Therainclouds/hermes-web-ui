# ADR-0012: Knowledge Plugin Root-Cause Fix

**Date:** 2026-09-10
**Status:** Accepted
**Context:** v0.8.x Knowledge plugin (RAG document search)

## Problem

The Knowledge plugin shipped in a state where the UI was visible and
enabled by default, but the backend was never initialized in production.
Combined with five additional bugs, the plugin was completely
non-functional across all deployment paths (Docker, source-deploy,
local dev).

## Root Causes Identified

1. **Bootstrap disconnect** — `KnowledgeService` was never instantiated
   by `initAllStores()`. The routes were mounted but the service was
   `null`, causing 500 errors on every API call.

2. **CJK search always returned zero results** — FTS5 with `porter`
   tokenizer does not segment Chinese text. `buildFtsQuery` used
   whitespace splitting, also wrong for CJK. `searchHybrid` did not
   fall back to vector search when FTS had no candidates.

3. **`sqlite-vec` in `devDependencies`** — Docker builds run
   `npm prune --omit=dev`, removing the extension. Runtime
   `MODULE_NOT_FOUND` on `require('sqlite-vec')`.

4. **Embedding model not persisted** — Architecture doc §2.3 required
   `embedding_model` and `embedding_dim` per embedding, but the schema
   only baked dim into the vec0 table. Swapping models silently
   corrupted retrieval.

5. **No resource guards** — No file size limit (ARM device risk), no
   vault path validation (arbitrary filesystem access), no extension
   whitelist enforcement in `processIngest`.

6. **Non-atomic cascade delete** — `removeVault(cascade=true)` deleted
   documents one by one without a wrapping transaction. Partial failure
   left orphaned chunks/FTS entries.

7. **SQL injection risk** — `deleteDocumentIndexes` used string
   interpolation for `document_id` in SQL.

8. **Client i18n incomplete** — Only 3 of 11 locales had translations.
   `message.success('✓')` instead of i18n key. Filter buttons missing
   `indexing` status.

## Design Decisions

### Why bigram tokenization (not an external CJK tokenizer)

- **No new native dependency** — `sqlite-vec` is already the hardest
  native dep to manage; adding `icu` or `jieba` would double the
  deployment surface.
- **Bigram is sufficient for search recall** — 2-char sliding window
  covers all Chinese words (most are 2-4 chars). Precision is handled
  by the vector re-rank step.
- **Write-side bigram** — FTS content stores bigrams, but the real
  content column retains original text for display.
- **Cost:** ~1.5-2x index size increase. Acceptable for < 10k docs.

### Why `optionalDependencies` (not `dependencies` or `peerDependencies`)

- Mirrors existing `sherpa-onnx-*` pattern in the same package.json.
- `npm prune --omit=dev` does not remove `optionalDependencies`, fixing
  the Docker build.
- Platforms where the native binary is missing still install cleanly —
  the `loadSqliteVec` function handles `MODULE_NOT_FOUND` gracefully.

### Why soft migration (not blocking upgrade)

- Pre-existing deployments have `knowledge_chunks_vec` but no
  `knowledge_embeddings_meta`. A blocking migration would prevent
  upgrades.
- Soft migration: insert `model='unverified'` into meta table. This
  warns the user in health reports but does not prevent operation.
- User-triggered re-index (`POST /api/knowledge/reindex`) clears the
  `unverified` marker.

### Why `validateVaultPath` uses realpathSync + blocklist

- Symbolic links could escape the intended directory.
- System directory blocklist (`/etc`, `/proc`, `/sys`, `/root`,
  `/var`, `/boot`, plus Windows equivalents) prevents accidental
  indexing of sensitive paths.
- Path depth limit (≤ 16) prevents inotify quota exhaustion on ARM.

## Implementation Summary

Six atomic commits:

1. `fix(knowledge): wire KnowledgeService bootstrap + 503 on disabled`
2. `fix(knowledge): sqlite-vec as optionalDependency + graceful degradation`
3. `fix(knowledge): CJK bigram tokenization + hybrid search fallback`
4. `feat(knowledge): persist embedding_model/dim via knowledge_embeddings_meta`
5. `fix(knowledge): resource guards + transactional cascade + prepared statements`
6. `feat(knowledge): client i18n 11-locale coverage + UI fixes`

## Test Coverage

- `tests/server/knowledge-schema.test.ts` — schema bootstrap, soft
  migration, dim mismatch
- `tests/server/knowledge-search-cjk.test.ts` — bigram tokenization,
  CJK search, hybrid fallback
- `tests/server/knowledge-controller.test.ts` — path validation, 503
- `tests/server/knowledge-service.test.ts` — cascade delete, health
- `tests/server/knowledge-extractors.test.ts` — PDF/DOCX extraction
  with timeout fix

## Consequences

- Devices with pre-existing knowledge data will see `unverified`
  marker until re-index.
- CJK search quality improved from "never works" to "works via bigram
  + vector fallback".
- Index size increases ~1.5-2x for CJK-heavy content.
- All 11 locales now have translations (may need native-speaker polish).
