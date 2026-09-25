import type { Document } from "@langchain/core/documents";
import type { WikiPage } from "./wiki.js";

// LLM에게 넘길 맥락(위키 + 원문 근거)과 프롬프트를 만드는 순수 함수들. 파일/네트워크 접근이 없다.

// 청크 메타데이터를 "파일:시작줄-끝줄" 형태의 출처 표기로 바꾼다
export function citation(metadata: Record<string, unknown>): string {
  const source = String(metadata.source ?? "알 수 없는 출처");
  const lines = (metadata.loc as { lines?: { from?: number; to?: number } } | undefined)?.lines;
  return lines?.from !== undefined && lines.to !== undefined
    ? `${source}:${lines.from}-${lines.to}`
    : source;
}

export interface WikiContext {
  text: string;
  used: string[]; // 맥락에 실제로 넣은 문서 이름
  omitted: string[]; // 글자 수 예산 때문에 넣지 못한 문서 이름
}

// 위키 문서를 이름순으로 넣는다. 예산을 넘는 문서부터는 넣지 않고 omitted에 기록한다.
// 문서가 많아지면 프롬프트가 너무 커지므로, omitted가 생기면 "관련 문서만 고르는 단계"가 필요하다는 신호다
export function renderWikiContext(pages: WikiPage[], charBudget: number): WikiContext {
  const sorted = [...pages].sort((a, b) => a.name.localeCompare(b.name));
  const sections: string[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  let total = 0;

  for (const page of sorted) {
    const section = `### 문서: ${page.name} (출처: ${page.sources.join(", ") || "없음"})\n${page.body.trim()}`;
    if (omitted.length === 0 && total + section.length <= charBudget) {
      sections.push(section);
      used.push(page.name);
      total += section.length;
    } else {
      omitted.push(page.name);
    }
  }
  return { text: sections.join("\n\n") || "(위키 문서 없음)", used, omitted };
}

// 검색된 raw 청크를 출처와 함께 나열한다
export function renderEvidence(hits: Array<[Document, number]>): string {
  if (hits.length === 0) return "(검색된 원문 없음)";
  return hits
    .map(([doc]) => `### ${citation(doc.metadata)}\n${doc.pageContent.trim()}`)
    .join("\n\n");
}

export function buildPrompt(question: string, wikiText: string, evidenceText: string): string {
  return `당신은 지식베이스 질의응답 도우미입니다. 아래 두 종류의 맥락을 바탕으로 질문에 답하세요.

[위키: LLM이 원문을 정리한 해석. 아직 사람이 검토하지 않았을 수 있음]
${wikiText}

[원문 근거: 질문과 관련해 검색된 원문 조각. 조각마다 출처(파일:줄)가 붙어 있음]
${evidenceText}

[규칙]
1. 위키는 해석이고 원문은 증거입니다. 둘이 다르면 원문을 따르고, 다르다고 밝히세요.
2. 주장마다 근거가 된 원문 조각의 출처를 표시하세요. 출처는 원문 근거의 제목(### 뒤의 "파일:시작줄-끝줄")을 글자 그대로 복사해서 쓰고, 조각 안에서 더 좁은 줄 번호를 추측해 만들지 마세요(조각 본문에는 줄 번호가 없습니다). 원문 근거에서 확인되지 않고 위키에만 있는 내용은 (위키)라고 표시하세요.
3. 두 맥락 어디에도 없는 내용은 추측하지 말고 모른다고 답하세요.

[질문]
${question}`;
}
