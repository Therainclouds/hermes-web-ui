import { getDb } from '../index'
import { reverseDoubleUtf8 } from '../../utils/double-utf8'

/**
 * Idempotent migration that fixes double-UTF-8-encoded mojibake in
 * `wechat_bindings.display_name` and `users.avatar.seed` columns.
 *
 * Background: an earlier version of `token-platform-client.ts` decoded the
 * Token Platform's response with `res.text()`, which on Node 24 reads GBK
 * bytes as Latin1 high characters and stores them into SQLite as a UTF-8
 * string. The result looks like `ç»å¤©é¸æ°å¹` — each Latin1 character is
 * a single byte of the original UTF-8 string, so the full byte sequence is
 * still recoverable by re-encoding each codepoint back to a byte and
 * decoding as strict UTF-8.
 *
 * Detection rule: every codepoint of the stored string must be in the
 * Latin1 range (≤ 0xFF) and re-encoding the string as latin1 bytes must
 * produce a byte sequence that is a valid UTF-8 string. The result must
 * differ from the input (otherwise the input was already correct).
 *
 * This migration is gated on a row in `server_migrations`
 * (`name = 'wechat_double_utf8_v1'`) so it runs exactly once per
 * installation.
 */

const MIGRATION_NAME = 'wechat_double_utf8_v1'

// Re-exported for tests that already import this path.
export { reverseDoubleUtf8 as tryReverseDoubleUtf8 }

export function migrateWeChatDoubleUtf8(): {
  bindingsFixed: number
  usersFixed: number
} {
  const db = getDb()
  if (!db) return { bindingsFixed: 0, usersFixed: 0 }

  // Ensure the migration tracking table exists with the required shape.
  // An earlier release may have created an empty `server_migrations` table
  // without the `name` column — in that case we ALTER TABLE to add it.
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS server_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL,
        affected_rows INTEGER NOT NULL DEFAULT 0,
        details TEXT
      )`
    )
    // If the table already existed from an older release, add the `name`
    // column if it is missing.
    const cols = db.prepare(`PRAGMA table_info(server_migrations)`).all() as
      Array<{ name: string }>
    if (!cols.some(c => c.name === 'name')) {
      db.exec(`ALTER TABLE server_migrations ADD COLUMN name TEXT`)
    }
  } catch {
    // Table may not exist at all on a fresh install — skip silently.
  }

  // Skip if the migration has already run.
  let already: unknown = undefined
  try {
    already = db
      .prepare(`SELECT 1 FROM server_migrations WHERE name = ? LIMIT 1`)
      .get(MIGRATION_NAME)
  } catch {
    // Migration table not ready — skip.
  }
  if (already) return { bindingsFixed: 0, usersFixed: 0 }

  let bindingsFixed = 0
  let usersFixed = 0

  // 1) Fix `wechat_bindings.display_name`.
  try {
    const rows = db
      .prepare(`SELECT id, display_name FROM wechat_bindings`)
      .all() as Array<{ id: number; display_name: string | null }>
    for (const row of rows) {
      const fixed = reverseDoubleUtf8(row.display_name)
      if (fixed) {
        db.prepare(
          `UPDATE wechat_bindings SET display_name = ?, updated_at = ? WHERE id = ?`
        ).run(fixed, Date.now(), row.id)
        bindingsFixed++
      }
    }
  } catch {
    // Table may not exist yet on a fresh install — skip silently.
  }

  // 2) Fix `users.avatar` — the column holds a JSON object with a `seed`
  //    field that may also carry double-UTF-8-encoded mojibake.
  try {
    const rows = db
      .prepare(`SELECT id, avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''`)
      .all() as Array<{ id: number; avatar: string | null }>
    for (const row of rows) {
      if (!row.avatar) continue
      let parsed: { seed?: string }
      try {
        parsed = JSON.parse(row.avatar) as { seed?: string }
      } catch {
        continue
      }
      if (!parsed || typeof parsed.seed !== 'string') continue
      const fixed = reverseDoubleUtf8(parsed.seed)
      if (!fixed) continue
      parsed.seed = fixed
      db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`)
        .run(JSON.stringify(parsed), row.id)
      usersFixed++
    }
  } catch {
    // Table may not exist yet — skip silently.
  }

  const affected = bindingsFixed + usersFixed
  try {
    db.prepare(
      `INSERT INTO server_migrations (name, applied_at, affected_rows, details)
       VALUES (?, ?, ?, ?)`
    ).run(
      MIGRATION_NAME,
      Date.now(),
      affected,
      JSON.stringify({ bindingsFixed, usersFixed }),
    )
  } catch {
    // Duplicate INSERT — migration already recorded; swallow.
  }

  if (affected > 0) {
    console.info(
      `[migrate] wechat_double_utf8_v1 applied: ${bindingsFixed} bindings, ${usersFixed} user avatars fixed`,
    )
  }
  return { bindingsFixed, usersFixed }
}
