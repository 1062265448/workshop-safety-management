-- 人工复核标记：存量数据均视为已复核（true），AI 批量识别新入库的为 false
ALTER TABLE "issues" ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT true;
