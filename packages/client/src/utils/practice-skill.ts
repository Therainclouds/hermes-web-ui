/**
 * 口语对练练习技能（practice skill）运行时——纯函数模块（无副作用，便于单测）。
 *
 * 框架 v2（跨场景）：一个练习技能 = 带 `hermes_practice` 契约的普通 SKILL.md
 * （frontmatter 由服务端解析成 JSON，客户端不解析 YAML）。技能可声明：
 *
 *   - 身份/入口：scene、targetLanguages（限定语言，UI 下拉收敛并自动切换）、
 *     directions（方向预置）、entry.label/hint、voice（建议音色）；
 *   - 角色与对话结构（前置提示词）：coach.soul/role/userRole/interaction/
 *     plannedTurns/extraRules/tools（工作台工具子集，借鉴 agent 模式）；
 *   - 评价对象与打分逻辑：evaluation.scale{min,max,step}、
 *     dimensions[{id,label,description,rubric,weight}]（开放自定义）、
 *     overallMode=model|weighted|average、resultBands 结论分档；
 *   - 结束与报告：reviewOnEnd、report.conclusion、report.omni{enabled,
 *     requireAudio,requireFrames,instructions}。
 *
 * 向后兼容：默认「通用口语教练」与语言类技能沿用六维 id
 * （fluency/pronunciation/grammar/vocabulary/content + bodyLanguage），
 * 行为与历史版本一致；跨场景技能可用任意维度 id。
 *
 * 契约字段规范见 docs/design/speech-practice-skill-architecture.md（schema 1）。
 */

/** 语言类技能保留的标准维度 id（供兼容路径与默认技能使用）。 */
export const PRACTICE_STANDARD_DIM_IDS = [
  'fluency',
  'pronunciation',
  'grammar',
  'vocabulary',
  'content',
] as const
export type PracticeStandardDimId = (typeof PRACTICE_STANDARD_DIM_IDS)[number]

/** 固定维度（overall 必填；bodyLanguage 由摄像头场景动态启用）。 */
export const PRACTICE_FIXED_DIM_IDS = ['overall', 'bodyLanguage'] as const

/** 契约里可以被引用的细分维度（不含 overall/bodyLanguage）——语言类技能兼容别名。 */
export const PRACTICE_SKILL_DIM_KEYS: readonly PracticeStandardDimId[] = [...PRACTICE_STANDARD_DIM_IDS]

/** 语言类技能的默认中文维度名（导出物离线中文，遵循 hardcode 先例）。 */
export const PRACTICE_SKILL_DIM_LABELS: Record<PracticeStandardDimId, string> = {
  fluency: '流利度',
  pronunciation: '发音语调',
  grammar: '语法准确',
  vocabulary: '词汇表达',
  content: '内容逻辑',
}

/** 技能维度配置（契约 evaluation.dimensions[] 的一项）。 */
export interface PracticeDimensionSpec {
  /** 维度 id（ASCII 小写；语言类技能请用标准 id 保持兼容）。 */
  id: string
  /** 维度显示名（报告/评分卡/工具描述用）。 */
  label: string
  /** 打给模型看的说明（可选）。 */
  description?: string
  /** 分档 rubric 文本（原样进工具描述与报告）。 */
  rubric?: string
  /** 权重（0-1，仅 weighted 综合分/加权平均用；可缺省）。 */
  weight?: number
}

/** 契约原始形态（服务端 SKILL.md frontmatter 解析产物）。 */
export interface PracticeSkillManifest {
  schema?: number
  /** 场景族标签（language|sales|interview|knowledge|presentation|custom…，仅展示/分类）。 */
  scene?: string
  /** 仅这些目标语言可用（空 = 不限）；值是 PracticeLanguage 代码（zh/en/ja/ko）。 */
  targetLanguages?: string[]
  /** 方向预置候选（UI 占位提示）。 */
  directions?: string[]
  entry?: {
    label?: string
    hint?: string
    /** 建议音色（DashScope voice id，如 Tina/Ethan；空 = 跟随用户选择）。 */
    voice?: string
  }
  coach?: {
    soul?: string
    /** 模型扮演的角色（口语化提示，如「顾客」）。 */
    role?: string
    /** 用户扮演的角色（如「销售」）。 */
    userRole?: string
    /** 对话结构：free|qa|roleplay|scenario_card|timed_turns（缺省 free）。 */
    interaction?: string
    /** 建议的整场轮数（可选，节奏提示用）。 */
    plannedTurns?: number
    /** 额外行为守则行。 */
    extraRules?: string[]
    /**
     * 本场启用的工作台工具子集（借鉴 agent 模式；允许的值见
     * PRACTICE_WORKSPACE_TOOL_IDS）。缺省 = 全部工作台工具。
     */
    tools?: string[]
  }
  /**
   * 评价对象与打分逻辑（v2 主路径）。旧式 `scoring` 仍兼容：语言类技能可直接写
   * scoring.{rubrics,labels,weights,overallMode,scale}。
   */
  evaluation?: {
    scale?: { min?: number; max?: number; step?: number }
    /** 开放自定义的评分维度（跨场景用）。 */
    dimensions?: PracticeDimensionSpec[]
    /** model=模型每轮报 overall；weighted=维度加权合成；average=各轮 overall 平均。 */
    overallMode?: 'model' | 'weighted' | 'average'
    /** 结论分档（如知识点掌握度），按综合分落档。 */
    resultBands?: Array<{ min: number; label: string; description?: string }>
  }
  /** 旧式字段（语言类技能兼容；normalize 时合并进 evaluation）。 */
  scoring?: {
    scale?: { min?: number; max?: number }
    rubrics?: Partial<Record<string, string>>
    labels?: Partial<Record<string, string>>
    weights?: Partial<Record<string, number>>
    overallMode?: 'model' | 'weighted' | 'average'
  }
  /** 结束是否让教练在同一个实时会话里先做口头收尾总评（默认 true）。 */
  reviewOnEnd?: boolean
  report?: {
    conclusion?: boolean
    omni?: {
      enabled?: boolean
      requireAudio?: boolean
      requireFrames?: boolean
      instructions?: string
    }
    sections?: string[]
  }
}

/** 工作台工具（agent 模式工具集）允许在练习中启用的 id 全集。 */
export const PRACTICE_WORKSPACE_TOOL_IDS = [
  'query_agent_memory',
  'list_agent_skills',
  'read_skill_detail',
  'list_recent_sessions',
  'list_jobs',
  'query_hermes_agent',
] as const
export type PracticeWorkspaceToolId = (typeof PRACTICE_WORKSPACE_TOOL_IDS)[number]

/** 归一化后的运行时维度（默认值全部落地）。 */
export interface PracticeDimension {
  id: string
  label: string
  description: string
  rubric: string
  weight: number | null
}

/** 运行时量表。 */
export interface PracticeScale {
  min: number
  max: number
  step: number
}

/** 运行时结论分档。 */
export interface PracticeResultBand {
  min: number
  label: string
  description: string
}

/** 归一化后的运行时技能（使用方不再判空）。 */
export interface PracticeSkill {
  kind: 'default' | 'skill'
  category: string
  name: string
  displayName: string
  description: string
  background: string
  scene: string
  voice: string | null
  /** 教练人格（soul 位输入）。 */
  coachSoul: string
  /** 模型扮演的角色（口语提示）。 */
  role: string
  /** 用户扮演的角色。 */
  userRole: string
  /** 对话结构标签。 */
  interaction: string
  plannedTurns: number | null
  /** 行为守则追加行。 */
  extraRules: string[]
  /** 本场启用的工作台工具子集（空 = 全部）。 */
  workspaceTools: PracticeWorkspaceToolId[] | null
  targetLanguages: string[]
  directions: string[]
  /** 评价对象（默认语言技能 = 标准五维；overall/bodyLanguage 单独处理）。 */
  evaluation: {
    scale: PracticeScale
    dims: PracticeDimension[]
    overallMode: 'model' | 'weighted' | 'average'
    resultBands: PracticeResultBand[]
  }
  /** 旧式兼容别名（= evaluation.dims 的 label/rubric/weight 映射，语言类技能用）。 */
  rubrics: Record<string, string>
  labels: Record<string, string>
  weights: Record<string, number>
  /** 是否建议开启摄像头（肢体语言维度需要画面时提示用户）。 */
  suggestsCamera: boolean
  reviewOnEnd: boolean
  /** 离线全模态深度书面分析开关。 */
  omniEnabled: boolean
  omniRequireAudio: boolean
  omniRequireFrames: boolean
  omniInstructions: string
  reportConclusion: boolean
}

/** 下拉里代表「未选任何下载技能」的内置通用教练。 */
export const PRACTICE_DEFAULT_SKILL_KEY = 'default'

/** 通用教练默认人格（= 历史 PRACTICE_COACH_SOUL，逐字一致）。 */
export const PRACTICE_DEFAULT_COACH_SOUL = [
  '你是一名专业、耐心的口语陪练教练，任务是陪用户练习目标语言的口语表达。',
  '你不扮演任何工作台助理人格；除按守则用中文简短解释语法/词汇外，全程使用目标语言交流。',
  '点评具体、诚实、有区分度，善于用提问引导用户持续开口。',
].join('\n')

const SCALE_DEFAULT: PracticeScale = { min: 1, max: 10, step: 1 }
/** 语言类技能的标准维度定义（rubric/weight 由技能覆盖）。 */
const STANDARD_DIM_DEFS: PracticeDimensionSpec[] = [
  { id: 'fluency', label: PRACTICE_SKILL_DIM_LABELS.fluency, description: '语流顺畅度、停顿与自我修正。' },
  { id: 'pronunciation', label: PRACTICE_SKILL_DIM_LABELS.pronunciation, description: '发音清晰度与语调自然度。' },
  { id: 'grammar', label: PRACTICE_SKILL_DIM_LABELS.grammar, description: '语法与句式准确度。' },
  { id: 'vocabulary', label: PRACTICE_SKILL_DIM_LABELS.vocabulary, description: '词汇量、搭配与表达丰富度。' },
  { id: 'content', label: PRACTICE_SKILL_DIM_LABELS.content, description: '内容相关性与逻辑结构。' },
]

function cleanText(value: unknown, max = 600): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function toDimId(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase()
  // 只允许安全字符，防止把任意文本塞进工具参数名
  return /^[a-z][a-z0-9_]{0,31}$/.test(raw) ? raw : ''
}

/** 合并旧式 scoring 与 v2 evaluation：返回统一的维度规格数组。 */
function resolveDimensionSpecs(manifest: PracticeSkillManifest | null): PracticeDimensionSpec[] {
  const evalDims = manifest?.evaluation?.dimensions
  if (Array.isArray(evalDims) && evalDims.length > 0) {
    const out: PracticeDimensionSpec[] = []
    for (const dim of evalDims) {
      const id = toDimId(dim.id)
      if (!id || id === 'overall' || id === 'bodylanguage') continue
      out.push({
        id,
        label: cleanText(dim.label, 40) || id,
        description: cleanText(dim.description, 200),
        rubric: cleanText(dim.rubric, 500),
        weight: typeof dim.weight === 'number' && Number.isFinite(dim.weight) ? dim.weight : undefined,
      })
    }
    if (out.length > 0) return out
  }
  // 旧式路径：语言类技能（scoring.rubrics/labels/weights）
  const labels = manifest?.scoring?.labels || {}
  const rubrics = manifest?.scoring?.rubrics || {}
  const weights = manifest?.scoring?.weights || {}
  return STANDARD_DIM_DEFS.map(def => ({
    ...def,
    label: cleanText(labels[def.id], 40) || def.label,
    rubric: cleanText(rubrics[def.id], 500),
    weight: typeof weights[def.id] === 'number' ? weights[def.id] : undefined,
  }))
}

function resolveScale(manifest: PracticeSkillManifest | null): PracticeScale {
  const src = manifest?.evaluation?.scale || {}
  const legacy = manifest?.scoring?.scale || {}
  const min = typeof src.min === 'number' && Number.isFinite(src.min)
    ? src.min
    : typeof legacy.min === 'number' && Number.isFinite(legacy.min)
      ? legacy.min
      : SCALE_DEFAULT.min
  const max = typeof src.max === 'number' && Number.isFinite(src.max) && src.max > min
    ? src.max
    : typeof legacy.max === 'number' && Number.isFinite(legacy.max) && legacy.max > min
      ? legacy.max
      : SCALE_DEFAULT.max
  const step = typeof src.step === 'number' && Number.isFinite(src.step) && src.step > 0
    ? src.step
    : SCALE_DEFAULT.step
  return { min, max, step }
}

function resolveBands(manifest: PracticeSkillManifest | null, scale: PracticeScale): PracticeResultBand[] {
  const raw = manifest?.evaluation?.resultBands
  if (!Array.isArray(raw)) return []
  const bands: PracticeResultBand[] = []
  for (const band of raw) {
    const min = Number(band?.min)
    const label = cleanText(band?.label, 40)
    if (!Number.isFinite(min) || !label) continue
    bands.push({ min: Math.max(scale.min, Math.min(scale.max, min)), label, description: cleanText(band?.description, 200) })
  }
  return bands.sort((a, b) => b.min - a.min)
}

/**
 * 把服务端契约归一化成运行时 PracticeSkill。
 *
 * @param meta 技能身份（default 技能传 kind='default'，其余传 category/name/description）。
 * @param manifest 契约；default 技能为 null。
 * @param bodyHint SKILL.md 正文首段（作为技能背景注入分析提示词，可空）。
 */
export function normalizePracticeSkill(
  meta: { kind?: 'default' | 'skill'; category?: string; name: string; description?: string },
  manifest?: PracticeSkillManifest | null,
  bodyHint?: string,
): PracticeSkill {
  const isDefault = meta.kind !== 'skill' || meta.name === PRACTICE_DEFAULT_SKILL_KEY
  const m = isDefault ? null : (manifest || null)
  const entry = m?.entry || {}
  const coach = m?.coach || {}

  const dims = resolveDimensionSpecs(m).map(spec => ({
    id: spec.id,
    label: spec.label,
    description: spec.description || '',
    rubric: spec.rubric || '',
    weight: typeof spec.weight === 'number' && Number.isFinite(spec.weight) ? spec.weight : null,
  }))
  const scale = resolveScale(m)
  // 维度权重归一化（weighted 模式）；权重未声明时按维度均分
  const weightedIds = dims.filter(dim => dim.weight != null).map(dim => dim.id)
  const weights: Record<string, number> = {}
  if (weightedIds.length === dims.length && dims.length > 0) {
    const total = dims.reduce((sum, dim) => sum + Number(dim.weight), 0)
    for (const dim of dims) weights[dim.id] = total > 0 ? Number(dim.weight) / total : 0
  } else if (dims.length > 0) {
    const each = 1 / dims.length
    for (const dim of dims) weights[dim.id] = each
  }
  const labels: Record<string, string> = {}
  const rubrics: Record<string, string> = {}
  for (const dim of dims) {
    labels[dim.id] = dim.label
    if (dim.rubric) rubrics[dim.id] = dim.rubric
  }
  const legacyMode = m?.scoring?.overallMode
  const overallMode = m?.evaluation?.overallMode || legacyMode || 'average'
  const resultBands = resolveBands(m, scale)
  const rawTools = Array.isArray(coach.tools) ? coach.tools : null
  const workspaceTools: PracticeWorkspaceToolId[] | null = rawTools
    ? rawTools
      .map(id => String(id).trim())
      .filter((id): id is PracticeWorkspaceToolId =>
        (PRACTICE_WORKSPACE_TOOL_IDS as readonly string[]).includes(id))
    : null

  return {
    kind: isDefault ? 'default' : 'skill',
    category: isDefault ? '' : (meta.category || 'misc'),
    name: meta.name,
    displayName: isDefault ? '通用口语教练' : (cleanText(entry.label, 60) || meta.description || meta.name),
    description: meta.description || cleanText(entry.hint, 200) || '',
    background: cleanText(bodyHint, 1500),
    scene: cleanText(m?.scene, 40),
    voice: cleanText(entry.voice, 60) || null,
    coachSoul: cleanText(coach.soul, 2000) || PRACTICE_DEFAULT_COACH_SOUL,
    role: cleanText(coach.role, 60),
    userRole: cleanText(coach.userRole, 60),
    interaction: cleanText(coach.interaction, 40),
    plannedTurns: typeof coach.plannedTurns === 'number' && Number.isFinite(coach.plannedTurns)
      ? Math.max(1, Math.min(200, Math.floor(coach.plannedTurns)))
      : null,
    extraRules: Array.isArray(coach.extraRules)
      ? coach.extraRules.map(rule => cleanText(rule, 400)).filter(Boolean)
      : [],
    workspaceTools,
    targetLanguages: Array.isArray(m?.targetLanguages)
      ? m.targetLanguages!.map(lang => cleanText(lang, 10)).filter(Boolean)
      : [],
    directions: Array.isArray(m?.directions)
      ? m.directions!.map(dir => cleanText(dir, 120)).filter(Boolean)
      : [],
    evaluation: { scale, dims, overallMode, resultBands },
    rubrics,
    labels,
    weights,
    suggestsCamera: false,
    reviewOnEnd: m?.reviewOnEnd !== false,
    omniEnabled: m?.report?.omni?.enabled !== false,
    omniRequireAudio: m?.report?.omni?.requireAudio === true,
    omniRequireFrames: m?.report?.omni?.requireFrames === true,
    omniInstructions: cleanText(m?.report?.omni?.instructions, 1000),
    reportConclusion: m?.report?.conclusion !== false,
  }
}

/** 内置通用教练（缺省，无需下载；= 现状硬编码行为）。 */
export function defaultPracticeSkill(): PracticeSkill {
  return normalizePracticeSkill({ kind: 'default', name: PRACTICE_DEFAULT_SKILL_KEY })
}

/** 从服务端拉回的练习技能条目（含契约），见 fetchPracticeSkills()。 */
export interface PracticeSkillEntry {
  category: string
  name: string
  description: string
  enabled: boolean
  source: string
  /** 服务端解析的 hermes_practice 契约；下载技能必有，default 技能为 null。 */
  manifest?: PracticeSkillManifest | null
}

/** 练习技能引用（随练习配置持久化，用于重开会话时还原）。 */
export interface PracticeSkillRef {
  category: string
  name: string
}

export function isDefaultSkillRef(ref: PracticeSkillRef | null | undefined): boolean {
  return !ref || ref.name === PRACTICE_DEFAULT_SKILL_KEY
}

/** 练习技能下拉选项（ChatPanel 组装，UI 文案由调用方做 i18n）。 */
export interface PracticeSkillOption {
  key: string
  category: string
  name: string
  label: string
  hint: string
  voice: string | null
  manifest: PracticeSkillManifest | null
}

/** 把下载技能条目折叠成下拉选项；'default' 恒为首项。 */
export function toPracticeSkillOptions(entries: PracticeSkillEntry[]): PracticeSkillOption[] {
  const options: PracticeSkillOption[] = [{
    key: PRACTICE_DEFAULT_SKILL_KEY,
    category: '',
    name: PRACTICE_DEFAULT_SKILL_KEY,
    label: '通用口语教练',
    hint: '',
    voice: null,
    manifest: null,
  }]
  const seen = new Set<string>([PRACTICE_DEFAULT_SKILL_KEY])
  for (const entry of entries) {
    if (!entry || !entry.name || seen.has(entry.name)) continue
    seen.add(entry.name)
    const m = entry.manifest || null
    options.push({
      key: `${entry.category || 'misc'}/${entry.name}`,
      category: entry.category || 'misc',
      name: entry.name,
      label: m?.entry?.label || entry.description || entry.name,
      hint: m?.entry?.hint || entry.description || '',
      voice: m?.entry?.voice || null,
      manifest: m,
    })
  }
  return options
}

/** 按持久化的引用解析条目；找不到（已删除/未安装）返回 null。 */
export function findPracticeSkillEntry(
  entries: PracticeSkillEntry[],
  ref: PracticeSkillRef | null | undefined,
): PracticeSkillEntry | null {
  if (!ref || isDefaultSkillRef(ref)) return null
  return entries.find(entry =>
    entry.name === ref.name && (ref.category ? entry.category === ref.category : true),
  ) || null
}

// --- 语言绑定（targetLanguages → UI 下拉收敛/自动切换） --------------------

/** 技能限定的目标语言代码列表；null = 不限（跟随用户选择）。 */
export function skillLanguageCodes(skill: PracticeSkill): string[] | null {
  return skill.targetLanguages.length > 0 ? [...skill.targetLanguages] : null
}

export function skillSupportsLanguage(skill: PracticeSkill, language: string): boolean {
  return skill.targetLanguages.length === 0 || skill.targetLanguages.includes(language)
}

/**
 * 技能绑定语言后应选定的语言：技能不限定 → null（用户自由选）；
 * 限定且 current 在范围内 → current；否则 → 技能第一个语言。
 */
export function resolveSkillLanguage(skill: PracticeSkill, current: string): string | null {
  const codes = skillLanguageCodes(skill)
  if (!codes) return null
  return codes.includes(current) ? current : (codes[0] || null)
}

/** 维度显示名（labels 已归一化，直接用）。 */
export function skillDimLabel(skill: PracticeSkill, dimId: string, fallback = dimId): string {
  return skill.labels[dimId] || fallback
}

// --- 打分逻辑 ---------------------------------------------------------------

/** 单条评分记录里读取某维度的数值（记录顶层按维度 id 存放数字；兼容旧六维字段）。 */
export function readFeedbackScore(record: Record<string, unknown>, dimId: string): number | null {
  const value = record[dimId]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 整场综合分（打分逻辑）：
 *   - overallMode 'model' 或 'average'：取各轮 overall 的平均；
 *   - 'weighted'：按技能维度权重对每轮维度分先求均值再加权合成。
 * 返回 null 表示样本不足。
 */
export function aggregateOverallScore(
  records: Array<Record<string, unknown>>,
  skill: PracticeSkill,
): { value: number | null; mode: 'model' | 'weighted' | 'average' } {
  const mode = skill.evaluation.overallMode
  if (mode === 'weighted' && skill.evaluation.dims.length > 0) {
    const anyWeighted = skill.evaluation.dims.some(dim => skill.weights[dim.id] != null)
    if (anyWeighted) {
      let total = 0
      let hasAny = false
      for (const dim of skill.evaluation.dims) {
        const weight = skill.weights[dim.id]
        if (weight == null) continue
        const samples = records
          .map(record => readFeedbackScore(record, dim.id))
          .filter((value): value is number => value != null)
        if (samples.length === 0) continue
        hasAny = true
        total += (samples.reduce((sum, n) => sum + n, 0) / samples.length) * weight
      }
      return hasAny ? { value: Math.round(total * 10) / 10, mode } : { value: null, mode }
    }
  }
  const overalls = records
    .map(record => readFeedbackScore(record, 'overall'))
    .filter((value): value is number => value != null)
  if (overalls.length === 0) return { value: null, mode }
  const mean = overalls.reduce((sum, n) => sum + n, 0) / overalls.length
  return { value: Math.round(mean * 10) / 10, mode }
}

/** 把综合分映射到技能声明的结论档位（resultBands）；无档位返回 null。 */
export function resultBandOf(skill: PracticeSkill, value: number | null): PracticeResultBand | null {
  if (value == null) return null
  for (const band of skill.evaluation.resultBands) {
    if (value >= band.min) return band
  }
  return skill.evaluation.resultBands.length > 0
    ? skill.evaluation.resultBands[skill.evaluation.resultBands.length - 1]!
    : null
}

/** 综合分算法的中文说明（报告/提示词里用）。 */
export function overallModeLabel(skill: PracticeSkill): string {
  const mode = skill.evaluation.overallMode
  if (mode === 'weighted') {
    const parts = skill.evaluation.dims
      .filter(dim => skill.weights[dim.id] != null)
      .map(dim => `${dim.label} ${Math.round(Number(skill.weights[dim.id]) * 100)}%`)
    return `按技能权重加权（${parts.join('、')}）`
  }
  return mode === 'model' ? '教练逐轮评分（overall）' : '各轮总分平均'
}

// --- 指令/工具/报告拼装 ------------------------------------------------------

/** 报告里的「本次技能与评价标准」参考段落（Markdown；无内容时返回空串）。 */
export function buildSkillCriteriaMarkdown(skill: PracticeSkill): string {
  const out: string[] = []
  if (skill.kind === 'skill') {
    out.push('', '## 附：本次练习技能与评价标准', '', `- **技能**：${skill.displayName}`)
    if (skill.description) out.push(`- **说明**：${skill.description}`)
  }
  out.push(`- **评分量表**：${skill.evaluation.scale.min}-${skill.evaluation.scale.max} 分`
    + `（步长 ${skill.evaluation.scale.step}）｜**打分逻辑**：${overallModeLabel(skill)}`)
  if (skill.evaluation.dims.length > 0) {
    out.push('', '各维度评分参考：', '')
    for (const dim of skill.evaluation.dims) {
      const weightText = skill.weights[dim.id] != null
        ? `（权重 ${Math.round(Number(skill.weights[dim.id]) * 100)}%）`
        : ''
      const desc = dim.description ? `｜${dim.description}` : ''
      out.push(`- **${dim.label}**${weightText}：${dim.rubric || '（技能未给出分档标准，按量表自行把握）'}${desc}`)
    }
  }
  if (skill.evaluation.resultBands.length > 0) {
    out.push('', '结论分档：', '')
    for (const band of [...skill.evaluation.resultBands].sort((a, b) => b.min - a.min)) {
      out.push(`- ≥ ${band.min} 分 → **${band.label}**${band.description ? `：${band.description}` : ''}`)
    }
  }
  return out.length > 0 ? out.join('\n') : ''
}

/** rubric 摘要行（注入实时指令，让模型打分时参考技能标准；无则空串）。 */
export function buildRubricSummaryLine(skill: PracticeSkill): string {
  const parts = skill.evaluation.dims
    .filter(dim => dim.rubric)
    .map(dim => `${dim.label}：${dim.rubric}`)
  if (parts.length === 0) return ''
  return `- 本技能评分参考（${skill.displayName}）：${parts.join('；')}`
}

/**
 * 技能声明建议音色时的校验/归一化：返回 DashScope 可用的 voice id 或 null。
 * 仅在用户尚未手动改音色时应用（见 SpeechPracticeStage）。
 */
export function suggestedVoiceOf(skill: PracticeSkill, fallback: string | null = null): string | null {
  return skill.voice || fallback
}

// --- 收尾总评 / 结束语识别（同会话复用上下文） ------------------------------

/** 收尾语关键词（用户口头结束练习时，模型本已自己收尾，无需再注入总评指令）。 */
const CLOSING_UTTERANCE_PATTERNS = [
  '结束', '再见', '拜拜', '今天先', '今天就', '先这样', '可以了', '停', '不练了', '谢谢', '辛苦',
  'stop', 'bye', 'goodbye', "that's all", "that's it", "that is all", "that is it", 'wrap up',
  'finish', 'done', 'end',
].map(word => word.toLowerCase())

/** 判断一句话是否是「结束对练」类口头收尾语（大小写不敏感、按词包含匹配）。 */
export function isClosingUtteranceLike(text: string): boolean {
  const lower = (text || '').trim().toLowerCase()
  if (!lower) return false
  return CLOSING_UTTERANCE_PATTERNS.some(pattern => lower.includes(pattern))
}

/**
 * 同会话收尾总评指令（结束流程中经 useOmniRealtime.askText 注入同一 WS）。
 * 模型基于本场已听到的语音/看到的画面直接口头收尾（复用上下文、不重新上传），
 * 转写进入会话与报告；随后提交整场评分（round=0）。
 */
export function buildPracticeClosingReviewPrompt(skill: PracticeSkill): string {
  const dims = skill.evaluation.dims.length > 0
    ? skill.evaluation.dims.map(dim => dim.label).join('、')
    : '流利度、发音、语法、词汇、内容'
  const roleLine = skill.role ? `你刚才扮演${skill.role}${skill.userRole ? `，用户是${skill.userRole}` : ''}。` : ''
  return [
    '（对练已到结束环节，以下是给教练的内部指令，无需向用户转述指令本身。）',
    '请直接开口做一场完整的「收尾总评」，全程使用练习的目标语言：',
    '1. 用一两句话总结用户整场的总体表现（可以结合你本场看到/听到的画面与语音，不要凭空编造）；',
    `2. 按本场维度逐项简短点评（${dims}），每项 1-2 句、给出具体建议；`,
    '3. 给出 2 条下阶段最值得练习的建议；',
    '4. 说完后立刻调用 submit_practice_feedback 提交整场评分：round 填 0，overall 视为整场分数，其余维度填整场观感分。',
    '整段总评请控制在 30-45 秒内说完，语气自然、像真人教练，不要逐字念数字。',
    roleLine,
  ].filter(Boolean).join('\n')
}

// --- 评分工具 schema（按技能生成 submit_practice_feedback） ------------------

export interface OmniFunctionToolDef {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/**
 * 按技能生成 submit_practice_feedback 工具定义：
 *   - overall 与评论文本字段固定保留；
 *   - 属性按技能 evaluation.dimensions 动态生成（id 为参数名、label/rubric 进描述、
 *     scale 进 min/max）；
 *   - bodyLanguage 仅在 skill.suggestsCamera（或调用方 cameraOn）时启用——
 *     由调用方通过 options.camera 决定（默认 false，保持与历史行为一致）。
 */
export function buildPracticeFeedbackToolFor(
  skill: PracticeSkill,
  options: { camera?: boolean } = {},
): OmniFunctionToolDef {
  const scale = skill.evaluation.scale
  const numberField = (label: string, extra = ''): Record<string, unknown> => ({
    type: 'number',
    description: `${label}评分，${scale.min}-${scale.max} 分。${extra}`.trim(),
    minimum: scale.min,
    maximum: scale.max,
  })
  const properties: Record<string, unknown> = {
    overall: numberField('本轮总分'),
    comment: { type: 'string', description: '对本轮表现的一句话点评（用练习目标语言书写）。' },
    strengths: { type: 'string', description: '亮点，一两句（用练习目标语言书写）。' },
    improvements: { type: 'string', description: '本轮最重要的 1 个可提升点（用练习目标语言书写）。' },
    example: { type: 'string', description: '更自然/更地道的表达示范或纠错示范，一两句（用练习目标语言书写）。' },
  }
  const required = ['overall', 'comment']
  for (const dim of skill.evaluation.dims) {
    properties[dim.id] = numberField(dim.label, dim.rubric || dim.description || '')
    required.push(dim.id)
  }
  if (options.camera) {
    properties.bodyLanguage = {
      ...numberField('肢体语言/仪态/眼神交流', '只在摄像头开启、你能看到用户画面时填写；看不到画面一律不填。'),
    }
  }
  const dimList = skill.evaluation.dims.map(dim => dim.label).join(' / ')
  return {
    type: 'function',
    name: 'submit_practice_feedback',
    description: `口语对练专用：每轮用户发言结束后，把对本轮表现的结构化打分与点评通过本工具提交`
      + `（客户端会实时显示在评分卡上，并进入最终的分析报告）。`
      + `评分维度：总分 overall${dimList ? ` + ${dimList}` : ''}（${scale.min}-${scale.max} 分整数）`
      + `${options.camera ? ' + 肢体语言 bodyLanguage' : ''}。`
      + `评分后再用目标语言口头简短总结一句，然后继续引导下一轮练习。`,
    parameters: { type: 'object', properties, required },
  }
}
