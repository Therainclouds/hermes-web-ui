/**
 * Detect user-visible strings that look like mojibake — i.e. Chinese (or
 * other multi-byte) text that was round-tripped through a wrong encoding
 * (e.g. GBK bytes read as UTF-8 or vice versa) before being stored in the
 * local SQLite/JSON cache.
 *
 * Three signals, any one of which is enough to flag the string:
 *   1. Contains U+FFFD (the Unicode replacement character) — Node/SQLite
 *      round-trips invalid UTF-8 bytes to this codepoint.
 *   2. Latin1 artifacts of UTF-8 bytes: the string contains
 *      U+00C0-U+00FF (À-ÿ) characters. A real Latin display name almost
 *      never carries such letters, but UTF-8 Chinese bytes (e.g. "你好"
 *      0xE4 0xBD 0xA0 0xE5 0xA5 0xBD) interpreted as Latin-1 render as
 *      "ä½ å¥½" — every code point in U+00C0–U+00FF.
 *   3. Hangul/half-width/kana pattern repeated more than once: the
 *      character class U+AC00-U+D7A3 (Hangul) and U+FF00-U+FFEF (full-
 *      width) can also appear as artifacts of GBK→UTF-8 double decoding.
 *
 * The function is intentionally conservative (false positives preferred
 * over false negatives in the UI hint, which only suggests a re-scan).
 */

const REPLACEMENT = '\uFFFD'
const LATIN_HIGH = /[À-ÿ]/
const CJK_HALF_OR_KANA = /[぀-ゟ゠-ヿ]/

export function looksLikeMojibake(value: string | null | undefined): boolean {
  if (!value) return false
  if (value.includes(REPLACEMENT)) return true
  if (LATIN_HIGH.test(value)) return true
  if (CJK_HALF_OR_KANA.test(value)) return true
  return false
}