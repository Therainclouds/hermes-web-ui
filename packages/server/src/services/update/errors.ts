export type UpdateErrorCode =
  | 'update_execution_misconfigured'
  | 'update_dangerous_layout'

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
