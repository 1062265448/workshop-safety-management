-- 参考标注增加隐患类型标签关联（tags.id，可空）
ALTER TABLE "issue_annotations" ADD COLUMN "tagId" TEXT;
