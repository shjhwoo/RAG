import path from "path";
import dotenv from "dotenv";
import { createChatModel, createEmbeddings } from "./models.js";
import { chunkRawFiles, readRawFiles } from "./raw.js";
import { SimpleVectorStore } from "./vectorstore.js";
import {
  addBacklinks,
  listPages,
  parsePage,
  readPage,
  rebuildIndex,
  renderOverview,
  toPageName,
  writePage,
} from "./wiki.js";

dotenv.config();

interface WikiPlan {
  targetName: string;
  summary: string;
}

// LLM이 답변을 ```json ... ``` 이나 ```markdown ... ``` 으로 감싸는 경우가 있어 펜스를 벗겨낸다.
// 추론 모델이 섞어 내는 <think>...</think> 블록도 함께 제거한다
function stripCodeFence(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "");
}

function parsePlan(text: string): WikiPlan {
  try {
    const plan = JSON.parse(stripCodeFence(text)) as Partial<WikiPlan>;
    if (typeof plan.targetName === "string" && typeof plan.summary === "string") {
      return { targetName: plan.targetName, summary: plan.summary };
    }
  } catch {
    // 아래에서 원문과 함께 오류를 던진다
  }
  throw new Error(`위키 계획 JSON 파싱 실패. LLM 응답:\n${text}`);
}

// 새 raw 데이터를 기존 위키에 통합한다
async function updateWiki(
  rawText: string,
  rawName: string,
  wikiDir: string,
): Promise<void> {
  // 2-1. 기존 위키 스캔: 이름 + 요약 + 목차 (코드가 읽는다. LLM 호출 없음)
  const pages = await listPages(wikiDir);

  // raw는 불변이므로 이미 반영한 파일을 다시 넣을 필요가 없다 (LLM 비용 절약 + 중복 통합 방지)
  if (pages.some((p) => p.sources.includes(rawName))) {
    console.log(`   '${rawName}'은(는) 이미 위키에 반영되어 건너뜁니다.`);
    return;
  }

  // text-in/text-out으로 쓰기 위해, 채팅 모델이 돌려주는 메시지 객체(AIMessage)에서 .text로 문자열만 꺼낸다
  const planLlm = createChatModel({ json: true }); // 결정 단계는 JSON만 받는다
  const writeLlm = createChatModel(); // 본문 작성은 마크다운 자유 텍스트

  // 2-2. 새 지식을 어느 문서에 넣을지 결정 (기존 문서 갱신 vs 새 문서)
  const planPrompt = `
당신은 지식베이스의 전담 에디터(Compiling Agent)입니다.
새로 들어온 원문을 위키의 어느 문서에 반영할지 결정하세요.

[기존 위키 문서 목록 (이름: 요약 / 목차)]
${renderOverview(pages)}

[새로 입력된 Raw Data]
${rawText}

[지침]
1. 원문이 기존 문서의 주제와 관련 있으면 그 문서의 이름을 targetName으로 쓰세요 (기존 문서 갱신).
2. 아예 새로운 주제라면 새 이름을 정하세요. 이름은 확장자 없이 짧게 씁니다 (예: nats, architecture).
3. summary에는 그 문서가 다루는 주제를 한 문장으로 요약하세요.
4. 아래 JSON 형식으로만 출력하세요:

{"targetName": "문서이름", "summary": "한 문장 요약"}
`;

  console.log(`   '${rawName}' 지식 융합 대상 결정 중...`);
  const plan = parsePlan((await planLlm.invoke(planPrompt)).text);
  const name = toPageName(plan.targetName);

  // LLM이 "새 문서"라고 해도 같은 이름의 파일이 이미 있으면 갱신으로 다룬다 (덮어쓰기 방지)
  const existing = await readPage(wikiDir, name);
  const linkableNames = pages.map((p) => p.name).filter((n) => n !== name);

  // 2-3. 문서 본문 작성. 대상 문서 하나의 전체 내용만 보여준다
  const writePrompt = `
당신은 지식베이스의 전담 에디터(Compiling Agent)입니다.
'${name}' 문서의 최종 마크다운 본문을 작성하세요.

[기존 '${name}' 문서 내용]
${existing ? existing.body : "없음 (새 문서를 만드세요)"}

[새로 입력된 Raw Data]
${rawText}

[링크 가능한 다른 문서 이름]
${linkableNames.length ? linkableNames.join(", ") : "없음"}

[지침]
1. 기존 문서가 있으면 기존 내용을 유지하면서 새 내용을 통합한 문서 전체를 출력하세요.
2. 위 목록의 다른 문서와 관련이 있으면 [[문서이름]] 형식의 위키링크로 연결하세요. 목록에 있는 이름만 사용하세요.
3. '## 관련 문서' 섹션은 시스템이 자동으로 관리하므로 쓰지 마세요.
4. 마크다운 본문만 출력하세요. frontmatter(---)나 코드블록으로 감싸는 것은 하지 마세요.
`;

  console.log(
    `   '${name}' 문서 작성 중... (${existing ? "기존 문서 업데이트" : "새 문서 생성"})`,
  );
  const draft = stripCodeFence((await writeLlm.invoke(writePrompt)).text);
  // LLM이 frontmatter를 붙였더라도 코드가 붙이는 것만 남기도록 제거한다
  const body = parsePage(name, draft).body;

  // 2-4. 저장 → 양방향 링크 → 색인 갱신
  await writePage(wikiDir, name, body, plan.summary, rawName);
  await addBacklinks(wikiDir, name, body);
  await rebuildIndex(wikiDir);
}

async function runIngest() {
  const rawDir = path.join(process.cwd(), "storage/raw");
  const wikiDir = path.join(process.cwd(), "storage/wiki");
  const vectorStorePath = path.join(process.cwd(), "storage/vector_store");

  // 1. Raw 데이터 읽기 (Immutable)
  const rawFiles = await readRawFiles(rawDir);
  if (rawFiles.length === 0) {
    console.log("storage/raw/에 처리할 텍스트 파일(.txt, .md)이 없습니다.");
    return;
  }
  console.log(`1. Raw 파일 ${rawFiles.length}개 읽기 완료`);

  // 2. RAG 인덱싱: raw 원문을 청킹해서 출처 메타데이터와 함께 저장한다.
  //    위키와 서로 의존하지 않으므로, LLM 오류가 잦은 위키 갱신보다 먼저 한다.
  //    fromDocuments는 매번 새 인덱스를 만들므로 재실행해도 청크가 중복되지 않는다.
  const docs = await chunkRawFiles(rawFiles);
  const vectorStore = await SimpleVectorStore.fromDocuments(docs, createEmbeddings());
  await vectorStore.save(vectorStorePath);
  console.log(
    `2. 벡터 데이터베이스 인덱싱 완료 (청크 ${docs.length}개):`,
    vectorStorePath,
  );

  // 3. LLM Wiki 갱신: 파일 하나씩 순서대로 (앞 파일이 만든 문서를 다음 파일이 볼 수 있다)
  console.log("3. LLM Wiki 갱신");
  for (const file of rawFiles) {
    await updateWiki(file.text, file.name, wikiDir);
  }
  console.log("   위키 갱신 및 index.md 갱신 완료");
}

runIngest().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 실패했는데 종료 코드가 0이면 성공한 것으로 오해하기 쉽다
});
