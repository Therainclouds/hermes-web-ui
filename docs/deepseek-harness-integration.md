# DeepSeek Harness coding agent integration

Hermes Web UI registers DeepSeek Harness (`dsh`) as a third managed coding
agent beside Claude Code and Codex. It launches the DeepSeek Harness SDK
runtime as a subprocess, drives it over newline-delimited JSON-RPC stdio, and
maps its session log onto the same canonical Responses event stream the other
coding agents use, so streaming text, reasoning, tool traces, persistence, and
Socket.IO delivery all reuse the existing pipeline.

## Data flow

```text
Coding Agents / Chat (coding_agent_id=deepseek-harness)
        │
        ▼
coding-agents.ts  prepareCodingAgentLaunch
        │  writes scoped cordis.yml, sets DSH_* / DEEPSEEK_* env
        ▼
coding-agent-run-manager.ts  spawnDeepseekHarnessChild
        │  spawn dsh-jsonrpc-agent <cordis.yml>  (persistent, stdio)
        ▼
DshJsonRpcClient  (JSON-RPC: initialize → session/prompt; session.event/status notifications)
        │
        ▼
dsh-session-event-mapper.ts  (session.event → CanonicalResponsesEvent)
        │
        ▼
handleResponseEvent  →  applyResponseStreamEvent / emitToChat  (shared with Claude Code)
```

The runtime keeps one `dsh-jsonrpc-agent` process per session. Each user turn
sends a `session/prompt` request; the turn closes when the runtime reports
`session.status` `idle`. Multi-turn continuity lives inside the persistent
runtime, not in per-turn subprocess `--resume` flags.

## Install / runtime discovery

The runtime is resolved in this order:

1. The bundled `dsh-jsonrpc-agent` executable on `PATH` (from
   `python3 -m pip install deepseek-harness-sdk`).
2. A local DeepSeek Harness source checkout, launched directly as
   `node --import tsx <checkout>/packages/examples/jsonrpc-demo/src/bin.ts
   <checkout>/examples/jsonrpc-agent/cordis.yml` with the checkout as its
   working directory. The checkout is discovered from `DEEPSEEK_HARNESS_ROOT`,
   `~/dev/deepseek-harness`, `~/deepseek-harness`, or `/home/kali/dev/deepseek-harness`.

The source-checkout path needs no `pip` install and no global `dsh` binary: it
runs the harness from its own repository, so a machine with the checkout built
can start DeepSeek Harness coding agents the moment the Web UI starts. This
mirrors the existing Hermes Agent runtime-discovery pattern.

The runtime reads the ordinary DeepSeek Harness environment, so the DeepSeek
API key and endpoint come from the Hermes provider selected in scoped launch
(`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`), the same way Claude Code and Codex
receive their credentials.

## Updating the runtime

Hermes only launches DeepSeek Harness; it does not vendor the harness, so
updating the harness means updating whichever source is active:

- Bundled binary: `python3 -m pip install --upgrade deepseek-harness-sdk`
  (upgrades `deepseek-harness-runtime-bin` along with it). The Coding Agents
  page "Install" button runs this same `--upgrade` command.
- Source checkout: `cd <checkout> && git pull && pnpm install && pnpm run build`.

Each new coding-agent session spawns a fresh runtime subprocess, so a runtime
update takes effect on the next session without restarting the Web UI. A
Web UI restart is needed only when the harness's JSON-RPC wire protocol or
session-event shapes change enough to require edits in
`dsh-jsonrpc-client.ts` / `dsh-session-event-mapper.ts` / the cordis template
in `coding-agents.ts`.

## Composition

For the bundled binary, `prepareCodingAgentLaunch` writes a managed
`cordis.yml` into the scoped runtime directory. For a source checkout it uses
the checkout's own `examples/jsonrpc-agent/cordis.yml`. Both mount the SDK
JSON-RPC server, the DeepSeek adapter (`deepseek-official`), local bash,
`read`/`write`/`edit`, an in-process `subagent` tool, `todo_write`, JSONL
session persistence, and context compaction. The Hermes system prompt becomes
the agent persona through `DSH_SYSTEM_PROMPT`; `DSH_CWD` pins the workspace and
`DSH_SESSION_ROOT` the session directory under the scoped runtime root.

## Configuration files

The Coding Agents page exposes one editable file for this agent:

| Key | Path | Language |
| --- | --- | --- |
| `cordis` | `~/.deepseek-harness/cordis.yml` | yaml |

## Troubleshooting

A run that fails with `spawn dsh-jsonrpc-agent ENOENT` means neither the
bundled binary nor a local source checkout could be found. Install the binary
with `python3 -m pip install deepseek-harness-sdk`, or point
`DEEPSEEK_HARNESS_ROOT` at a built checkout. The Coding Agents page shows "not
installed" for the same condition. A non-zero exit (for example
`DeepSeek Harness exited with code 1: ...`) carries the runtime's stderr tail,
which is the cordis composition boot failure to inspect.

## Known limitations

- The shipped adapter is DeepSeek (`deepseek-official`). Selecting a
  non-DeepSeek provider for this coding agent does not switch the runtime's
  model adapter in this iteration.
- The model id selected in Hermes is passed through to the DeepSeek adapter
  verbatim; exact-model resolution belongs to the harness.
- DeepSeek Harness is in developer preview with compatibility-breaking changes;
  the SDK wire protocol and package names may change.
- Workflow nodes, group chat, and meeting agent selection do not offer
  `deepseek-harness` yet; only the Coding Agents page and the chat
  new-session agent picker do.
