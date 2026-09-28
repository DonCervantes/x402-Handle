import type { TrustScore } from "contracts";
import { ScoreRing } from "./ScoreRing";

const FACTOR_LABELS: Record<keyof TrustScore["components"], string> = {
  age: "Antigüedad",
  volume: "Volumen 30d",
  kyb: "KYB",
  claims: "Disputas (próximamente)", // #73: sin fuente de disputas, el factor no puntúa
  recency: "Actividad reciente",
};

function Bar({ value, weight }: { value: number; weight: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: "var(--radius-sm)",
          background: "var(--surface-muted)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(value * 100)}%`,
            height: "100%",
            background: "var(--mesh-blue)",
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: "var(--text-3)", width: 32, textAlign: "right" }}>
        ×{weight}
      </span>
    </div>
  );
}

export function TrustScoreBreakdown({ trustScore }: { trustScore: TrustScore }) {
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
      <ScoreRing score={trustScore.score} size={88} label="Trust Score" />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
        {Object.entries(trustScore.components).map(([key, value]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)", width: 130 }}>
              {FACTOR_LABELS[key as keyof TrustScore["components"]]}
            </span>
            <Bar value={value} weight={trustScore.weights[key as keyof TrustScore["weights"]]} />
          </div>
        ))}
        <span style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
          Calculado {new Date(trustScore.computedAt).toLocaleString()} — fórmula determinística,
          no ML.
        </span>
      </div>
    </div>
  );
}
