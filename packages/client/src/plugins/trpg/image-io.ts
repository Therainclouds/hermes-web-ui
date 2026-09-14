/** Mime types accepted for portraits and manually uploaded highlight images. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Accept only the image types the pipeline can actually store and re-send.
 *
 * Manual highlight uploads are the fallback when generation fails, so the same
 * bound as character portraits is enforced here instead of trusting the file
 * picker (a renamed `.png` can still carry arbitrary bytes).
 */
export function isSupportedImage(file: { type: string; size: number }): boolean {
  return (IMAGE_MIMES as readonly string[]).includes(file.type) && file.size > 0 && file.size <= MAX_IMAGE_BYTES
}

/** Downscale reference inputs before JSON transport; originals remain local Blobs. */
export async function imageDataUri(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('imageInvalid')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.88)
  } finally { bitmap.close() }
}
/**
 * Encode any file (e.g. PDF character sheet) as a data URI without canvas conversion.
 * The downstream LLM is expected to consume the raw bytes for non-image MIME types
 * (the server sends PDFs as file content blocks, images as image_url).
 */
export async function fileDataUri(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return `data:${blob.type};base64,${btoa(binary)}`
}
/** Raw base64 (no data-URI prefix) for JSON transport to the server. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // Chunk the conversion: spreading a multi-megabyte array would blow the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
/** The storable mime of a blob, or null when the bytes must not be uploaded. */
export function imageMime(blob: Blob): (typeof IMAGE_MIMES)[number] | null {
  return (IMAGE_MIMES as readonly string[]).includes(blob.type) ? (blob.type as (typeof IMAGE_MIMES)[number]) : null
}
export function generatedImageBlob(base64: string): Blob {
  if (typeof base64 !== 'string' || base64.length > 40 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('imageFailed')
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('imageFailed')
  return new Blob([bytes], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' })
}
