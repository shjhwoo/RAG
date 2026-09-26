-- pgvector 확장 활성화. drizzle-kit generate는 CREATE EXTENSION을 만들지 않으므로 직접 쓴다.
-- 이 파일이 다음 마이그레이션(vector 컬럼이 있는 테이블)보다 먼저 적용되어야 한다.
CREATE EXTENSION IF NOT EXISTS vector;
