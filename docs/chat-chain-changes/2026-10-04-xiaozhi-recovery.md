---
date: 2026-10-04
feature: xiaozhi-realtime-camera-recovery
impact: Restore Realtime backend after restart and accept authorized MCU camera calls.
commit: 9d9c069a
---

# 2026-10-04: XiaoZhi Realtime and camera recovery

Realtime upgrades lazily restore the managed Python backend after a Node restart and share startup across devices. Bootstrap owns unknown upgrade cleanup so Socket.IO does not terminate a pending Realtime handshake after one second. Upgrade waiting is bounded to 65 seconds; existing ASR TLS transport selection is preserved.

Bridge MCP discovery and loop imports support the current split Hermes modules and older runtimes. MCU sessions can repair a directly invoked deferred camera name only when that exact name and photo-analysis schema occur in their current authorized tool catalog. Ordinary registry dispatch and policy remain responsible for execution. Non-MCU sessions and unknown, stale, or preview-only tools retain existing behavior.

Validation: focused recovery, camera authorization, MCP filtering, bridge boundary, voice-stream and STT tests; production build; live backend restart and existing MCU camera session.
