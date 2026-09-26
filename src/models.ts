import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// 채팅 모델과 임베딩 모델의 제공자를 .env에서 따로 고른다.
//   CHAT_PROVIDER  = gemini(기본) | openai | ollama
//   EMBED_PROVIDER = ollama(기본) | openai
//
// 주의: 임베딩 모델이 바뀌면 벡터 차원이 달라져 기존 storage/vector_store를 읽을 수 없다.
// EMBED_PROVIDER를 바꾸면 ingest를 다시 실행해서 인덱스를 새로 만들어야 하고,
// ingest와 query는 반드시 같은 EMBED_PROVIDER로 실행해야 한다.
// (채팅 모델은 언제 바꿔도 인덱스에 영향이 없다)
// VECTOR_STORE=pgvector 이면 차원이 DB 스키마(src/db/schema.ts의 EMBEDDING_DIMENSIONS)에도 고정되어 있어서,
// 임베딩 모델을 바꿀 때 그 값을 바꾸고 db:generate / db:migrate 도 해야 한다.

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_CHAT_MODEL = "qwen3:8b";
const OLLAMA_EMBED_MODEL = "bge-m3"; // 한국어를 포함한 다국어 임베딩

// Gemini 모델 이름은 자주 바뀌므로 .env의 GEMINI_CHAT_MODEL로 덮어쓸 수 있다.
// (환경변수는 반드시 함수 안에서 읽는다. 파일 최상단에서 읽으면 dotenv.config()보다 먼저 실행되어 .env 값이 안 보인다)
const DEFAULT_GEMINI_CHAT_MODEL = "gemini-3.5-flash-lite";

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name] ?? fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`알 수 없는 ${name}: '${value}' (${allowed.join(" | ")} 중 하나여야 합니다)`);
}

// json: true이면 JSON만 출력하도록 요청한다. 작은 모델은 JSON 형식을 자주 어기기 때문이다
export function createChatModel(options: { json?: boolean } = {}): BaseChatModel {
  const provider = pick("CHAT_PROVIDER", ["gemini", "openai", "ollama"], "gemini");

  if (provider === "gemini") {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error("CHAT_PROVIDER=gemini 이면 .env에 GOOGLE_API_KEY가 필요합니다.");
    }
    return new ChatGoogleGenerativeAI({
      model: process.env.GEMINI_CHAT_MODEL ?? DEFAULT_GEMINI_CHAT_MODEL,
      ...(options.json ? { json: true } : {}),
    });
  }

  if (provider === "openai") {
    return new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.1 });
  }

  return new ChatOllama({
    baseUrl: OLLAMA_URL,
    model: OLLAMA_CHAT_MODEL,
    temperature: 0.1,
    // Ollama의 기본 컨텍스트가 작으면 긴 프롬프트의 앞부분이 조용히 잘린다
    numCtx: 8192,
    // qwen3의 <think> 추론 출력을 끈다. JSON/마크다운 파싱을 방해하고 CPU에서는 시간도 크게 늘린다
    think: false,
    ...(options.json ? { format: "json" as const } : {}),
  });
}

export function createEmbeddings(): EmbeddingsInterface {
  const provider = pick("EMBED_PROVIDER", ["ollama", "openai"], "ollama");

  if (provider === "openai") {
    return new OpenAIEmbeddings({ model: "text-embedding-3-small" });
  }
  return new OllamaEmbeddings({ baseUrl: OLLAMA_URL, model: OLLAMA_EMBED_MODEL });
}
