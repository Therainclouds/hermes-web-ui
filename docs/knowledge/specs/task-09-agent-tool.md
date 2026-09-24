# Task 9 — Hermes Agent tool binding

> Status: blocked on Tasks 6 + 7.

## Summary

Expose `knowledge_search` as an MCP tool through the existing
agent-bridge. The Hermes Agent discovers it via MCP; the bridge
forwards the call to the local Web UI route; results are stitched
into the Agent's context.

## Dependencies

- Task 6 (orchestrator).
- Task 7 (routes — the tool calls `/api/knowledge/search`).

## Files

### Create / modify

- Wherever Agent tools are registered in the agent-bridge path: add
  `knowledge_search` tool.
- `tests/server/knowledge-agent-tool.test.ts`

## Acceptance criteria

1. Hermes Agent can invoke `knowledge_search` as a tool.
2. The tool's description tells the Agent:
   - What the endpoint returns (chunks with source paths).
   - When to use it ("when the user asks about a document they
     dropped on USB").
   - Recommendation: `limit=3` for factual lookups, `limit=10` for
     research-style queries, never exceed 20.
   - **For Chinese queries prefer semantic search** — v1 FTS5
     keyword match is unreliable on Chinese text (§7.5, audit P2-6).
   - **Interpret `totalCandidatesBeforeFilter`**: if `results.length
     << totalCandidatesBeforeFilter`, the threshold is filtering
     aggressively; retry with looser `maxDistance`.
3. The tool response format matches §5.2.
4. Tool is registered via the agent-bridge MCP tool path — **not by
   modifying Hermes Agent core** (audit P2-1).

## Implementation steps

1. **Read** the existing agent-bridge tool registration path:
   `packages/server/src/services/hermes/agent-bridge/`. Find how
   other MCP tools are registered; mirror that pattern.
2. **Define** the `knowledge_search` tool:
   ```ts
   {
     name: 'knowledge_search',
     description: 'Search the local knowledge base for relevant '
       + 'document chunks. Use when the user asks about a document '
       + 'they dropped on USB or a fact in the corpus.\n\n'
       + 'Parameters:\n'
       + '- query: search string (max 2000 chars; required)\n'
       + '- vaultId: optional vault scope\n'
       + '- limit: default 5, recommend 3 for facts, 10 for research, max 20\n'
       + '- hybrid: default true. For Chinese queries prefer false '
       + '(semantic) because v1 FTS5 keyword match is unreliable on Chinese text\n'
       + '- maxDistance: default 0.3 (cosine distance, lower = stricter; '
       + 'similarity = 1 - distance)\n\n'
       + 'Response interpretation:\n'
       + '- results[]: chunks (≤ 500 tokens each) with source paths\n'
       + '- totalCandidatesBeforeFilter: chunks that passed stage-1 before '
       + 'maxDistance trim. If results.length << totalCandidatesBeforeFilter, '
       + 'the threshold is filtering aggressively — retry with higher maxDistance.\n'
       + '- truncated: true when the query matched more than limit',
     parameters: { ... JSON schema ... }
   }
   ```
3. **Implement** the handler:
   - Validate input.
   - Call `/api/knowledge/search` via the bridge's internal HTTP
     client (or directly call `knowledge.service.search()` — whichever
     pattern the bridge uses for other tools).
   - Return the response body.
4. **Filtering**: the agent-bridge already has a tool-filtering path
   (`agent-bridge-mcp-tools-filter` tests). Make sure
   `knowledge_search` is visible to the Agent.
5. **Test**:
   - Call the tool with a known query; assert response shape.
   - Call with `hybrid: false`; assert pure-vector path is used.
   - Call with `query.length > 2000`; assert tool error.

## Hard rules

- **Do NOT modify Hermes Agent core.** Tool registration goes through
  the agent-bridge MCP path only (audit P2-1).
- **Do NOT mix knowledge results into Agent conversation history.**
  The tool is a pure lookup — results are stitched into context for
  the current turn only, not persisted to memory.
- **Tool description must steer Chinese queries toward semantic
   search** (audit P2-6).
- **Tool description must call out `totalCandidatesBeforeFilter`**
   explicitly (audit T1) — this is the main signal the Agent uses
   to decide whether to retry with looser parameters.

## Suggested commit message

```
feat(knowledge): Hermes Agent MCP tool knowledge_search

- Register knowledge_search via agent-bridge MCP tool path.
- Tool description steers Chinese queries to semantic search and
  explains totalCandidatesBeforeFilter for recall tuning.
- Response shape matches §5.2 of the architecture doc.
- Does not modify Hermes Agent core (audit P2-1).

Refs: docs/knowledge-architecture.md §5.3
Refs: docs/knowledge/specs/task-09-agent-tool.md
```

## Out of scope

- Push-based notifications to the Agent (the Agent pulls; §2.4).
- Tool description localization — v1 ships in English; the Agent
  handles translation at its layer.

## References

- Architecture doc §5.3 (Hermes Agent integration)
- Architecture doc §7.5 (Chinese tokenization)
- Integration guide Task 9
