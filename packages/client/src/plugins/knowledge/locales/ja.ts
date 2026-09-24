export default {
  knowledge: {
    title: 'ナレッジベース',
    subtitle: 'ドキュメント検索のためのRAGボールト',
    sidebarLabel: 'ナレッジ',
    description: 'Hermes Agentによるセマンティック検索のためにローカルドキュメントをインデックスします。',

    tabs: {
      dashboard: '概要',
      graph: 'グラフ',
      list: 'ライブラリ',
    },

    sidebar: {
      vaults: 'ボールト',
      tags: 'タグ',
      allVaults: 'すべてのボールト',
      noVaults: 'ボールトがありません',
      noTags: 'タグがありません',
    },

    dashboard: {
      statusBreakdown: 'ステータス内訳',
      recentActivity: '最近のアクティビティ',
      noRecentActivity: '最近のアクティビティはありません',
      quickActions: 'クイックアクション',
      openGraph: 'グラフを開く',
      openList: 'ライブラリを開く',
    },

    graph: {
      title: 'ナレッジグラフ',
      empty: '可視化するデータがありません',
      allVaults: 'すべてのボールト',
      legend: {
        vault: 'ボールト',
        document: 'ドキュメント',
      },
    },

    detail: {
      title: 'ドキュメントの詳細',
      noDocument: 'ドキュメントが選択されていません',
      metadata: 'メタデータ',
      content: 'コンテンツ',
      path: 'パス',
      vault: 'ボールト',
      mime: 'タイプ',
      size: 'サイズ',
      indexed: 'インデックス済み',
      error: 'エラー',
      noChunks: 'コンテンツチャンクがありません',
      close: '閉じる',
    },

    vaults: {
      title: 'ボールト', add: 'ボールト追加', name: '名前', path: 'ルートパス',
      status: 'ステータス', watching: '監視中', offline: 'オフライン',
      documents: 'ドキュメント', confirmDelete: 'このボールトを削除しますか？',
      cascadeDelete: 'インデックス済みドキュメントも削除する',
      pathPlaceholder: '/path/to/documents', namePlaceholder: '私のドキュメント',
    },
    documents: {
      title: 'ドキュメント', name: '名前', status: 'ステータス', path: 'ソースパス', size: 'サイズ',
      indexedAt: 'インデックス日時', pending: '保留中', indexing: 'インデックス中',
      indexed: '完了', failed: '失敗', metadata_only: 'メタデータのみ',
      all: 'すべて', noDocuments: 'ドキュメントがありません。', error: 'エラー',
    },
    health: {
      title: 'ヘルス', vaults: 'ボールト', documents: 'ドキュメント',
      chunks: 'チャンク', vectors: 'ベクトル', lastSuccess: '最終成功',
      lastFailure: '最終失敗', noError: 'エラーなし',
    },
    actions: { delete: '削除', refresh: '更新', cancel: 'キャンセル', confirm: '確認' },
    errors: { fetchFailed: 'データの読み込みに失敗しました', createFailed: 'ボールトの作成に失敗しました', deleteFailed: 'ボールトの削除に失敗しました' },
    messages: { vaultCreated: 'ボールトを作成しました' },
    settings: {
      title: '設定',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API キー設定済み（末尾 {hint}）',
      notConfigured: 'Embedding API キーが未設定です。保存するまでドキュメントをインデックスできません。',
      pluginDisabled: 'ナレッジプラグインが無効です。KNOWLEDGE_ENABLED=1 を設定してサーバーを再起動してください。',
      save: 'キーを保存',
      saved: 'API キーを保存しました — プラグインが有効になりました',
      savedButNotInitialized: 'API キーは保存されましたが、プラグインが起動していません。サーバーログを確認してください。',
      saveFailed: 'API キーの保存に失敗しました',
    },
  },
  pluginsKnowledge: { sidebarLabel: 'ナレッジ', description: 'RAG検索付きドキュメントナレッジベース。' },
}