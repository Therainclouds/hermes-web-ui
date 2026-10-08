import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const setup = String.raw`
import copy, json, os, sys, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/services/hermes/agent-bridge/python').resolve()))
from bridge_mcp import install_studio_mcp_env

tools = types.ModuleType('tools')
tools.__path__ = []
sys.modules['tools'] = tools
layout = sys.argv[1]
module_name = 'tools.mcp_tool_config' if layout == 'split' else 'tools.mcp_tool'
module = types.ModuleType(module_name)
module._build_safe_env = lambda env: {'PATH': os.environ.get('PATH', ''), **(env or {})}
sys.modules[module_name] = module
if layout == 'legacy':
    sys.modules['tools.mcp_tool_config'] = None

owner = {'HERMES_WEB_UI_URL': 'http://127.0.0.1:8748',
         'HERMES_WEB_UI_HOME': '/owner/state', 'HERMES_WEBUI_STATE_DIR': '/owner/state',
         'ELECTRON_RUN_AS_NODE': '1'}
os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV'] = json.dumps(owner)
os.environ['HERMES_AGENT_BRIDGE_WORKER_PROFILE'] = 'research'
stale = {'HERMES_WEB_UI_MANAGED_MCP': '1', 'HERMES_WEB_UI_URL': 'http://127.0.0.1:8647',
         'HERMES_WEB_UI_HOME': '/other/state', 'HERMES_WEBUI_STATE_DIR': '/other/state',
         'HERMES_WEB_UI_PROFILE': 'default', 'HERMES_WEB_UI_TOKEN': 'stale-token',
         'HERMES_MCP_TOOLSET': 'plan', 'CUSTOM': 'keep'}
original = copy.deepcopy(stale)
`

describe('Hermes Bridge managed MCP instance routing', () => {
  it.each(['split', 'legacy'])('pins managed MCP launch env to the owner on %s runtimes', layout => {
    const output = execFileSync(python, ['-c', setup + String.raw`
install_studio_mcp_env()
installed = module._build_safe_env
install_studio_mcp_env()
assert module._build_safe_env is installed
actual = installed(stale)
assert stale == original
for key, value in owner.items():
    assert actual[key] == value, (key, actual)
assert actual['HERMES_WEB_UI_PROFILE'] == 'research'
assert 'HERMES_WEB_UI_TOKEN' not in actual
assert actual['CUSTOM'] == 'keep' and actual['HERMES_MCP_TOOLSET'] == 'plan'
assert installed(None) == {'PATH': os.environ.get('PATH', '')}
custom = {**stale, 'HERMES_WEB_UI_MANAGED_MCP': '0'}
assert installed(custom) == {'PATH': os.environ.get('PATH', ''), **custom}
print('ok')
`, layout], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('does not change standalone Hermes launches without a Studio owner', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
del os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV']
original_builder = module._build_safe_env
install_studio_mcp_env()
assert module._build_safe_env is original_builder
print('ok')
`, 'split'], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('keeps XiaoZhi user-owned MCP device credentials and routing unchanged', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
install_studio_mcp_env()
device = {'HERMES_WEB_UI_MANAGED_MCP': '0', 'HERMES_WEB_UI_URL': 'http://xiaozhi.local:8765', 'DEVICE_TOKEN': 'device-only'}
assert module._build_safe_env(device)['DEVICE_TOKEN'] == 'device-only'
assert module._build_safe_env(device)['HERMES_WEB_UI_URL'] == 'http://xiaozhi.local:8765'
print('ok')
`, 'split'], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })
})
