/**
 * 安全 ZIP 解压器
 * - 拒绝绝对路径条目
 * - 拒绝 .. 路径穿越
 * - 解压后总字节数限制
 */
import { createReadStream, promises as fs } from 'fs'
import { join, resolve as resolvePath, sep, normalize } from 'path'
import { createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'

interface CentralDirEntry {
  fileName: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
  isDirectory: boolean
}

function dosToJs(t: number): Date {
  return new Date(((t >> 25) & 0x7f) + 1980, ((t >> 21) & 0x0f) - 1, (t >> 16) & 0x1f,
    (t >> 11) & 0x1f, (t >> 5) & 0x3f, (t & 0x1f) << 1)
}

async function readUInt32LE(file: import('fs').promises.FileHandle, offset: number): Promise<number> {
  const buf = Buffer.alloc(4)
  await file.read(buf, 0, 4, offset)
  return buf.readUInt32LE(0)
}

async function readUInt16LE(file: import('fs').promises.FileHandle, offset: number): Promise<number> {
  const buf = Buffer.alloc(2)
  await file.read(buf, 0, 2, offset)
  return buf.readUInt16LE(0)
}

async function findEndOfCentralDir(file: import('fs').promises.FileHandle): Promise<number> {
  const stat = await file.stat()
  const size = stat.size
  const minOffset = Math.max(0, size - 65557)
  for (let i = size - 22; i >= minOffset; i--) {
    const sig = await readUInt32LE(file, i)
    if (sig === 0x06054b50) return i
  }
  throw new Error('End of central directory not found')
}

async function readCentralDir(file: import('fs').promises.FileHandle): Promise<CentralDirEntry[]> {
  const eocdOffset = await findEndOfCentralDir(file)
  const totalEntries = await readUInt16LE(file, eocdOffset + 10)
  const cdSize = await readUInt32LE(file, eocdOffset + 12)
  const cdOffset = await readUInt32LE(file, eocdOffset + 16)
  const entries: CentralDirEntry[] = []
  let p = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    const sig = await readUInt32LE(file, p)
    if (sig !== 0x02014b50) throw new Error('Invalid central dir signature')
    const compressionMethod = await readUInt16LE(file, p + 10)
    const compressedSize = await readUInt32LE(file, p + 20)
    const uncompressedSize = await readUInt32LE(file, p + 24)
    const fileNameLen = await readUInt16LE(file, p + 28)
    const extraLen = await readUInt16LE(file, p + 30)
    const commentLen = await readUInt16LE(file, p + 32)
    const localHeaderOffset = await readUInt32LE(file, p + 42)
    const fnBuf = Buffer.alloc(fileNameLen)
    await file.read(fnBuf, 0, fileNameLen, p + 46)
    const fileName = fnBuf.toString('utf8')
    entries.push({
      fileName,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      isDirectory: fileName.endsWith('/'),
    })
    p += 46 + fileNameLen + extraLen + commentLen
  }
  void cdSize
  return entries
}

function assertSafePath(root: string, rel: string): string {
  if (!rel || rel.includes('\u0000')) {
    throw new Error(`invalid path: ${rel}`)
  }
  const norm = normalize(rel).replace(/^[\\/]+/, '')
  if (norm.startsWith('..') || norm.includes(`..${sep}`)) {
    throw new Error(`path traversal: ${rel}`)
  }
  const abs = resolvePath(root, norm)
  const rootAbs = resolvePath(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path escape: ${rel}`)
  }
  return abs
}

export async function extractZip(zipPath: string, destDir: string, maxBytes: number): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  const fh = await fs.open(zipPath, 'r')
  try {
    const entries = await readCentralDir(fh)
    let totalBytes = 0
    for (const entry of entries) {
      const safe = assertSafePath(destDir, entry.fileName)
      if (entry.isDirectory) {
        await fs.mkdir(safe, { recursive: true })
        continue
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > maxBytes) {
        throw new Error(`Uncompressed total ${totalBytes} exceeds limit ${maxBytes}`)
      }
      const dataSig = await readUInt32LE(fh, entry.localHeaderOffset)
      if (dataSig !== 0x04034b50) throw new Error('Invalid local file header')
      const fileNameLen = await readUInt16LE(fh, entry.localHeaderOffset + 26)
      const extraLen = await readUInt16LE(fh, entry.localHeaderOffset + 28)
      const dataStart = entry.localHeaderOffset + 30 + fileNameLen + extraLen
      await fs.mkdir(safe.substring(0, safe.lastIndexOf(sep)), { recursive: true })

      if (entry.compressionMethod === 0) {
        const out = await fs.open(safe, 'w')
        try {
          let remaining = entry.uncompressedSize
          let pos = dataStart
          const bufSize = 64 * 1024
          while (remaining > 0) {
            const slice = Math.min(bufSize, remaining)
            const buf = Buffer.alloc(slice)
            await fh.read(buf, 0, slice, pos)
            await out.write(buf)
            remaining -= slice
            pos += slice
          }
        } finally {
          await out.close()
        }
      } else if (entry.compressionMethod === 8) {
        // streamed inflate + gunzip
        const stream = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 })
        const out = (await import('fs')).createWriteStream(safe)
        await pipeline(stream, createGunzip(), out)
      } else {
        throw new Error(`unsupported compression method: ${entry.compressionMethod}`)
      }
    }
  } finally {
    await fh.close()
  }
}
