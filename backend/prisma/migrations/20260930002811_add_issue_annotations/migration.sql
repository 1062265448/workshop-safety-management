-- CreateTable
CREATE TABLE "issue_annotations" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "relevance" TEXT NOT NULL DEFAULT 'medium',
    "similarity" TEXT NOT NULL DEFAULT '',
    "caution" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_annotations_issueId_key" ON "issue_annotations"("issueId");
