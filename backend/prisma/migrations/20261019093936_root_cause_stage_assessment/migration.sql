-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "causeType" TEXT,
ADD COLUMN     "countermeasureLevel" TEXT,
ADD COLUMN     "countermeasureReason" TEXT,
ADD COLUMN     "institutionNote" TEXT,
ADD COLUMN     "linkedKnowledgeDocId" TEXT,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'rechecking';

-- CreateTable
CREATE TABLE "assessments" (
    "id" TEXT NOT NULL,
    "issueId" TEXT,
    "issueTitle" TEXT NOT NULL DEFAULT '',
    "owner" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'normal',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

