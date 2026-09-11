export default {
  knowledge: {
    title: 'База знаний',
    subtitle: 'RAG-хранилища для поиска документов',
    sidebarLabel: 'Знания',
    description: 'Индексируйте локальные документы для семантического поиска через Hermes Agent.',

    tabs: {
      dashboard: 'Обзор',
      graph: 'Граф',
      list: 'Библиотека',
    },

    sidebar: {
      vaults: 'Хранилища',
      tags: 'Метки',
      allVaults: 'Все хранилища',
      noVaults: 'Нет хранилищ',
      noTags: 'Нет меток',
    },

    dashboard: {
      statusBreakdown: 'Разбивка по статусам',
      recentActivity: 'Недавняя активность',
      noRecentActivity: 'Нет недавней активности',
      quickActions: 'Быстрые действия',
      openGraph: 'Открыть граф',
      openList: 'Открыть библиотеку',
    },

    graph: {
      title: 'Граф знаний',
      empty: 'Нет данных для визуализации',
      allVaults: 'Все хранилища',
      legend: {
        vault: 'Хранилище',
        document: 'Документ',
      },
    },

    detail: {
      title: 'Детали документа',
      noDocument: 'Документ не выбран',
      metadata: 'Метаданные',
      content: 'Содержимое',
      path: 'Путь',
      vault: 'Хранилище',
      mime: 'Тип',
      size: 'Размер',
      indexed: 'Проиндексировано',
      error: 'Ошибка',
      noChunks: 'Нет блоков содержимого',
      close: 'Закрыть',
    },

    vaults: {
      title: 'Хранилища', add: 'Добавить хранилище', name: 'Имя', path: 'Корневой путь',
      status: 'Статус', watching: 'Отслеживание', offline: 'Офлайн',
      documents: 'Документы', confirmDelete: 'Удалить это хранилище?',
      cascadeDelete: 'Также удалить все проиндексированные документы',
      pathPlaceholder: '/путь/к/документам', namePlaceholder: 'Мои документы',
    },
    documents: {
      title: 'Документы', name: 'Имя', status: 'Статус', path: 'Путь источника', size: 'Размер',
      indexedAt: 'Индексировано', pending: 'Ожидание', indexing: 'Индексация',
      indexed: 'Готово', failed: 'Ошибка', metadata_only: 'Только метаданные',
      all: 'Все', noDocuments: 'Документы не найдены.', error: 'Ошибка',
    },
    health: {
      title: 'Состояние', vaults: 'Хранилища', documents: 'Документы',
      chunks: 'Блоки', vectors: 'Векторы', lastSuccess: 'Последний успех',
      lastFailure: 'Последний сбой', noError: 'Нет ошибок',
    },
    actions: { delete: 'Удалить', refresh: 'Обновить', cancel: 'Отмена', confirm: 'Подтвердить' },
    errors: { fetchFailed: 'Не удалось загрузить данные', createFailed: 'Не удалось создать хранилище', deleteFailed: 'Не удалось удалить хранилище' },
    messages: { vaultCreated: 'Хранилище создано' },
    settings: {
      title: 'Настройки',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API-ключ настроен (оканчивается на {hint})',
      notConfigured: 'Embedding API-ключ не настроен — индексация документов невозможна.',
      pluginDisabled: 'Плагин знаний отключён. Установите KNOWLEDGE_ENABLED=1 и перезапустите сервер.',
      save: 'Сохранить ключ',
      saved: 'API-ключ сохранён — плагин активен',
      savedButNotInitialized: 'API-ключ сохранён, но плагин не запустился. Проверьте журналы сервера.',
      saveFailed: 'Не удалось сохранить API-ключ',
    },
  },
  pluginsKnowledge: { sidebarLabel: 'Знания', description: 'Документальная база знаний с RAG-поиском.' },
}