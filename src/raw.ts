import fs from "fs/promises";
import path from "path";
import type { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// raw 데이터를 읽고 RAG용으로 청킹하는 코드. raw는 불변이므로 여기에는 읽기만 있고 쓰기가 없다.

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);

export interface RawFile {
  name: string; // 파일명. 위키 frontmatter의 sources, 청크 메타데이터의 source와 같은 값이다
  text: string;
}

// raw 폴더의 텍스트 파일을 이름순으로 읽는다 (이미지/영상 등은 아직 지원하지 않는다)
export async function readRawFiles(rawDir: string): Promise<RawFile[]> {
  const entries = await fs.readdir(rawDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  const files: RawFile[] = [];
  for (const name of names) {
    files.push({ name, text: await fs.readFile(path.join(rawDir, name), "utf-8") });
  }
  return files;
}

// 원문을 청킹하고, 청크마다 출처 메타데이터를 붙인다 (답변의 근거가 어느 파일에서 왔는지 추적하기 위해)
export async function chunkRawFiles(files: RawFile[]): Promise<Document[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  const docs: Document[] = [];
  for (const file of files) {
    const chunks = await splitter.createDocuments(
      [file.text],
      [{ source: file.name, sourceType: "raw" }],
    );
    docs.push(...chunks);
  }
  return docs;
}
