# 2026-09-11 — TRPG long-form novel pipeline

- Feature: `long_novel` writing mode, background generation and resumable scene checkpoints.
- Changes: TRPG panel/API/shared contracts, `services/trpg/novel*`, bundled recap
  skill and MCP recap-save description. Reuses existing AgentBridgeClient with
  separate ephemeral profile sessions for extraction, planning, writing and review.
- Runtime impact: long novels no longer require a browser chat tab to stay open.
  Every owned transcript range is validated; originals are re-read for scene writing.
  Public appearance and bounded dialogue adaptation are supported. Existing modes
  keep their previous chat path and 1,800-character chapter limit.
- Cancellation destroys the active ephemeral bridge session. Checkpoint resume
  is explicit after failure/restart and never reruns completed persisted steps.
- No Hermes Agent upgrade, release/update, auth policy or recording changes.
- Design/limits: `docs/harness/trpg-long-novel.md`.
- Validation: focused mock server/client tests, browser flow, harness and build.
