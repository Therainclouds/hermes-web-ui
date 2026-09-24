# Task 3 — Text extractors

> Status: unblocked once Task 1 lands.

## Summary

Build the extractor registry and four v1 extractors (Markdown, plain
text, PDF, DOCX). Each extractor returns `{ text, tokenCount }` for
its file type. Unknown types return a sentinel "metadata-only" result.

## Dependencies

- Task 1 (schema).
- Existing `pdfjs-dist` and `docx` dependencies in `package.json`.

## Files

### Create

- `packages/server/src/services/knowledge/extractors/index.ts`
- `packages/server/src/services/knowledge/extractors/markdown.ts`
- `packages/server/src/services/knowledge/extractors/text.ts`
- `packages/server/src/services/knowledge/extractors/pdf.ts`
- `packages/server/src/services/knowledge/extractors/docx.ts`
- `tests/server/knowledge-extractors.test.ts`
- `tests/server/fixtures/knowledge/sample.md`
- `tests/server/fixtures/knowledge/sample.txt`
- `tests/server/fixtures/knowledge/sample.pdf`
- `tests/server/fixtures/knowledge/sample.docx`

## Acceptance criteria

1. Each extractor returns `{ text: string, tokenCount: number }` for
   its file type, using `js-tiktoken` / `cl100k_base` to count tokens
   (audit P2-8).
2. Unknown file types return a sentinel `extractor:none` (metadata
   only, status stays `indexed` per §10.2).
3. Corrupt PDF / DOCX throws a known error class `ExtractError` with
   `kind: 'corrupt'` — caller marks doc `status=failed`,
   `error=extract:<kind>`.
4. Token counts in tests are deterministic: same fixture → same count.
5. The test covers all four v1 extractors with fixture files.

## Implementation steps

1. **Define** the registry interface in `extractors/index.ts`:
   ```ts
   interface ExtractResult { text: string; tokenCount: number }
   type Extractor = (path: string) => Promise<ExtractResult>
   const registry: Map<string, Extractor> = new Map()
   registry.set('.md', markdownExtractor)
   registry.set('.txt', textExtractor)
   registry.set('.pdf', pdfExtractor)
   registry.set('.docx', docxExtractor)
   export function extract(path: string): Promise<ExtractResult> {
     const ext = path.extname(path).toLowerCase()
     const fn = registry.get(ext)
     if (!fn) return Promise.resolve({ text: '', tokenCount: 0 })
     return fn(path)
   }
   ```
2. **Implement** each extractor:
   - `markdown.ts`: `fs.readFile(path, 'utf-8')`. Count tokens.
   - `text.ts`: same as markdown.
   - `pdf.ts`: `pdfjs-dist` `getDocument(path)` → iterate pages →
     `page.getTextContent()` → join. Wrap in try/catch → throw
     `ExtractError({ kind: 'corrupt' })` on failure.
   - `docx.ts`: use the `docx` package's extraction path; same error
     wrapping.
3. **Create fixture files** in `tests/server/fixtures/knowledge/`.
   For PDF/DOCX, generate minimal valid files at test setup or commit
   small binary fixtures.
4. **Write tests**:
   - One test per extractor — call with fixture path, assert non-empty
     text, assert `tokenCount > 0`, assert determinism.
   - Unknown extension → `{ text: '', tokenCount: 0 }`.
   - Corrupt fixture (truncate a PDF) → throws `ExtractError` with
     `kind: 'corrupt'`.

## Hard rules

- Registry uses file extension (lowercased) as dispatch key. No MIME
  sniffing in v1 — it's fragile and hard to test.
- Token counts must use `js-tiktoken` / `cl100k_base`. No ad-hoc
  word-splitting heuristics (audit P2-8).

## Suggested commit message

```
feat(knowledge): text extractors for md/txt/pdf/docx

- Add extractor registry keyed by lowercased file extension.
- Implement four v1 extractors; unknown types return metadata-only.
- Token counts use js-tiktoken / cl100k_base (audit P2-8).
- Fixture files in tests/server/fixtures/knowledge/.
- Corrupt-file path throws ExtractError({ kind: 'corrupt' }).

Refs: docs/knowledge-architecture.md §4.2
Refs: docs/knowledge/specs/task-03-extractor.md
```

## Out of scope

- Audio / video / image extractors — metadata-only in v1 (§4.2).
- The chunker that consumes extractor output (Task 4).

## References

- Architecture doc §4.2 (text extraction)
- Integration guide Task 3
