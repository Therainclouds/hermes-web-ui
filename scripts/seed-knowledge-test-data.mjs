/**
 * Seed fake knowledge data for UI testing.
 * Run: node scripts/seed-knowledge-test-data.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const dbPath = join(homedir(), '.hermes-web-ui', 'hermes-web-ui.db')
console.log(`Opening ${dbPath}`)
const db = new DatabaseSync(dbPath)

// Ensure schema exists.
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_vaults (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path  TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    watch      INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path  TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    vault_id     INTEGER NOT NULL,
    mime_type    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    mtime        INTEGER NOT NULL,
    indexed_at   INTEGER NOT NULL,
    status       TEXT NOT NULL,
    error        TEXT,
    FOREIGN KEY (vault_id) REFERENCES knowledge_vaults(id)
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL,
    position     INTEGER NOT NULL,
    content      TEXT NOT NULL,
    token_count  INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
  )
`)

// Clear existing data.
db.exec('DELETE FROM knowledge_chunks')
db.exec('DELETE FROM knowledge_documents')
db.exec('DELETE FROM knowledge_vaults')

const now = Math.floor(Date.now() / 1000)

// --- Vaults ---------------------------------------------------------------
const vaultStmt = db.prepare(
  'INSERT INTO knowledge_vaults (root_path, name, watch, created_at) VALUES (?, ?, ?, ?)'
)
const r1 = vaultStmt.run('C:\\Users\\DELL\\Documents\\Notes', '工作笔记', 1, now - 86400 * 30)
const r2 = vaultStmt.run('C:\\Users\\DELL\\Documents\\Wiki', '技术Wiki', 1, now - 86400 * 7)
const V1 = r1.lastInsertRowid
const V2 = r2.lastInsertRowid
console.log(`✓ 2 vaults (ids: ${V1}, ${V2})`)

// --- Documents (various statuses) ----------------------------------------
const docStmt = db.prepare(`
  INSERT INTO knowledge_documents
    (source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

function h(s) { return createHash('sha256').update(s).digest('hex').slice(0, 16) }

// Use placeholders for vault_id — we'll fill after we know the actual IDs.
const docsTemplate = [
  // Vault 1
  ['C:\\Users\\DELL\\Documents\\Notes\\会议记录-20260901.md', 'meeting-0901', null, 'text/markdown', 4200, now - 3600, now - 3000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Notes\\项目计划Q3.md', 'plan-q3', null, 'text/markdown', 8900, now - 7200, now - 6000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Notes\\周报-0910.pdf', 'weekly-0910', null, 'application/pdf', 125000, now - 86400, now - 86000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Notes\\技术方案-v2.docx', 'tech-v2', null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 67000, now - 1800, now - 1500, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Notes\\需求文档.docx', 'req-doc', null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 34000, now - 300, 0, 'indexing', null],
  ['C:\\Users\\DELL\\Documents\\Notes\\旧版本备份.txt', 'old-backup', null, 'text/plain', 2048, now - 100, 0, 'failed', 'Extraction failed: unsupported encoding'],
  ['C:\\Users\\DELL\\Documents\\Notes\\README.txt', 'readme', null, 'text/plain', 512, now - 60, 0, 'metadata_only', null],
  // Vault 2
  ['C:\\Users\\DELL\\Documents\\Wiki\\SQLite性能优化.md', 'sqlite-perf', null, 'text/markdown', 12400, now - 43200, now - 42000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Wiki\\Kubernetes部署指南.md', 'k8s-guide', null, 'text/markdown', 28600, now - 21600, now - 20000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Wiki\\API设计规范.pdf', 'api-spec', null, 'application/pdf', 540000, now - 14400, now - 13000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Wiki\\架构评审记录.md', 'arch-review', null, 'text/markdown', 6700, now - 5400, now - 5000, 'indexed', null],
  ['C:\\Users\\DELL\\Documents\\Wiki\\数据库迁移计划.md', 'db-migrate', null, 'text/markdown', 3100, now - 1200, 0, 'pending', null],
]

const docIds = []
for (const d of docsTemplate) {
  const vaultId = d[0].includes('Wiki') ? V2 : V1
  d[2] = vaultId
  const r = docStmt.run(d[0], h(d[1]), d[2], d[3], d[4], d[5], d[6], d[7], d[8])
  docIds.push(r.lastInsertRowid)
}
console.log(`✓ ${docsTemplate.length} documents (ids: ${docIds.join(',')})`)

// --- Chunks for indexed docs ---------------------------------------------
const chunkStmt = db.prepare(
  'INSERT INTO knowledge_chunks (document_id, position, content, token_count) VALUES (?, ?, ?, ?)'
)

// Index into docIds array: 0=会议记录, 1=项目计划, 2=周报, 3=技术方案, 7=SQLite, 8=K8s, 9=API, 10=架构
const chunks = [
  [0, 1, '2026年9月1日产品评审会议纪要：\n1. Knowledge 插件 v1 进入测试阶段\n2. CJK 检索 bigram 方案已确认\n3. 下周完成 UI 集成测试\n4. 性能指标：单次搜索 < 200ms'],
  [0, 2, '参会人员：产品组 3 人，后端 2 人，前端 1 人\n下次会议：9月8日 14:00\n备注：sqlite-vec 扩展需要在各平台验证加载行为'],
  [1, 1, '# Q3 项目计划\n\n## 里程碑\n- M1: 知识库插件 MVP（8月15日）\n- M2: 多格式文档支持（9月1日）\n- M3: 向量检索优化（9月15日）\n- M4: 生产环境灰度发布（9月30日）'],
  [1, 2, '## 技术栈\n- SQLite + sqlite-vec：向量存储\n- FTS5：全文检索\n- pdfjs-dist / mammoth：文档解析\n- chokidar：文件监听'],
  [2, 1, '周报 2026-09-10\n本周完成：\n- Knowledge 插件根除式修复（7 个 commit）\n- OCR review 技能打包\n- Web UI 设置入口上线\n\n下周计划：\n- 端到端流程测试\n- 性能基准测试'],
  [3, 1, '# 知识库技术方案 v2\n\n## 架构概述\n本方案采用嵌入式 SQLite 作为唯一持久化层，避免引入外部数据库依赖。向量检索通过 sqlite-vec 扩展实现，全文检索使用 FTS5。'],
  [3, 2, '## 安全考量\n1. API key 存储：secrets 文件 + 0600 权限\n2. 路径校验：realpathSync + 系统目录黑名单\n3. 文件大小上限：20MB\n4. 扩展名白名单：.md .txt .pdf .docx'],
  [7, 1, '# SQLite 性能优化指南\n\n## 索引策略\n- 为高频查询列建索引\n- 复合索引遵循最左前缀原则\n- 避免在 WHERE 子句中对索引列使用函数'],
  [7, 2, '## WAL 模式\n开启 WAL 模式可将读写并发性能提升 3-5 倍：\nPRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;'],
  [8, 1, '# Kubernetes 部署指南\n\n## 前置条件\n- K8s 集群 1.25+\n- 持久化存储卷（至少 10Gi）\n- TLS 证书'],
  [8, 2, '## 部署步骤\n1. 创建 namespace: kubectl create ns hermes\n2. 部署 ConfigMap\n3. 部署 StatefulSet（单副本，SQLite 不支持多写）\n4. 配置 Service + Ingress'],
  [9, 1, '# API 设计规范\n\n## RESTful 约定\n- 资源名用复数：/vaults, /documents\n- 操作用 HTTP 方法：GET/POST/DELETE\n- 错误响应用统一格式'],
  [10, 1, '# 架构评审记录 2026-09\n\n## 决议\n- 采用单文件 SQLite 方案，不做分库分表\n- 向量检索走 sqlite-vec，不引入 pgvector\n- FTS5 bigram 切词覆盖 CJK'],
]

for (const [docIdx, pos, content] of chunks) {
  const actualDocId = docIds[docIdx]
  const tc = Math.ceil(content.length / 4)
  chunkStmt.run(actualDocId, pos, content, tc)
}
console.log(`✓ ${chunks.length} chunks`)

db.close()
console.log('\nDone. Reload the Knowledge page in the browser.')
