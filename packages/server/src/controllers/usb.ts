import { getUSBService } from '../services/usb'

function serviceErrorStatus(error: unknown): number {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
  if (code === 'invalid_path') return 400
  if (code === 'not_found') return 404
  if (code === 'file_too_large') return 413
  return 500
}

function serviceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'USB request failed'
}

function bufferResponse(buffer: Buffer): { encoding: 'utf-8' | 'base64', content: string } {
  const looksBinary = buffer.includes(0)
  if (looksBinary) {
    return {
      encoding: 'base64',
      content: buffer.toString('base64'),
    }
  }
  return {
    encoding: 'utf-8',
    content: buffer.toString('utf-8'),
  }
}

export async function listUSBDevices(ctx: any) {
  const service = getUSBService()
  ctx.body = {
    runtime: service.status(),
    devices: service.listDevices(),
  }
}

export async function listUSBHistory(ctx: any) {
  const service = getUSBService()
  const since = typeof ctx.query?.since === 'string' ? ctx.query.since : '24h'
  ctx.body = {
    runtime: service.status(),
    events: service.listHistory(since),
  }
}

export async function listUSBFiles(ctx: any) {
  const service = getUSBService()
  const uuid = String(ctx.params?.uuid || '').trim()
  const relativePath = typeof ctx.query?.path === 'string' ? ctx.query.path : '/'
  try {
    ctx.body = {
      uuid,
      path: relativePath,
      entries: await service.listFiles(uuid, relativePath),
    }
  } catch (error) {
    ctx.status = serviceErrorStatus(error)
    ctx.body = { error: serviceErrorMessage(error) }
  }
}

export async function statUSBPath(ctx: any) {
  const service = getUSBService()
  const uuid = String(ctx.params?.uuid || '').trim()
  const relativePath = typeof ctx.query?.path === 'string' ? ctx.query.path : '/'
  try {
    ctx.body = {
      uuid,
      stat: await service.statPath(uuid, relativePath),
    }
  } catch (error) {
    ctx.status = serviceErrorStatus(error)
    ctx.body = { error: serviceErrorMessage(error) }
  }
}

export async function readUSBFile(ctx: any) {
  const service = getUSBService()
  const uuid = String(ctx.params?.uuid || '').trim()
  const relativePath = typeof ctx.query?.path === 'string' ? ctx.query.path : ''
  try {
    const content = await service.readFile(uuid, relativePath)
    const response = bufferResponse(content)
    ctx.body = {
      uuid,
      path: relativePath,
      size: content.byteLength,
      ...response,
    }
  } catch (error) {
    ctx.status = serviceErrorStatus(error)
    ctx.body = { error: serviceErrorMessage(error) }
  }
}

export async function usbDiskUsage(ctx: any) {
  const service = getUSBService()
  const uuid = String(ctx.params?.uuid || '').trim()
  try {
    ctx.body = {
      uuid,
      usage: await service.diskUsage(uuid),
    }
  } catch (error) {
    ctx.status = serviceErrorStatus(error)
    ctx.body = { error: serviceErrorMessage(error) }
  }
}
