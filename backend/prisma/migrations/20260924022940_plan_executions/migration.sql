-- CreateTable
CREATE TABLE "plan_executions" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "executor" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "issueIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_executions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "plan_executions" ADD CONSTRAINT "plan_executions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "inspection_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
