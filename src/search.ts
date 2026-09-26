import dotenv from "dotenv";
import { citation } from "./context.js";
import { createEmbeddings } from "./models.js";
import { openStore, vectorStoreKind } from "./store.js";

dotenv.config();

// 검색만 한다 (채팅 모델을 부르지 않으므로 GOOGLE_API_KEY가 필요 없다).
// 질문과 비슷한 청크가 실제로 나오는지 눈으로 확인하는 용도다.
// 사용법: npm run search -- "질문" [k]

const SNIPPET_CHARS = 110;

async function runSearch(query: string, k: number) {
  const store = await openStore(createEmbeddings());
  try {
    const hits = await store.similaritySearchWithScore(query, k);
    console.log(`[${vectorStoreKind()}] 질문: ${query}\n`);
    hits.forEach(([doc, score], i) => {
      const snippet = doc.pageContent.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
      console.log(`${i + 1}. ${score.toFixed(3)}  ${citation(doc.metadata)}\n   ${snippet}…`);
    });
  } finally {
    await store.close();
  }
}

const query = process.argv[2];
if (!query) {
  console.error('사용법: npm run search -- "질문" [k]');
  process.exit(1);
}
const k = Number(process.argv[3] ?? 5);
runSearch(query, Number.isInteger(k) && k > 0 ? k : 5).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
