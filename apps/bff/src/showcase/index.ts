import { handleHitPayMppPaidShowcase } from "./hitpay-mpp-paid";
import { handleSolanaMppPaidShowcase } from "./solana-mpp-paid";
import { handleStripeMppPaidShowcase } from "./stripe-mpp-paid";

export const showcaseRoutes = new Set([
  "/showcase/stripe-mpp/paid",
  "/showcase/hitpay-mpp/paid",
  "/showcase/solana-mpp/paid",
]);

export const handleShowcaseRoute = (
  request: Request,
  path: string,
): Promise<Response> | Response | null => {
  switch (path) {
    case "/showcase/stripe-mpp/paid":
      return handleStripeMppPaidShowcase(request);
    case "/showcase/hitpay-mpp/paid":
      return handleHitPayMppPaidShowcase(request);
    case "/showcase/solana-mpp/paid":
      return handleSolanaMppPaidShowcase(request);
    default:
      return null;
  }
};
