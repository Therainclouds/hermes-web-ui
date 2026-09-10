export default {
  knowledge: {
    title: '知識庫',
    subtitle: '文件語意搜尋 RAG 庫',
    sidebarLabel: '知識庫',
    description: '索引本地文件，供 Hermes Agent 進行語意搜尋。',

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
      status: '狀態',
      path: '來源路徑',
      size: '大小',
      indexedAt: '索引時間',
      pending: '等待中',
      indexing: '索引中',
      indexed: '已索引',
      failed: '失敗',
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
      deleteFailed: '刪除知識庫失敗',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: '知識庫',
    description: '文件知識庫，支援 RAG 語意搜尋。',
  },
}
