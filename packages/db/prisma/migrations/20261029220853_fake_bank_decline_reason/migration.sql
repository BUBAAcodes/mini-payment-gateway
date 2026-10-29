-- DropIndex
DROP INDEX "bank_transactions_gateway_reference_idx";

-- AlterTable
ALTER TABLE "bank_transactions" ADD COLUMN     "decline_reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_gateway_reference_type_key" ON "bank_transactions"("gateway_reference", "type");

