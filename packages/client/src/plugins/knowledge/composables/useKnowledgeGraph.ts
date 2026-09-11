/**
 * Knowledge plugin — graph data composable.
 *
 * Builds node-link graph from vaults + documents for visualization.
 * Nodes are organized in a hierarchical layout: vaults as parent nodes,
 * documents as children grouped by status.
 */
import { computed } from 'vue'
import type { KnowledgeVault, KnowledgeDocument } from '../api'

export interface GraphNode {
  id: string
  type: 'vault' | 'document'
  label: string
  vaultId: number
  status?: string
  size?: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export function useKnowledgeGraph(
  vaults: () => readonly KnowledgeVault[],
  documents: () => readonly KnowledgeDocument[],
) {
  return computed<GraphData>(() => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const vaultList = vaults()
    const docList = documents()

    for (const vault of vaultList) {
      nodes.push({
        id: `vault-${vault.id}`,
        type: 'vault',
        label: vault.name,
        vaultId: vault.id,
        size: vaultList.length > 0 ? 80 : 60,
      })
    }

    for (const doc of docList) {
      const docNode: GraphNode = {
        id: `doc-${doc.id}`,
        type: 'document',
        label: doc.source_path.split(/[\\/]/).pop() || doc.source_path,
        vaultId: doc.vault_id,
        status: doc.status,
        size: Math.max(24, Math.min(60, Math.log2(doc.size_bytes + 1) * 6)),
      }
      nodes.push(docNode)
      edges.push({
        id: `edge-${vault.id}-${doc.id}`,
        source: `vault-${doc.vault_id}`,
        target: `doc-${doc.id}`,
      })
    }

    return { nodes, edges }
  })
}

/** Compute a simple grid-based layout: vaults in row 0, docs below. */
export function computeGraphLayout(data: GraphData): {
  positionedNodes: Array<GraphNode & { x: number; y: number }>
  positionedEdges: Array<GraphEdge & { sourceX: number; sourceY: number; targetX: number; targetY: number }>
} {
  const vaultNodes = data.nodes.filter(n => n.type === 'vault')
  const docNodes = data.nodes.filter(n => n.type === 'document')

  const vaultSpacing = 200
  const vaultStartX = 100
  const vaultY = 60
  const docYOffset = 180
  const docSpacing = 140
  const docStartX = 80

  const positionedNodes: Array<GraphNode & { x: number; y: number }> = []
  const vaultPositions = new Map<number, number>()

  vaultNodes.forEach((vault, i) => {
    const x = vaultStartX + i * vaultSpacing
    vaultPositions.set(vault.vaultId, x)
    positionedNodes.push({ ...vault, x, y: vaultY })
  })

  const docsByVault = new Map<number, GraphNode[]>()
  for (const doc of docNodes) {
    const list = docsByVault.get(doc.vaultId) || []
    list.push(doc)
    docsByVault.set(doc.vaultId, list)
  }

  for (const [vaultId, docs] of docsByVault) {
    const vaultX = vaultPositions.get(vaultId) ?? vaultStartX
    docs.forEach((doc, i) => {
      const x = vaultX - (docs.length - 1) * docSpacing / 2 + i * docSpacing
      positionedNodes.push({ ...doc, x, y: vaultY + docYOffset })
    })
  }

  const nodeById = new Map(positionedNodes.map(n => [n.id, n]))
  const positionedEdges = data.edges.map(edge => {
    const s = nodeById.get(edge.source)!
    const t = nodeById.get(edge.target)!
    return {
      ...edge,
      sourceX: s.x,
      sourceY: s.y,
      targetX: t.x,
      targetY: t.y,
    }
  })

  return { positionedNodes, positionedEdges }
}