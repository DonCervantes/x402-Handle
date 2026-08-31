> **⚠️ Legacy document.** This file describes the earlier Flovia PoC frontend (Solana/EVM era).
> The project has since pivoted to **HANDLE / Stellar**. For current architecture, see the [root README](../../README.md).

# Flovia PoC Frontend (Legacy — Solana/EVM era)

This is a prototype UI for x402 Co-usage Discovery, built with Next.js 15 (App Router), React 19, TypeScript, and Tailwind CSS v4.

## Usage

Required tool: **Bun 1.3.13+**. This app runs as the monorepo `apps/frontend` workspace and expects `apps/bff` to be running at `http://localhost:3001` as its data source.

```bash
bun install
bun --filter frontend dev
```

Open [http://localhost:3000](http://localhost:3000). On first access localStorage is empty, so three demo providers for the sidebar are seeded. You can also add your own `pay_to` from Setup.

### Connect to BFF

Each screen (Customers / Wallet 360° / Patterns) fetches BFF directly from Server Components. The Server Component target can be overridden with `BFF_URL` (default: `http://localhost:3001`). For browser-side calls, use `NEXT_PUBLIC_BFF_URL` (default: `/api`), which is forwarded to BFF through the rewrite in `next.config.ts`.

```bash
BFF_URL=http://localhost:3001 NEXT_PUBLIC_BFF_URL=/api bun --filter frontend dev
```

The PoC BFF returns only customer projections at payer wallet level and does not split scope by provider. The sidebar `providerId` works only as a display identifier in localStorage; data shown in screens is aggregated across the full BFF dataset.

#### BFF startup and demo data

BFF lives in the same monorepo at `apps/bff`. On request path it does not call live RPC / external services, and returns prepared fixtures / projections as a read-only demo API.

```bash
bun install
bun --filter bff start
```

You can start BFF and frontend together with Docker Compose.

```bash
docker compose up --build
```

If `3000` is in use, change the host port.

```bash
FRONTEND_PORT=3002 docker compose up --build
```

Other scripts:

| Command | Description |
| --- | --- |
| `bun --filter frontend build` | Production build (`.next/`) |
| `bun --filter frontend start` | Start production build |
| `bun --filter frontend typecheck` | `tsc --noEmit` |
| `bun --filter frontend verify` | typecheck + test |

## Routing

| Path | Purpose |
| --- | --- |
| `/setup` | Register and manage providers (`pay_to`). Saved in localStorage |
| `/providers/[providerId]/customers` | Customer wallet list for the provider |
| `/providers/[providerId]/wallet/[address]` | Wallet 360° (main screen). Activity Timeline + Co-usage Map + Insight stack |
| `/providers/[providerId]/patterns` | Aggregated view. Co-usage shown with Bubble Chart. Retention / Workflow Clusters are not implemented |
| `/` | Redirect to Customers of the first Provider in localStorage, or to `/setup` if none exists |

## Directory structure

```
apps/frontend/
├── app/                              # Next.js App Router
│   ├── layout.tsx                    # font + context providers
│   ├── page.tsx                      # root (dynamic redirect)
│   ├── globals.css                   # CSS variables + Tailwind v4 @theme + utility classes
│   ├── providers.tsx                 # Provider context (localStorage hydration)
│   ├── setup/
│   │   ├── layout.tsx
│   │   └── page.tsx
│   └── providers/[providerId]/
│       ├── layout.tsx                # shell with sidebar
│       ├── customers/page.tsx
│       ├── wallet/[address]/page.tsx
│       └── patterns/page.tsx
├── components/
│   ├── ui/                           # Icon, FreeTierBar
│   ├── shell/                        # Sidebar, TopBar
│   ├── setup/                        # SetupForm, SavedProviderList, Field
│   ├── customers/                    # CustomersTable, CustomersHeader, SummaryChip, Toolbar, UpsellPill, Select
│   ├── wallet/                       # WalletScreen, IdentityBar, ActivityTimeline, Insights, InsightCard, KPI, Stat
│   └── patterns/                     # PatternsScreen, BubbleChart
├── lib/
│   ├── api/
│   │   ├── client.ts                 # fetch wrapper for BFF (no-store)
│   │   ├── adapters.ts               # canonical BFF response -> UI view model
│   │   └── types.ts                  # UI view model types
│   ├── types.ts                      # StoredProvider-related (for localStorage)
│   ├── storage.ts                    # localStorage read/write (SSR-safe)
│   ├── providers.ts                  # slugify, seed, UI helpers
│   └── format.ts                     # formatAtomic, formatRatioPct, formatGrowth, classNames, shortAddr
└── ...
```

## Design direction

Color, spacing, and typography are unified via CSS variables defined in `app/globals.css` under `:root`. They are re-exposed as Tailwind v4 `@theme` tokens (`bg-mesh-blue`, `text-text-1`, ...) so new code can use Tailwind utilities, while existing inline styles like `style={{ color: "var(--mesh-blue)" }}` still work.

Color meanings:

| Role | Value | Tailwind |
| --- | --- | --- |
| Primary accent (blue) | `--mesh-blue` `#2563EB` | `bg-mesh-blue` |
| Secondary accent (teal) | `--teal` `#0D9488` | `bg-teal` |
| Warning | `--warn` `#B45309` | `bg-warn` |
| Base surface | `--bg-shell` `#F6F7F9` | `bg-bg-shell` |
| Primary text | `--text-1` `#0F172A` | `text-text-1` |

## localStorage

Providers added in Setup are stored under key `flovia:providers` as `StoredProvider[]`. See [`lib/types.ts`](lib/types.ts) for the shape. On first visit, if `flovia:initialized` sentinel is not set, three demo entries are seeded. Clearing localStorage manually will trigger reseeding.

## Deployment

Current standard startup is monorepo Docker Compose. To validate against the same contract and fixtures as BFF, workspace-level validation is prioritized over standalone frontend deployment.
