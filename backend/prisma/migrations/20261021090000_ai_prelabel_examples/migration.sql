-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "aiCategory" TEXT,
ADD COLUMN     "aiCauseType" TEXT,
ADD COLUMN     "aiRiskLevel" TEXT,
ADD COLUMN     "aiSuggestion" TEXT;

-- CreateTable
CREATE TABLE "prelabel_examples" (
    "id" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prelabel_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prelabel_examples_categoryName_idx" ON "prelabel_examples"("categoryName");
