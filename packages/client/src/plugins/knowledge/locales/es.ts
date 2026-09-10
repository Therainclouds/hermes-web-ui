export default {
  knowledge: {
    title: 'Base de conocimientos',
    subtitle: 'Bóvedas RAG para búsqueda de documentos',
    sidebarLabel: 'Conocimientos',
    description: 'Indexa documentos locales para búsqueda semántica con Hermes Agent.',
    vaults: {
      title: 'Bóvedas', add: 'Añadir bóveda', name: 'Nombre', path: 'Ruta raíz',
      status: 'Estado', watching: 'Vigilando', offline: 'Sin conexión',
      documents: 'Documentos', confirmDelete: '¿Eliminar esta bóveda?',
      cascadeDelete: 'Eliminar también todos los documentos indexados',
      pathPlaceholder: '/ruta/a/documentos', namePlaceholder: 'Mis documentos',
    },
    documents: {
      title: 'Documentos', status: 'Estado', path: 'Ruta fuente', size: 'Tamaño',
      indexedAt: 'Indexado', pending: 'Pendiente', indexing: 'Indexando',
      indexed: 'Indexado', failed: 'Fallido', all: 'Todos',
      noDocuments: 'No se encontraron documentos.', error: 'Error',
    },
    health: {
      title: 'Salud', vaults: 'Bóvedas', documents: 'Documentos',
      chunks: 'Fragmentos', vectors: 'Vectores', lastSuccess: 'Último éxito',
      lastFailure: 'Último fallo', noError: 'Sin errores',
    },
    actions: { delete: 'Eliminar', refresh: 'Actualizar', cancel: 'Cancelar', confirm: 'Confirmar' },
    errors: { fetchFailed: 'Error al cargar datos', createFailed: 'Error al crear bóveda', deleteFailed: 'Error al eliminar bóveda' },
    messages: { vaultCreated: 'Bóveda creada' },
  },
  pluginsKnowledge: { sidebarLabel: 'Conocimientos', description: 'Base de conocimientos documental con búsqueda RAG.' },
}
