export default {
  knowledge: {
    title: 'Wissensbasis',
    subtitle: 'RAG-Tresore für die Dokumentensuche',
    sidebarLabel: 'Wissen',
    description: 'Lokale Dokumente für die semantische Suche durch Hermes Agent indizieren.',

    tabs: {
      dashboard: 'Übersicht',
      graph: 'Graph',
      list: 'Bibliothek',
    },

    sidebar: {
      vaults: 'Tresore',
      tags: 'Schlagwörter',
      allVaults: 'Alle Tresore',
      noVaults: 'Keine Tresore',
      noTags: 'Keine Schlagwörter',
    },

    dashboard: {
      statusBreakdown: 'Statusaufschlüsselung',
      recentActivity: 'Letzte Aktivität',
      noRecentActivity: 'Keine letzte Aktivität',
      quickActions: 'Schnellaktionen',
      openGraph: 'Graph öffnen',
      openList: 'Bibliothek öffnen',
    },

    graph: {
      title: 'Wissensgraph',
      empty: 'Keine Daten zur Visualisierung',
      allVaults: 'Alle Tresore',
      legend: {
        vault: 'Tresor',
        document: 'Dokument',
      },
    },

    detail: {
      title: 'Dokumentdetails',
      noDocument: 'Kein Dokument ausgewählt',
      metadata: 'Metadaten',
      content: 'Inhalt',
      path: 'Pfad',
      vault: 'Tresor',
      mime: 'Typ',
      size: 'Größe',
      indexed: 'Indiziert',
      error: 'Fehler',
      noChunks: 'Keine Inhaltsblöcke',
      close: 'Schließen',
    },

    vaults: {
      title: 'Tresore', add: 'Tresor hinzufügen', name: 'Name', path: 'Wurzelpfad',
      status: 'Status', watching: 'Überwacht', offline: 'Offline',
      documents: 'Dokumente', confirmDelete: 'Diesen Tresor löschen?',
      cascadeDelete: 'Auch alle indizierten Dokumente löschen',
      pathPlaceholder: '/pfad/zu/dokumenten', namePlaceholder: 'Meine Dokumente',
    },
    documents: {
      title: 'Dokumente', name: 'Name', status: 'Status', path: 'Quellpfad', size: 'Größe',
      indexedAt: 'Indiziert am', pending: 'Ausstehend', indexing: 'Indizierung',
      indexed: 'Indiziert', failed: 'Fehlgeschlagen', metadata_only: 'Nur Metadaten',
      all: 'Alle', noDocuments: 'Keine Dokumente gefunden.', error: 'Fehler',
    },
    health: {
      title: 'Zustand', vaults: 'Tresore', documents: 'Dokumente',
      chunks: 'Blöcke', vectors: 'Vektoren', lastSuccess: 'Letzter Erfolg',
      lastFailure: 'Letzter Fehlschlag', noError: 'Keine Fehler',
    },
    actions: { delete: 'Löschen', refresh: 'Aktualisieren', cancel: 'Abbrechen', confirm: 'Bestätigen' },
    errors: { fetchFailed: 'Daten konnten nicht geladen werden', createFailed: 'Tresor konnte nicht erstellt werden', deleteFailed: 'Tresor konnte nicht gelöscht werden' },
    messages: { vaultCreated: 'Tresor erstellt' },
    settings: {
      title: 'Einstellungen',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API-Key konfiguriert (endet auf {hint})',
      notConfigured: 'Kein Embedding-API-Key konfiguriert — Dokumente können erst indexiert werden, wenn einer gespeichert ist.',
      pluginDisabled: 'Wissens-Plugin ist deaktiviert. Setzen Sie KNOWLEDGE_ENABLED=1 und starten Sie den Server neu.',
      save: 'Key speichern',
      saved: 'API-Key gespeichert — Plugin ist aktiv',
      savedButNotInitialized: 'API-Key gespeichert, aber das Plugin wurde nicht gestartet. Siehe Server-Logs.',
      saveFailed: 'API-Key konnte nicht gespeichert werden',
    },
  },
  pluginsKnowledge: { sidebarLabel: 'Wissen', description: 'Dokument-Wissensbasis mit RAG-Suche.' },
}