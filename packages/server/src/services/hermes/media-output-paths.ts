import { join } from 'path'
import { config } from '../../config'

/**
 * Output paths for generated media.
 *
 * These used to live in the Hermes media controller. The ChatGPT web image
 * service writes into the same directory, and a service must not import from a
 * controller, so the helpers moved here and the controller re-exports them for
 * its existing callers and tests.
 */
export function defaultMediaOutputPath(requestId: string, now = new Date()): string {
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/g, '_') || `video_${now.getTime()}`
  return join(config.appHome, 'media', `${safeRequestId}.mp4`)
}

export function defaultImageOutputPath(requestId: string, index = 0): string {
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/g, '_') || `image_${Date.now()}`
  const suffix = index > 0 ? `-${index + 1}` : ''
  return join(config.appHome, 'media', `${safeRequestId}${suffix}.png`)
}
