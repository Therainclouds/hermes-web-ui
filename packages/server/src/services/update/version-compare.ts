interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

export function parseSemver(version: string): ParsedSemver | null {
  const normalized = version.trim()
  if (!normalized) return null

  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  }
}

export function isRemoteVersionNewer(localVersion: string, remoteVersion: string): boolean {
  const local = parseSemver(localVersion)
  const remote = parseSemver(remoteVersion)
  if (!local || !remote) return false

  if (remote.major !== local.major) return remote.major > local.major
  if (remote.minor !== local.minor) return remote.minor > local.minor
  return remote.patch > local.patch
}
