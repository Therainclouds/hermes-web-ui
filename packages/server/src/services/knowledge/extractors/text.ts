/**
 * Plain text extractor. Reads the file as UTF-8 and counts tokens
 * via the shared `cl100k_base` encoder.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

export async function textExtractor(filePath: string): Promise<ExtractResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    throw new ExtractError(`Failed to read text file: ${filePath}`, {
      kind: 'io',
      cause: err,
    })
  }

  return {
    text: raw.trim(),
    tokenCount: countTokens(raw),
  }
}
