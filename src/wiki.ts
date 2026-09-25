import fs from "fs/promises";
import path from "path";

// 위키 폴더의 파일 구조를 다루는 코드. LLM 호출은 여기에 없다 (ingest.ts 담당).

export const INDEX_FILE = "index.md";
const RELATED_HEADING = "## 관련 문서";
const RELATED_LINE = /^## 관련 문서[ \t]*$/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK = /\[\[([^\]|#]+)\]\]/g;

export interface WikiPage {
  name: string; // 파일명(확장자 제외). [[위키링크]]에 쓰는 이름과 같다
  summary: string;
  sources: string[];
  headings: string[];
  body: string; // frontmatter를 뺀 본문
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

// LLM이 준 이름을 안전한 페이지 이름으로 바꾼다 (위키 폴더 밖으로 나가는 경로 방지)
export function toPageName(input: string): string {
  // path.basename은 Windows에서 "a:"를 드라이브 문자로 취급해 글자를 버리므로, 구분자로만 직접 자른다
  const name = (input.split(/[\\/]/).pop() ?? "")
    .replace(/\.md$/i, "")
    .replace(/[<>:"/\\|?*[\]#]/g, "-")
    .trim();
  if (!name || name.toLowerCase() === "index") {
    throw new Error(`사용할 수 없는 위키 페이지 이름: ${input}`);
  }
  return name;
}

function pagePath(wikiDir: string, name: string): string {
  return path.join(wikiDir, `${toPageName(name)}.md`);
}

export function parsePage(name: string, markdown: string): WikiPage {
  const match = markdown.match(FRONTMATTER);
  const meta = match?.[1] ?? "";
  const body = match ? markdown.slice(match[0].length) : markdown;

  const summary = meta.match(/^summary:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const sources = (meta.match(/^sources:\s*\[(.*)\]\s*$/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headings = body
    .split("\n")
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim());

  return { name, summary, sources, headings, body };
}

export async function readPage(
  wikiDir: string,
  name: string,
): Promise<WikiPage | null> {
  try {
    const markdown = await fs.readFile(pagePath(wikiDir, name), "utf-8");
    return parsePage(toPageName(name), markdown);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// [1단계] 기존 위키의 모든 문서를 읽는다 (index.md는 자동 생성물이라 제외)
export async function listPages(wikiDir: string): Promise<WikiPage[]> {
  let files: string[];
  try {
    files = await fs.readdir(wikiDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const pages: WikiPage[] = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file === INDEX_FILE) continue;
    const page = await readPage(wikiDir, file.slice(0, -".md".length));
    if (page) pages.push(page);
  }
  return pages;
}

// LLM에게 보여줄 위키 개요: 이름 + 요약 + 목차만. 본문 전체는 넣지 않는다
export function renderOverview(pages: WikiPage[]): string {
  if (pages.length === 0) return "현재 저장된 위키 문서가 없습니다.";
  return pages
    .map((p) => `- ${p.name}: ${p.summary}\n  목차: ${p.headings.join(" / ")}`)
    .join("\n");
}

// "## 관련 문서"(역링크) 섹션은 코드가 관리한다. LLM이 문서를 다시 쓰다 빠뜨려도 역링크가 유지되게 하려는 것이다
function splitRelated(body: string): { main: string; related: string } {
  const at = body.search(RELATED_LINE);
  if (at === -1) return { main: body, related: "" };
  return { main: body.slice(0, at), related: body.slice(at) };
}

// [2단계] 문서 저장. frontmatter는 코드가 붙이고, 출처와 역링크 섹션은 기존 것을 이어받는다
export async function writePage(
  wikiDir: string,
  name: string,
  body: string,
  summary: string,
  source: string,
): Promise<void> {
  const existing = await readPage(wikiDir, name);
  const sources = [...new Set([...(existing?.sources ?? []), source])];
  const { main } = splitRelated(body); // LLM이 쓴 역링크 섹션은 버린다
  const { related } = splitRelated(existing?.body ?? "");
  const content = related
    ? `${main.trim()}\n\n${related.trim()}`
    : main.trim();

  const frontmatter = [
    "---",
    `summary: ${summary.replace(/\s+/g, " ").trim()}`,
    `sources: [${sources.join(", ")}]`,
    `updated: ${new Date().toISOString()}`,
    "review_status: unreviewed",
    "---",
    "",
    "",
  ].join("\n");

  await fs.mkdir(wikiDir, { recursive: true });
  await fs.writeFile(
    pagePath(wikiDir, name),
    `${frontmatter}${content}\n`,
    "utf-8",
  );
}

// [2단계] 양방향 링크: fromName이 [[다른문서]]로 링크했다면, 그 문서에도 fromName으로 돌아오는 링크를 추가한다
export async function addBacklinks(
  wikiDir: string,
  fromName: string,
  body: string,
): Promise<void> {
  const targets = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1]?.trim();
    if (target && target !== fromName && target.toLowerCase() !== "index") {
      targets.add(target);
    }
  }

  for (const target of targets) {
    const file = pagePath(wikiDir, target);
    let markdown: string;
    try {
      markdown = await fs.readFile(file, "utf-8");
    } catch (err) {
      if (isNotFound(err)) continue; // 아직 없는 문서로의 링크는 건너뛴다
      throw err;
    }
    if (markdown.includes(`[[${fromName}]]`)) continue; // 이미 연결됨

    const heading = RELATED_LINE.test(markdown) ? "" : `\n${RELATED_HEADING}\n`;
    await fs.writeFile(
      file,
      `${markdown.trimEnd()}\n${heading}- [[${fromName}]]\n`,
      "utf-8",
    );
  }
}

// [3단계] index.md는 전체 문서의 frontmatter에서 매번 새로 만든다 (LLM이 관리하면 실제 파일과 어긋날 수 있다)
export async function rebuildIndex(wikiDir: string): Promise<void> {
  const pages = (await listPages(wikiDir)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const lines = pages.map((p) => {
    const sources = p.sources.length ? ` (출처: ${p.sources.join(", ")})` : "";
    return `- [[${p.name}]] — ${p.summary || "(요약 없음)"}${sources}`;
  });

  await fs.mkdir(wikiDir, { recursive: true });
  await fs.writeFile(
    path.join(wikiDir, INDEX_FILE),
    [
      "# 위키 색인",
      "",
      "> 자동 생성 파일입니다. 직접 수정하지 마세요.",
      "",
      ...lines,
      "",
    ].join("\n"),
    "utf-8",
  );
}
