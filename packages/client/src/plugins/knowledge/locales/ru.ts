export default {
  knowledge: {
    title: 'База знаний',
    subtitle: 'RAG-хранилища для поиска документов',
    sidebarLabel: 'Знания',
    description: 'Индексируйте локальные документы для семантического поиска через Hermes Agent.',
    vaults: {
      title: 'Хранилища', add: 'Добавить хранилище', name: 'Имя', path: 'Корневой путь',
      status: 'Статус', watching: 'Отслеживание', offline: 'Офлайн',
      documents: 'Документы', confirmDelete: 'Удалить это хранилище?',
      cascadeDelete: 'Также удалить все проиндексированные документы',
      pathPlaceholder: '/путь/к/документам', namePlaceholder: 'Мои документы',
    },
    documents: {
      title: 'Документы', status: 'Статус', path: 'Путь источника', size: 'Размер',
      indexedAt: 'Индексировано', pending: 'Ожидание', indexing: 'Индексация',
      indexed: 'Готово', failed: 'Ошибка', all: 'Все',
      noDocuments: 'Документы не найдены.', error: 'Ошибка',
    },
    health: {
      title: 'Состояние', vaults: 'Хранилища', documents: 'Документы',
      chunks: 'Блоки', vectors: 'Векторы', lastSuccess: 'Последний успех',
      lastFailure: 'Последний сбой', noError: 'Нет ошибок',
    },
    actions: { delete: 'Удалить', refresh: 'Обновить', cancel: 'Отмена', confirm: 'Подтвердить' },
    errors: { fetchFailed: 'Не удалось загрузить данные', createFailed: 'Не удалось создать хранилище', deleteFailed: 'Не удалось удалить хранилище' },
    messages: { vaultCreated: 'Хранилище создано' },
  },
  pluginsKnowledge: { sidebarLabel: 'Знания', description: 'Документальная база знаний с RAG-поиском.' },
}
