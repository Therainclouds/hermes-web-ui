export default {
  knowledge: {
    title: 'Base de conhecimento',
    subtitle: 'Cofres RAG para pesquisa de documentos',
    sidebarLabel: 'Conhecimento',
    description: 'Indexe documentos locais para pesquisa semântica pelo Hermes Agent.',
    vaults: {
      title: 'Cofres', add: 'Adicionar cofre', name: 'Nome', path: 'Caminho raiz',
      status: 'Status', watching: 'Monitorando', offline: 'Offline',
      documents: 'Documentos', confirmDelete: 'Excluir este cofre?',
      cascadeDelete: 'Também excluir todos os documentos indexados',
      pathPlaceholder: '/caminho/para/documentos', namePlaceholder: 'Meus documentos',
    },
    documents: {
      title: 'Documentos', status: 'Status', path: 'Caminho fonte', size: 'Tamanho',
      indexedAt: 'Indexado em', pending: 'Pendente', indexing: 'Indexando',
      indexed: 'Indexado', failed: 'Falhou', all: 'Todos',
      noDocuments: 'Nenhum documento encontrado.', error: 'Erro',
    },
    health: {
      title: 'Saúde', vaults: 'Cofres', documents: 'Documentos',
      chunks: 'Blocos', vectors: 'Vetores', lastSuccess: 'Último sucesso',
      lastFailure: 'Última falha', noError: 'Sem erros',
    },
    actions: { delete: 'Excluir', refresh: 'Atualizar', cancel: 'Cancelar', confirm: 'Confirmar' },
    errors: { fetchFailed: 'Falha ao carregar dados', createFailed: 'Falha ao criar cofre', deleteFailed: 'Falha ao excluir cofre' },
    messages: { vaultCreated: 'Cofre criado' },
  },
  pluginsKnowledge: { sidebarLabel: 'Conhecimento', description: 'Base de conhecimento documental com pesquisa RAG.' },
}
