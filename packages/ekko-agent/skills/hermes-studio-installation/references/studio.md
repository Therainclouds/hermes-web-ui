# Quanthermes Studio installation

Use the user's existing Quanthermes installation and its configured update source.
Do not redirect the installation to the upstream Ekko npm package, Docker image, commercial App, or update feeds.

## Source installation

Requires Git, Node.js 23 or newer, and npm. Inspect existing changes first.

```bash
git clone https://github.com/tangledup-ai/hermes-web-ui.git
cd hermes-web-ui
npm ci
npm run build
NODE_ENV=production node dist/server/index.js
```

The backend defaults to port 8647. Development uses `npm run dev`, with the frontend on port 6060.
The npm package is `@quanthermes/hermes-web-ui`; its CLI is `hermes-web-ui`.
For CLI arguments, read `hermes-web-ui --help` from the installed version.
For MCP use `hermes-studio-mcp [api|browser|devices|use]`.

## Updates and persistence

Use the project's update UI and configured Quanthermes OSS manifests. Preserve the source-deploy/device-package update contract, existing operator pins, and user settings. Do not publish or promote releases unless requested.
Desktop updates, Hermes Runtime installation, and `hermes update` are separate operations.
Docker deployments must keep their existing image policy and persistent mounts; inspect this checkout's Compose file before recreating a container.

Studio state resolves through `HERMES_WEB_UI_HOME` or `HERMES_WEBUI_STATE_DIR`, defaulting to `~/.hermes-web-ui`.
Hermes data uses `HERMES_HOME`, defaulting to `~/.hermes`.
Never discard a dirty checkout or delete an active runtime merely to upgrade.

## XiaoZhi

The local XiaoZhi OTA and `/global-agent` pipeline defaults to Hermes. Explicit `agentRuntime: "ekko"` is optional and uses isolated Ekko sessions. Preserve firmware endpoint, Opus, camera MCP, profile authorization and playback/clear-session behavior.
