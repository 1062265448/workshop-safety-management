-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "recheckIntervalDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "recheckRequired" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "rechecks" TEXT[] DEFAULT ARRAY[]::TEXT[];
