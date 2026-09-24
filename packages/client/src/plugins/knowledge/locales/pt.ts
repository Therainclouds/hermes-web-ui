export default {
  knowledge: {
    title: 'Base de conhecimento',
    subtitle: 'Cofres RAG para pesquisa de documentos',
    sidebarLabel: 'Conhecimento',
    description: 'Indexe documentos locais para pesquisa semântica pelo Hermes Agent.',

    tabs: {
      dashboard: 'Visão geral',
      graph: 'Grafo',
      list: 'Biblioteca',
    },

    sidebar: {
      vaults: 'Cofres',
      tags: 'Etiquetas',
      allVaults: 'Todos os cofres',
      noVaults: 'Sem cofres',
      noTags: 'Sem etiquetas',
    },

    dashboard: {
      statusBreakdown: 'Detalhamento por status',
      recentActivity: 'Atividade recente',
      noRecentActivity: 'Sem atividade recente',
      quickActions: 'Ações rápidas',
      openGraph: 'Abrir grafo',
      openList: 'Abrir biblioteca',
    },

    graph: {
      title: 'Grafo de conhecimento',
      empty: 'Sem dados para visualizar',
      allVaults: 'Todos os cofres',
      legend: {
        vault: 'Cofre',
        document: 'Documento',
      },
    },

    detail: {
      title: 'Detalhe do documento',
      noDocument: 'Nenhum documento selecionado',
      metadata: 'Metadados',
      content: 'Conteúdo',
      path: 'Caminho',
      vault: 'Cofre',
      mime: 'Tipo',
      size: 'Tamanho',
      indexed: 'Indexado',
      error: 'Erro',
      noChunks: 'Sem blocos de conteúdo',
      close: 'Fechar',
    },

    vaults: {
      title: 'Cofres', add: 'Adicionar cofre', name: 'Nome', path: 'Caminho raiz',
      status: 'Status', watching: 'Monitorando', offline: 'Offline',
      documents: 'Documentos', confirmDelete: 'Excluir este cofre?',
      cascadeDelete: 'Também excluir todos os documentos indexados',
      pathPlaceholder: '/caminho/para/documentos', namePlaceholder: 'Meus documentos',
    },
    documents: {
      title: 'Documentos', name: 'Nome', status: 'Status', path: 'Caminho fonte', size: 'Tamanho',
      indexedAt: 'Indexado em', pending: 'Pendente', indexing: 'Indexando',
      indexed: 'Indexado', failed: 'Falhou', metadata_only: 'Apenas metadados',
      all: 'Todos', noDocuments: 'Nenhum documento encontrado.', error: 'Erro',
    },
    health: {
      title: 'Saúde', vaults: 'Cofres', documents: 'Documentos',
      chunks: 'Blocos', vectors: 'Vetores', lastSuccess: 'Último sucesso',
      lastFailure: 'Última falha', noError: 'Sem erros',
    },
    actions: { delete: 'Excluir', refresh: 'Atualizar', cancel: 'Cancelar', confirm: 'Confirmar' },
    errors: { fetchFailed: 'Falha ao carregar dados', createFailed: 'Falha ao criar cofre', deleteFailed: 'Falha ao excluir cofre' },
    messages: { vaultCreated: 'Cofre criado' },
    settings: {
      title: 'Configurações',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'Chave de API configurada (termina em {hint})',
      notConfigured: 'Nenhuma chave de API de embedding configurada — não é possível indexar documentos.',
      pluginDisabled: 'O plugin de conhecimento está desativado. Defina KNOWLEDGE_ENABLED=1 e reinicie o servidor.',
      save: 'Salvar chave',
      saved: 'Chave de API salva — plugin ativo',
      savedButNotInitialized: 'Chave de API salva, mas o plugin não iniciou. Verifique os logs do servidor.',
      saveFailed: 'Falha ao salvar a chave de API',
    },
  },
  pluginsKnowledge: { sidebarLabel: 'Conhecimento', description: 'Base de conhecimento documental com pesquisa RAG.' },
}