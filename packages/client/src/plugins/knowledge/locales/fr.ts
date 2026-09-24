export default {
  knowledge: {
    title: 'Base de connaissances',
    subtitle: 'Coffres RAG pour la recherche documentaire',
    sidebarLabel: 'Connaissances',
    description: 'Indexez des documents locaux pour la recherche sémantique par Hermes Agent.',

    tabs: {
      dashboard: 'Vue d’ensemble',
      graph: 'Graphe',
      list: 'Bibliothèque',
    },

    sidebar: {
      vaults: 'Coffres',
      tags: 'Étiquettes',
      allVaults: 'Tous les coffres',
      noVaults: 'Aucun coffre',
      noTags: 'Aucune étiquette',
    },

    dashboard: {
      statusBreakdown: 'Répartition par statut',
      recentActivity: 'Activité récente',
      noRecentActivity: 'Aucune activité récente',
      quickActions: 'Actions rapides',
      openGraph: 'Ouvrir le graphe',
      openList: 'Ouvrir la bibliothèque',
    },

    graph: {
      title: 'Graphe de connaissances',
      empty: 'Aucune donnée à visualiser',
      allVaults: 'Tous les coffres',
      legend: {
        vault: 'Coffre',
        document: 'Document',
      },
    },

    detail: {
      title: 'Détail du document',
      noDocument: 'Aucun document sélectionné',
      metadata: 'Métadonnées',
      content: 'Contenu',
      path: 'Chemin',
      vault: 'Coffre',
      mime: 'Type',
      size: 'Taille',
      indexed: 'Indexé',
      error: 'Erreur',
      noChunks: 'Aucun bloc de contenu',
      close: 'Fermer',
    },

    vaults: {
      title: 'Coffres', add: 'Ajouter un coffre', name: 'Nom', path: 'Chemin racine',
      status: 'Statut', watching: 'Surveillé', offline: 'Hors ligne',
      documents: 'Documents', confirmDelete: 'Supprimer ce coffre ?',
      cascadeDelete: 'Supprimer aussi tous les documents indexés',
      pathPlaceholder: '/chemin/vers/documents', namePlaceholder: 'Mes documents',
    },
    documents: {
      title: 'Documents', name: 'Nom', status: 'Statut', path: 'Chemin source', size: 'Taille',
      indexedAt: 'Indexé le', pending: 'En attente', indexing: 'Indexation',
      indexed: 'Indexé', failed: 'Échoué', metadata_only: 'Métadonnées uniquement',
      all: 'Tous', noDocuments: 'Aucun document trouvé.', error: 'Erreur',
    },
    health: {
      title: 'Santé', vaults: 'Coffres', documents: 'Documents',
      chunks: 'Blocs', vectors: 'Vecteurs', lastSuccess: 'Dernier succès',
      lastFailure: 'Dernier échec', noError: 'Aucune erreur',
    },
    actions: { delete: 'Supprimer', refresh: 'Actualiser', cancel: 'Annuler', confirm: 'Confirmer' },
    errors: { fetchFailed: 'Échec du chargement des données', createFailed: 'Échec de la création du coffre', deleteFailed: 'Échec de la suppression du coffre' },
    messages: { vaultCreated: 'Coffre créé' },
    settings: {
      title: 'Paramètres',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'Clé API configurée (finit par {hint})',
      notConfigured: "Aucune clé API d'embedding configurée — les documents ne peuvent pas être indexés.",
      pluginDisabled: 'Le plugin de connaissances est désactivé. Définissez KNOWLEDGE_ENABLED=1 et redémarrez le serveur.',
      save: 'Enregistrer la clé',
      saved: 'Clé API enregistrée — plugin actif',
      savedButNotInitialized: 'Clé API enregistrée, mais le plugin n’a pas démarré. Consultez les logs du serveur.',
      saveFailed: "Échec de l'enregistrement de la clé API",
    },
  },
  pluginsKnowledge: { sidebarLabel: 'Connaissances', description: 'Base de connaissances documentaires avec recherche RAG.' },
}