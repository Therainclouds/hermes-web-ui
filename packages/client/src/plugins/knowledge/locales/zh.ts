export default {
  knowledge: {
    title: '知识库',
    subtitle: '文档语义搜索 RAG 库',
    sidebarLabel: '知识库',
    description: '索引本地文档，供 Hermes Agent 进行语义搜索。',

    tabs: {
      dashboard: '概览',
      graph: '图谱',
      list: '文档库',
    },

    sidebar: {
      vaults: '知识库',
      tags: '标签',
      allVaults: '全部知识库',
      noVaults: '暂无知识库',
      noTags: '暂无标签',
    },

    dashboard: {
      statusBreakdown: '状态分布',
      recentActivity: '最近活动',
      noRecentActivity: '暂无最近活动',
      quickActions: '快捷操作',
      openGraph: '打开图谱',
      openList: '打开文档库',
    },

    graph: {
      title: '知识图谱',
      empty: '暂无可视化数据',
      allVaults: '全部知识库',
      legend: {
        vault: '知识库',
        document: '文档',
      },
    },

    detail: {
      title: '文档详情',
      noDocument: '未选择文档',
      metadata: '元数据',
      content: '内容',
      path: '路径',
      vault: '所属知识库',
      mime: '类型',
      size: '大小',
      indexed: '索引时间',
      error: '错误信息',
      noChunks: '暂无内容分块',
      close: '关闭',
      index: '全文索引',
      indexQueued: '已加入索引队列，完成后可被搜索',
      indexFailed: '加入索引队列失败',
      metadataOnlyHint: '仅记录元数据，暂不可被搜索。执行全文索引后才能参与检索。',
    },

    modes: {
      tasks: { label: '任务', desc: '盯住索引状态、任务引用与进度' },
      legal: { label: '法务', desc: '合同案卷归档，审查引用是否合规' },
      learning: { label: '学习', desc: '用双链连接知识，强化复习' },
      explorer: { label: '探索', desc: '图谱、向量索引与全部高级设置' },
      batch: { label: '批量', desc: '批量导入文件，整理重复劳动' },
    },

    onboarding: {
      title: '选择你的工作方式',
      subtitle: '知识库会按你的主要用途调整界面。之后随时可在顶部切换，数据不会丢失。',
      skip: '稍后设置',
    },

    statusBar: {
      ready: '就绪',
      needsKey: '未配置 API Key',
      disabled: '插件未启用',
      documents: '{n} 篇文档',
      indexed: '已索引 {n}',
      queue: '队列 {n}',
      failed: '失败 {n}',
      settings: '设置',
      switchMode: '切换模式',
    },

    tasks: {
      heroTitle: '索引进度',
      progress: { done: '完成', todo: '待办', running: '进行中', errored: '出错' },
      filesTitle: '归档文件',
      goExplorer: '添加知识库',
      columns: { references: '引用', lastCited: '最近引用' },
      references: {
        title: '引用记录',
        empty: '暂无检索引用记录',
        loadFailed: '引用记录加载失败',
        sourceChat: '界面搜索',
        sourceAgent: 'Agent 工具',
        never: '未被引用',
      },
    },

    modePlaceholder: {
      comingSoon: '此模式将在下一轮更新中开放',
    },

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
      name: '文件名',
      status: '状态',
      path: '源路径',
      size: '大小',
      indexedAt: '索引时间',
      pending: '等待中',
      indexing: '索引中',
      indexed: '已索引',
      failed: '失败',
      metadata_only: '仅元数据',
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
      deleteFailed: '删除失败',
    },

    messages: {
      vaultCreated: '知识库已创建',
    },

    settings: {
      title: '设置',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API Key 已配置（尾号 {hint}）',
      notConfigured: '尚未配置 Embedding API Key，保存后才能索引文档。',
      pluginDisabled: '知识库插件已禁用。请设置 KNOWLEDGE_ENABLED=1 并重启服务。',
      save: '保存 Key',
      saved: 'API Key 已保存，插件已激活',
      savedButNotInitialized: 'API Key 已保存，但插件未启动，请查看服务端日志。',
      saveFailed: '保存 API Key 失败',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: '知识库',
    description: '文档知识库，支持 RAG 语义搜索。',
  },
}