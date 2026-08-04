---
date: 2026-07-16
pr: 2100
feature: Desktop card layout, chat surface colors, and conversation navigation state
impact: Desktop chat, group chat, history, and workflow surfaces use a consistent inset card layout without changing message data, session state, routing, or Agent runtime behavior.
---

This change is visual only. Mobile main content keeps its previous edge-to-edge
layout, while desktop sidebars and main surfaces gain shared spacing, radii,
shadows, and theme-aware colors. Chat input, message persistence, context
construction, Socket.IO events, and Agent execution behavior are unchanged.
