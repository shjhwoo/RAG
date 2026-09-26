# mnemosyne

raw 데이터를 넣으면 LLM이 **위키**로 정리해 쌓고, 질문이 오면 위키(해석)와 **원문 근거**(RAG 검색)를 함께 보고 답하는 지식베이스.

- **raw** = 증거. 절대 수정하지 않는다.
- **wiki** = 해석. LLM이 raw를 읽고 마크다운 문서로 정리하며 누적한다.
- **RAG** = 원문 근거를 찾는 검색 층. 위키가 아니라 **raw 원문**을 인덱싱해서, 답변의 근거를 `파일:줄`로 추적할 수 있다.

> 설계 참고: [LLM Wiki와 RAG는 경쟁이 아니라 보완 관계다 (tilnote)](https://tilnote.io/pages/6a0be2683bfab6e3928bd3a3)

## 실행 방법

### 준비

```bash
npm install
ollama pull bge-m3        # 임베딩 모델 (로컬, 무료)
```

프로젝트 루트에 `.env`를 만든다.

```
GOOGLE_API_KEY=...        # 채팅 모델(Gemini)용. https://aistudio.google.com 에서 발급
```

> Gemini 무료 티어는 입력 데이터가 Google 제품 개선에 사용될 수 있다. 민감한 자료는 넣지 않는다.

### 사용

```bash
# 1. storage/raw/ 에 .txt 또는 .md 파일을 넣는다
npm run ingest                   # raw → 벡터 인덱스 + 위키 갱신
npm run query -- "질문"          # 위키 + 원문 근거로 답변 (질문을 생략하면 기본 질문)
npm run typecheck                # 타입 검사
```

`ingest`는 이미 위키에 반영된 raw 파일은 건너뛴다. 벡터 인덱스는 매번 raw 전체로 새로 만든다.

### pgvector (PostgreSQL) 벡터 스토어

기본 벡터 스토어는 `storage/vector_store/store.json`이다. PostgreSQL + pgvector를 쓰려면:

`.env`에 다음을 추가한다.

```
VECTOR_STORE=pgvector
DATABASE_URL=postgresql://mnemosyne:mnemosyne@localhost:5432/mnemosyne
```

```bash
docker compose up -d --wait                # 1. pgvector/pgvector:pg17 컨테이너 (localhost:5432, 로컬 전용 계정)
npm run db:migrate                         # 2. 마이그레이션 적용 (pgvector 확장 + raw_chunks 테이블). 처음 한 번, 스키마가 바뀔 때마다
npm run embed                              # 3. raw → 청킹 → 임베딩 → 벡터 스토어까지만 (위키/채팅 모델 호출 없음)
npm run search -- "llm wiki" 5             # 검색만 실행해 상위 청크와 점수를 본다 (GOOGLE_API_KEY 불필요)
npm run eval                               # 정답을 미리 정해 둔 질문들로 검색 품질 평가
npm run eval -- --parity                   # json과 pgvector의 순위·점수가 같은지 비교 (두 스토어 모두 embed 필요)
```

`ingest`와 `query`도 `VECTOR_STORE`를 따른다. 스토어를 바꿀 때는 `ingest`(또는 `embed`)를 그 스토어로 다시 실행한다. `docker compose down`은 데이터를 남기고, `docker compose down -v`는 데이터까지 지운다.

스키마는 [Drizzle](https://orm.drizzle.team)로 관리한다. 원본은 `src/db/schema.ts`이고, 스키마를 바꾸는 순서는 이렇다.

```bash
# src/db/schema.ts 수정 후
npm run db:generate                        # drizzle/ 아래에 마이그레이션 SQL 생성 (생성된 SQL을 읽어 확인한다)
npm run db:migrate                         # DB에 적용. 적용 이력은 DB의 drizzle.__drizzle_migrations 테이블에 남는다
```

- `drizzle/0000_enable_pgvector.sql`은 `CREATE EXTENSION`을 직접 쓴 마이그레이션이다. drizzle-kit은 확장 활성화를 만들어 주지 않는다.
- `embed`/`ingest`는 테이블을 `TRUNCATE`하고 다시 채울 뿐 스키마는 건드리지 않는다. 테이블이 없으면 `db:migrate`를 먼저 실행하라고 안내한다.
- **벡터 차원(`EMBEDDING_DIMENSIONS`, 기본 1024)이 스키마에 고정된다.** pgvector에서 `EMBED_PROVIDER=openai`(1536)를 쓰려면 `schema.ts`의 값을 바꾸고 `db:generate` → `db:migrate` 해야 한다. 기존 벡터가 있는 컬럼의 차원은 변환되지 않으므로, 이 마이그레이션은 `TRUNCATE` 후 `embed`를 다시 실행하는 것과 함께 해야 한다. (JSON 스토어는 차원을 스스로 읽는다)

### 모델 설정 (`.env`)

채팅 모델과 임베딩 모델의 제공자를 따로 고른다 (`src/models.ts`).

| 변수 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `CHAT_PROVIDER` | `gemini` \| `openai` \| `ollama` | `gemini` | 위키 작성, 질의응답에 쓰는 채팅 모델 |
| `EMBED_PROVIDER` | `ollama` \| `openai` | `ollama` | 임베딩 모델 (`bge-m3` / `text-embedding-3-small`) |
| `GEMINI_CHAT_MODEL` | 모델 이름 | `gemini-3.5-flash-lite` | Gemini 모델 이름은 자주 바뀌므로 덮어쓸 수 있다 |
| `VECTOR_STORE` | `json` \| `pgvector` | `json` | 벡터 저장소. `pgvector`는 `DATABASE_URL`이 필요하다 |

- `openai`를 쓰려면 `OPENAI_API_KEY`가 필요하다. `ollama` 채팅은 `qwen3:8b`를 쓰며 메모리를 6GB 이상 쓰고 CPU에서는 느리다.
- **`EMBED_PROVIDER`를 바꾸면 벡터 차원이 달라진다.** `npm run ingest`를 다시 실행해 인덱스를 새로 만들어야 하고, `ingest`와 `query`는 같은 값으로 실행해야 한다. (채팅 모델은 언제 바꿔도 된다) `VECTOR_STORE=pgvector`에서는 스키마의 차원도 함께 바꿔야 한다 (아래 pgvector 절 참고).

## 아키텍처

점선은 아직 구현하지 않은 부분이다.

```mermaid
flowchart TD
    User([사용자])

    subgraph App ["Node.js / TypeScript (LangChain.js)"]
        Ingest["ingest.ts<br/>raw 읽기 · 청킹 · 위키 갱신"]
        Query["query.ts<br/>위키 + 원문 근거로 답변"]
        Router["질문 유형 라우팅 (예정)"]
        Lint["정기 Lint Worker (예정)"]
    end

    subgraph Storage ["storage/"]
        Raw["raw/<br/>원본 (불변, 읽기 전용)"]
        Vec["vector_store/store.json<br/>raw 청크 + 벡터 + 출처"]
        Wiki["wiki/*.md, index.md<br/>LLM이 누적한 해석"]
        BM25["BM25 키워드 인덱스 (예정)"]
    end

    Chat["채팅 모델<br/>Gemini / OpenAI / Ollama"]
    Emb["임베딩 모델<br/>Ollama bge-m3 / OpenAI"]

    %% Ingest
    User -- "raw 파일 추가" --> Raw
    Raw --> Ingest
    Ingest -- "청크 임베딩" --> Emb
    Ingest -- "청크 + 벡터 + 출처 저장" --> Vec
    Ingest -- "위키 갱신 요청<br/>(대상 결정 → 본문 작성)" --> Chat
    Ingest -- "문서 · 역링크 · 색인 저장" --> Wiki

    %% Query
    User -- "질문" --> Query
    Query -- "질문 임베딩" --> Emb
    Query -- "유사한 청크 4개 검색" --> Vec
    Query -- "위키 문서 읽기" --> Wiki
    Query -- "위키 + 원문 근거 + 질문" --> Chat
    Query -- "답변 + 참고한 맥락" --> User

    %% 예정
    Query -.-> Router
    Query -.-> BM25
    Lint -.-> Wiki

    classDef planned fill:#f5f5f5,stroke:#999,stroke-dasharray:5 5,color:#666
    class Router,Lint,BM25 planned

    style User fill:#f9f,stroke:#333,stroke-width:2px
    style Raw fill:#ffe6cc,stroke:#d79b00,stroke-width:1px
    style Wiki fill:#d5e8d4,stroke:#82b366,stroke-width:2px
    style Vec fill:#dae8fc,stroke:#6c8ebf,stroke-width:1px
```

## 동작 방식

### Ingest (`npm run ingest`)

1. `storage/raw/`의 `.txt`, `.md`를 읽는다. (읽기만 한다. 수정하지 않는다)
2. **RAG 인덱싱:** raw 원문을 500자(겹침 50) 청크로 나누고, 청크마다 출처(`source`, `sourceType: "raw"`, 줄 위치)를 붙여 임베딩해 `store.json`에 저장한다.
3. **위키 갱신:** 위키에 아직 반영되지 않은 raw만 하나씩 처리한다.
   1. 위키 전체의 이름·요약·목차만 보고 어느 문서에 넣을지 결정한다 (기존 문서 갱신 / 새 문서). 본문 전체를 보여 주지 않으므로 문서가 많아져도 프롬프트가 커지지 않는다.
   2. 대상 문서 하나의 전체 내용 + raw로 본문을 작성한다.
   3. **frontmatter(`summary`, `sources`, `updated`, `review_status`), 양방향 `[[링크]]`의 역링크, `index.md`는 LLM이 아니라 코드가 만든다.** LLM이 빼먹거나 실제 파일과 어긋날 수 있기 때문이다.

### Query (`npm run query`)

1. 위키 문서를 맥락에 넣는다. 지금은 문서가 적어 전부 넣고, 12,000자를 넘으면 경고를 내고 나머지를 제외한다.
2. 질문과 비슷한 raw 청크 상위 4개를 검색한다.
3. 위키(해석)와 원문 근거를 구분해서 LLM에 전달한다. 규칙: 둘이 다르면 원문을 따르고, 주장마다 출처를 표시하고, 없는 내용은 모른다고 답한다.
4. 답변 뒤에 **실제로 맥락에 넣은** 위키 문서와 원문 청크(`파일:줄`, 유사도)를 코드가 직접 출력한다.

### 벡터 스토어를 직접 구현한 이유

`src/vectorstore.ts`는 코사인 유사도를 전수 비교로 계산하는 순수 TypeScript 구현이다. 처음에는 `hnswlib-node`를 썼지만, 이 환경(Windows)에서 직접 빌드한 네이티브 모듈이 초기화 전 `getCurrentCount()`에서 간헐적으로 쓰레기 값을 돌려줘서 인덱스 생성이 실패했다. 청크가 수십~수백 개인 규모에서는 전수 비교로 충분하다.

`src/pgvectorstore.ts`는 같은 인터페이스의 PostgreSQL + pgvector 구현이다 (`VECTOR_STORE=pgvector`). 코사인 거리 연산자 `<=>`의 결과를 `1 - 거리`로 바꿔 JSON 스토어와 같은 유사도로 돌려주며, `npm run eval -- --parity`로 두 구현의 순위와 점수가 같은지 확인할 수 있다. 테이블 스키마는 코드가 아니라 Drizzle 마이그레이션이 만든다(위 참고). 색인할 때마다 테이블을 `TRUNCATE`하고 다시 채운다. HNSW 인덱스를 만들어 두지만 행이 수십 개인 지금은 플래너가 쓰지 않고 전수 스캔한다.

## 디렉토리 구조

```
mnemosyne/
├── storage/                    # 데이터 저장소 (로컬. 추후 S3/Git으로 오프로드)
│   ├── raw/                    # [Immutable] 사용자가 제공한 원본 (.txt, .md)
│   ├── wiki/                   # [LLM Wiki] 생성된 위키 문서(.md)와 index.md   (git 무시)
│   └── vector_store/           # [RAG] raw 청크 + 벡터를 저장한 store.json   (git 무시)
├── src/
│   ├── ingest.ts               # Ingest: raw 읽기 → RAG 인덱싱 → 위키 갱신
│   ├── query.ts                # Query: 위키 + 원문 근거로 답변, 참고한 맥락 출력
│   ├── wiki.ts                 # 위키 파일 다루기: 읽기/저장, frontmatter, 역링크, index.md
│   ├── raw.ts                  # raw 읽기(읽기 전용)와 청킹 + 출처 메타데이터
│   ├── vectorstore.ts          # 순수 TS 벡터 스토어 (코사인 유사도, JSON 저장)
│   ├── pgvectorstore.ts        # PostgreSQL + pgvector 벡터 스토어 (Drizzle 쿼리. 스키마는 만들지 않는다)
│   ├── db/schema.ts            # raw_chunks 테이블 스키마 (Drizzle). 스키마의 유일한 원본
│   ├── store.ts                # VECTOR_STORE에 따라 위 두 스토어 중 하나를 고른다
│   ├── embed.ts                # 색인만 (위키/채팅 모델 호출 없음)
│   ├── search.ts               # 검색만 (상위 청크와 점수 출력)
│   ├── eval.ts                 # 검색 품질 평가, json/pgvector 결과 비교
│   ├── context.ts              # 질의 맥락과 프롬프트 만들기 (순수 함수)
│   └── models.ts               # 채팅/임베딩 모델 제공자 선택 (Gemini / OpenAI / Ollama)
├── drizzle/                    # DB 마이그레이션 SQL (커밋 대상)
├── drizzle.config.ts           # drizzle-kit 설정
├── docker-compose.yml          # 로컬 PostgreSQL + pgvector
├── .env                        # [Config] GOOGLE_API_KEY, VECTOR_STORE, DATABASE_URL 등 (git 무시)
├── package.json
└── tsconfig.json
```

`storage/wiki/`와 `storage/vector_store/`는 `ingest`가 만드는 생성물이라 커밋하지 않는다.

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

## 구현 현황

- [x] raw 텍스트 파일(.txt, .md) 읽기. raw는 수정하지 않는다
- [x] 위키 누적: 기존 문서 갱신 / 새 문서, frontmatter, 양방향 링크, `index.md`
- [x] raw 원문 기준 RAG 인덱싱 (출처 메타데이터 포함, 코사인 유사도 검색)
- [x] 위키 + 원문 근거로 답변, 참고한 맥락 출력
- [x] 채팅/임베딩 제공자 선택 (Gemini, OpenAI, Ollama)
- [x] PostgreSQL + pgvector 벡터 스토어 (`VECTOR_STORE=pgvector`), 검색 품질 평가 스크립트
- [ ] BM25 키워드 검색 + 하이브리드 검색
- [ ] 질문 유형별 라우팅 (개념 질문은 위키, 근거 확인은 RAG, 전략 질문은 둘 다)
- [ ] 위키 문서가 많을 때 관련 문서만 고르는 단계
- [ ] 정기 lint (죽은 링크, 중복, 모순 탐지와 보고)
- [ ] 이미지, 동영상, 링크 등 텍스트가 아닌 raw
- [ ] S3 raw 저장소, 위키를 별도 GitHub 저장소로 관리
- [ ] 증분 인덱싱 (지금은 매번 raw 전체를 다시 임베딩)
- [ ] 응답 피드백과 교정

## 알려진 한계

- **답변 본문의 출처 인용은 프롬프트로 유도할 뿐 코드로 검증하지 않아, 틀릴 수 있다.** 모델이 조각 안의 더 좁은 줄 번호를 지어내거나, 검색된 적 없는 `파일:줄`을 인용하는 것을 관찰했다. 신뢰할 수 있는 근거는 답변 뒤에 코드가 출력하는 "참고한 맥락"이다. (답변의 출처가 검색된 청크 목록에 있는지 검사하는 기능은 아직 없다)
- "핵심 주제가 뭐야?" 같은 포괄적인 질문은 원문 검색 점수가 낮고 답이 사실상 위키에 의존한다.
- 위키 문서의 `review_status`는 갱신할 때마다 `unreviewed`로 돌아간다. 사람이 검토하는 절차는 아직 없다.

## 샘플 데이터

`storage/raw/`의 파일은 동작 확인용이다. `sample2.txt`는 외부 글([tilnote](https://tilnote.io/pages/6a0be2683bfab6e3928bd3a3))을 옮긴 것으로, 테스트 목적으로만 포함되어 있다.
