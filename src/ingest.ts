import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { OpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

dotenv.config();

async function runIngest() {
  const rawFilePath = path.join(process.cwd(), "storage/raw/sample.txt");
  const wikiFilePath = path.join(
    process.cwd(),
    "storage/wiki/sample_summary.md",
  );
  const vectorStorePath = path.join(process.cwd(), "storage/vector_store");

  // 1. Raw 데이터 읽기 (Immutable)
  const rawText = await fs.readFile(rawFilePath, "utf-8");
  console.log("1. Raw 파일 읽기 완료");

  // 2. LLM을 사용해 LLM Wiki 마크다운 문서 생성
  const llm = new OpenAI({ modelName: "gpt-4o-mini", temperature: 0 });
  const wikiPrompt = `다음 원문 내용을 바탕으로 구조화된 Markdown 위키 문서를 작성해줘:\n\n${rawText}`;
  const wikiMarkdown = await llm.invoke(wikiPrompt);

  await fs.mkdir(path.dirname(wikiFilePath), { recursive: true });
  await fs.writeFile(wikiFilePath, wikiMarkdown, "utf-8");
  console.log("2. LLM Wiki 마크다운 문서 생성 완료:", wikiFilePath);

  // 3. 문단 청킹 (Chunking)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });
  const docs = await splitter.createDocuments([wikiMarkdown]);

  // 4. Vector Store 생성 및 저장 (HNSWLib 로컬 파일 저장)
  const vectorStore = await HNSWLib.fromDocuments(
    docs,
    new OpenAIEmbeddings({ modelName: "text-embedding-3-small" }),
  );
  await vectorStore.save(vectorStorePath);
  console.log("3. 벡터 데이터베이스 인덱싱 완료:", vectorStorePath);
}

runIngest().catch(console.error);

/*
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { OpenAI } from "@langchain/openai";

dotenv.config();

// 1. 기존 위키 저장소의 마크다운 파일 상태 읽기
async function getExistingWikiContext(wikiDir: string): Promise<string> {
  try {
    const files = await fs.readdir(wikiDir);
    const mdFiles = files.filter((file) => file.endsWith(".md"));
    if (mdFiles.length === 0) return "현재 저장된 위키 문서가 없습니다.";

    let context = "현재 존재하는 위키 문서 목록:\n";
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(wikiDir, file), "utf-8");
      // 헤더/주요 내용 일부만 프롬프트용 템플릿으로 요약 추출
      context += `\n--- 파일명: ${file} ---\n${content.slice(0, 500)}...\n`;
    }
    return context;
  } catch {
    return "현재 저장된 위키 문서가 없습니다.";
  }
}

async function runKarpathyIngest() {
  const rawFilePath = path.join(process.cwd(), "storage/raw/sample.txt");
  const wikiDir = path.join(process.cwd(), "storage/wiki");

  const rawText = await fs.readFile(rawFilePath, "utf-8");
  await fs.mkdir(wikiDir, { recursive: true });

  // 기존 위키 맥락 가져오기
  const existingWikiContext = await getExistingWikiContext(wikiDir);

  const llm = new OpenAI({ modelName: "gpt-4o-mini", temperature: 0.1 });

  // 카파시 스타일 LLM Wiki Ingest 프롬프트
  const wikiPrompt = `
당신은 지식베이스의 전담 에디터(Compiling Agent)입니다.
새로운 원문 데이터를 기존 LLM Wiki 지식베이스에 통합하는 작업을 수행하세요.

[기존 위키 지식베이스 상태]
${existingWikiContext}

[새로 입력된 Raw Data]
${rawText}

[지침]
1. 새 데이터를 분석하여 기존 위키 문서에 내용을 덧붙여 업데이트할지, 혹은 새로운 위키 문서를 만들지 결정하세요.
2. 개념 및 키워드 간의 연관성이 있다면 위키 스타일의 위키링크 형식(예: [[개념이름]])을 사용하세요.
3. 생성/수정할 파일명과 마크다운 본문을 다음 JSON 형식으로만 정확히 출력하세요:

{
  "targetFile": "파일명.md",
  "isUpdate": true 또는 false,
  "content": "최종 마크다운 문서 전체 내용"
}
`;

  console.log("LLM Wiki 지식 융합 및 정제 중...");
  const response = await llm.invoke(wikiPrompt);

  try {
    const result = JSON.parse(response);
    const targetPath = path.join(wikiDir, result.targetFile);

    await fs.writeFile(targetPath, result.content, "utf-8");
    console.log(
      `[Karpathy Ingest Complete] '${result.targetFile}' (${result.isUpdate ? "기존 문서 업데이트" : "새 문서 생성"})`
    );
  } catch (err) {
    console.error("JSON 파싱 에러 또는 지식 정제 실패:", response);
  }
}

runKarpathyIngest().catch(console.error);
*/
