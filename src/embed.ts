import path from "path";
import dotenv from "dotenv";
import { createEmbeddings } from "./models.js";
import { chunkRawFiles, readRawFiles } from "./raw.js";
import { buildStore, storeLocation, vectorStoreKind } from "./store.js";

dotenv.config();

// raw → 청킹 → 임베딩 → 벡터 스토어까지만 한다. ingest와 달리 채팅 모델(위키 갱신)을 부르지 않는다.
// 검색 실험을 할 때 위키를 건드리지 않고 인덱스만 다시 만들기 위한 스크립트다.
// 사용법: npm run embed   (VECTOR_STORE=json | pgvector)

async function runEmbed() {
  const rawFiles = await readRawFiles(path.join(process.cwd(), "storage/raw"));
  if (rawFiles.length === 0) {
    console.log("storage/raw/에 처리할 텍스트 파일(.txt, .md)이 없습니다.");
    return;
  }
  const docs = await chunkRawFiles(rawFiles);
  const store = await buildStore(docs, createEmbeddings());
  await store.close();
  console.log(`[${vectorStoreKind()}] raw ${rawFiles.length}개 → 청크 ${docs.length}개 인덱싱 완료: ${storeLocation()}`);
}

runEmbed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
