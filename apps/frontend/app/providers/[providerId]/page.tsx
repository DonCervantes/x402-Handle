export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { getStellarProviderIntelligence } from "@/lib/api/client";
import { ProviderDetail } from "@/components/stellar/ProviderDetail";

// URL uses "--" as separator instead of "/" (Next.js decodes %2F before routing).
// Sub-routes (customers, api-growth, etc.) use legacy ids without "--", no collision.
export default async function StellarProviderDetailPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;
  if (!providerId.includes("--")) notFound();
  const realId = providerId.replace("--", "/");

  const intelligence = await getStellarProviderIntelligence(realId);
  if (!intelligence) notFound();

  return <ProviderDetail intelligence={intelligence} />;
}
