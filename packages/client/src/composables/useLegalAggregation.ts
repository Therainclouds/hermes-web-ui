import { computed, type Ref } from 'vue'
import type { AnalysisRound } from '@/composables/useMeetingAssist'

/** 风险清单条目（跨轮次去重累积后）。 */
export interface LegalRiskItem {
  level: 'high' | 'medium' | 'low'
  text: string
  quote?: string
  lawHint?: string
  timestamp: number
}

/** 各方立场时间线条目。 */
export interface LegalPosition {
  party: string
  stance: string
  timestamp: number
}

/** 法条引用卡条目。 */
export interface LegalLawRef {
  name: string
  article?: string
  note?: string
  verified: boolean
}

export interface LegalSummary {
  highRiskCount: number
  riskTotal: number
  partyCount: number
}

export interface UseLegalAggregationDeps {
  /** AI 实时点评轮次流（调用方的 useMeetingAssist().rounds——此处不得自建连接） */
  rounds: Ref<AnalysisRound[]>
}

/**
 * 法律场景 AI 轮次聚合（纯累积去重，行为与 speech 的增量评价同构）。
 * 同时导出纯函数 summarizeLegalRisks 供状态条等非组合体场景复用。
 */
export function useLegalAggregation(deps: UseLegalAggregationDeps) {
  const roundsRef = deps.rounds

  // 风险雷达：跨轮次按 text 去重累积，high 优先排序
  const riskItems = computed<LegalRiskItem[]>(() => summarizeRiskItems(roundsRef.value))

  // 各方立场时间线：party+stance 去重，按发言顺序累积
  const positions = computed<LegalPosition[]>(() => {
    const seen = new Set<string>()
    const out: LegalPosition[] = []
    for (const r of roundsRef.value) {
      for (const p of r.positions || []) {
        const key = `${p.party?.trim()}|${p.stance?.trim()}`
        if (!p.party?.trim() || !p.stance?.trim() || seen.has(key)) continue
        seen.add(key)
        out.push({ party: p.party, stance: p.stance, timestamp: r.timestamp })
      }
    }
    return out
  })

  // 法条依据卡：name+article 去重
  const lawRefs = computed<LegalLawRef[]>(() => {
    const seen = new Set<string>()
    const out: LegalLawRef[] = []
    for (const r of roundsRef.value) {
      for (const l of r.lawRefs || []) {
        const key = `${l.name?.trim()}|${l.article?.trim()}`
        if (!l.name?.trim() || seen.has(key)) continue
        seen.add(key)
        out.push({
          name: l.name,
          ...(l.article ? { article: l.article } : {}),
          ...(l.note ? { note: l.note } : {}),
          verified: l.verified === true,
        })
      }
    }
    return out
  })

  const summary = computed<LegalSummary>(() => summarizeLegalRisks(roundsRef.value))

  return { riskItems, positions, lawRefs, summary }
}

/** 状态条/KPI 复用的纯汇总函数。 */
export function summarizeLegalRisks(rounds: AnalysisRound[]): LegalSummary & { riskItems: LegalRiskItem[] } {
  const riskItems = summarizeRiskItems(rounds)
  return {
    highRiskCount: riskItems.filter(r => r.level === 'high').length,
    riskTotal: riskItems.length,
    partyCount: new Set(
      rounds.flatMap(r => (r.positions || []).map(p => p.party?.trim()).filter(Boolean) as string[]),
    ).size,
    riskItems,
  }
}

function summarizeRiskItems(rounds: AnalysisRound[]): LegalRiskItem[] {
  const seen = new Set<string>()
  const out: LegalRiskItem[] = []
  const levelOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
  for (const r of rounds) {
    for (const item of r.riskItems || []) {
      const key = item.text?.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        level: item.level,
        text: item.text,
        ...(item.quote ? { quote: item.quote } : {}),
        ...(item.lawHint ? { lawHint: item.lawHint } : {}),
        timestamp: r.timestamp,
      })
    }
  }
  return out.sort((a, b) => levelOrder[a.level] - levelOrder[b.level])
}
