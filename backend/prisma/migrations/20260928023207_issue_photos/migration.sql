-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];
