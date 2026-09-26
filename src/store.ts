import path from "path";
import type { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { PgVectorStore } from "./pgvectorstore.js";
import { SimpleVectorStore } from "./vectorstore.js";

// 벡터 스토어 구현을 .env의 VECTOR_STORE로 고른다.
//   VECTOR_STORE = json(기본) | pgvector
// 두 구현은 검색 결과(문서, 코사인 유사도)가 같아야 한다. 다르면 둘 중 하나에 버그가 있는 것이다.
// ingest와 query는 같은 VECTOR_STORE로 실행해야 한다 (json은 파일, pgvector는 DB에 저장한다).

const JSON_STORE_DIR = path.join(process.cwd(), "storage/vector_store");

export type VectorStoreKind = "json" | "pgvector";

export interface RetrievalStore {
  similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>>;
  close(): Promise<void>; // pgvector는 DB 연결을 닫아야 프로세스가 끝난다
}

export function vectorStoreKind(): VectorStoreKind {
  const value = process.env.VECTOR_STORE ?? "json";
  if (value === "json" || value === "pgvector") return value;
  throw new Error(`알 수 없는 VECTOR_STORE: '${value}' (json | pgvector 중 하나여야 합니다)`);
}

// 청크를 임베딩해서 저장한다 (매번 새로 만든다)
export async function buildStore(
  docs: Document[],
  embeddings: EmbeddingsInterface,
  kind: VectorStoreKind = vectorStoreKind(),
): Promise<RetrievalStore> {
  if (kind === "pgvector") return PgVectorStore.fromDocuments(docs, embeddings);
  const store = await SimpleVectorStore.fromDocuments(docs, embeddings);
  await store.save(JSON_STORE_DIR);
  return { similaritySearchWithScore: (q, k) => store.similaritySearchWithScore(q, k), close: async () => {} };
}

// 저장된 스토어를 연다
export async function openStore(
  embeddings: EmbeddingsInterface,
  kind: VectorStoreKind = vectorStoreKind(),
): Promise<RetrievalStore> {
  if (kind === "pgvector") return PgVectorStore.connect(embeddings);
  const store = await SimpleVectorStore.load(JSON_STORE_DIR, embeddings);
  return { similaritySearchWithScore: (q, k) => store.similaritySearchWithScore(q, k), close: async () => {} };
}

export function storeLocation(kind: VectorStoreKind = vectorStoreKind()): string {
  return kind === "pgvector" ? "PostgreSQL(pgvector) raw_chunks 테이블" : JSON_STORE_DIR;
}
