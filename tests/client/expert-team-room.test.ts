import { describe, expect, it } from 'vitest'
import type { ExpertDetail, ExpertManifest, ExpertProfileBindingRow } from '../../packages/client/src/api/hermes/experts'
import { buildExpertTeamRoomAgents, buildExpertTeamWelcomeEntries } from '../../packages/client/src/utils/hermes/expert-team-room'

describe('buildExpertTeamRoomAgents', () => {
  it('builds a group chat roster with captain first and members sorted by team order', () => {
    const detail: ExpertDetail = {
      slug: 'content-team',
      name: '内容专家团',
      kind: 'team',
      summary: '内容策划协作团队',
      description: 'desc',
      icon_url: null,
      cover_url: null,
      category: '内容',
      default_launch_target: 'group-chat',
      is_featured: false,
      latest_version: null,
      team_members: [
        { slug: 'content-team', name: '内容专家团', role_name: 'Captain', sort_order: 0, is_captain: true, latest_version: '1.0.0' },
        { slug: 'product-manager', name: '产品经理', role_name: 'PRD', sort_order: 2, is_captain: false, latest_version: '1.0.0' },
        { slug: 'copywriter', name: '文案专家', role_name: 'Copy', sort_order: 1, is_captain: false, latest_version: '1.0.0' },
      ],
    }

    const bindings: ExpertProfileBindingRow[] = [
      {
        id: 1,
        expert_slug: 'content-team',
        profile_name: 'expert_team_content-team',
        role: 'captain',
        parent_team_slug: '',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 2,
        expert_slug: 'product-manager',
        profile_name: 'expert_member_product-manager',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 3,
        expert_slug: 'copywriter',
        profile_name: 'expert_member_copywriter',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
    ]

    expect(buildExpertTeamRoomAgents('content-team', detail, bindings)).toEqual([
      {
        agent: 'hermes',
        profile: 'expert_team_content-team',
        name: '内容专家团',
        description: '内容策划协作团队',
      },
      {
        agent: 'hermes',
        profile: 'expert_member_copywriter',
        name: '文案专家',
        description: 'Copy',
      },
      {
        agent: 'hermes',
        profile: 'expert_member_product-manager',
        name: '产品经理',
        description: 'PRD',
      },
    ])
  })

  it('deduplicates repeated profiles and ignores unrelated bindings', () => {
    const bindings: ExpertProfileBindingRow[] = [
      {
        id: 1,
        expert_slug: 'content-team',
        profile_name: 'expert_team_content-team',
        role: 'captain',
        parent_team_slug: '',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 2,
        expert_slug: 'copywriter',
        profile_name: 'expert_member_copywriter',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 3,
        expert_slug: 'copywriter',
        profile_name: 'expert_member_copywriter',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 4,
        expert_slug: 'other-team',
        profile_name: 'expert_team_other-team',
        role: 'captain',
        parent_team_slug: '',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
    ]

    expect(buildExpertTeamRoomAgents('content-team', null, bindings)).toEqual([
      {
        agent: 'hermes',
        profile: 'expert_team_content-team',
        name: 'expert_team_content-team',
        description: '',
      },
      {
        agent: 'hermes',
        profile: 'expert_member_copywriter',
        name: 'expert_member_copywriter',
        description: '',
      },
    ])
  })
})

describe('buildExpertTeamWelcomeEntries', () => {
  it('builds welcome messages from each manifest starter prompt in roster order', () => {
    const detail: ExpertDetail = {
      slug: 'content-team',
      name: '内容专家团',
      kind: 'team',
      summary: '内容策划协作团队',
      description: 'desc',
      icon_url: null,
      cover_url: null,
      category: '内容',
      default_launch_target: 'group-chat',
      is_featured: false,
      latest_version: null,
      team_members: [
        { slug: 'content-team', name: '内容专家团', role_name: 'Captain', sort_order: 0, is_captain: true, latest_version: '1.0.0' },
        { slug: 'copywriter', name: '文案专家', role_name: 'Copy', sort_order: 1, is_captain: false, latest_version: '1.0.0' },
        { slug: 'product-manager', name: '产品经理', role_name: 'PRD', sort_order: 2, is_captain: false, latest_version: '1.0.0' },
      ],
    }

    const bindings: ExpertProfileBindingRow[] = [
      {
        id: 1,
        expert_slug: 'content-team',
        profile_name: 'expert_team_content-team',
        role: 'captain',
        parent_team_slug: '',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 2,
        expert_slug: 'copywriter',
        profile_name: 'expert_member_copywriter',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 3,
        expert_slug: 'product-manager',
        profile_name: 'expert_member_product-manager',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
    ]

    const manifestBySlug: Record<string, ExpertManifest | null | undefined> = {
      'content-team': {
        id: 'team',
        version: '1.0.0',
        profileTemplate: {
          starterPrompts: ['统筹目标', '协调分工'],
        },
      } as ExpertManifest,
      'copywriter': {
        id: 'copywriter',
        version: '1.0.0',
        profileTemplate: {
          starterPrompts: ['撰写文案', '优化表达'],
        },
      } as ExpertManifest,
      'product-manager': {
        id: 'pm',
        version: '1.0.0',
        profileTemplate: {
          starterPrompts: ['梳理需求'],
        },
      } as ExpertManifest,
    }

    const entries = buildExpertTeamWelcomeEntries('content-team', detail, bindings, manifestBySlug)
    expect(entries.map((entry) => entry.profile)).toEqual([
      'expert_team_content-team',
      'expert_member_copywriter',
      'expert_member_product-manager',
    ])
    expect(entries[0]?.content).toContain('统筹目标')
    expect(entries[1]?.content).toContain('优化表达')
    expect(entries[1]?.content).toContain('我主要负责：Copy')
    expect(entries[2]?.content).toContain('梳理需求')
  })

  it('falls back to a simple intro when a member manifest is missing', () => {
    const detail: ExpertDetail = {
      slug: 'content-team',
      name: '内容专家团',
      kind: 'team',
      summary: '内容策划协作团队',
      description: 'desc',
      icon_url: null,
      cover_url: null,
      category: '内容',
      default_launch_target: 'group-chat',
      is_featured: false,
      latest_version: null,
      team_members: [
        { slug: 'content-team', name: '内容专家团', role_name: 'Captain', sort_order: 0, is_captain: true, latest_version: '1.0.0' },
        { slug: 'product-manager', name: '产品经理', role_name: 'PRD', sort_order: 1, is_captain: false, latest_version: '1.0.0' },
      ],
    }

    const bindings: ExpertProfileBindingRow[] = [
      {
        id: 1,
        expert_slug: 'content-team',
        profile_name: 'expert_team_content-team',
        role: 'captain',
        parent_team_slug: '',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 2,
        expert_slug: 'product-manager',
        profile_name: 'expert_member_product-manager',
        role: 'member',
        parent_team_slug: 'content-team',
        installed_version: '1.0.0',
        created_at: 0,
        updated_at: 0,
      },
    ]

    const entries = buildExpertTeamWelcomeEntries('content-team', detail, bindings, {})
    expect(entries[1]?.content).toContain('产品经理')
    expect(entries[1]?.content).toContain('我主要负责：PRD')
    expect(entries[1]?.content).toContain('请告诉我你希望我从哪个方向开始协助')
  })
})
