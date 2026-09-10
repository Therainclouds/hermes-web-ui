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

    messages: {
      vaultCreated: 'Vault created',
    },

    settings: {
      title: 'Settings',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API key configured (ending {hint})',
      notConfigured: 'No embedding API key configured — documents cannot be indexed until one is saved.',
      pluginDisabled: 'Knowledge plugin is disabled. Set KNOWLEDGE_ENABLED=1 and restart the server.',
      save: 'Save Key',
      saved: 'API key saved — plugin is now active',
      savedButNotInitialized: 'API key saved, but the plugin did not start. Check server logs.',
      saveFailed: 'Failed to save API key',
    },
  },

  pluginsKnowledge: {
    sidebarLabel: 'Knowledge',
    description: 'Document knowledge base with RAG search.',
  },
}
