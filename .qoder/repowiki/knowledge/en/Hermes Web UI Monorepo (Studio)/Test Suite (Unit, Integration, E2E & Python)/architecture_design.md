Tests are organized by target domain into parallel directories mirroring the application's architecture:
- `client/` — Vitest unit tests for React components, stores, hooks, and browser-only modules.
- `server/` — Vitest unit/integration tests for Node.js HTTP routes, services, DB layers, and WebSocket handlers; uses in-memory SQLite (`DatabaseSync`) and mocked auth middleware.
- `desktop/` — Tests for Electron-specific code (CLI shim, runtime manager, updater) with a minimal `mocks/electron.ts` shim.
- `e2e/` — Playwright specs that spin up a real app instance and use `fixtures.ts` to intercept all `/api/*` and `/v1/*` requests via `page.route`, plus helpers to mock Socket.IO and terminal WebSockets.
- `ekko-agent/` — Unit tests for the Ekko agent subsystem (browser tools, memory store, model requests, runtime, tools).
- `python/` — Standard-library `unittest` suite for the USB monitor scripts under `hermes_data/bots/usb`.
- Shared infrastructure: `setup.ts` bootstraps Vitest globals (`__APP_VERSION__`, `window.matchMedia`, `localStorage`); `fixtures/fake-mcp-server.cjs` is a stdio-based MCP server used by integration tests; `group-chat-test-helpers.ts` provides an in-memory GroupChatServer fixture with socket utilities (`once`, `emitAck`).
Dependency direction is one-way: test files import source modules from `../../packages/server/src/...` or `../../packages/client/src/...`; no production code imports test files.