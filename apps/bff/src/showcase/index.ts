import { handleHitPayMppPaidShowcase } from "./hitpay-mpp-paid";
import { withShowcasePayAuth } from "./pay-authorization";
import { handleSolanaMppPaidShowcase, handleSolanaMppPayShowcase } from "./solana-mpp-paid";
import { handleStripeMppPaidShowcase, handleStripeMppPayShowcase } from "./stripe-mpp-paid";

export const showcaseRoutes = new Set([
  "/showcase/stripe-mpp/paid",
  "/showcase/stripe-mpp/pay",
  "/showcase/hitpay-mpp/paid",
  "/showcase/solana-mpp/paid",
  "/showcase/solana-mpp/pay",
]);

export const handleShowcaseRoute = (
  request: Request,
  path: string,
): Promise<Response> | Response | null => {
  switch (path) {
    case "/showcase/stripe-mpp/paid":
      return handleStripeMppPaidShowcase(request);
    case "/showcase/stripe-mpp/pay":
      return withShowcasePayAuth(request, handleStripeMppPayShowcase);
    case "/showcase/hitpay-mpp/paid":
      return handleHitPayMppPaidShowcase(request);
    case "/showcase/solana-mpp/paid":
      return handleSolanaMppPaidShowcase(request);
    case "/showcase/solana-mpp/pay":
      return withShowcasePayAuth(request, handleSolanaMppPayShowcase);
    default:
      return null;
  }
};
