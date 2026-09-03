# Agent Bridge

Optional backend-side bridge for talking to Hermes Agent by instantiating
`run_agent.AIAgent` directly in a Python process.

This is intentionally separate from the current Web UI chat path.

## Python Service

Python bridge code lives under `python/` so it stays separate from the Node/TS
bridge client and manager code. The executable entrypoint is
`python/hermes_bridge.py`, and the implementation is split across sibling
Python modules:

- `bridge_runtime.py` - environment, config, import discovery, JSON helpers.
- `bridge_pool.py` - in-process agent sessions, runs, callbacks, approvals.
- `bridge_server.py` - worker-side request handling.
- `bridge_transport.py` - socket protocol and worker process helpers.
- `bridge_broker.py` - broker-side profile worker routing.

```bash
python packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py
```

Default endpoint:

```text
ipc:///tmp/hermes-agent-bridge.sock
```

On Windows, the default endpoint is TCP because Python may not support Unix
domain sockets there:

```text
tcp://127.0.0.1:18765
```

Override with:

```bash
HERMES_AGENT_BRIDGE_ENDPOINT=tcp://127.0.0.1:8765 python packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py
```

Profile workers use the same platform defaults: TCP on Windows and IPC on
macOS/Linux. Override worker transport with:

```bash
HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp HERMES_AGENT_BRIDGE_WORKER_PORT_BASE=18780 python packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py
```

The service discovers Hermes Agent in this order:

1. `--agent-root`
2. `HERMES_AGENT_ROOT`
3. the installed `hermes` command path
4. current working directory and parent directories
5. common locations such as `~/.hermes/hermes-agent`, `~/hermes-agent`, and `/opt/hermes-agent`
6. the `hermes-agent` package installed in the selected Python environment

Hermes home is resolved from `--hermes-home`, `HERMES_HOME`, then `~/.hermes`.

Default agent root:

```text
~/.hermes/hermes-agent
```

You can pass both paths explicitly:

```bash
python packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py \
  --agent-root ~/.hermes/hermes-agent \
  --hermes-home ~/.hermes
```

If no source checkout containing `run_agent.py` is found, the bridge falls back
to importing `run_agent` from the Python environment. This supports package
installs such as `pip install hermes-agent`. The Node manager prefers the source
checkout's virtualenv when a checkout exists, then the Python interpreter from
the installed `hermes` command, then the system Python.

The socket transport uses Python and Node standard libraries. No ZMQ dependency
is required.

## Backend Usage

```ts
import { AgentBridgeClient } from './services/hermes/agent-bridge'

const bridge = new AgentBridgeClient()
// Select this policy when the cached Hermes AgentSession is first created.
// contextEstimate may be the creation boundary before the first chat call.
await bridge.contextEstimate(
  sessionId,
  [],
  instructions,
  profile,
  { background_delegation_enabled: false },
)
const run = await bridge.chat(sessionId, message, undefined, instructions, profile, {
  // Creation fallback if chat is the first Bridge operation for this session.
  background_delegation_enabled: false,
})

for await (const chunk of bridge.streamOutput(run.run_id)) {
  if (chunk.delta) {
    // forward chunk.delta to Socket.IO/SSE/etc.
  }
}
```

To stop only the foreground run at a Hermes-owned safe boundary, bind the
request to the active Bridge run ID:

```ts
const boundary = await bridge.requestBoundaryInterrupt(
  sessionId,
  run.run_id,
  profile,
)
```

The model phase is interrupted immediately. An in-flight `_execute_tool_calls`
batch is allowed to finish before Hermes starts another model request. The
Bridge checks the installed Hermes runtime before enabling this capability and
returns `status: 'unsupported'` with `guarantee: 'none'` when its private
whole-batch boundary is incompatible; it never falls back to the broader user
stop that also interrupts tools and detached subagents.

The external chat call only sends `session_id` and `message`. Provider, model,
keys, tools, reasoning, and session DB are resolved by hermes-agent from the
normal Hermes config and environment.

`background_delegation_enabled` is an Agent-session creation setting. It is
optional and defaults to `true` for Bridge consumers that do not select a
policy. The created `AgentSession` retains the value, and later runs bind the
Hermes context from that cached setting instead of changing it per turn.
Passing `false` binds `async_delivery=false`, so `delegate_task` remains
available but requests for background execution fall back to the synchronous
path. Hermes currently exposes this as its session-level async-delivery
capability, so other detached-completion tools in that AgentSession also see it
disabled.

Hermes Web UI creates ordinary single-chat agents with this value set to
`true`, enabling background task delivery by default. Group-chat agents and
Hermes workflow-node agents set it to `false` at their own call sites and remain
intentionally disabled. Coding Agent and Ekko Agent calls do not receive this
Hermes Bridge field.

The bridge instantiates `AIAgent` with `platform="cli"` by default so behavior
matches CLI chat. Override it only if a caller intentionally needs a distinct
platform identity:

```bash
HERMES_AGENT_BRIDGE_PLATFORM=agent-bridge python packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py
```

## Troubleshooting

### `[Errno 2] No such file or directory` from the bridge

**Scope**: only relevant when this deployment talks to a **local Hermes Agent
installation** (a local `hermes` binary / agent root on the same machine, via
`HERMES_BIN` or an agent root under `~/.hermes`). Deployments that never run
the local agent bridge do not use this code path and do not need any of the
following.

**Symptom**: the Web UI chat reports
`Error: [Errno 2] No such file or directory` (note: *without* a filename in
the message) and `bridge.log` shows repeated
`[agent-bridge-client] request rejected` entries with the same error, while
`ping`/`status_if_loaded` requests still succeed.

**Root cause**: the bridge broker (`hermes_bridge.py`) is a long-lived process
that keeps listening on the fixed endpoint `ipc:///tmp/hermes-agent-bridge.sock`.
A newer Web UI server attaches to an already-running broker because it
responds to pings. If that broker was started from a directory that has since
been deleted (for example the project directory was wiped and re-cloned, or a
deploy replaced the working tree), every worker spawn fails: `os.getcwd()`
raises a bare `OSError: [Errno 2] No such file or directory` and
`subprocess.Popen(cwd=os.getcwd())` in `WorkerProcess.start()` fails the same
way. The Node side surfaces the raw errno string to the chat.

**Fix shipped** (2026-09): `bridge_transport.py` now resolves the spawn cwd
via `_safe_cwd()` — it validates the current working directory and falls back
to the directory containing the bridge script, so a stale broker keeps
working instead of failing every request.

**Manual recovery** (when running an older build, or to clean up orphans):

```bash
# 1. Find the process holding the broker socket
lsof /tmp/hermes-agent-bridge.sock

# 2. Kill the stale broker (and its workers)
kill -9 <PID>

# 3. Remove the stale socket if it is left behind
rm -f /tmp/hermes-agent-bridge.sock

# 4. Restart the Web UI server; the manager spawns a fresh broker
```

**Prevention**: prefer restarting the Web UI server after deleting/re-creating
its working directory (deploys, re-clones). If you manage the server under
systemd/launchd, a plain restart also restarts the bridge children.

