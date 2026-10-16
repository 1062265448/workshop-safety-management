-- 1) 回收站：issues 加软删除时间
ALTER TABLE "issues" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- 2) 标签子标签：tags 加父标签引用
ALTER TABLE "tags" ADD COLUMN "parentId" TEXT;

-- 3) 风险等级三档改为 一般/重大/即知即改：原"较大(major)"并入"一般"
UPDATE "issues" SET "riskLevel" = 'general' WHERE "riskLevel" = 'major';
