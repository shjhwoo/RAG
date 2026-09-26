CREATE TABLE "raw_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "raw_chunks_embedding_idx" ON "raw_chunks" USING hnsw ("embedding" vector_cosine_ops);