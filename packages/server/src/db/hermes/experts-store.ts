/**
 * 专家系统本地安装/绑定 store
 * - installed_experts：每个 expert_slug 一行（成员行也写）
 * - expert_profile_bindings：每个 profile 一行
 */
import { isSqliteAvailable, getDb } from '../index'
import {
  INSTALLED_EXPERTS_TABLE,
  EXPERT_PROFILE_BINDINGS_TABLE,
} from './schemas'

export type InstalledExpertStatus =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing_profile'
  | 'installed'
  | 'failed'

export type ExpertRole = 'expert' | 'captain' | 'member'

export interface InstalledExpertRow {
  id: number
  expert_slug: string
  expert_name: string
  kind: 'expert' | 'team'
  category: string
  installed_version: string
  status: InstalledExpertStatus | string
  local_path: string
  manifest_json: string
  last_error: string
  last_error_stage: string
  installed_at: number
  updated_at: number
  team_slug: string
}

export interface ExpertProfileBindingRow {
  id: number
  expert_slug: string
  profile_name: string
  role: ExpertRole | string
  parent_team_slug: string
  installed_version: string
  created_at: number
  updated_at: number
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function requireDb() {
  if (!isSqliteAvailable()) {
    throw new Error('SQLite not available')
  }
  const db = getDb()
  if (!db) throw new Error('SQLite not initialized')
  return db
}

function mapInstalled(row: Record<string, unknown>): InstalledExpertRow {
  return {
    id: Number(row.id || 0),
    expert_slug: String(row.expert_slug || ''),
    expert_name: String(row.expert_name || ''),
    kind: (row.kind as 'expert' | 'team') || 'expert',
    category: String(row.category || ''),
    installed_version: String(row.installed_version || ''),
    status: String(row.status || 'installed'),
    local_path: String(row.local_path || ''),
    manifest_json: String(row.manifest_json || ''),
    last_error: String(row.last_error || ''),
    last_error_stage: String(row.last_error_stage || ''),
    installed_at: Number(row.installed_at || 0),
    updated_at: Number(row.updated_at || 0),
    team_slug: String(row.team_slug || ''),
  }
}

function mapBinding(row: Record<string, unknown>): ExpertProfileBindingRow {
  return {
    id: Number(row.id || 0),
    expert_slug: String(row.expert_slug || ''),
    profile_name: String(row.profile_name || ''),
    role: String(row.role || 'expert'),
    parent_team_slug: String(row.parent_team_slug || ''),
    installed_version: String(row.installed_version || ''),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

export function listInstalledExperts(): InstalledExpertRow[] {
  const db = requireDb()
  const rows = db
    .prepare(
      `SELECT * FROM ${INSTALLED_EXPERTS_TABLE} ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[]
  return rows.map(mapInstalled)
}

export function getInstalledExpert(slug: string): InstalledExpertRow | null {
  const db = requireDb()
  const row = db
    .prepare(`SELECT * FROM ${INSTALLED_EXPERTS_TABLE} WHERE expert_slug = ?`)
    .get(slug) as Record<string, unknown> | undefined
  return row ? mapInstalled(row) : null
}

export function upsertInstalledExpert(input: {
  expert_slug: string
  expert_name?: string
  kind?: 'expert' | 'team'
  category?: string
  installed_version?: string
  status: InstalledExpertStatus | string
  local_path?: string
  manifest_json?: string
  last_error?: string
  last_error_stage?: string
  team_slug?: string
}): InstalledExpertRow {
  const db = requireDb()
  const now = nowSec()
  const existing = getInstalledExpert(input.expert_slug)
  if (existing) {
    db.prepare(
      `UPDATE ${INSTALLED_EXPERTS_TABLE}
       SET expert_name = COALESCE(NULLIF(?, ''), expert_name),
           kind = COALESCE(NULLIF(?, ''), kind),
           category = COALESCE(NULLIF(?, ''), category),
           installed_version = COALESCE(NULLIF(?, ''), installed_version),
           status = ?,
           local_path = COALESCE(NULLIF(?, ''), local_path),
           manifest_json = COALESCE(NULLIF(?, ''), manifest_json),
           last_error = ?,
           last_error_stage = ?,
           team_slug = COALESCE(NULLIF(?, ''), team_slug),
           updated_at = ?
       WHERE expert_slug = ?`,
    ).run(
      input.expert_name ?? '',
      input.kind ?? '',
      input.category ?? '',
      input.installed_version ?? '',
      input.status,
      input.local_path ?? '',
      input.manifest_json ?? '',
      input.last_error ?? '',
      input.last_error_stage ?? '',
      input.team_slug ?? '',
      now,
      input.expert_slug,
    )
  } else {
    db.prepare(
      `INSERT INTO ${INSTALLED_EXPERTS_TABLE} (
         expert_slug, expert_name, kind, category, installed_version,
         status, local_path, manifest_json, last_error, last_error_stage,
         installed_at, updated_at, team_slug
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.expert_slug,
      input.expert_name ?? '',
      input.kind ?? 'expert',
      input.category ?? '',
      input.installed_version ?? '',
      input.status,
      input.local_path ?? '',
      input.manifest_json ?? '',
      input.last_error ?? '',
      input.last_error_stage ?? '',
      input.status === 'installed' ? now : 0,
      now,
      input.team_slug ?? '',
    )
  }
  return getInstalledExpert(input.expert_slug)!
}

export function deleteInstalledExpert(slug: string): boolean {
  const db = requireDb()
  const result = db
    .prepare(`DELETE FROM ${INSTALLED_EXPERTS_TABLE} WHERE expert_slug = ?`)
    .run(slug)
  return result.changes > 0
}

export function listBindings(): ExpertProfileBindingRow[] {
  const db = requireDb()
  const rows = db
    .prepare(
      `SELECT * FROM ${EXPERT_PROFILE_BINDINGS_TABLE} ORDER BY created_at DESC`,
    )
    .all() as Record<string, unknown>[]
  return rows.map(mapBinding)
}

export function listBindingsByExpert(slug: string): ExpertProfileBindingRow[] {
  const db = requireDb()
  const rows = db
    .prepare(
      `SELECT * FROM ${EXPERT_PROFILE_BINDINGS_TABLE} WHERE expert_slug = ?`,
    )
    .all(slug) as Record<string, unknown>[]
  return rows.map(mapBinding)
}

export function getBindingByProfile(profileName: string): ExpertProfileBindingRow | null {
  const db = requireDb()
  const row = db
    .prepare(
      `SELECT * FROM ${EXPERT_PROFILE_BINDINGS_TABLE} WHERE profile_name = ?`,
    )
    .get(profileName) as Record<string, unknown> | undefined
  return row ? mapBinding(row) : null
}

export function upsertBinding(input: {
  expert_slug: string
  profile_name: string
  role: ExpertRole | string
  parent_team_slug?: string
  installed_version: string
}): ExpertProfileBindingRow {
  const db = requireDb()
  const now = nowSec()
  const existing = getBindingByProfile(input.profile_name)
  if (existing) {
    db.prepare(
      `UPDATE ${EXPERT_PROFILE_BINDINGS_TABLE}
       SET expert_slug = ?,
           role = ?,
           parent_team_slug = ?,
           installed_version = ?,
           updated_at = ?
       WHERE profile_name = ?`,
    ).run(
      input.expert_slug,
      input.role,
      input.parent_team_slug ?? '',
      input.installed_version,
      now,
      input.profile_name,
    )
  } else {
    db.prepare(
      `INSERT INTO ${EXPERT_PROFILE_BINDINGS_TABLE} (
         expert_slug, profile_name, role, parent_team_slug, installed_version,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.expert_slug,
      input.profile_name,
      input.role,
      input.parent_team_slug ?? '',
      input.installed_version,
      now,
      now,
    )
  }
  return getBindingByProfile(input.profile_name)!
}

export function deleteBindingsByExpert(slug: string): number {
  const db = requireDb()
  const result = db
    .prepare(`DELETE FROM ${EXPERT_PROFILE_BINDINGS_TABLE} WHERE expert_slug = ?`)
    .run(slug)
  return Number(result.changes)
}

export function deleteBindingByProfile(profileName: string): boolean {
  const db = requireDb()
  const result = db
    .prepare(
      `DELETE FROM ${EXPERT_PROFILE_BINDINGS_TABLE} WHERE profile_name = ?`,
    )
    .run(profileName)
  return result.changes > 0
}
