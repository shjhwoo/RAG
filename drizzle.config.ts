import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// drizzle-kit(generate / migrate) 설정. 마이그레이션 SQL은 ./drizzle 에 쌓이며 커밋 대상이다.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://mnemosyne:mnemosyne@localhost:5432/mnemosyne",
  },
});
