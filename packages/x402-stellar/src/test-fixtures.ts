// Fixtures compartidos para los tests de x402-stellar (no es un test en sí).
import type { HorizonLike } from "./verify";
import { USDC_ISSUERS } from "./verify";

export const TESTNET_ISSUER = USDC_ISSUERS.testnet;
export const PUBLIC_ISSUER = USDC_ISSUERS.public;

// Cuentas G válidas según el regex /^G[A-Z2-7]{55}$/.
export const DESTINATION = "G" + "A".repeat(55);
export const PAYER = "G" + "B".repeat(55);
export const OTHER_ISSUER = "G" + "C".repeat(55);

export interface FakeTx {
  successful: boolean;
  memo_type: string;
  memo: string;
}

export interface FakePayment {
  type: string;
  from: string;
  to: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  amount: string;
}

/** Construye un HorizonLike que devuelve la tx y operación indicadas. */
export function makeHorizon(tx: FakeTx, payment: FakePayment): HorizonLike {
  return {
    transactions: () => ({
      transaction: () => ({
        call: async () => tx,
      }),
    }),
    operations: () => ({
      forTransaction: () => ({
        call: async () => ({ records: [payment] }),
      }),
    }),
  };
}

/** HorizonLike que lanza 404 (tx no encontrada). */
export function makeHorizonNotFound(): HorizonLike {
  return {
    transactions: () => ({
      transaction: () => ({
        call: async () => {
          const err: any = new Error("not found");
          err.response = { status: 404 };
          throw err;
        },
      }),
    }),
    operations: () => ({
      forTransaction: () => ({
        call: async () => ({ records: [] }),
      }),
    }),
  };
}

export function validTx(memo: string): FakeTx {
  return { successful: true, memo_type: "text", memo };
}

export function validPayment(overrides: Partial<FakePayment> = {}): FakePayment {
  return {
    type: "payment",
    from: PAYER,
    to: DESTINATION,
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: TESTNET_ISSUER,
    amount: "0.005",
    ...overrides,
  };
}
