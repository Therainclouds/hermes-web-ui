---
date: 2026-07-18
pr: 2123
feature: Session Profile filter persistence
impact: The chat session list restores its selected Profile filter after a page reload and falls back to all Profiles when the cached Profile is unavailable.
---

The filter preference is stored separately from the active Hermes Profile and
does not change session ownership, runtime selection, or message behavior.
