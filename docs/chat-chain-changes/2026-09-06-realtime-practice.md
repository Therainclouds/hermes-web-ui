---
date: 2026-09-06
feature: Realtime direct tools and practice assessment
impact: Lower-latency commands and evidence-based session reviews
pr: pending
---

# Realtime direct tools and practice assessment

Date: 2026-09-06. PR/commit: pending.

Realtime advertises direct workspace queries and a bounded terminal function
before Hermes delegation. Terminal execution uses argument arrays, the active
profile's configured working directory, a 15-second timeout, bounded output,
and the same super-admin boundary as the interactive terminal. MCP and skill
orchestration remain Hermes tasks.

Practice feedback respects the selected skill's scale and preserves one record
per user turn. Round zero is the whole-session assessment, separate from round
averages. Strengths and improvements quote actual user expressions; the sidebar
also retains these observations for previous rounds. Closing assessment submits
its written review through function calling using the live session's retained
media plus bounded transcript/observation evidence for older turns. Successful
reviews skip the separate HTTP multimodal analysis. Failure falls back to the
existing sampled recordings/frames if the skill enables offline analysis.

Camera preview requests 640x480 at 15fps with unconstrained fallback; inference
still samples at 1fps. Canvas is reused; background, end-of-session and congested
transport skip frames. Late camera permission results cannot leak a stream after
closing the stage.

Cost limitation: this avoids a duplicate analysis request, not repeated-input
billing. DashScope bills history still present in each Realtime response; media
can also age out of the context window. Reviews must disclose missing evidence.
https://help.aliyun.com/zh/model-studio/realtime

Validation: focused practice/terminal tests, full coverage, browser suite, build,
and harness check (see task result for environment failures).
