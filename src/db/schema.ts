import { bigserial, index, jsonb, pgTable, text, vector } from "drizzle-orm/pg-core";

// pgvector 테이블의 스키마. 이 파일이 스키마의 유일한 원본이다.
// 바꾸려면 여기를 고치고 `npm run db:generate`로 마이그레이션을 만든 뒤 `npm run db:migrate`로 적용한다.
// (drizzle-kit이 이 파일을 직접 읽으므로 상대 경로 import를 넣지 않는다)

// 벡터 차원은 임베딩 모델이 정한다 (ollama bge-m3: 1024, openai text-embedding-3-small: 1536).
// 스키마에 고정되므로 EMBED_PROVIDER를 바꾸려면 이 값을 바꾸고 마이그레이션을 새로 만들어야 한다.
export const EMBEDDING_DIMENSIONS = 1024;

export const rawChunks = pgTable(
  "raw_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(), // source, sourceType, loc.lines
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (t) => [
    // 행이 수십 개인 지금은 플래너가 쓰지 않고 전수 스캔한다. 규모가 커졌을 때를 위한 인덱스다
    index("raw_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
