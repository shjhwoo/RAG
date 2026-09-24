# mnemosyne

## 아키텍처

```mermaid
flowchart TD
    %% 사용자 및 인터페이스
    User([사용자 / Client])

    %% API Layer (Backend Orchestrator)
    subgraph API_Layer ["API Layer (LangChain.js / Node.js)"]
        IngestAPI["Ingestion API"]
        QueryAPI["Query / Router API"]
        LintAPI["Periodic Lint Worker"]
    end

    %% Storage & Index Layer
    subgraph Storage_Layer ["Data & Storage Layer"]
        subgraph Raw_Storage ["Raw Data (Immutable)"]
            RawDir["storage/raw/
            (Local Files / S3)"]
        end

        subgraph Vector_DB ["Vector Database"]
            VectorStore["HNSWLib / pgvector
            (Vector Embeddings)"]
            BM25Index["BM25 Keyword Index"]
        end

        subgraph LLM_Wiki ["LLM Wiki (Knowledge Base)"]
            WikiDir["storage/wiki/
            (GitHub Repository / .md)"]
        end
    end

    %% External LLM Provider
    subgraph LLM_Engine ["LLM Provider"]
        LLM["OpenAI / Claude / Local LLM"]
    end

    %% 1. Ingestion Flow (데이터 수집 및 위키 생성)
    User -- "1. Raw 데이터 제공\n(텍스트, 파일, 링크 등)" --> IngestAPI
    IngestAPI -- "원본 저장 (읽기전용 유지)" --> RawDir
    IngestAPI -- "문서 정제/요약 요청" --> LLM
    LLM -- "마크다운 문서 생성" --> WikiDir
    IngestAPI -- "청크 분할 & 임베딩" --> VectorStore
    IngestAPI -- "키워드 인덱싱" --> BM25Index

    %% 2. Query & RAG Flow (질문 및 하이브리드 검색)
    User -- "2. 지식베이스 질문" --> QueryAPI
    QueryAPI -- "질문 의도 파악 / 라우팅" --> LLM
    QueryAPI -- "BM25 키워드 검색" --> BM25Index
    QueryAPI -- "벡터 유사도 검색" --> VectorStore
    QueryAPI -- "정리된 지식(Context) 참조" --> WikiDir
    QueryAPI -- "검색 결과 + Prompt 전달" --> LLM
    LLM -- "최종 답변 생성" --> QueryAPI
    QueryAPI -- "3. 답변 반환" --> User

    %% 3. Periodic Lint Flow (스스로 정기 점검)
    LintAPI -- "4. 위키/인덱스 정기 점검" --> WikiDir
    LintAPI -- "중복/오류 검증 요청" --> LLM
    LLM -- "정리/리포트 작성" --> WikiDir

    %% Styling
    style User fill:#f9f,stroke:#333,stroke-width:2px
    style RawDir fill:#ffe6cc,stroke:#d79b00,stroke-width:1px
    style WikiDir fill:#d5e8d4,stroke:#82b366,stroke-width:2px
    style VectorStore fill:#dae8fc,stroke:#6c8ebf,stroke-width:1px
    style LLM fill:#e1d5e7,stroke:#9673a6,stroke-width:2px

```

## 디렉토리 구조

```
mnemosyne/
├── storage/                    # 데이터 저장소 (로컬 또는 추후 S3/Git으로 오프로드)
│   ├── raw/                    # [Immutable] 사용자가 업로드한 수정을 금지하는 원본 데이터 (텍스트, 파일 등)
│   ├── wiki/                   # [LLM Wiki] LLM이 원본을 정제/요약하여 생성한 마크다운(.md) 지식 문서들
│   └── vector_store/           # [Vector DB] 마크다운 청크들을 임베딩(Vector)하여 저장한 로컬 파일 DB
├── src/                        # [API Layer] 전체 시스템의 데이터 흐름과 오케스트레이션을 담당하는 백엔드 로직
│   ├── ingest.ts               # [Ingest API] Raw 데이터를 받아 LLM Wiki 문서를 생성하고 Vector DB에 저장하는 비즈니스 로직
│   └── query.ts                # [Query/RAG API] 사용자 질문을 받아 Vector DB/Wiki를 검색하고 LLM 응답을 조율하는 라우팅 로직
├── .env                        # [Config] OPENAI_API_KEY 등 보안이 필요한 환경변수 설정 파일
├── package.json                # [Dependencies] 프로젝트 메타데이터 및 의존성 라이브러리 관리 파일
└── tsconfig.json               # [TS Config] TypeScript 컴파일러 옵션 및 빌드 동작 설정 파일
```

## 요구사항 명세서

### 최소 요구사항

- 사용자는 지식베이스와 관련된 여러가지 raw 데이터 - 이미지 동영상 링크, 그 외 파일, 텍스트 등을 제공한다.
- 이런 데이터들을 받아서 llm wiki(github 저장소) 및 RAG 기반의 벡터 데이터베이스에 저장을 한다 (각각 ingest, embed 작업을 진행한다)
- 나중에 사용자가 해당 지식베이스에 대해서 질문을 하면 API 레이어에서 wiki,
  RAG(BM25 키워드 검색 + 벡터 기반 검색) 을 수행하여 결과를 제공한다.
- 사용자가 제공한 raw 데이터는 절대 불변 상태를 유지해야 한다.
- 스스로 정기적으로 lint하고 보고할수 있다면 더더욱 좋을거 같다.

#### 최소 요구사항을 위해 필요한 인프라와 기술 스택

##### 인프라

- 별도의 또다른 깃허브 저장소: llm wiki 구축을 위해 필요
- s3: 사용자가 제공하는 raw 데이터를 저장하는 곳
  (일단 초반에는 지금 로컬 개발 환경의 파일시스템에서 테스트해보는 걸로.
  S3는 접근을 어떻게 해야할지, 그리고 프리티어 얼마나 사용할수있는지 알아봐야 한다)
- postgreSQL: 벡터 DB 역할을 해준다? 아직 잘 모르겠음
- llm: 어떤 모델을 사용할 건지 정해야 함. llm은 주어진 요구사항에 따라서 ingest 하거나 lint를 할 수 있어야 한다.
- API layer: 사용자의 질문을 받아서 처리를 해줘야 한다 -> llm에게 전달해줘야 한다.

##### 기술 스택

- langchain.js: LLM 에이전트를 다루기 위한 프레임워크

### 지금은 없어도 되지만 있으면 더 좋은 요구사항

- 응답에 대해서 사용자가 피드백을 주고 교정할 수 있다 -> 더 개선하기

#### 디렉토리 구조
