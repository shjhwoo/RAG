import dotenv from "dotenv";
import { createEmbeddings } from "./models.js";
import { openStore, vectorStoreKind, type RetrievalStore, type VectorStoreKind } from "./store.js";

dotenv.config();

// 검색 실험: "질문에 관련된 원문이 정말로 검색 결과에 나오는가?"를 확인한다. 채팅 모델은 쓰지 않는다.
//
// 정답(관련 줄 범위)은 샘플 원문을 직접 읽고 검색 결과를 보기 전에 정했다. 청크가 이 범위와 한 줄이라도 겹치면 관련 청크로 센다.
//   sample.txt  9-10 : 한 줄 요약 (RAG=lazy, LLM Wiki=eager)
//   sample.txt 21-25 : RAG의 한계 (쓰레기 산)
//   sample.txt 26-33 : LLM Wiki의 핵심 구조
//   sample.txt 34-36 : LLM Wiki가 쓰레기산이 되지 않으려면
//   sample.txt 37-44 : Obsidian + Git + RAG + 사람 승인 구성표
//   sample2.txt 11-13: 요약 (경쟁이 아니라 보완)
//   sample2.txt 17-23: 둘은 경쟁자가 아니다 (RAG=찾는 기술, Wiki=쌓는 기술)
//   sample2.txt 63   : BM25 / 벡터 / 하이브리드 검색 설명
//   그 밖의 문서(postgres-tuning.md 등)는 각각 한 주제만 다루므로, 그 주제를 묻는 질문에는 문서 전체가 정답이다.
//   위키백과 편집 안내(단어 "위키"), 게임 벡터 수학(단어 "벡터"), Git 브랜치(샘플에도 Git이 나옴)는 겉으로만 비슷한 함정 문서다.
//
// onTopic: 그 질문에 답이 있어야 하는 문서 목록. 상위 K개 중 이 목록 밖의 문서가 끼면 "무관한 문서가 섞였다"고 센다.
//
// 사용법:
//   npm run eval                 현재 VECTOR_STORE의 검색 결과를 평가한다
//   npm run eval -- --parity     json과 pgvector의 검색 결과(순위, 점수)가 같은지 비교한다
//                                (두 스토어 모두 npm run embed로 먼저 채워 둬야 한다)

const K = 4; // query.ts의 RAG_TOP_K와 같다

type Range = [source: string, from: number, to: number];

interface Case {
  label: string;
  query: string;
  relevant: Range[]; // 비어 있으면 관련 원문이 없어야 하는 대조군
  onTopic?: string[]; // 답이 있어야 하는 문서. 대조군에는 없다
}

const WIKI_DOCS = ["sample.txt", "sample2.txt"];
const WIKI_DEFINITION: Range[] = [
  ["sample.txt", 9, 10],
  ["sample.txt", 26, 33],
  ["sample2.txt", 11, 13],
  ["sample2.txt", 17, 23],
];
const whole = (source: string): Range[] => [[source, 1, Number.MAX_SAFE_INTEGER]];

const CASES: Case[] = [
  { label: "LLM Wiki: 정의(한글)", query: "LLM Wiki가 뭐야?", relevant: WIKI_DEFINITION, onTopic: WIKI_DOCS },
  { label: "LLM Wiki: 정의(짧은 영문 소문자)", query: "llm wiki", relevant: WIKI_DEFINITION, onTopic: WIKI_DOCS },
  { label: "LLM Wiki: 정의(한글 표기)", query: "LLM 위키", relevant: WIKI_DEFINITION, onTopic: WIKI_DOCS },
  {
    label: "LLM Wiki: 바꿔 말하기(키워드 없음)",
    query: "질문이 오기 전에 미리 지식을 정리해 두는 방식",
    relevant: WIKI_DEFINITION,
    onTopic: WIKI_DOCS,
  },
  {
    label: "LLM Wiki: 구체적 주제",
    query: "위키가 쓰레기 산이 되지 않게 하려면?",
    relevant: [["sample.txt", 21, 25], ["sample.txt", 34, 36]],
    onTopic: WIKI_DOCS,
  },
  {
    label: "LLM Wiki: 구체적 주제(Git 함정 문서 있음)",
    query: "Obsidian과 Git으로 팀 지식을 동기화하는 방법",
    relevant: [["sample.txt", 37, 44]],
    onTopic: WIKI_DOCS,
  },
  {
    label: "LLM Wiki: 구체적 주제(영문 용어)",
    query: "keyword search vs semantic search, hybrid",
    relevant: [["sample2.txt", 63, 63]],
    onTopic: WIKI_DOCS,
  },
  {
    label: "다른 문서: 위키백과(함정: '위키')",
    query: "위키백과에서 문서를 편집할 때 지켜야 할 규칙",
    relevant: whole("wikipedia-editing.txt"),
    onTopic: ["wikipedia-editing.txt"],
  },
  {
    label: "다른 문서: 게임 벡터(함정: '벡터')",
    query: "게임에서 캐릭터가 대각선으로 움직일 때 속도가 빨라지는 문제",
    relevant: whole("game-vectors.md"),
    onTopic: ["game-vectors.md"],
  },
  {
    label: "다른 문서: Git 브랜치(함정: 'Git')",
    query: "Git에서 리베이스와 머지의 차이",
    relevant: whole("git-branching.md"),
    onTopic: ["git-branching.md"],
  },
  {
    label: "다른 문서: PostgreSQL 튜닝",
    query: "PostgreSQL 쿼리 실행 계획 튜닝",
    relevant: whole("postgres-tuning.md"),
    onTopic: ["postgres-tuning.md"],
  },
  {
    label: "다른 문서: 사워도우",
    query: "사워도우 스타터는 어떻게 만들어?",
    relevant: whole("sourdough.txt"),
    onTopic: ["sourdough.txt"],
  },
  {
    label: "다른 문서: 마라톤",
    query: "마라톤 대회 전에 탄수화물을 어떻게 보충하나",
    relevant: whole("marathon.md"),
    onTopic: ["marathon.md"],
  },
  { label: "대조군(전혀 무관)", query: "김치찌개 맛있게 끓이는 법", relevant: [] },
  { label: "대조군(기술 주제인데 원문에 없음)", query: "Redis 캐시 만료 정책과 메모리 관리", relevant: [] },
  { label: "대조군(위키/RAG 말투인데 원문에 없음)", query: "RAG 답변의 환각을 평가하는 지표", relevant: [] },
];

function overlaps(source: string, from: number, to: number, r: Range): boolean {
  return source === r[0] && from <= r[2] && to >= r[1];
}

function hitInfo(hit: [import("@langchain/core/documents").Document, number]) {
  const [doc, score] = hit;
  const lines = (doc.metadata.loc as { lines?: { from?: number; to?: number } } | undefined)?.lines;
  return {
    source: String(doc.metadata.source ?? "?"),
    from: lines?.from ?? -1,
    to: lines?.to ?? -1,
    score,
  };
}

async function evaluate(store: RetrievalStore) {
  // 청크 단위 점수 비교용. good = 정답 청크, bad = 확실히 틀린 청크(대조군의 모든 결과 + 답이 있어야 할 문서 밖의 결과)
  // (정답 문서 안에서 정답 범위 밖인 청크는 판단이 갈릴 수 있어 bad에 넣지 않는다)
  const goodScores: number[] = [];
  const badScores: number[] = [];
  let wikiOffTopic = 0;
  let wikiSlots = 0;
  const otherFirstRanks: number[] = [];

  for (const c of CASES) {
    const hits = (await store.similaritySearchWithScore(c.query, K)).map(hitInfo);
    const flags = hits.map((h) => c.relevant.some((r) => overlaps(h.source, h.from, h.to, r)));
    const firstRank = flags.indexOf(true) + 1; // 0이면 상위 K개에 관련 청크가 없다
    const precision = flags.filter(Boolean).length / K;
    const offTopic = c.onTopic ? hits.filter((h) => !c.onTopic?.includes(h.source)).length : 0;

    console.log(`\n■ ${c.label}: "${c.query}"`);
    hits.forEach((h, i) => {
      const mark = c.relevant.length === 0 ? " " : flags[i] ? "✓" : "✗";
      console.log(`   ${i + 1}. ${mark} ${h.score.toFixed(3)}  ${h.source}:${h.from}-${h.to}`);
    });
    if (c.relevant.length === 0) {
      console.log(`   → 대조군: 관련 원문이 없어야 한다. 1위 점수 ${hits[0]?.score.toFixed(3)}`);
      badScores.push(...hits.map((h) => h.score));
    } else {
      hits.forEach((h, i) => {
        if (flags[i]) goodScores.push(h.score);
        else if (c.onTopic && !c.onTopic.includes(h.source)) badScores.push(h.score);
      });
      console.log(
        `   → 첫 관련 청크 순위: ${firstRank || `상위 ${K}개 안에 없음`}, 정밀도@${K}: ${precision.toFixed(2)}, ` +
          `엉뚱한 문서 ${offTopic}개, 1위 점수 ${hits[0]?.score.toFixed(3)}`,
      );
      if (c.onTopic === WIKI_DOCS) {
        wikiOffTopic += offTopic;
        wikiSlots += K;
      } else {
        otherFirstRanks.push(firstRank);
      }
    }
  }

  const min = (xs: number[]) => Math.min(...xs);
  const max = (xs: number[]) => Math.max(...xs);
  console.log("\n================ 요약 ================");
  console.log(`LLM Wiki 질문: 상위 ${K}개 자리 ${wikiSlots}개 중 무관한 문서가 낀 자리 ${wikiOffTopic}개`);
  console.log(
    `다른 주제 질문: 정답 문서가 1위인 경우 ${otherFirstRanks.filter((r) => r === 1).length}/${otherFirstRanks.length}` +
      ` (순위 목록: ${otherFirstRanks.map((r) => r || "없음").join(", ")})`,
  );
  console.log(`정답 청크 ${goodScores.length}개의 점수 범위:      ${min(goodScores).toFixed(3)} ~ ${max(goodScores).toFixed(3)}`);
  console.log(`확실히 틀린 청크 ${badScores.length}개의 점수 범위: ${min(badScores).toFixed(3)} ~ ${max(badScores).toFixed(3)}`);
  console.log(
    min(goodScores) > max(badScores)
      ? "→ 정답 청크의 최저 점수가 틀린 청크의 최고 점수보다 높다: 점수 임계값으로 구분할 여지가 있다."
      : "→ 점수 범위가 겹친다: 고정된 점수 임계값으로는 '관련 없음'을 걸러낼 수 없다.",
  );
}

// json과 pgvector가 같은 질문에 같은 순위와 (거의) 같은 점수를 내는지 본다. 둘 다 정확 검색이라 같아야 한다
async function parity() {
  const embeddings = createEmbeddings();
  const json = await openStore(embeddings, "json");
  const pg = await openStore(embeddings, "pgvector");
  let maxDiff = 0;
  let rankMismatch = 0;
  try {
    for (const c of CASES) {
      const a = (await json.similaritySearchWithScore(c.query, K)).map(hitInfo);
      const b = (await pg.similaritySearchWithScore(c.query, K)).map(hitInfo);
      const sameOrder = a.every((h, i) => h.source === b[i]?.source && h.from === b[i]?.from);
      const diff = Math.max(...a.map((h, i) => Math.abs(h.score - (b[i]?.score ?? Infinity))));
      maxDiff = Math.max(maxDiff, diff);
      if (!sameOrder) rankMismatch++;
      console.log(`${sameOrder ? "순위 일치" : "순위 불일치"}  점수 최대 차이 ${diff.toExponential(2)}  "${c.query}"`);
    }
  } finally {
    await json.close();
    await pg.close();
  }
  console.log(`\n순위 불일치 ${rankMismatch}건, 점수 최대 차이 ${maxDiff.toExponential(2)}`);
  if (rankMismatch > 0 || maxDiff > 1e-3) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes("--parity")) return parity();
  const kind: VectorStoreKind = vectorStoreKind();
  console.log(`벡터 스토어: ${kind}, 상위 ${K}개 평가`);
  const store = await openStore(createEmbeddings(), kind);
  try {
    await evaluate(store);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
