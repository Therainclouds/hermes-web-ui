# Task 8 — Client side (Vue3 UI)

> Status: blocked on Task 7.

## Summary

Vue3 UI for the knowledge plugin: sidebar entry, vault list, document
list, and Pinia store + API helpers. All strings translated into
`en`, `zh`, `zh-TW`.

## Dependencies

- Task 7 (routes).

## Files

### Create

- `packages/client/src/features/knowledge/KnowledgeSidebar.vue`
- `packages/client/src/features/knowledge/VaultList.vue`
- `packages/client/src/features/knowledge/DocumentList.vue`
- `packages/client/src/features/knowledge/DocumentDetail.vue`
- `packages/client/src/stores/knowledge.ts`
- `packages/client/src/api/knowledge.ts`

### Modify

- `packages/client/src/i18n/locales/en.ts` — add `knowledge.*` keys.
- `packages/client/src/i18n/locales/zh.ts` — add `knowledge.*` keys.
- `packages/client/src/i18n/locales/zh-TW.ts` — add `knowledge.*` keys.
- The main router / sidebar composition file — add the knowledge
  entry.

## Acceptance criteria

1. Sidebar entry is visible; clicking it shows the Vault list.
2. Adding a vault triggers a server-side watch; the UI shows the
   ingest status of new documents in real time via Socket.IO event
   `knowledge:ingest:progress`.
3. Document list shows status badges: `pending` / `indexed` /
   `failed`.
4. Document detail view shows chunk preview.
5. All strings translated into all three locales — no hardcoded
   English.
6. API errors surface as toast notifications with the server's error
   code.

## Implementation steps

1. **Match the existing client patterns** — look at another feature
   (e.g. `meetings` or `chat`) and copy its file structure, store
   pattern, and route registration.
2. **Create** `api/knowledge.ts`:
   - `listVaults()`, `createVault(path)`, `deleteVault(id, cascade)`.
   - `listDocuments(filters)`, `getDocument(id)`, `deleteDocument(id)`.
   - `search(body)` — for the in-UI search preview.
   - `reindexAll()`.
   - Use the existing axios/fetch helper.
3. **Create** `stores/knowledge.ts`:
   - Pinia store (match the pattern of other stores).
   - State: `vaults`, `documents`, `health`.
   - Actions: `fetchVaults()`, `addVault(path)`, etc.
   - Subscribe to Socket.IO events: `knowledge:vault:*`,
     `knowledge:ingest:progress`, `knowledge:ingest:error`.
4. **Create** `KnowledgeSidebar.vue`:
   - Entry point — a nav item that routes to `/knowledge`.
5. **Create** `VaultList.vue`:
   - Table of vaults with `root_path`, `name`, `watch` status,
     document count.
   - Add button with input for path.
   - Delete button with confirm; optional `cascade` checkbox.
6. **Create** `DocumentList.vue`:
   - Table of documents with status filter (pending/indexed/failed).
   - Click row → navigate to detail.
   - Delete button.
7. **Create** `DocumentDetail.vue`:
   - Document metadata + chunk preview list.
8. **Add i18n keys** to all three locale files under `knowledge.*`:
   - Sidebar label, vault actions, status labels, error messages.

## Hard rules

- Every user-facing string goes through i18n — no hardcoded English.
- Follow the existing client patterns (router, store, API helpers).
- Socket.IO events must use the `knowledge:` namespace.

## Suggested commit message

```
feat(knowledge): Vue3 UI for vaults and documents

- KnowledgeSidebar, VaultList, DocumentList, DocumentDetail views.
- Pinia store + API helpers.
- Socket.IO subscription for real-time ingest progress.
- i18n keys added to en/zh/zh-TW.

Refs: docs/knowledge-architecture.md §6.2
Refs: docs/knowledge/specs/task-08-client.md
```

## Out of scope

- Vault-create UI cost estimate (P1 follow-up — estimate token count
  before first ingest).
- Search UI in the sidebar (the v1 search surface is the Agent tool;
  an in-UI search preview is a follow-up).

## References

- Architecture doc §6.2 (client side)
- Architecture doc §10.6 (observability — Socket.IO events)
- Integration guide Task 8
