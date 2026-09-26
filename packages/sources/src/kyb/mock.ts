// MOCK_KYB: Reemplazar en mes 1-3 por integración real con SEP-12 anchor.

export type KybRecord = {
  providerId: string;
  status: "verified" | "demo_verified" | "pending" | "none";
  kybProvider?: string;
  kybTier?: 1 | 2 | 3;
  verifiedAt?: string;
};

// Ticket 4.7 — seed demo: los 5 providers sembrados en testnet.
// Los providers 1-3 son demo-only y no deben contarse como identidad verificada de producción.
// Reemplazar por SEP-12 real antes del launch (fecha objetivo: SEP-12).
const REGISTRY_CONTRACT_ID = "CC4M6C3UI2Y5Z2FNPTT4UCSXYWSJH2NBILEMHQYJLWJU5IHZ3GNT7EPX";
const providerKey = (providerId: number) => `${REGISTRY_CONTRACT_ID}/${providerId}`;

const MOCKS: Record<string, KybRecord> = {
  [providerKey(1)]: {
    providerId: providerKey(1),
    status: "demo_verified",
    kybProvider: "mock-anchor",
    kybTier: 2,
    verifiedAt: "2026-05-01T00:00:00.000Z",
  },
  [providerKey(2)]: {
    providerId: providerKey(2),
    status: "demo_verified",
    kybProvider: "mock-anchor",
    kybTier: 1,
    verifiedAt: "2026-05-10T00:00:00.000Z",
  },
  [providerKey(3)]: {
    providerId: providerKey(3),
    status: "demo_verified",
    kybProvider: "mock-anchor",
    kybTier: 3,
    verifiedAt: "2026-04-20T00:00:00.000Z",
  },
  [providerKey(4)]: {
    providerId: providerKey(4),
    status: "pending",
    kybProvider: "mock-anchor",
  },
  [providerKey(5)]: {
    providerId: providerKey(5),
    status: "none",
  },
};

export async function getKybStatus(providerId: string): Promise<KybRecord> {
  console.warn(`[MOCK_KYB] fetching ${providerId}`);
  return MOCKS[providerId] ?? { providerId, status: "none" };
}

export async function setKybStatus(rec: KybRecord) {
  MOCKS[rec.providerId] = rec;
}
