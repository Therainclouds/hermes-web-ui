export interface ProfileWithDisplay {
  name: string
  displayName?: string | null
  alias?: string | null
}

/**
 * 获取 profile 的用户可见显示名，优先级：
 * 1. displayName（Web UI 可编辑）
 * 2. alias（expert-package.json 自动提取）
 * 3. name（系统标识）
 */
export function getProfileDisplayName(profile: ProfileWithDisplay | null | undefined): string {
  if (!profile) return ''
  return profile.displayName || profile.alias || profile.name
}
