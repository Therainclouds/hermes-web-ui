export default {
  knowledge: {
    title: '知識庫',
    subtitle: '文件語意搜尋 RAG 庫',
    sidebarLabel: '知識庫',
    description: '索引本地文件，供 Hermes Agent 進行語意搜尋。',

    tabs: {
      dashboard: '總覽',
      graph: '圖譜',
      list: '文件庫',
    },

    sidebar: {
      vaults: '知識庫',
      tags: '標籤',
      allVaults: '全部知識庫',
      noVaults: '尚無知識庫',
      noTags: '尚無標籤',
    },

    dashboard: {
      statusBreakdown: '狀態分佈',
      recentActivity: '最近活動',
      noRecentActivity: '尚無最近活動',
      quickActions: '快捷操作',
      openGraph: '開啟圖譜',
      openList: '開啟文件庫',
    },

    graph: {
      title: '知識圖譜',
      empty: '暫無可視化資料',
      allVaults: '全部知識庫',
      legend: {
        vault: '知識庫',
        document: '文件',
      },
    },

    detail: {
      title: '文件詳情',
      noDocument: '未選擇文件',
      metadata: '元資料',
      content: '內容',
      path: '路徑',
      vault: '所屬知識庫',
      mime: '類型',
      size: '大小',
      indexed: '索引時間',
      error: '錯誤訊息',
      noChunks: '暫無內容分塊',
      close: '關閉',
    },

    vaults: {
      title: '知識庫',
      add: '新增知識庫',
      name: '名稱',
      path: '根路徑',
      status: '狀態',
      watching: '監聽中',
      offline: '離線',
      documents: '文件數',
      confirmDelete: '確定刪除此知識庫？',
      cascadeDelete: '同時刪除所有已索引文件',
      pathPlaceholder: '/path/to/documents',
      namePlaceholder: '我的文件',
    },

    documents: {
      title: '文件',
      name: '檔名',
      status: '狀態',
      path: '來源路徑',
      size: '大小',
      indexedAt: '索引時間',
      pending: '等待中',
      indexing: '索引中',
      indexed: '已索引',
      failed: '失敗',
      metadata_only: '僅中繼資料',
      all: '全部',
      noDocuments: '未找到文件。',
      error: '錯誤',
    },

    health: {
      title: '健康狀態',
      vaults: '知識庫',
      documents: '文件',
      chunks: '分塊',
      vectors: '向量',
      lastSuccess: '最近成功',
      lastFailure: '最近失敗',
      noError: '無錯誤',
    },

    actions: {
      delete: '刪除',
      refresh: '重新整理',
      cancel: '取消',
      confirm: '確認',
    },

    errors: {
      fetchFailed: '載入知識庫資料失敗',
      createFailed: '建立知識庫失敗',
      deleteFailed: '刪除失敗',
    },

    messages: {
      vaultCreated: '知識庫已建立',
    },

    settings: {
      title: '設定',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API Key 已設定（尾號 {hint}）',
      notConfigured: '尚未設定 Embedding API Key，儲存後才能索引文件。',
      pluginDisabled: '知識庫外掛已停用。請設定 KNOWLEDGE_ENABLED=1 並重新啟動服務。',
      save: '儲存 Key',
      saved: 'API Key 已儲存，外掛已啟用',
      savedButNotInitialized: 'API Key 已儲存，但外掛未啟動，請查看伺服器日誌。',
      saveFailed: '儲存 API Key 失敗',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: '知識庫',
    description: '文件知識庫，支援 RAG 語意搜尋。',
  },
}