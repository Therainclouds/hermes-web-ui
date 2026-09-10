export default {
  knowledge: {
    title: 'Base de connaissances',
    subtitle: 'Coffres RAG pour la recherche documentaire',
    sidebarLabel: 'Connaissances',
    description: 'Indexez des documents locaux pour la recherche sémantique par Hermes Agent.',
    vaults: {
      title: 'Coffres', add: 'Ajouter un coffre', name: 'Nom', path: 'Chemin racine',
      status: 'Statut', watching: 'Surveillé', offline: 'Hors ligne',
      documents: 'Documents', confirmDelete: 'Supprimer ce coffre ?',
      cascadeDelete: 'Supprimer aussi tous les documents indexés',
      pathPlaceholder: '/chemin/vers/documents', namePlaceholder: 'Mes documents',
    },
    documents: {
      title: 'Documents', status: 'Statut', path: 'Chemin source', size: 'Taille',
      indexedAt: 'Indexé le', pending: 'En attente', indexing: 'Indexation',
      indexed: 'Indexé', failed: 'Échoué', all: 'Tous',
      noDocuments: 'Aucun document trouvé.', error: 'Erreur',
    },
    health: {
      title: 'Santé', vaults: 'Coffres', documents: 'Documents',
      chunks: 'Blocs', vectors: 'Vecteurs', lastSuccess: 'Dernier succès',
      lastFailure: 'Dernier échec', noError: 'Aucune erreur',
    },
    actions: { delete: 'Supprimer', refresh: 'Actualiser', cancel: 'Annuler', confirm: 'Confirmer' },
    errors: { fetchFailed: 'Échec du chargement des données', createFailed: 'Échec de la création du coffre', deleteFailed: 'Échec de la suppression du coffre' },
    messages: { vaultCreated: 'Coffre créé' },
  },
  pluginsKnowledge: { sidebarLabel: 'Connaissances', description: 'Base de connaissances documentaires avec recherche RAG.' },
}
