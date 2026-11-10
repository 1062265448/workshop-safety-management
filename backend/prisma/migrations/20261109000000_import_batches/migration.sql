-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "externalMessageId" TEXT,
    "fileHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "error" TEXT,

    CONSTRAINT "import_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_idempotencyKey_key" ON "import_batches"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "import_items_batchId_sourceKey_key" ON "import_items"("batchId", "sourceKey");

-- CreateIndex
CREATE INDEX "import_items_batchId_idx" ON "import_items"("batchId");

-- CreateIndex
CREATE INDEX "import_items_issueId_idx" ON "import_items"("issueId");
