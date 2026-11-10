-- Non-destructive additions for idempotent creation, durable side effects and workflow audit.
ALTER TABLE "issues" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "issues" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "import_batches" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';

CREATE TABLE "recheck_records" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "pass" BOOLEAN NOT NULL,
    "fail" BOOLEAN NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recheck_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "issueId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from" JSONB,
    "to" JSONB,
    "detail" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "issues_requestKey_key" ON "issues"("requestKey");
CREATE INDEX "recheck_records_issueId_checkedAt_idx" ON "recheck_records"("issueId", "checkedAt");
CREATE INDEX "audit_logs_issueId_createdAt_idx" ON "audit_logs"("issueId", "createdAt");
CREATE INDEX "audit_logs_actor_createdAt_idx" ON "audit_logs"("actor", "createdAt");
CREATE UNIQUE INDEX "outbox_events_idempotencyKey_key" ON "outbox_events"("idempotencyKey");
CREATE INDEX "outbox_events_status_nextAttemptAt_idx" ON "outbox_events"("status", "nextAttemptAt");
CREATE INDEX "outbox_events_type_status_idx" ON "outbox_events"("type", "status");
