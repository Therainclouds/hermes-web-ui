---
date: 2026-07-16
pr: 2098
feature: Single-chat and group-chat message references
impact: Users can reference a completed message in their next turn without changing either message database schema or legacy history loading.
---

Single-chat and group-chat message actions can select a message as the reference
for the next turn. Each input shows a removable, conversation-scoped one-line
preview outside the input box. Sending wraps the referenced content in an
explicit `quoted_message` block for the agent while message rendering converts
it back to a clean Markdown quote. Group mention routing ignores `@` tokens
inside the quoted block, so only mentions in the new reply can trigger agents.
Existing persistence and model context paths continue treating the result as
ordinary content, so previously stored messages are unchanged and need no
migration.
