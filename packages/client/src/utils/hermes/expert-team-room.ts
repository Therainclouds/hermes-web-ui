import type { ExpertDetail, ExpertManifest, ExpertProfileBindingRow } from '@/api/hermes/experts'

export interface ExpertTeamRoomAgentInput {
  agent: 'hermes'
  profile: string
  name?: string
  description?: string
  invited?: boolean
}

export interface ExpertTeamWelcomeEntry {
  profile: string
  senderId: string
  senderName: string
  content: string
}

interface ExpertTeamRosterEntry {
  slug: string
  profile: string
  name: string
  description: string
  role: 'captain' | 'member'
  sortOrder: number
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, 'zh-CN')
}

function normalizePrompts(prompts: string[] | undefined): string[] {
  return (prompts || []).map((prompt) => String(prompt || '').trim()).filter(Boolean)
}

function buildWelcomeText(name: string, prompts: string[], roleName?: string, isCaptain = false) {
  const intro = `👋 大家好，我是 **${name}**。`
  const roleLine = roleName && !isCaptain ? `\n\n我主要负责：${roleName}。` : ''
  const normalizedPrompts = normalizePrompts(prompts)
  if (normalizedPrompts.length > 0) {
    return `${intro}${roleLine}\n\n我可以帮助你：\n${normalizedPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}\n\n请告诉我你想从哪个方向开始？`
  }
  if (roleName && !isCaptain) {
    return `${intro}${roleLine}\n\n请告诉我你希望我从哪个方向开始协助。`
  }
  return `${intro}\n\n请告诉我你想做什么？`
}

function buildExpertTeamRoster(
  teamSlug: string,
  detail: ExpertDetail | null | undefined,
  bindings: ExpertProfileBindingRow[],
) {
  if (!teamSlug) return []

  const captainBinding = bindings.find((binding) =>
    binding.role === 'captain' && binding.expert_slug === teamSlug,
  )
  const memberBindings = bindings
    .filter((binding) => binding.role === 'member' && binding.parent_team_slug === teamSlug)

  const memberMetaBySlug = new Map(
    (detail?.team_members || [])
      .filter((member) => !member.is_captain)
      .map((member) => [member.slug, member] as const),
  )

  const sortedMemberBindings = [...memberBindings].sort((left, right) => {
    const leftMeta = memberMetaBySlug.get(left.expert_slug)
    const rightMeta = memberMetaBySlug.get(right.expert_slug)
    const leftOrder = leftMeta?.sort_order ?? Number.MAX_SAFE_INTEGER
    const rightOrder = rightMeta?.sort_order ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return compareText(leftMeta?.name || left.profile_name, rightMeta?.name || right.profile_name)
  })

  const roster: ExpertTeamRosterEntry[] = []

  if (captainBinding) {
    roster.push({
      slug: teamSlug,
      profile: captainBinding.profile_name,
      name: detail?.name || captainBinding.profile_name,
      description: detail?.summary || '',
      role: 'captain',
      sortOrder: -1,
    })
  }

  for (const binding of sortedMemberBindings) {
    const meta = memberMetaBySlug.get(binding.expert_slug)
    roster.push({
      slug: binding.expert_slug,
      profile: binding.profile_name,
      name: meta?.name || binding.profile_name,
      description: meta?.role_name || '',
      role: 'member',
      sortOrder: meta?.sort_order ?? Number.MAX_SAFE_INTEGER,
    })
  }

  const seenProfiles = new Set<string>()
  return roster.filter((entry) => {
    if (!entry.profile || seenProfiles.has(entry.profile)) return false
    seenProfiles.add(entry.profile)
    return true
  })
}

export function buildExpertTeamRoomAgents(
  teamSlug: string,
  detail: ExpertDetail | null | undefined,
  bindings: ExpertProfileBindingRow[],
): ExpertTeamRoomAgentInput[] {
  return buildExpertTeamRoster(teamSlug, detail, bindings).map((entry) => ({
    agent: 'hermes' as const,
    profile: entry.profile,
    name: entry.name,
    description: entry.description,
  }))
}

export function buildExpertTeamWelcomeEntries(
  teamSlug: string,
  detail: ExpertDetail | null | undefined,
  bindings: ExpertProfileBindingRow[],
  manifestBySlug: Record<string, ExpertManifest | null | undefined>,
): ExpertTeamWelcomeEntry[] {
  return buildExpertTeamRoster(teamSlug, detail, bindings).map((entry) => {
    const prompts = manifestBySlug[entry.slug]?.profileTemplate?.starterPrompts || []
    return {
      profile: entry.profile,
      senderId: `agent:${entry.profile}`,
      senderName: entry.name,
      content: buildWelcomeText(entry.name, prompts, entry.description, entry.role === 'captain'),
    }
  })
}
