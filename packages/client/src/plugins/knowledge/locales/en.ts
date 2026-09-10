export default {
  knowledge: {
    title: 'Knowledge Base',
    subtitle: 'RAG vaults for document search',
    sidebarLabel: 'Knowledge',
    description: 'Index local documents for semantic search by the Hermes Agent.',

    vaults: {
      title: 'Vaults',
      add: 'Add Vault',
      name: 'Name',
      path: 'Root Path',
      status: 'Status',
      watching: 'Watching',
      offline: 'Offline',
      documents: 'Documents',
      confirmDelete: 'Delete this vault?',
      cascadeDelete: 'Also delete all indexed documents',
      pathPlaceholder: '/path/to/documents',
      namePlaceholder: 'My Documents',
    },

    documents: {
      title: 'Documents',
      status: 'Status',
      path: 'Source Path',
      size: 'Size',
      indexedAt: 'Indexed',
      pending: 'Pending',
      indexing: 'Indexing',
      indexed: 'Indexed',
      failed: 'Failed',
      all: 'All',
      noDocuments: 'No documents found.',
      error: 'Error',
    },

    health: {
      title: 'Health',
      vaults: 'Vaults',
      documents: 'Documents',
      chunks: 'Chunks',
      vectors: 'Vectors',
      lastSuccess: 'Last Success',
      lastFailure: 'Last Failure',
      noError: 'No errors',
    },

    actions: {
      delete: 'Delete',
      refresh: 'Refresh',
      cancel: 'Cancel',
      confirm: 'Confirm',
    },

    errors: {
      fetchFailed: 'Failed to load knowledge data',
      createFailed: 'Failed to create vault',
      deleteFailed: 'Failed to delete vault',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: 'Knowledge',
    description: 'Document knowledge base with RAG search.',
  },
}
