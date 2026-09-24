---
date: 2026-09-07
commit: working-tree
feature: Teacher paper grading MCP tools
impact: Adds profile-scoped camera and export requests without changing ordinary chat execution.
---

# 2026-09-07 — Teacher paper grading (working tree)

Adds ten native grading tools to the existing API MCP toolset. The packaged
paper-grading skill is discovered automatically by HermesSkillInjector; the
existing skill-bundles module manages user YAML bundles and has no built-in list.
Camera and render requests use a separate authenticated /grading Socket.IO
namespace scoped to the authorized profile. Images stay in grading storage and
are never returned in native MCP tool results. OCR is cached before text-only
question detection and scoring. The ordinary chat execution path is unchanged.

Validation: focused grading pipeline/store and plugin registry tests, TypeScript,
production build, harness and browser tests (see task result for actual outcomes).
