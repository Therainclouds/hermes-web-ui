export default {
  knowledge: {
    title: '지식 베이스',
    subtitle: '문서 검색을 위한 RAG 볼트',
    sidebarLabel: '지식',
    description: 'Hermes Agent의 시맨틱 검색을 위해 로컬 문서를 인덱싱합니다.',
    vaults: {
      title: '볼트', add: '볼트 추가', name: '이름', path: '루트 경로',
      status: '상태', watching: '감시 중', offline: '오프라인',
      documents: '문서', confirmDelete: '이 볼트를 삭제하시겠습니까?',
      cascadeDelete: '인덱싱된 문서도 함께 삭제',
      pathPlaceholder: '/path/to/documents', namePlaceholder: '내 문서',
    },
    documents: {
      title: '문서', status: '상태', path: '소스 경로', size: '크기',
      indexedAt: '인덱싱 일시', pending: '대기 중', indexing: '인덱싱 중',
      indexed: '완료', failed: '실패', all: '전체',
      noDocuments: '문서가 없습니다.', error: '오류',
    },
    health: {
      title: '상태', vaults: '볼트', documents: '문서',
      chunks: '청크', vectors: '벡터', lastSuccess: '마지막 성공',
      lastFailure: '마지막 실패', noError: '오류 없음',
    },
    actions: { delete: '삭제', refresh: '새로고침', cancel: '취소', confirm: '확인' },
    errors: { fetchFailed: '데이터를 불러오지 못했습니다', createFailed: '볼트를 생성하지 못했습니다', deleteFailed: '볼트를 삭제하지 못했습니다' },
    messages: { vaultCreated: '볼트가 생성되었습니다' },
  },
  pluginsKnowledge: { sidebarLabel: '지식', description: 'RAG 검색이 포함된 문서 지식 베이스.' },
}
