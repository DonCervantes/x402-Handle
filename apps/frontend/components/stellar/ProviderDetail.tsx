"use client";

import type { ProviderIntelligence } from "contracts";
import { AddressChip } from "./AddressChip";
import { LayerTabs } from "./LayerTabs";
import { TrustScoreBreakdown } from "./TrustScoreBreakdown";

export function ProviderDetail({ intelligence }: { intelligence: ProviderIntelligence }) {
  const { provider, kyb, financial, trustScore } = intelligence;

  return (
    <div className="scroll" style={{ background: "var(--bg-shell)" }}>
      <div className="page-pad page-pad--wide">
        <header style={{ marginBottom: 24 }}>
          <h1
            className="display"
            style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}
          >
            {provider.name}
          </h1>
          <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
            <AddressChip address={provider.ownerAccount} />
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>{provider.endpoint}</span>
          </div>
        </header>

        <LayerTabs
          tabs={[
            {
              id: "identity",
              label: "Identidad",
              content: (
                <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 10 }}>
                  <dt style={{ color: "var(--text-3)" }}>Contract ID</dt>
                  <dd style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                    <AddressChip address={provider.contractId} />
                  </dd>
                  <dt style={{ color: "var(--text-3)" }}>Provider ID</dt>
                  <dd>{provider.providerId}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Categoría</dt>
                  <dd>{provider.category ?? "—"}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Estado</dt>
                  <dd>{provider.active ? "Activo" : "Inactivo"}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Registrado</dt>
                  <dd>{new Date(provider.createdAt).toLocaleString()}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Último visto on-chain</dt>
                  <dd>{provider.lastSeenAt ? new Date(provider.lastSeenAt).toLocaleString() : "—"}</dd>
                </dl>
              ),
            },
            {
              id: "financial",
              label: "Financiero",
              content: (
                <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 10 }}>
                  <dt style={{ color: "var(--text-3)" }}>Precio por llamada</dt>
                  <dd>
                    {provider.priceUsdc} {provider.paymentAsset}
                  </dd>
                  <dt style={{ color: "var(--text-3)" }}>Volumen 30d</dt>
                  <dd>{financial.volume30dUsdc} USDC</dd>
                  <dt style={{ color: "var(--text-3)" }}>Pagos 30d</dt>
                  <dd>{financial.paymentCount30d}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Pagadores únicos 30d</dt>
                  <dd>{financial.uniquePayers30d}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Último pago</dt>
                  <dd>
                    {financial.lastPaymentAt
                      ? new Date(financial.lastPaymentAt).toLocaleString()
                      : "Sin pagos registrados"}
                  </dd>
                </dl>
              ),
            },
            {
              id: "kyb",
              label: "KYB",
              content: (
                <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 10 }}>
                  <dt style={{ color: "var(--text-3)" }}>Estado</dt>
                  <dd>{kyb.status}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Proveedor KYB</dt>
                  <dd>{kyb.kybProvider ?? "—"}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Tier</dt>
                  <dd>{kyb.kybTier ?? "—"}</dd>
                  <dt style={{ color: "var(--text-3)" }}>Verificado</dt>
                  <dd>{kyb.verifiedAt ? new Date(kyb.verifiedAt).toLocaleString() : "—"}</dd>
                  <dd
                    style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--text-3)", marginTop: 4 }}
                  >
                    Mock demo (anchor SEP-12 real planeado post-hackathon).
                  </dd>
                </dl>
              ),
            },
            {
              id: "trust",
              label: "Trust Score",
              content: <TrustScoreBreakdown trustScore={trustScore} />,
            },
          ]}
        />
      </div>
    </div>
  );
}
