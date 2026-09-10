/**
 * Markdown text extractor. Reads the file as UTF-8 and counts tokens
 * via the shared `cl100k_base` encoder.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

export async function markdownExtractor(filePath: string): Promise<ExtractResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    throw new ExtractError(`Failed to read markdown file: ${filePath}`, {
      kind: 'io',
      cause: err,
    })
  }

  // Strip front-matter (YAML between --- delimiters at the start).
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')

  return {
    text: stripped.trim(),
    tokenCount: countTokens(stripped),
  }
}
