---
date: 2026-09-11
pr: pending
feature: TRPG writing model routing and durable novel review
impact: All writing modes accept a default model, while long-novel steps support stage models, evidence-based consistency checks and durable human review gates.
---

# 2026-09-11 — TRPG writing model routing and durable review

PR/commit: local working-tree change, pending review.

TRPG chronicle chat creation now passes the configured default provider/model
through existing session options for all three chat writing modes. Long-novel
steps pass optional extract/plan/write/review identities to fresh Agent Bridge
sessions, using the existing profile credentials. Review also covers a separate
consistency audit. No central chat transport, compression or group-chat behavior
changes. Durable pause and chapter/outline review happen between model calls.

Validation: focused recap/novel/model tests, writing-workbench browser flow,
production build and harness check. Detailed contracts and limitations live in
`docs/harness/trpg-long-novel.md`.

2026-09-13 follow-up: the novel model adapter optionally reports final bridge input/output token counters to its caller. It preserves string responses and existing session/cancellation behavior. The novel job persists reported or explicitly estimated usage; the main chat usage flow is unchanged. Economy mode avoids unconditional manuscript rewrites while retaining independent audits and repair gates.

2026-09-14: novel-only model adapter gains an optional structured-output preview callback. Active job workbench responses expose bounded in-memory previews after profile authorization; no new chat session routing or background delegation is enabled. Paragraph repair checkpoints separate prose generation from report repair, and length budgets enforce total ±10% before publication. Existing chat UI and model usage callback signatures remain backward compatible.
