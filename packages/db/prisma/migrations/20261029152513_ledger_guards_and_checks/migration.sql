-- Rules Prisma's schema language can't express. Written by hand; Prisma ignores CHECK constraints
-- and triggers when it diffs, so later migrations won't try to drop them.

-- ---------- CHECK constraints (spec section 3, rules 1 and 6) ----------

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amount_range" CHECK ("amount" BETWEEN 100 AND 50000000),
  ADD CONSTRAINT "orders_currency_inr" CHECK ("currency" = 'INR');

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_currency_inr" CHECK ("currency" = 'INR'),
  -- Backstop for "no over-refunds": even a buggy service can't refund more than was paid.
  ADD CONSTRAINT "payments_amount_refunded_range" CHECK ("amount_refunded" BETWEEN 0 AND "amount");

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);

-- The direction (debit or credit) carries the sign, so amounts are always positive.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0);

-- ---------- Ledger: every transaction balances (rule 3) ----------

-- Runs at COMMIT, not per INSERT: a transaction's entries go in one row at a time, so it is only
-- balanced once they are all in. Fires once per inserted row and re-sums the whole transaction,
-- which also catches a one-sided entry added later to a transaction that used to balance.
CREATE FUNCTION "check_ledger_transaction_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  difference bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "direction" = 'debit' THEN "amount" ELSE -"amount" END), 0)
    INTO difference
    FROM "ledger_entries"
   WHERE "transaction_id" = NEW."transaction_id";

  IF difference <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debits minus credits = %',
      NEW."transaction_id", difference
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_ledger_transaction_balanced"();

-- ---------- Ledger: append-only (rule 3) ----------

-- Corrections are new reversal transactions, never edits. Uses the default SQLSTATE (P0001):
-- Prisma reports restrict_violation (23001) as a foreign key error and drops the message.
CREATE FUNCTION "reject_ledger_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING HINT = 'Post a reversal transaction instead.';
END;
$$;

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_ledger_change"();

CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_ledger_change"();

CREATE TRIGGER "ledger_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "reject_ledger_change"();

CREATE TRIGGER "ledger_transactions_no_truncate"
  BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_ledger_change"();

-- ---------- System ledger accounts ----------

-- Reference data every environment needs. Per-merchant merchant_balance:{id} accounts
-- (liability) are created with the merchant.
INSERT INTO "ledger_accounts" ("code", "type") VALUES
  ('gateway_clearing', 'asset'),
  ('fee_revenue', 'revenue'),
  ('payouts', 'asset');
