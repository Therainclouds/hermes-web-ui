export default {
  knowledge: {
    title: '지식 베이스',
    subtitle: '문서 검색을 위한 RAG 볼트',
    sidebarLabel: '지식',
    description: 'Hermes Agent의 시맨틱 검색을 위해 로컬 문서를 인덱싱합니다.',

    tabs: {
      dashboard: '개요',
      graph: '그래프',
      list: '라이브러리',
    },

    sidebar: {
      vaults: '볼트',
      tags: '태그',
      allVaults: '모든 볼트',
      noVaults: '볼트가 없습니다',
      noTags: '태그가 없습니다',
    },

    dashboard: {
      statusBreakdown: '상태 분류',
      recentActivity: '최근 활동',
      noRecentActivity: '최근 활동이 없습니다',
      quickActions: '빠른 작업',
      openGraph: '그래프 열기',
      openList: '라이브러리 열기',
    },

    graph: {
      title: '지식 그래프',
      empty: '시각화할 데이터가 없습니다',
      allVaults: '모든 볼트',
      legend: {
        vault: '볼트',
        document: '문서',
      },
    },

    detail: {
      title: '문서 상세',
      noDocument: '선택된 문서가 없습니다',
      metadata: '메타데이터',
      content: '내용',
      path: '경로',
      vault: '볼트',
      mime: '유형',
      size: '크기',
      indexed: '인덱싱됨',
      error: '오류',
      noChunks: '콘텐츠 청크가 없습니다',
      close: '닫기',
    },

    vaults: {
      title: '볼트', add: '볼트 추가', name: '이름', path: '루트 경로',
      status: '상태', watching: '감시 중', offline: '오프라인',
      documents: '문서', confirmDelete: '이 볼트를 삭제하시겠습니까?',
      cascadeDelete: '인덱싱된 문서도 함께 삭제',
      pathPlaceholder: '/path/to/documents', namePlaceholder: '내 문서',
    },
    documents: {
      title: '문서', name: '이름', status: '상태', path: '소스 경로', size: '크기',
      indexedAt: '인덱싱 일시', pending: '대기 중', indexing: '인덱싱 중',
      indexed: '완료', failed: '실패', metadata_only: '메타데이터만',
      all: '전체', noDocuments: '문서가 없습니다.', error: '오류',
    },
    health: {
      title: '상태', vaults: '볼트', documents: '문서',
      chunks: '청크', vectors: '벡터', lastSuccess: '마지막 성공',
      lastFailure: '마지막 실패', noError: '오류 없음',
    },
    actions: { delete: '삭제', refresh: '새로고침', cancel: '취소', confirm: '확인' },
    errors: { fetchFailed: '데이터를 불러오지 못했습니다', createFailed: '볼트를 생성하지 못했습니다', deleteFailed: '볼트를 삭제하지 못했습니다' },
    messages: { vaultCreated: '볼트가 생성되었습니다' },
    settings: {
      title: '설정',
      apiKeyPlaceholder: 'sk-...',
      keyConfigured: 'API 키 구성됨 (끝자리 {hint})',
      notConfigured: 'Embedding API 키가 구성되지 않았습니다. 저장하기 전까지 문서를 인덱싱할 수 없습니다.',
      pluginDisabled: '지식 플러그인이 비활성화되어 있습니다. KNOWLEDGE_ENABLED=1로 설정하고 서버를 재시작하세요.',
      save: '키 저장',
      saved: 'API 키가 저장되었습니다 — 플러그인이 활성화되었습니다',
      savedButNotInitialized: 'API 키가 저장되었지만 플러그인이 시작되지 않았습니다. 서버 로그를 확인하세요.',
      saveFailed: 'API 키 저장에 실패했습니다',
    },
  },
  pluginsKnowledge: { sidebarLabel: '지식', description: 'RAG 검색이 포함된 문서 지식 베이스.' },
}