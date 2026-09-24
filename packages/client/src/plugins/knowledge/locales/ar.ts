export default {
  knowledge: {
    title: 'قاعدة المعرفة',
    subtitle: 'خزن RAG للبحث في المستندات',
    sidebarLabel: 'المعرفة',
    description: 'فهرسة المستندات المحلية للبحث الدلالي بواسطة Hermes Agent.',

    tabs: {
      dashboard: 'نظرة عامة',
      graph: 'الرسم البياني',
      list: 'المكتبة',
    },

    sidebar: {
      vaults: 'الخزنات',
      tags: 'الوسوم',
      allVaults: 'كل الخزنات',
      noVaults: 'لا توجد خزنات',
      noTags: 'لا توجد وسوم',
    },

    dashboard: {
      statusBreakdown: 'التوزيع حسب الحالة',
      recentActivity: 'النشاط الأخير',
      noRecentActivity: 'لا يوجد نشاط حديث',
      quickActions: 'إجراءات سريعة',
      openGraph: 'فتح الرسم البياني',
      openList: 'فتح المكتبة',
    },

    graph: {
      title: 'رسم المعرفة',
      empty: 'لا توجد بيانات للتصور',
      allVaults: 'كل الخزنات',
      legend: {
        vault: 'خزن',
        document: 'مستند',
      },
    },

    detail: {
      title: 'تفاصيل المستند',
      noDocument: 'لم يتم اختيار مستند',
      metadata: 'البيانات الوصفية',
      content: 'المحتوى',
      path: 'المسار',
      vault: 'الخزن',
      mime: 'النوع',
      size: 'الحجم',
      indexed: 'مفهرس',
      error: 'خطأ',
      noChunks: 'لا توجد أجزاء محتوى',
      close: 'إغلاق',
    },

    vaults: {
      title: 'الخزنات', add: 'إضافة خزن', name: 'الاسم', path: 'المسار الجذري',
      status: 'الحالة', watching: 'مراقبة', offline: 'غير متصل',
      documents: 'المستندات', confirmDelete: 'حذف هذه الخزن؟',
      cascadeDelete: 'حذف جميع المستندات المفهرسة أيضاً',
      pathPlaceholder: '/path/to/documents', namePlaceholder: 'مستنداتي',
    },
    documents: {
      title: 'المستندات', name: 'الاسم', status: 'الحالة', path: 'مسار المصدر', size: 'الحجم',
      indexedAt: 'فُهرس في', pending: 'قيد الانتظار', indexing: 'جارٍ الفهرسة',
      indexed: 'مفهرس', failed: 'فشل', metadata_only: 'البيانات الوصفية فقط',
      all: 'الكل', noDocuments: 'لم يتم العثور على مستندات.', error: 'خطأ',
    },
    health: {
      title: 'الصحة', vaults: 'الخزنات', documents: 'المستندات',
      chunks: 'الأجزاء', vectors: 'المتجهات', lastSuccess: 'آخر نجاح',
      lastFailure: 'آخر فشل', noError: 'لا أخطاء',
    },
    actions: { delete: 'حذف', refresh: 'تحديث', cancel: 'إلغاء', confirm: 'تأكيد' },
    errors: { fetchFailed: 'فشل تحميل البيانات', createFailed: 'فشل إنشاء الخزن', deleteFailed: 'فشل حذف الخزن' },
    messages: { vaultCreated: 'تم إنشاء الخزن' },
    settings: {
      title: 'الإعدادات',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'مفتاح API مُهيأ (ينتهي بـ {hint})',
      notConfigured: 'لا يوجد مفتاح API لل embedding — لا يمكن فهرسة المستندات قبل حفظه.',
      pluginDisabled: 'إضافة المعرفة معطلة. عيّن KNOWLEDGE_ENABLED=1 وأعد تشغيل الخادم.',
      save: 'حفظ المفتاح',
      saved: 'تم حفظ مفتاح API — الإضافة نشطة الآن',
      savedButNotInitialized: 'تم حفظ المفتاح لكن الإضافة لم تبدأ. راجع سجلات الخادم.',
      saveFailed: 'فشل حفظ مفتاح API',
    },
  },
  pluginsKnowledge: { sidebarLabel: 'المعرفة', description: 'قاعدة معرفة مستندات مع بحث RAG.' },
}