import { readConfigYamlForProfile } from '../config-helpers'
import { resolveEkkoProviderRuntimeConfig } from '../ekko-agent/provider-runtime'
import { resolveModelExecutionIdentity } from '../model-execution-identity'
import { MCU_VOICE_SYSTEM_INSTRUCTIONS } from './mcu-voice-instructions'

export type McuAgentRuntime = 'ekko' | 'hermes'

export const DEFAULT_MCU_AGENT_RUNTIME: McuAgentRuntime = 'ekko'

export function normalizeMcuAgentRuntime(value: unknown): McuAgentRuntime {
  return typeof value === 'string' && value.trim().toLowerCase() === 'hermes'
    ? 'hermes'
    : DEFAULT_MCU_AGENT_RUNTIME
}

export function mcuChatRunFields(agentRuntime: McuAgentRuntime) {
  if (agentRuntime === 'hermes') {
    return {
      source: 'global_agent' as const,
      session_source: 'global_agent' as const,
      instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
    }
  }

  return {
    source: 'coding_agent' as const,
    session_source: 'global_agent' as const,
    coding_agent_id: 'ekko-agent' as const,
    instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
  }
}

export async function resolveMcuModelFields(profile: string, runtime: McuAgentRuntime) {
  if (runtime === 'hermes') return {}
  const config = await readConfigYamlForProfile(profile)
  const provider = String(config.model?.provider || '').trim()
  const model = String(config.model?.default || '').trim()
  const resolved = await resolveEkkoProviderRuntimeConfig({ profile, provider, model })
  return resolveModelExecutionIdentity({ profile, provider, model, apiMode: resolved.apiMode })
}
