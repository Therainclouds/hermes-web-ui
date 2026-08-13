export class MultipartParseError extends Error {}

export function parseMultipartBoundary(contentType: string): Buffer | null {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = (match?.[1] || match?.[2] || '').trim()
  return boundary ? Buffer.from(`--${boundary}`) : null
}

export function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundary.length
  }
  return parts
}

export function parseMultipartFilename(header: string): string | null {
  const disposition = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)?.[1]
  if (!disposition) return null

  const encodedFilename = disposition.match(/(?:^|;)\s*filename\*\s*=\s*([^;\r\n]+)/i)?.[1]
  if (encodedFilename) {
    const value = encodedFilename.trim().replace(/^"|"$/g, '')
    const utf8Match = value.match(/^UTF-8''(.+)$/i)
    if (!utf8Match) return null

    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      throw new MultipartParseError('Malformed multipart filename')
    }
  }

  return disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? null
}

/**
 * Stream the first file part of a multipart/form-data request to disk without
 * buffering the whole body in memory (supports 100MB+ documents).
 *
 * Returns the original filename and the number of bytes written. The caller
 * owns the target path (already resolved + sanitized). The part is terminated
 * by the first `\r\n--<boundary>` marker.
 */
export async function streamMultipartFirstFile(
  req: AsyncIterable<Buffer>,
  boundary: Buffer,
  targetPath: string,
  writeChunk: (chunk: Buffer) => Promise<void> | void = async () => {},
): Promise<{ filename: string | null; size: number }> {
  // boundary already includes the leading `--` (parseMultipartBoundary output).
  const partTerminator = Buffer.concat([Buffer.from('\r\n'), boundary])
  const terminatorLength = partTerminator.length
  // Bytes we may need to hold back because they could be the start of the terminator.
  const holdBack = terminatorLength - 1

  const pending: Buffer[] = []
  let pendingLen = 0
  let headerEnded = false
  let headerBuffer = Buffer.alloc(0)
  let filename: string | null = null
  let size = 0
  let sawFirstPart = false
  let finished = false

  const appendPending = (buf: Buffer) => {
    pending.push(buf)
    pendingLen += buf.length
  }

  const flushSafePrefix = async () => {
    if (pendingLen <= holdBack) return
    const concat = Buffer.concat(pending)
    const keep = concat.subarray(0, concat.length - holdBack)
    pending.length = 0
    pending.push(concat.subarray(concat.length - holdBack))
    pendingLen = keep.length + pending[0].length
    if (keep.length > 0) {
      size += keep.length
      await writeChunk(keep)
    }
  }

  for await (const chunk of req) {
    if (finished) break
    appendPending(chunk)
    const concat = Buffer.concat(pending)
    pending.length = 0

    if (!headerEnded) {
      const headerEnd = concat.indexOf(Buffer.from('\r\n\r\n'))
      if (headerEnd === -1) {
        // Header still incomplete (request preamble + headers are small).
        headerBuffer = Buffer.concat([headerBuffer, concat])
        pendingLen = 0
        if (headerBuffer.length > 64 * 1024) {
          throw new MultipartParseError('Multipart headers too large or malformed')
        }
        continue
      }
      headerEnded = true
      headerBuffer = Buffer.concat([headerBuffer, concat.subarray(0, headerEnd)])
      const header = headerBuffer.toString('utf-8')
      try {
        filename = parseMultipartFilename(header)
      } catch (error) {
        if (error instanceof MultipartParseError) throw error
        throw new MultipartParseError('Malformed multipart filename')
      }
      sawFirstPart = filename !== null
      const contentStart = concat.subarray(headerEnd + 4)
      if (contentStart.length > 0) appendPending(contentStart)
    } else {
      appendPending(concat)
    }

    if (!sawFirstPart) continue

    // Look for the part terminator in the accumulated (unflushed) buffer.
    const idx = indexOfTerminator(Buffer.concat(pending), partTerminator)
    if (idx !== -1) {
      const keep = Buffer.concat(pending).subarray(0, idx)
      pending.length = 0
      pendingLen = 0
      if (keep.length > 0) {
        size += keep.length
        await writeChunk(keep)
      }
      finished = true
      break
    }
    await flushSafePrefix()
  }

  if (!headerEnded || !sawFirstPart) {
    throw new MultipartParseError('No file part found in multipart body')
  }
  if (!finished && pendingLen > 0) {
    const keep = Buffer.concat(pending)
    pending.length = 0
    pendingLen = 0
    size += keep.length
    await writeChunk(keep)
  }
  return { filename, size }
}

function indexOfTerminator(haystack: Buffer, terminator: Buffer): number {
  if (haystack.length < terminator.length) return -1
  for (let i = 0; i <= haystack.length - terminator.length; i++) {
    let match = true
    for (let j = 0; j < terminator.length; j++) {
      if (haystack[i + j] !== terminator[j]) {
        match = false
        break
      }
    }
    if (match) return i
  }
  return -1
}
