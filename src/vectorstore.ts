import fs from "fs/promises";
import path from "path";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";

// 순수 TypeScript 벡터 스토어. 코사인 유사도를 전수 비교로 계산한다.
// (hnswlib-node는 이 환경에서 직접 빌드하면 간헐적으로 쓰레기 값을 돌려줘서 뺐다.
//  청크가 수십~수백 개인 규모에서는 전수 비교로 충분하다.
//  규모가 커지면 pgvector 등 전용 저장소로 옮긴다)

const STORE_FILE = "store.json";
const STORE_VERSION = 1;

interface Entry {
  pageContent: string;
  metadata: Record<string, unknown>;
  vector: number[]; // 정규화된 벡터. 길이가 1이면 코사인 유사도 = 내적이 된다
}

interface StoreFile {
  version: number;
  numDimensions: number;
  entries: Entry[];
}

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const x of vector) {
    if (!Number.isFinite(x)) throw new Error("임베딩에 NaN/Infinity 값이 있습니다.");
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error("영벡터는 코사인 유사도를 계산할 수 없습니다.");
  return vector.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export class SimpleVectorStore {
  private constructor(
    private readonly entries: Entry[],
    private readonly numDimensions: number,
    private readonly embeddings: EmbeddingsInterface,
  ) {}

  // 문서들을 임베딩해서 새 스토어를 만든다
  static async fromDocuments(
    docs: Document[],
    embeddings: EmbeddingsInterface,
  ): Promise<SimpleVectorStore> {
    if (docs.length === 0) throw new Error("문서가 없어 벡터 스토어를 만들 수 없습니다.");

    const vectors = await embeddings.embedDocuments(docs.map((d) => d.pageContent));
    if (vectors.length !== docs.length) {
      throw new Error(`임베딩 개수(${vectors.length})가 문서 개수(${docs.length})와 다릅니다.`);
    }

    const numDimensions = vectors[0]?.length ?? 0;
    if (numDimensions === 0) throw new Error("임베딩 결과가 비어 있습니다.");

    const entries = docs.map((doc, i) => {
      const vector = vectors[i] ?? [];
      if (vector.length !== numDimensions) {
        throw new Error(`${i}번째 임베딩 차원(${vector.length})이 ${numDimensions}과 다릅니다.`);
      }
      return { pageContent: doc.pageContent, metadata: doc.metadata, vector: normalize(vector) };
    });
    return new SimpleVectorStore(entries, numDimensions, embeddings);
  }

  // 질문과 가장 비슷한 청크 k개를 (문서, 유사도) 쌍으로 돌려준다. 유사도는 클수록 비슷하다 (최대 1)
  async similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>> {
    const queryVector = await this.embeddings.embedQuery(query);
    if (queryVector.length !== this.numDimensions) {
      throw new Error(
        `질문 임베딩 차원(${queryVector.length})이 저장된 인덱스(${this.numDimensions})와 다릅니다. ` +
          "ingest와 query의 EMBED_PROVIDER가 같은지 확인하고, 바꿨다면 ingest를 다시 실행하세요.",
      );
    }
    const normalized = normalize(queryVector);

    return this.entries
      .map((entry) => ({ entry, score: dot(normalized, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k))
      .map(({ entry, score }): [Document, number] => [
        new Document({ pageContent: entry.pageContent, metadata: entry.metadata }),
        score,
      ]);
  }

  async similaritySearch(query: string, k: number): Promise<Document[]> {
    return (await this.similaritySearchWithScore(query, k)).map(([doc]) => doc);
  }

  // 임시 파일에 쓴 뒤 이름을 바꾼다. 쓰는 도중 프로세스가 죽어도 기존 파일이 깨지지 않는다
  async save(directory: string): Promise<void> {
    const data: StoreFile = {
      version: STORE_VERSION,
      numDimensions: this.numDimensions,
      entries: this.entries,
    };
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, STORE_FILE);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data), "utf-8");
    await fs.rename(temp, target);
  }

  // 저장된 스토어를 읽는다. embeddings는 "질문"을 임베딩할 때 쓰므로 ingest 때와 같은 모델이어야 한다
  static async load(directory: string, embeddings: EmbeddingsInterface): Promise<SimpleVectorStore> {
    const file = path.join(directory, STORE_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`벡터 스토어가 없습니다: ${file}\n먼저 ingest를 실행하세요.`);
      }
      throw err;
    }

    const data = JSON.parse(raw) as Partial<StoreFile>;
    if (data.version !== STORE_VERSION || typeof data.numDimensions !== "number" || !Array.isArray(data.entries)) {
      throw new Error(`벡터 스토어 형식이 올바르지 않습니다: ${file}\ningest를 다시 실행하세요.`);
    }
    if (data.entries.some((e) => e.vector.length !== data.numDimensions)) {
      throw new Error(`벡터 스토어가 손상되었습니다(벡터 차원 불일치): ${file}\ningest를 다시 실행하세요.`);
    }
    return new SimpleVectorStore(data.entries, data.numDimensions, embeddings);
  }
}
