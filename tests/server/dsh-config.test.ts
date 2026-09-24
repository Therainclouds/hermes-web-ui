import { describe, expect, it } from 'vitest'
import {
  readDshMcpServers,
  updateDshMcpServer,
  validateDshMcpServer,
  validateDshSettings,
  assertDshMcpProbeIsLiteral,
} from '../../packages/server/src/services/coding-agents/dsh/config'

describe('DSH MCP server YAML config', () => {
  const emptyPatch = '- insert: []\n'

  it('rejects settings that are not a YAML mapping', () => {
    expect(() => validateDshSettings('- 1\n')).toThrow(/YAML mapping/)
  })

  it('parses existing MCP entries and preserves enabled flag', () => {
    const patch = `${emptyPatch}
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: filesystem
    command: uvx
    args:
      - mcp-filesystem
- name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config:
    serverName: remote
    transport: streamable-http
    url: https://example.com/mcp
`
    const servers = readDshMcpServers(patch)
    expect(servers.get('filesystem')).toMatchObject({ command: 'uvx', enabled: true })
    expect(servers.get('remote')).toMatchObject({ transport: 'streamable-http', url: 'https://example.com/mcp', enabled: false })
  })

  it('rejects invalid MCP server names', () => {
    expect(() => validateDshMcpServer('bad name', { command: 'x' })).toThrow(/MCP names/)
  })

  it('rejects MCP entries that set both command and url', () => {
    expect(() => validateDshMcpServer('hybrid', { command: 'x', url: 'https://x' })).toThrow(/either command or url/)
  })

  it('rejects unsupported MCP transports', () => {
    expect(() => validateDshMcpServer('weird', { transport: 'sse' })).toThrow(/Streamable HTTP/)
  })

  it('updates an existing MCP entry without disturbing comments', () => {
    const original = `${emptyPatch}
# filesystem lives on the local box
- name: '@deepseek-ai/dsh-mcp-client' # marker
  config:
    serverName: filesystem
    command: uvx
`
    const next = updateDshMcpServer(original, 'filesystem', {
      command: 'uvx',
      args: ['mcp-filesystem'],
      enabled: true,
    })
    expect(next).toMatch(/# filesystem lives on the local box/)
    expect(next).toMatch(/# marker/)
    expect(next).toMatch(/mcp-filesystem/)
  })

  it('removes an MCP entry by setting config to null', () => {
    const patch = `${emptyPatch}
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: filesystem
    command: uvx
`
    const next = updateDshMcpServer(patch, 'filesystem', null)
    expect(next).not.toMatch(/serverName: filesystem/)
  })

  it('inserts a new MCP entry via the insert envelope', () => {
    const next = updateDshMcpServer(emptyPatch, 'remote', {
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      enabled: true,
    })
    expect(next).toMatch(/id: mcp-remote/)
    expect(next).toMatch(/serverName: remote/)
    expect(next).toMatch(/transport: streamable-http/)
  })

  it('refuses to probe an MCP entry that contains JavaScript expressions', () => {
    const patch = `${emptyPatch}
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: filesystem
    command: !!js "process.env.SHELL_CMD ?? 'uvx'"
`
    expect(() => assertDshMcpProbeIsLiteral(patch, 'filesystem')).toThrow(/JavaScript expressions/)
  })
})