export default {
  knowledge: {
    title: '知识库',
    subtitle: '文档语义搜索 RAG 库',
    sidebarLabel: '知识库',
    description: '索引本地文档，供 Hermes Agent 进行语义搜索。',

    vaults: {
      title: '知识库',
      add: '添加知识库',
      name: '名称',
      path: '根路径',
      status: '状态',
      watching: '监听中',
      offline: '离线',
      documents: '文档数',
      confirmDelete: '确定删除此知识库？',
      cascadeDelete: '同时删除所有已索引文档',
      pathPlaceholder: '/path/to/documents',
      namePlaceholder: '我的文档',
    },

    documents: {
      title: '文档',
      status: '状态',
      path: '源路径',
      size: '大小',
      indexedAt: '索引时间',
      pending: '等待中',
      indexing: '索引中',
      indexed: '已索引',
      failed: '失败',
      all: '全部',
      noDocuments: '未找到文档。',
      error: '错误',
    },

    health: {
      title: '健康状态',
      vaults: '知识库',
      documents: '文档',
      chunks: '分块',
      vectors: '向量',
      lastSuccess: '最近成功',
      lastFailure: '最近失败',
      noError: '无错误',
    },

    actions: {
      delete: '删除',
      refresh: '刷新',
      cancel: '取消',
      confirm: '确认',
    },

    errors: {
      fetchFailed: '加载知识库数据失败',
      createFailed: '创建知识库失败',
      deleteFailed: '删除知识库失败',
    },

    messages: {
      vaultCreated: '知识库已创建',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: '知识库',
    description: '文档知识库，支持 RAG 语义搜索。',
  },
}
