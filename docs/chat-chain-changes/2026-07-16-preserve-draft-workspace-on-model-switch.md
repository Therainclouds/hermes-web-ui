---
date: 2026-07-16
pr: 2095
feature: Preserve draft workspace on model switch
impact: Changing the model before a new chat's first message keeps the selected workspace instead of creating the server session with the default workspace.
---

Model changes for client-only draft sessions remain local until the first run.
The first message continues to create the persisted session with the selected
model, provider, and workspace, while existing persisted sessions keep using
the server-side model update path.
