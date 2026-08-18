---
date: 2026-08-18
pr: merge-upstream-0.6.42-into-main
feature: Group chat workspace panel structure merge with main
impact: GroupChatPanel.vue workspace panel keeps the upstream tool-panel Transition wrapper (showWorkspacePanel v-if with files/terminal/browser/diff conditions); main's duplicate-panel removal adaptation is superseded by the branch's single-panel structure. Agent-link APIs (group-chat-agent-link) and handoff resume APIs remain wired.
---

Merged `merge/upstream-main-20260814` (upstream 0.6.39→0.6.42 sync + local fixes) into
`main`:

- Group chat workspace panel: kept the branch's single `<Transition name="tool-panel">`
  wrapped `<aside class="group-workspace-panel">` structure (HEAD side), discarding
  main's duplicate-removal adaptation which targeted a pre-sync file layout.
- Agent bridge status lookup timeout regex updated to accept the parenthetical
  suffix from `agent-bridge/client.ts` ("…did not respond in time)") so session
  resume treats bridge status timeouts as non-fatal (silent skip + background poll).
- Auth unbind endpoint (`DELETE /api/auth/device-binding`) stays on the public
  route per main's shipped decision; the duplicate protected registration from the
  auto-merge was removed.
