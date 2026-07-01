import Link from "next/link";
import type { StellarProvider } from "contracts";
import { ScoreRing } from "./ScoreRing";

const KYB_LABEL: Record<string, string> = {
  verified: "KYB verificado",
  pending: "KYB pendiente",
  none: "Sin KYB",
};

const KYB_COLOR: Record<string, string> = {
  verified: "var(--signal-priority)",
  pending: "var(--signal-attention)",
  none: "var(--text-3)",
};

type ProviderCardProps = {
  provider: StellarProvider;
  trustScore?: number;
  kybStatus?: "verified" | "pending" | "none";
};

export function ProviderCard({ provider, trustScore, kybStatus }: ProviderCardProps) {
  return (
    <Link
      href={`/providers/${provider.id.replace("/", "--")}`}
      style={{
        display: "block",
        padding: 16,
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--line)",
        background: "var(--surface-card)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-1)" }}>
            {provider.name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {provider.endpoint}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            {provider.category && (
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--surface-muted)",
                  color: "var(--text-2)",
                }}
              >
                {provider.category}
              </span>
            )}
            <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text-2)" }}>
              ${provider.priceUsdc.toFixed(4)} USDC
            </span>
            {kybStatus && (
              <span style={{ fontSize: 11, color: KYB_COLOR[kybStatus] }}>
                {KYB_LABEL[kybStatus]}
              </span>
            )}
            {!provider.active && (
              <span style={{ fontSize: 11, color: "var(--danger)" }}>Inactivo</span>
            )}
          </div>
        </div>
        {trustScore !== undefined && <ScoreRing score={trustScore} size={48} />}
      </div>
    </Link>
  );
}
