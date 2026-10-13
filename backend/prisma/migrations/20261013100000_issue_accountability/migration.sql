-- 成品车间隐患增加责任落实字段：责任班组 / 网格主操手 / 网格责任人 / 系统责任人 / 系统原因
ALTER TABLE "issues"
  ADD COLUMN "team" TEXT,
  ADD COLUMN "gridOperator" TEXT,
  ADD COLUMN "gridOwner" TEXT,
  ADD COLUMN "systemOwner" TEXT,
  ADD COLUMN "systemCause" TEXT;
