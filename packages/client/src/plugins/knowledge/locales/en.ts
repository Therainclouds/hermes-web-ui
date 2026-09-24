export default {
  knowledge: {
    title: 'Knowledge Base',
    subtitle: 'RAG vaults for document search',
    sidebarLabel: 'Knowledge',
    description: 'Index local documents for semantic search by the Hermes Agent.',

    tabs: {
      dashboard: 'Overview',
      graph: 'Graph',
      list: 'Library',
    },

    sidebar: {
      vaults: 'Vaults',
      tags: 'Tags',
      allVaults: 'All vaults',
      noVaults: 'No vaults yet',
      noTags: 'No tags',
    },

    dashboard: {
      statusBreakdown: 'Status Breakdown',
      recentActivity: 'Recent Activity',
      noRecentActivity: 'No recent activity',
      quickActions: 'Quick Actions',
      openGraph: 'Open Graph',
      openList: 'Open Library',
    },

    graph: {
      title: 'Knowledge Graph',
      empty: 'No data to visualize',
      allVaults: 'All vaults',
      legend: {
        vault: 'Vault',
        document: 'Document',
      },
    },

    detail: {
      title: 'Document Detail',
      noDocument: 'No document selected',
      metadata: 'Metadata',
      content: 'Content',
      path: 'Path',
      vault: 'Vault',
      mime: 'Type',
      size: 'Size',
      indexed: 'Indexed',
      error: 'Error',
      noChunks: 'No content chunks',
      close: 'Close',
      index: 'Full-text index',
      indexQueued: 'Added to the index queue — searchable once complete',
      indexFailed: 'Failed to queue indexing',
      metadataOnlyHint: 'Metadata only — not searchable yet. Run full-text indexing to make it retrievable.',
    },

    modes: {
      tasks: { label: 'Tasks', desc: 'Watch index status, task citations and progress' },
      legal: { label: 'Legal', desc: 'Archive contracts and case files, audit citation compliance' },
      learning: { label: 'Learning', desc: 'Connect knowledge with backlinks, reinforce review' },
      explorer: { label: 'Explorer', desc: 'Graph, vector index and all advanced settings' },
      batch: { label: 'Batch', desc: 'Bulk-import files and clean up repetitive work' },
    },

    onboarding: {
      title: 'Choose how you work',
      subtitle: 'The knowledge base adapts its interface to your main use. Switch anytime from the top bar — no data is lost.',
      skip: 'Set up later',
    },

    statusBar: {
      ready: 'Ready',
      needsKey: 'API key not configured',
      disabled: 'Plugin disabled',
      documents: '{n} documents',
      indexed: '{n} indexed',
      queue: 'queue {n}',
      failed: '{n} failed',
      settings: 'Settings',
      switchMode: 'Switch mode',
    },

    tasks: {
      heroTitle: 'Index progress',
      progress: { done: 'Done', todo: 'Todo', running: 'Running', errored: 'Errored' },
      filesTitle: 'Archived files',
      goExplorer: 'Add a vault',
      columns: { references: 'Citations', lastCited: 'Last cited' },
      references: {
        title: 'Citation log',
        empty: 'No search citations yet',
        loadFailed: 'Failed to load citation log',
        sourceChat: 'UI search',
        sourceAgent: 'Agent tool',
        never: 'Never cited',
      },
    },

    modePlaceholder: {
      comingSoon: 'This mode arrives in the next round',
    },

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
      name: 'Name',
      status: 'Status',
      path: 'Source Path',
      size: 'Size',
      indexedAt: 'Indexed',
      pending: 'Pending',
      indexing: 'Indexing',
      indexed: 'Indexed',
      failed: 'Failed',
      metadata_only: 'Metadata only',
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
      deleteFailed: 'Failed to delete item',
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