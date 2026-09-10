export default {
  knowledge: {
    title: 'Wissensbasis',
    subtitle: 'RAG-Tresore für die Dokumentensuche',
    sidebarLabel: 'Wissen',
    description: 'Lokale Dokumente für die semantische Suche durch Hermes Agent indizieren.',
    vaults: {
      title: 'Tresore', add: 'Tresor hinzufügen', name: 'Name', path: 'Wurzelpfad',
      status: 'Status', watching: 'Überwacht', offline: 'Offline',
      documents: 'Dokumente', confirmDelete: 'Diesen Tresor löschen?',
      cascadeDelete: 'Auch alle indizierten Dokumente löschen',
      pathPlaceholder: '/pfad/zu/dokumenten', namePlaceholder: 'Meine Dokumente',
    },
    documents: {
      title: 'Dokumente', status: 'Status', path: 'Quellpfad', size: 'Größe',
      indexedAt: 'Indiziert am', pending: 'Ausstehend', indexing: 'Indizierung',
      indexed: 'Indiziert', failed: 'Fehlgeschlagen', all: 'Alle',
      noDocuments: 'Keine Dokumente gefunden.', error: 'Fehler',
    },
    health: {
      title: 'Zustand', vaults: 'Tresore', documents: 'Dokumente',
      chunks: 'Blöcke', vectors: 'Vektoren', lastSuccess: 'Letzter Erfolg',
      lastFailure: 'Letzter Fehlschlag', noError: 'Keine Fehler',
    },
    actions: { delete: 'Löschen', refresh: 'Aktualisieren', cancel: 'Abbrechen', confirm: 'Bestätigen' },
    errors: { fetchFailed: 'Daten konnten nicht geladen werden', createFailed: 'Tresor konnte nicht erstellt werden', deleteFailed: 'Tresor konnte nicht gelöscht werden' },
    messages: { vaultCreated: 'Tresor erstellt' },
  },
  pluginsKnowledge: { sidebarLabel: 'Wissen', description: 'Dokument-Wissensbasis mit RAG-Suche.' },
}
