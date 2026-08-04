---
date: 2026-07-17
pr: pending
feature: History targeted lineage lookup and source pagination
impact: History loads each source in independent pages and opens a session by querying only its compression lineage instead of scanning every session a second time.
---

The History list still builds its global compression index once so grouped session
summaries remain unchanged. The automatic first-session detail request and other
detail lookups now follow the requested session's parent and continuation links
with targeted database queries, while preserving pagination and compression-chain
selection behavior. The sidebar requests 50 sessions per source, keeps pinned and
deep-linked sessions available, and loads subsequent source pages from an explicit
header control until the backend reports that no rows remain.
API Server sessions are included as their own History source category and use
the existing local-first detail path when opened.
