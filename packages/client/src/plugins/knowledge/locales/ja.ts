export default {
  knowledge: {
    title: 'ナレッジベース',
    subtitle: 'ドキュメント検索のためのRAGボールト',
    sidebarLabel: 'ナレッジ',
    description: 'Hermes Agentによるセマンティック検索のためにローカルドキュメントをインデックスします。',
    vaults: {
      title: 'ボールト', add: 'ボールト追加', name: '名前', path: 'ルートパス',
      status: 'ステータス', watching: '監視中', offline: 'オフライン',
      documents: 'ドキュメント', confirmDelete: 'このボールトを削除しますか？',
      cascadeDelete: 'インデックス済みドキュメントも削除する',
      pathPlaceholder: '/path/to/documents', namePlaceholder: '私のドキュメント',
    },
    documents: {
      title: 'ドキュメント', status: 'ステータス', path: 'ソースパス', size: 'サイズ',
      indexedAt: 'インデックス日時', pending: '保留中', indexing: 'インデックス中',
      indexed: '完了', failed: '失敗', all: 'すべて',
      noDocuments: 'ドキュメントがありません。', error: 'エラー',
    },
    health: {
      title: 'ヘルス', vaults: 'ボールト', documents: 'ドキュメント',
      chunks: 'チャンク', vectors: 'ベクトル', lastSuccess: '最終成功',
      lastFailure: '最終失敗', noError: 'エラーなし',
    },
    actions: { delete: '削除', refresh: '更新', cancel: 'キャンセル', confirm: '確認' },
    errors: { fetchFailed: 'データの読み込みに失敗しました', createFailed: 'ボールトの作成に失敗しました', deleteFailed: 'ボールトの削除に失敗しました' },
    messages: { vaultCreated: 'ボールトを作成しました' },
  },
  pluginsKnowledge: { sidebarLabel: 'ナレッジ', description: 'RAG検索付きドキュメントナレッジベース。' },
}
