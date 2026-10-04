# XiaoZhi Real Time audio API

The existing `/ws/omni-realtime` WebSocket also accepts a device session.
Its first text frame is `{"type":"start","client":"xiaozhi"}`. That selects
450 ms server VAD silence while browser sessions keep the 800 ms setting.
The `ready` response includes `input_audio` (PCM s16le mono at 16 kHz),
`output_audio` (PCM s16le mono at 24 kHz), and `turn_silence_ms`.

Send raw 16 kHz PCM as binary frames continuously. Responses contain raw
24 kHz PCM binary frames plus `user_transcript`, `transcript`,
`response_done`, and `error` JSON events. Send `{"type":"stop"}` when the
device ends the session. The XiaoZhi gateway converts the device's 60 ms
Opus frames to and from this PCM API and keeps the WebSocket open across turns.

For a local installation, set the gateway's `studio.url` to the Web UI server.
The gateway derives the realtime URL from it. `EKKO_REALTIME_URL` or
`realtime.url` can override that URL. The Web UI backend must have a valid
`DASHSCOPE_API_KEY` for Omni Realtime.
