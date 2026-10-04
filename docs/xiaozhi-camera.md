# XiaoZhi camera

The Devices page includes a camera capture button, preview and download.
The device must be on the same LAN, provisioned using the OTA URL shown by the page,
and have an open WebSocket session (wake the device first).

Device configuration is stored under getWebUiHome()/devices/xiaozhi.json.
The existing deviceId selects the camera; optional deviceIds keeps additional boards
eligible for OTA provisioning. gatewayMcpToken authenticates local MCP requests.

The gateway camera configuration must include url (the LAN-accessible
/api/xiaozhi/camera/upload endpoint) and token (the provisioned device bearer token).
The policy allow list must permit self.camera.take_photo. At hello the gateway sends
the camera upload capability during the device MCP initialize handshake.

POST /api/xiaozhi/camera/capture is administrator-only. It invokes the selected
physical camera, which uploads multipart JPEG with its Device-Id and bearer token.
The public upload route independently verifies both credentials and bounds input
size to 3 MB. Photos use random IDs and are stored under the Web UI state directory.
GET /api/xiaozhi/photos/:id requires administrator authentication; ?format=json
returns base64 for the authenticated client, which creates a temporary blob preview.

This feature captures and saves photos; it does not send them to a vision model.
Photo storage is persistent; downloads are available from the current page preview.
