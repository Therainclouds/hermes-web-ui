import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('migrate-wechat-double-utf8', () => {
  let db: any = null
  let migrate: any = null

  /**
   * Build the double-UTF-8-encoded form of a clean Chinese string.
   * Each byte of the UTF-8 encoding is read as a Latin1 character,
   * reproducing the mojibake that ends up in the database.
   */
  function doubleEncode(text: string): string {
    const bytes = Buffer.from(text, 'utf-8')
    return bytes.toString('latin1')
  }

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    // initAllHermesTables already ran the migration once (on empty tables),
    // recording a row in server_migrations. Drop that record so each test
    // can exercise the full migration path against its own fixture data.
    try {
      db.prepare(`DELETE FROM server_migrations WHERE name = 'wechat_double_utf8_v1'`).run()
    } catch { /* table may not exist in test fixtures */ }
    migrate = await import(
      '../../packages/server/src/db/hermes/migrate-wechat-double-utf8'
    )
  })

  it('tryReverseDoubleUtf8 returns the original text for mojibake input', () => {
    const mojibake = doubleEncode('白云雨幕')
    expect(mojibake).not.toBe('白云雨幕')
    expect(migrate.tryReverseDoubleUtf8(mojibake)).toBe('白云雨幕')
  })

  it('tryReverseDoubleUtf8 returns null for already-clean text', () => {
    expect(migrate.tryReverseDoubleUtf8('白云雨幕')).toBeNull()
  })

  it('tryReverseDoubleUtf8 returns null for null/empty', () => {
    expect(migrate.tryReverseDoubleUtf8(null)).toBeNull()
    expect(migrate.tryReverseDoubleUtf8('')).toBeNull()
    expect(migrate.tryReverseDoubleUtf8(undefined)).toBeNull()
  })

  it('tryReverseDoubleUtf8 returns null when any codepoint is above Latin1', () => {
    // A clean CJK string where every codepoint > 0xFF is not double-encoded.
    expect(migrate.tryReverseDoubleUtf8('你好')).toBeNull()
  })

  it('fixes wechat_bindings.display_name on first run', () => {
    const mojibake = doubleEncode('量迹Ai立伟')
    db.prepare(
      `INSERT INTO wechat_bindings
        (platform_profile_id, platform_username, api_base, api_key, display_name, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(17, 'wechat_17', 'https://api.example.com', 'sk-17', mojibake, Date.now(), Date.now())

    const result = migrate.migrateWeChatDoubleUtf8()
    expect(result.bindingsFixed).toBe(1)

    const row = db
      .prepare(`SELECT display_name FROM wechat_bindings WHERE platform_profile_id = 17`)
      .get() as { display_name: string }
    expect(row.display_name).toBe('量迹Ai立伟')
  })

  it('fixes users.avatar.seed on first run', () => {
    const mojibake = doubleEncode('白云雨幕')
    const avatar = JSON.stringify({
      type: 'image',
      dataUrl: 'https://example.com/a.jpg',
      seed: mojibake,
    })
    db.prepare(
      `INSERT INTO users (username, password_hash, role, status, avatar, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('tp_17', 'pw', 'admin', 'active', avatar, Date.now(), Date.now())

    const result = migrate.migrateWeChatDoubleUtf8()
    expect(result.usersFixed).toBe(1)

    const row = db.prepare(`SELECT avatar FROM users WHERE username = 'tp_17'`).get() as { avatar: string }
    const parsed = JSON.parse(row.avatar)
    expect(parsed.seed).toBe('白云雨幕')
  })

  it('is idempotent — second run makes no changes', () => {
    const mojibake = doubleEncode('测试用户')
    db.prepare(
      `INSERT INTO wechat_bindings
        (platform_profile_id, platform_username, api_base, api_key, display_name, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(42, 'wechat_42', 'https://api.example.com', 'sk-42', mojibake, Date.now(), Date.now())

    const first = migrate.migrateWeChatDoubleUtf8()
    expect(first.bindingsFixed).toBe(1)

    const second = migrate.migrateWeChatDoubleUtf8()
    expect(second.bindingsFixed).toBe(0)
    expect(second.usersFixed).toBe(0)

    const row = db
      .prepare(`SELECT display_name FROM wechat_bindings WHERE platform_profile_id = 42`)
      .get() as { display_name: string }
    expect(row.display_name).toBe('测试用户')
  })

  it('leaves already-clean rows untouched', () => {
    db.prepare(
      `INSERT INTO wechat_bindings
        (platform_profile_id, platform_username, api_base, api_key, display_name, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(7, 'wechat_7', 'https://api.example.com', 'sk-7', '正常昵称', Date.now(), Date.now())

    const result = migrate.migrateWeChatDoubleUtf8()
    expect(result.bindingsFixed).toBe(0)

    const row = db
      .prepare(`SELECT display_name FROM wechat_bindings WHERE platform_profile_id = 7`)
      .get() as { display_name: string }
    expect(row.display_name).toBe('正常昵称')
  })
})
