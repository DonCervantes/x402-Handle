-- HANDLE (Flovia) escrow indexer: tables maintained by apps/cli/indexer.ts
-- mirroring the on-chain events of contracts/soroban-escrow (lock / release /
-- refund / dispute / resolve).
--
-- Disputes are deliberately part of this single table (status + disputed_at /
-- dispute_opener) instead of a separate disputes table: every escrow row is
-- an idempotent projection of the newest event for that escrow id, so the
-- indexer can apply events in any order / re-poll safely.
--
-- getDisputeCount() in apps/bff reads this table to feed the trust score's
-- claimsFactor (replacing the hard-coded 0 from the v1 POC).

CREATE TABLE IF NOT EXISTS escrows (
  id               bigserial PRIMARY KEY,
  contract_id      text NOT NULL,                       -- escrow contract C...
  escrow_id        bigint NOT NULL,                     -- on-chain u64 id
  provider_account text NOT NULL,                       -- payout address (x402 destination)
  agent_account    text NOT NULL,                       -- paying agent
  token            text NOT NULL,                       -- SAC contract id of the asset
  amount_stroops   numeric(38,0) NOT NULL,              -- 1e-7 USDC units
  amount_usdc      numeric(20,7) NOT NULL,              -- convenience for reads/reports
  payment_ref      text NOT NULL,                       -- hex; ties escrow to the x402 payment
  status           text NOT NULL,                       -- locked | released | refunded | disputed
  created_at       timestamptz NOT NULL,
  deadline_at      timestamptz NOT NULL,
  disputed_at      timestamptz,
  dispute_opener   text,
  resolved_at      timestamptz,
  resolver         text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, escrow_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS escrows_payment_ref_idx ON escrows(contract_id, payment_ref);
CREATE INDEX IF NOT EXISTS escrows_provider_idx ON escrows(provider_account, status);
CREATE INDEX IF NOT EXISTS escrows_agent_idx ON escrows(agent_account);
CREATE INDEX IF NOT EXISTS escrows_disputed_idx ON escrows(disputed_at) WHERE disputed_at IS NOT NULL;
