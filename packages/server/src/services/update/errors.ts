export type UpdateErrorCode =
  | 'update_execution_misconfigured'
  | 'update_dangerous_layout'
  | 'update_preflight_permissions'
  | 'update_preflight_space'
  | 'update_manifest_fetch_failed'
  | 'update_manifest_invalid'
  | 'update_incompatible_node'
  | 'update_incompatible_current_version'
  | 'update_registry_query_failed'
  | 'update_registry_invalid'
  | 'update_download_failed'
  | 'update_package_fetch_failed'
  | 'update_sha256_mismatch'
  | 'update_install_spawn_failed'

export class UpdateError extends Error {
  code: UpdateErrorCode
  status: number
  details?: unknown

  constructor(code: UpdateErrorCode, message: string, status = 500, details?: unknown) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
    this.status = status
    this.details = details
  }
}
