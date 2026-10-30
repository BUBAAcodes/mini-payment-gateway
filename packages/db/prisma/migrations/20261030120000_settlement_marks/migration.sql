-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "settlement_id" TEXT;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "settlement_id" TEXT;

-- CreateIndex
CREATE INDEX "payments_merchant_id_settlement_id_idx" ON "payments"("merchant_id", "settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_issues_bank_date_kind_gateway_reference_key" ON "reconciliation_issues"("bank_date", "kind", "gateway_reference");

-- CreateIndex
CREATE INDEX "refunds_merchant_id_settlement_id_idx" ON "refunds"("merchant_id", "settlement_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

