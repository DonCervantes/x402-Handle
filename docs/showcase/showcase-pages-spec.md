# Showcase pages spec: Stripe MPP / HitPay MPP + Flovia SDK

## Goal

Create frontend showcase pages that demonstrate how an API provider integrates Flovia SDK alongside Stripe MPP and HitPay MPP.

The showcase should make three things clear:

1. The API provider adds Flovia as a single wrapper around a paid API route.
2. Stripe MPP / HitPay MPP still handle the payment flow.
3. Flovia joins payment context with API endpoint usage and shows what provider dashboards do not: route, rail, workflow, and retained API demand signals.

## Routes

Frontend pages:

```text
/showcase
/showcase/stripe-mpp
/showcase/hitpay-mpp
/showcase/solana-mpp
```

BFF showcase API endpoints:

```text
GET  /showcase/stripe-mpp/paid
GET  /showcase/hitpay-mpp/paid
GET  /showcase/solana-mpp/paid
```

The frontend calls the BFF endpoints directly. Server-side Stripe and Solana
pay routes are disabled; the public static confirmation headers are not
payment authorization. No separate API provider server is introduced for the
PoC.

## Information architecture

### `/showcase`

Purpose: overview and comparison page.

Sections:

1. Header
   - title: `Showcase: paid API analytics`
   - subtitle: Flovia connects MPP payment context with API provider usage.
2. Provider cards
   - Stripe MPP card
   - HitPay MPP card
   - each links to its dedicated page
3. Comparison table
   - payment provider
   - rail
   - payment UX
   - context available
   - Flovia join value
4. Joined analytics preview
   - payment context → endpoint usage → retained demand
   - compact Sankey or route flow visualization

### `/showcase/stripe-mpp`

Purpose: Stripe MPP-specific integration and flow verification.

Sections:

1. Header
   - title: `Stripe MPP showcase`
   - labels: `Stripe`, `MPP`, `Tempo`, `Flovia SDK`
2. Integration
   - code snippet showing one route-level Flovia wrapper
   - explanation of `attachPaymentContext(...)` for Stripe `PaymentIntent` and Tempo recipient metadata
3. Simulated flow
   - deterministic timeline that does not require live keys or wallet setup
   - steps: request started → challenge issued → token payment completed → paid API response → Flovia joined event
4. Live flow
   - `Call paid API` action
   - challenge/payment state
   - Tempo token payment / tx state
   - retry result
   - paid API response
5. What Flovia captured
   - Payment: provider, rail, amount, currency, payment intent id, recipient
   - API usage: endpoint, status, latency, request id
   - Joined insight: payment converted into paid API demand

### `/showcase/solana-mpp`

Purpose: Solana MPP-specific integration and flow verification.

Sections:

1. Header
   - title: `Solana MPP showcase`
   - labels: `Solana`, `MPP`, `SPL`, `devnet`, `Flovia SDK`
2. Integration
   - code snippet showing `Mppx.create({ methods: [solana.charge(...)] })` from `@solana/mpp/server` wrapped by `flovia.trackPaidApi(...)`
3. Simulated flow
   - deterministic timeline that does not require live wallet setup
   - steps: request started → challenge issued → SPL transfer signed → on-chain confirmation → paid API response → Flovia joined event
4. Live flow
   - `Call paid API` action against the BFF route on Solana devnet
   - 402 challenge with Solana recipient address and SPL mint
   - Server-side payment is disabled; the BFF route only exposes the payment challenge and does not hold or spend a payer key.
5. What Flovia captured
   - Payment: provider, rail, amount, currency, mint, recipient, network (`solana-devnet`)
   - API usage: endpoint, status, latency, request id
   - Joined insight: SPL token payment converted into paid API demand

### `/showcase/hitpay-mpp`

Purpose: HitPay MPP-specific integration and flow verification.

Sections:

1. Header
   - title: `HitPay MPP showcase`
   - labels: `HitPay`, `MPP`, `Checkout URL`, `QR`, `Flovia SDK`
2. Integration
   - code snippet showing `mpp.protect(...)` wrapped by `flovia.trackPaidApi(...)`
3. Simulated flow
   - deterministic timeline that does not require live checkout
   - steps: request started → challenge issued → checkout URL generated → payment completed → paid API response → Flovia joined event
4. Live flow
   - `Call paid API` action
   - checkout URL display
   - QR code generated from checkout URL
   - payment status / retry state
   - paid API response
5. What Flovia captured
   - Payment: provider, rail, amount, currency, charge/session id if available
   - API usage: endpoint, status, latency, request id
   - Joined insight: checkout payment converted into paid API demand

## Page pattern

Match the existing frontend dashboard style in `apps/frontend`:

- fixed left sidebar and topbar shell
- warm off-white app background
- white cards with hairline borders
- compact enterprise dashboard density
- muted blue and teal accents
- graphite typography
- small uppercase eyebrows
- Geist / Space Grotesk / mono-number feel
- no neon, no crypto coin visuals, no consumer checkout landing-page style

Recommended content layout per dedicated page:

```text
Header row
  ├─ title/subtitle
  └─ provider/rail/status chips

KPI row
  ├─ Payment provider
  ├─ Rail
  ├─ Paid endpoint
  └─ Join status

Two-column main grid
  ├─ Integration card with code snippet
  ├─ Simulated flow timeline
  ├─ Live flow control panel
  └─ What Flovia captured card

Bottom full-width visual
  └─ payment context → API usage → retained demand flow
```

## Integration copy

### Stripe code snippet

```ts
app.get("/showcase/stripe-mpp/paid", (c) =>
  flovia.trackPaidApi(c.req.raw, {
    provider: "stripe",
    rail: "mpp",
    endpoint: "/showcase/stripe-mpp/paid",
    amount: "1.00",
    currency: "usd",
    handler: async ({ attachPaymentContext }) => {
      const recipientAddress = await createPayToAddress(c.req.raw, {
        onPaymentIntent: ({ paymentIntent, payToAddress }) =>
          attachPaymentContext({
            provider: "stripe",
            rail: "mpp",
            paymentIntentId: paymentIntent.id,
            recipient: payToAddress,
            network: "tempo",
          }),
      });

      return runStripeMppCharge(c.req.raw, recipientAddress);
    },
  }),
);
```

### HitPay code snippet

```ts
const protectedPaid = mpp.protect(
  {
    amount: "1.00",
    currency: "sgd",
    description: "Machine payments sample",
  },
  async () => Response.json({ foo: "bar" }),
);

app.get("/showcase/hitpay-mpp/paid", (c) =>
  flovia.trackPaidApi(c.req.raw, {
    provider: "hitpay",
    rail: "mpp",
    endpoint: "/showcase/hitpay-mpp/paid",
    amount: "1.00",
    currency: "sgd",
    handler: () => protectedPaid(c.req.raw, undefined),
  }),
);
```

## Simulated vs live behavior

Use a three-layer story on each provider page:

```text
Integration → Simulated flow → Live flow
```

Why:

- Integration explains what the API provider changes.
- Simulated flow always works and demonstrates the Flovia join model.
- Live flow proves the integration can trigger the real payment flow when credentials and wallet/checkout setup are ready.

The simulated flow should not pretend to be a real transaction. It should be labeled as simulated and use demo ids such as:

```text
pi_demo_stripe_mpp_001
hitpay_demo_charge_001
req_demo_001
```

The live flow should show raw states and IDs when available, including failure states.

## Live Stripe MPP flow

Expected UX:

```text
Call paid API
  → receive MPP challenge
  → complete Tempo token payment
  → retry paid request with credential
  → receive paid API response
  → show captured Flovia event
```

Display fields:

- endpoint: `/showcase/stripe-mpp/paid`
- provider: `stripe`
- rail: `mpp`
- amount: `1.00`
- currency: `usd`
- payment intent id, if available
- Tempo recipient address, if available
- transaction / receipt reference, if available
- API response body
- status and latency

External dashboard:

- Do not embed Stripe Dashboard.
- If `paymentIntentId` is available, show an external `Open in Stripe Dashboard` link.

## Live HitPay MPP flow

Expected UX:

```text
Call paid API
  → receive HitPay MPP challenge / checkout URL
  → show checkout URL and QR code
  → user pays from phone or checkout page
  → retry/check paid request
  → receive paid API response
  → show captured Flovia event
```

Display fields:

- endpoint: `/showcase/hitpay-mpp/paid`
- provider: `hitpay`
- rail: `mpp`
- amount: `1.00`
- currency: `sgd`
- checkout URL
- QR code generated from checkout URL
- charge/session id, if available
- API response body
- status and latency

External dashboard:

- Do not embed HitPay Dashboard.
- If a charge/session id is available, show an external dashboard link if a stable URL can be constructed.

## Captured data panel

Each provider page should include a shared `What Flovia captured` panel with three columns:

```text
Payment context
  provider
  rail
  amount
  currency
  payment/session/intent id

API usage
  endpoint
  method
  status
  latency
  request id

Joined insight
  payment → route usage
  route → rail
  workflow → retained demand
```

## Event model

Use this event vocabulary in UI and BFF logs/events:

```text
paid_api.request_started
paid_api.payment_context_attached
paid_api.challenge_issued
paid_api.access_granted
paid_api.request_completed
paid_api.request_failed
```

## Image design requirements

The generated page images should resemble the existing `apps/frontend` UI, not a new brand direction:

- sidebar shell visible
- compact cards and tables
- warm off-white background
- muted blue/teal accents
- thin borders and minimal shadows
- code snippets in neutral mono blocks
- timeline/flow cards for simulated and live states
- no exaggerated crypto imagery
- no consumer payment marketing style

## Initial implementation scope

1. Build static frontend pages with simulated data first.
2. Add BFF showcase endpoints.
3. Wire live HitPay flow.
4. Wire live Stripe MPP flow.
5. Connect captured events into existing route analytics/read model.
