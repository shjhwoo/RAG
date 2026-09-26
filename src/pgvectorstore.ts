import pg from "pg";
import { asc, cosineDistance, count, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { EMBEDDING_DIMENSIONS, rawChunks } from "./db/schema.js";

// PostgreSQL + pgvector 벡터 스토어. SimpleVectorStore와 같은 사용법(fromDocuments / similaritySearchWithScore)을 갖는다.
// 유사도는 코사인 유사도(1 - 코사인 거리)로 돌려줘서 SimpleVectorStore의 점수와 그대로 비교할 수 있다.
//
// 이 파일은 스키마(DDL)를 만들지 않는다. 테이블은 src/db/schema.ts 가 정의하고 `npm run db:migrate`가 만든다.

const { Pool } = pg;

const INSERT_BATCH = 100;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("VECTOR_STORE=pgvector 이면 .env에 DATABASE_URL이 필요합니다. (docker compose up -d 로 DB를 먼저 띄우세요)");
  }
  return url;
}

// Drizzle은 드라이버 오류를 DrizzleQueryError로 감싸고 원래 오류를 cause에 둔다
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

const MISSING_TABLE = "42P01"; // undefined_table

const MIGRATE_HINT = "raw_chunks 테이블이 없습니다.\n먼저 `npm run db:migrate`로 마이그레이션을 적용하세요.";

// 임베딩 차원은 스키마(EMBEDDING_DIMENSIONS)에 고정되어 있다
function assertDimensions(actual: number, what: string): void {
  if (actual !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${what} 임베딩 차원(${actual})이 스키마의 차원(${EMBEDDING_DIMENSIONS})과 다릅니다. ` +
        "EMBED_PROVIDER를 바꿨다면 src/db/schema.ts 의 EMBEDDING_DIMENSIONS를 바꾸고 " +
        "`npm run db:generate` → `npm run db:migrate`로 스키마를 옮긴 뒤 다시 색인하세요. " +
        "(pgvector 스토어는 ingest와 query가 같은 EMBED_PROVIDER여야 합니다)",
    );
  }
}

export class PgVectorStore {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly embeddings: EmbeddingsInterface,
  ) {}

  // 문서들을 임베딩해서 테이블을 새로 채운다. TRUNCATE + INSERT를 한 트랜잭션으로 묶어 재실행해도 청크가 중복되지 않는다
  // (테이블 자체는 마이그레이션이 만든 것을 그대로 쓰고, 지우거나 다시 만들지 않는다)
  static async fromDocuments(
    docs: Document[],
    embeddings: EmbeddingsInterface,
    url: string = databaseUrl(),
  ): Promise<PgVectorStore> {
    if (docs.length === 0) throw new Error("문서가 없어 벡터 스토어를 만들 수 없습니다.");

    const vectors = await embeddings.embedDocuments(docs.map((d) => d.pageContent));
    if (vectors.length !== docs.length) {
      throw new Error(`임베딩 개수(${vectors.length})가 문서 개수(${docs.length})와 다릅니다.`);
    }
    vectors.forEach((vector, i) => {
      assertDimensions(vector.length, `${i}번째 문서의`);
      if (vector.some((x) => !Number.isFinite(x))) throw new Error(`${i}번째 임베딩에 NaN/Infinity 값이 있습니다.`);
    });

    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`TRUNCATE TABLE ${rawChunks} RESTART IDENTITY`);
        for (let start = 0; start < docs.length; start += INSERT_BATCH) {
          await tx.insert(rawChunks).values(
            docs.slice(start, start + INSERT_BATCH).map((doc, i) => ({
              content: doc.pageContent,
              metadata: doc.metadata, // 객체 그대로 넘긴다 (JSON.stringify하면 jsonb에 문자열로 들어가 metadata->'loc'가 깨진다)
              embedding: vectors[start + i] ?? [],
            })),
          );
        }
      });
    } catch (err) {
      await pool.end();
      if (pgErrorCode(err) === MISSING_TABLE) throw new Error(MIGRATE_HINT);
      throw err;
    }
    return new PgVectorStore(pool, db, embeddings);
  }

  // 이미 채워진 테이블에 연결한다. embeddings는 "질문"을 임베딩할 때 쓰므로 ingest 때와 같은 모델이어야 한다
  static async connect(
    embeddings: EmbeddingsInterface,
    url: string = databaseUrl(),
  ): Promise<PgVectorStore> {
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);
    try {
      const [row] = await db.select({ n: count() }).from(rawChunks);
      if ((row?.n ?? 0) === 0) {
        throw new Error("raw_chunks 테이블이 비어 있습니다.\n먼저 ingest(또는 npm run embed)를 실행하세요.");
      }
    } catch (err) {
      await pool.end();
      if (pgErrorCode(err) === MISSING_TABLE) throw new Error(MIGRATE_HINT);
      throw err;
    }
    return new PgVectorStore(pool, db, embeddings);
  }

  // 질문과 가장 비슷한 청크 k개를 (문서, 유사도) 쌍으로 돌려준다. 유사도는 클수록 비슷하다 (최대 1)
  async similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>> {
    const queryVector = await this.embeddings.embedQuery(query);
    assertDimensions(queryVector.length, "질문의");

    // <=> 는 코사인 "거리"(0이 가장 가까움)이므로 1에서 빼서 유사도로 바꾼다.
    // 정렬은 거리로 한다 (HNSW 인덱스가 거리 순서를 쓴다)
    const distance = cosineDistance(rawChunks.embedding, queryVector);
    const rows = await this.db
      .select({ content: rawChunks.content, metadata: rawChunks.metadata, score: sql<number>`1 - (${distance})` })
      .from(rawChunks)
      .orderBy(asc(distance))
      .limit(Math.max(0, k));

    return rows.map((r): [Document, number] => [
      new Document({ pageContent: r.content, metadata: r.metadata }),
      Number(r.score),
    ]);
  }

  async similaritySearch(query: string, k: number): Promise<Document[]> {
    return (await this.similaritySearchWithScore(query, k)).map(([doc]) => doc);
  }

  // 연결을 닫지 않으면 스크립트가 끝나지 않고 매달린다
  async close(): Promise<void> {
    await this.pool.end();
  }
}
