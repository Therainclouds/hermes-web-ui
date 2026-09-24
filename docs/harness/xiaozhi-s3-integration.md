# XiaoZhi S3 → Hermes / Ekko Agent

This integration reuses the existing `/global-agent` MCU voice path. An external
`xiaozhi-ekko-gateway` converts XiaoZhi WebSocket/Opus into MCU voice stream events
and exposes the board's MCP tools. No Studio user JWT is stored on the board.

## Changes

- `packages/ekko-agent/src/tools/mcp.ts` now uses the MCP client SDK for stdio and
  Streamable HTTP, based on the implementation in the local Ekko Studio reference.
  `type: http`, `transport: http`, and URL-only configurations are accepted.
- Dotted/long/duplicate remote tool names are exposed through a model-safe proxy;
  the original name is kept on the wire. This matters for `self.get_device_status`.
- The optional `/api/xiaozhi/ota/:code` GET/POST endpoint returns only a WebSocket
  configuration and server time. It does not update firmware or return MQTT config.
  Requests require both the device's configured setup code and matching Device-Id.
  Invalid configuration, code, or device returns 404. Responses are not cacheable.

## Local configuration

Create `<getWebUiHome()>/devices/xiaozhi.json`, with mode 0600:

```json
{
  "deviceId": "98:a3:16:f3:0f:68",
  "setupCode": "<random setup code, at least 24 characters>",
  "websocketUrl": "ws://<computer LAN address>:8765",
  "deviceToken": "<random device token, at least 24 characters>"
}
```

The file is opt-in and currently supports one board. No file means the route is
inactive. Match `deviceToken` to the gateway device token. Use the computer's
current LAN address; a previous network's address will not work.

Set the board's advanced OTA URL to
`http://<computer LAN address>:8647/api/xiaozhi/ota/<setupCode>` through its WiFi
configuration page. The OTA URL is HTTP, not the WebSocket URL. Keep the setup
code private; the endpoint is intended for the trusted local test network.

Register this in the desired profile's `mcp_servers` only when authorized:

```json
{
  "xiaozhi-device": {
    "type": "http",
    "url": "http://127.0.0.1:8766/mcp",
    "headers": { "Authorization": "Bearer <gateway MCP token>" }
  }
}
```

The deployed legacy `/api/hermes/mcp/servers` management controller uses the
Python Hermes bridge, which may report `MCP tool module not available`. That is
separate from Ekko Agent's MCP provider. Profile config or per-run `mcpServers`
can configure the native Ekko runtime; do not claim that the legacy panel tests
that runtime.

## Verification

1. Gateway connects to Studio `/global-agent` with `auth.role=hermes-studio` and a
   user JWT. MCU events also require `apiToken` (the gateway supplies this).
2. Device fetches the local OTA config, then opens its WebSocket audio channel.
3. `tools/list` exposes the physical device's `self.get_device_status` through the
   gateway. Keep gateway policy read-only during commissioning.
4. Invoke that tool from a real Agent run and check both tool events and the
   returned hardware state. Model-only replies are not tool verification.
5. Test a spoken request, interruption and reconnection separately. A successful
   text/tool roundtrip does not prove microphone, ASR or TTS playback.

For `/api/chat-run/runs` with `coding_agent_id=ekko-agent`, supply provider, model
and apiMode together (for example, `anthropic_messages` with the configured
MiniMax provider). Profile defaults are not used by that HTTP request validator.

Tests: `tests/ekko-agent/mcp-http.test.ts`, existing MCP multimodal tests and
`tests/server/xiaozhi-provisioning.test.ts`. No physical device is emulated as a
substitute for the final live acceptance check.
