"use client";

type AddressChipProps = {
  address: string;
  /** Stellar `G...` accounts and contract `C...` ids are both 56 chars; truncate the same way. */
  leading?: number;
  trailing?: number;
};

function truncate(address: string, leading: number, trailing: number): string {
  if (address.length <= leading + trailing + 1) return address;
  return `${address.slice(0, leading)}…${address.slice(-trailing)}`;
}

export function AddressChip({ address, leading = 6, trailing = 6 }: AddressChipProps) {
  return (
    <button
      type="button"
      title={address}
      onClick={() => navigator.clipboard?.writeText(address)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: "var(--radius)",
        border: "1px solid var(--line)",
        background: "var(--surface-card)",
        color: "var(--text-2)",
        fontFamily: "var(--mono)",
        fontSize: 12,
        cursor: "pointer",
        lineHeight: 1.6,
      }}
    >
      {truncate(address, leading, trailing)}
    </button>
  );
}
