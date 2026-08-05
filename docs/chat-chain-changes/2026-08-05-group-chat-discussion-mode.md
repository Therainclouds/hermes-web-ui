---
date: 2026-08-05
commit: feat(group-chat): 群聊自由讨论模式
feature: Group chat free discussion mode (task-056)
impact: Group chat rooms can run a hosted multi-agent discussion with a judge and a closing reporter; @-mention routing is suspended while a discussion is active.
---

Group chat rooms gain a "free discussion" flow. A manager starts a discussion
with a goal, an ordered agent list, round/message caps, a judge model, and an
optional reporter. The server drives each Agent in order with an injected
prompt carrying the goal, the Agent's identity, the judge's previous
assessment, and the round transcript, then asks a judge LLM whether the
discussion has converged or stalled. Terminals force a reporter to write a
closing summary message, and the discussion state is broadcast through a new
`discussion_update` Socket.IO event and persisted in the `gc_discussions`
table.

While a discussion is active, human @-mentions stop routing to Agents and
resume automatically once the discussion reaches a terminal status, so the
hosted run owns the Agent turn loop. The discussion runner is restarted on
server boot, marking any in-flight run as failed, and room clear/delete
aborts the active run.

## Follow-up enhancements (same day)

- **Judge resilience**: a judge failure (e.g. provider outage) no longer kills
  the run — that round's assessment is skipped, `lastError` records the
  outage, and the discussion keeps advancing; a subsequent successful round
  clears `lastError`. There is no judge-failure kill-switch anymore.
- **Soft round cap with progress signals**: the judge now also reports a
  `progress` boolean (new point/evidence/angle or resolved disagreement).
  When `maxRounds` is reached, the run keeps extending by up to
  `DISCUSSION_MAX_EXTEND_ROUNDS` (4) extra rounds while the judge keeps
  reporting progress, so open-ended scenarios (law/psychology/medical/paper
  review/knowledge learning) can converge naturally; as soon as a round shows
  no progress, the run closes at the next check.
- **Chat-input entry points**: a quick-start button in the group chat toolbar
  opens a modal to set the goal and pick participants, and sending
  `/讨论 <goal> [@member...]` (or `/discuss ...`) in the input box starts a
  discussion directly. Both paths respect manager-only and "already running"
  guards. UI strings added to all 11 locale files.
- **Discussion report export**: after a discussion reaches a terminal status,
  the discussion-result card offers a "Download Report" button that produces
  a structured Word `.docx` (title, goal, meta table, per-round judge notes,
  and the full consensus report rendered from Markdown) plus a `.md` copy for
  AI-friendly archiving. Implemented fully client-side with the `docx`
  package (`packages/client/src/utils/hermes/group-discussion-docx.ts`); the
  report body is located via `reportMessageId` in the room transcript.
