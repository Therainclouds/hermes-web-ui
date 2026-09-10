export default {
  knowledge: {
    title: 'قاعدة المعرفة',
    subtitle: 'خزن RAG للبحث في المستندات',
    sidebarLabel: 'المعرفة',
    description: 'فهرسة المستندات المحلية للبحث الدلالي بواسطة Hermes Agent.',
    vaults: {
      title: 'الخزنات', add: 'إضافة خزن', name: 'الاسم', path: 'المسار الجذري',
      status: 'الحالة', watching: 'مراقبة', offline: 'غير متصل',
      documents: 'المستندات', confirmDelete: 'حذف هذه الخزن؟',
      cascadeDelete: 'حذف جميع المستندات المفهرسة أيضاً',
      pathPlaceholder: '/path/to/documents', namePlaceholder: 'مستنداتي',
    },
    documents: {
      title: 'المستندات', status: 'الحالة', path: 'مسار المصدر', size: 'الحجم',
      indexedAt: 'فُهرس في', pending: 'قيد الانتظار', indexing: 'جارٍ الفهرسة',
      indexed: 'مفهرس', failed: 'فشل', all: 'الكل',
      noDocuments: 'لم يتم العثور على مستندات.', error: 'خطأ',
    },
    health: {
      title: 'الصحة', vaults: 'الخزنات', documents: 'المستندات',
      chunks: 'الأجزاء', vectors: 'المتجهات', lastSuccess: 'آخر نجاح',
      lastFailure: 'آخر فشل', noError: 'لا أخطاء',
    },
    actions: { delete: 'حذف', refresh: 'تحديث', cancel: 'إلغاء', confirm: 'تأكيد' },
    errors: { fetchFailed: 'فشل تحميل البيانات', createFailed: 'فشل إنشاء الخزن', deleteFailed: 'فشل حذف الخزن' },
    messages: { vaultCreated: 'تم إنشاء الخزن' },
  },
  pluginsKnowledge: { sidebarLabel: 'المعرفة', description: 'قاعدة معرفة مستندات مع بحث RAG.' },
}
