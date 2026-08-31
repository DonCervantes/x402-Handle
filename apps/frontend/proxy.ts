import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// The BFF gates LLM / upsell customer routes behind BFF_LLM_API_KEY. When the
// frontend is configured with the same key (server-side), forward it as the
// x-llm-api-key header so the gated demo keeps working. When unset, the
// request passes through and the BFF returns 403 (routes disabled on public
// demos unless gated).
const LLM_API_KEY = process.env.BFF_LLM_API_KEY;

export function proxy(request: NextRequest) {
  if (!LLM_API_KEY) {
    return NextResponse.next();
  }
  const headers = new Headers(request.headers);
  headers.set("x-llm-api-key", LLM_API_KEY);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/customers/:address/llm/:path*"],
};
