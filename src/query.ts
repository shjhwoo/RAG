import path from "path";
import dotenv from "dotenv";
import { buildPrompt, citation, renderEvidence, renderWikiContext } from "./context.js";
import { createChatModel, createEmbeddings } from "./models.js";
import { openStore } from "./store.js";
import { listPages } from "./wiki.js";

dotenv.config();

const RAG_TOP_K = 4; // 요약형 질문은 청크가 2개만으로는 부족했다
const WIKI_CHAR_BUDGET = 12000; // 위키 문서가 이보다 많아지면 관련 문서만 고르는 단계가 필요하다

async function runQuery(question: string) {
  const wikiDir = path.join(process.cwd(), "storage/wiki");

  // 1. 위키: 정리된 해석. 지금은 문서 수가 적으므로 전부 맥락에 넣는다
  const wiki = renderWikiContext(await listPages(wikiDir), WIKI_CHAR_BUDGET);
  if (wiki.omitted.length > 0) {
    console.warn(
      `위키 문서가 많아 다음 문서는 맥락에서 제외했습니다: ${wiki.omitted.join(", ")}\n` +
        "→ 이제 질문과 관련된 문서만 고르는 단계가 필요합니다.",
    );
  }

  // 2. RAG: 원문 근거. 인덱싱(ingest)할 때와 같은 임베딩 모델이어야 한다
  const vectorStore = await openStore(createEmbeddings());
  let hits;
  try {
    hits = await vectorStore.similaritySearchWithScore(question, RAG_TOP_K);
  } finally {
    await vectorStore.close();
  }

  // 3. 위키(해석)와 원문(근거)을 구분해서 LLM에 전달
  const llm = createChatModel();
  const response = await llm.invoke(
    buildPrompt(question, wiki.text, renderEvidence(hits)),
  );

  console.log("\n================ [ 질문 ] ================");
  console.log(question);
  console.log("\n================ [ 답변 ] ================");
  console.log(response.text);

  // 실제로 맥락에 넣은 것은 LLM의 말이 아니라 코드가 직접 출력한다
  console.log("\n================ [ 참고한 맥락 ] ================");
  console.log(`위키 문서: ${wiki.used.length ? wiki.used.join(", ") : "없음"}`);
  console.log("원문 근거:");
  for (const [doc, score] of hits) {
    console.log(`  - ${citation(doc.metadata)} (유사도 ${score.toFixed(3)})`);
  }
}

// 사용법: npx tsx src/query.ts "질문"   (질문을 생략하면 기본 질문을 쓴다)
const question = process.argv[2] ?? "LLM Wiki와 RAG를 어떻게 함께 쓰나?";
runQuery(question).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
