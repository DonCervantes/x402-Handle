# 🌐 HANDLE Service Registration & Discovery Specification

> Guide and format specification for registering, indexing, and verifying x402-compliant paid services within the HANDLE discovery and trust layer.

---

## 1. Overview

**HANDLE** is the discovery and reputation layer for agentic x402 micropayments. It bridges service discovery, payment requirements, and verifiable on-chain reputation:

1. **Discovery**: Allows autonomous software agents and client applications to discover payment-gated APIs, tools, and feeds without manual account creation or API-key provisioning.
2. **Standardization**: Uses HTTP `402 Payment Required` challenge-response mechanics, machine-readable manifests, OpenAPI 3.0 contracts, and Model Context Protocol (MCP) tool descriptors.
3. **Trust & Verification**: Deterministically ranks services using verifiable on-chain payment history, uptime, provider identity attestations, and audit signals.

HANDLE supports discovery through two complementary channels:
- **HTTP-native x402 Discovery & Facilitator Crawling**: Machine-readable discovery endpoints exposed directly by the service host (`/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/mcp/tools`) and facilitator registries (e.g. Coinbase CDP Facilitator).
- **On-chain Registry (Stellar Soroban)**: Canonical on-chain provider registry (`contracts/soroban-registry`) for immutable service registration, payment attestation (`log_payment`), and trust score anchoring.

---

## 2. HTTP Discovery Endpoints Specification

For automated crawlers and agent frameworks to discover and index a service, providers should expose four standard discovery endpoints on their root domain:

```
https://<your-service-host>/
├── /.well-known/x402    # x402 protocol manifest & payment config
├── /openapi.json        # OpenAPI 3.0 spec with 402 payment requirements
├── /llms.txt            # Markdown overview optimized for LLM agents
└── /mcp/tools           # Model Context Protocol (MCP) tool manifest
```

### 2.1 `/.well-known/x402` — Protocol Manifest

The manifest informs agents and discovery crawlers about payment facilitation, supported networks, settlement tokens, and paid endpoints.

```json
{
  "version": "1.0",
  "name": "Crypto Intelligence & Market Data API",
  "description": "Live x402 paid crypto intelligence, portfolio tracking, and MCP agent tools.",
  "facilitator": "https://api.cdp.coinbase.com/platform/v2/x402",
  "payTo": "0x16717295184B30b2c34988e402C402C402c40201",
  "chain": "base",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "currency": "USDC",
  "discovery": {
    "openapi": "https://x402.167-172-95-184.nip.io/openapi.json",
    "llms": "https://x402.167-172-95-184.nip.io/llms.txt",
    "mcp": "https://x402.167-172-95-184.nip.io/mcp/tools"
  },
  "endpoints": [
    {
      "path": "/price",
      "method": "GET",
      "priceUsd": 0.01,
      "amount": "10000",
      "scheme": "exact",
      "description": "Live cryptocurrency spot prices"
    },
    {
      "path": "/price/{coin}",
      "method": "GET",
      "priceUsd": 0.01,
      "amount": "10000",
      "scheme": "exact",
      "description": "Token spot price by symbol"
    },
    {
      "path": "/portfolio",
      "method": "GET",
      "priceUsd": 0.05,
      "amount": "50000",
      "scheme": "exact",
      "description": "Portfolio balance and asset distribution"
    },
    {
      "path": "/opportunities/latest",
      "method": "GET",
      "priceUsd": 0.10,
      "amount": "100000",
      "scheme": "exact",
      "description": "Latest market and yield opportunities"
    },
    {
      "path": "/audit/x402",
      "method": "GET",
      "priceUsd": 0.05,
      "amount": "50000",
      "scheme": "exact",
      "description": "x402 audit trail and settlement verification"
    },
    {
      "path": "/receipt/verify",
      "method": "POST",
      "priceUsd": 0.01,
      "amount": "10000",
      "scheme": "exact",
      "description": "Payment receipt verification"
    },
    {
      "path": "/mcp/call",
      "method": "POST",
      "priceUsd": 0.05,
      "amount": "50000",
      "scheme": "exact",
      "description": "Model Context Protocol tool invocation"
    },
    {
      "path": "/briefing/morning",
      "method": "GET",
      "priceUsd": 0.25,
      "amount": "250000",
      "scheme": "exact",
      "description": "Daily morning market intelligence briefing"
    },
    {
      "path": "/research/{topic}",
      "method": "GET",
      "priceUsd": 1.00,
      "amount": "1000000",
      "scheme": "exact",
      "description": "Comprehensive market research by topic"
    }
  ]
}
```

### 2.2 `/openapi.json` — OpenAPI 3.0+ Specification

Providers should document each paid route including its HTTP `402` payment challenge response:

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "Crypto Intelligence API",
    "version": "1.0.0",
    "description": "x402 paid crypto intelligence and portfolio endpoints"
  },
  "servers": [
    { "url": "https://x402.167-172-95-184.nip.io" }
  ],
  "paths": {
    "/price": {
      "get": {
        "summary": "Get latest cryptocurrency prices",
        "responses": {
          "200": {
            "description": "Successful price payload",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "prices": { "type": "object" },
                    "timestamp": { "type": "string" }
                  }
                }
              }
            }
          },
          "402": {
            "description": "Payment Required",
            "headers": {
              "WWW-Authenticate": {
                "schema": { "type": "string" },
                "description": "x402 payment challenge or facilitator redirection"
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": { "type": "string", "example": "Payment Required" },
                    "amount": { "type": "string", "example": "10000" },
                    "asset": { "type": "string", "example": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
                    "network": { "type": "string", "example": "eip155:8453" },
                    "payTo": { "type": "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### 2.3 `/llms.txt` — LLM-Readable Context

AI agent runtimes inspect `/llms.txt` to quickly infer tool capabilities and costs:

```markdown
# Crypto Intelligence API (x402 Paid)

> Real-time crypto intelligence, portfolio balances, and market research.

## Payment Information
- Settlement: USDC on Base (Chain ID 8453)
- Contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Protocol: x402 HTTP challenge-response
- Facilitator: Coinbase CDP (https://api.cdp.coinbase.com/platform/v2/x402)

## Available Endpoints & Costs
- GET /price: $0.01 USDC — Current spot prices
- GET /price/{coin}: $0.01 USDC — Price by coin symbol
- GET /portfolio: $0.05 USDC — Wallet & asset balance summary
- GET /opportunities/latest: $0.10 USDC — Yield and arbitrage opportunities
- GET /audit/x402: $0.05 USDC — Payment & settlement verification logs
- POST /receipt/verify: $0.01 USDC — Proof-of-payment validation
- POST /mcp/call: $0.05 USDC — Direct MCP tool execution
- GET /briefing/morning: $0.25 USDC — Morning macro briefing
- GET /research/{topic}: $1.00 USDC — Deep research report by topic
```

### 2.4 `/mcp/tools` — Model Context Protocol Tools Manifest

For agentic frameworks supporting Anthropic's Model Context Protocol (MCP):

```json
{
  "tools": [
    {
      "name": "get_crypto_price",
      "description": "Fetch live cryptocurrency price via x402 payment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "coin": { "type": "string", "description": "Asset symbol (e.g. BTC, ETH)" }
        },
        "required": ["coin"]
      },
      "payment": {
        "priceUsdc": 0.01,
        "amount": "10000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "network": "eip155:8453"
      }
    }
  ]
}
```

---

## 3. Facilitator Discovery Item Format (CDP Ingestion)

When registered through the **Coinbase CDP Facilitator** (`https://api.cdp.coinbase.com/platform/v2/x402`), HANDLE ingests endpoint entries matching this canonical JSON schema:

```json
{
  "resource": "https://x402.167-172-95-184.nip.io/price",
  "description": "Real-time cryptocurrency price feed via x402 micropayment",
  "lastUpdated": "2026-10-20T12:00:00.000Z",
  "accepts": [
    {
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x16717295184B30b2c34988e402C402C402c40201",
      "amount": "10000",
      "scheme": "exact",
      "network": "eip155:8453"
    }
  ],
  "extensions": {
    "bazaar": true
  }
}
```

- `resource` *(string, required)*: The absolute URL of the paywalled resource.
- `description` *(string, required)*: Clear, human and agent-readable summary of the resource.
- `lastUpdated` *(string, ISO-8601)*: Timestamp when the endpoint pricing or definition was updated.
- `accepts` *(array, required)*: Payment terms:
  - `asset`: Token contract address (or native symbol).
  - `payTo`: Recipient wallet address.
  - `amount`: Cost in token atomic units (e.g. 6 decimals for USDC: `10000` = $0.01 USDC).
  - `scheme`: Payment scheme (`exact`, `batch-settlement`, `upto`).
  - `network`: CAIP-2 network identifier (`eip155:8453` for Base, `eip155:1` for Ethereum, `solana:...`, `stellar:...`).
- `extensions`: Optional markers (e.g., `bazaar: true` for input/output schema presence).

---

## 4. On-Chain Registry Format (Stellar Soroban)

For decentralized trust, identity attestation, and verifiable reputation, providers can register on-chain in the **HANDLE Soroban Registry** (`contracts/soroban-registry`).

### 4.1 Smart Contract Call

```rust
register_provider(
    env: Env,
    owner: Address,            // Provider's Stellar account (signs tx)
    name: String,              // Human-readable service name
    endpoint: String,          // Base URL (e.g., "https://x402.167-172-95-184.nip.io")
    price_stroops: u64,        // Base call cost in stroops (1 USDC = 10^7 stroops)
    payment_token: Address,    // Stellar USDC SAC contract address
    metadata_hash: BytesN<32>, // SHA-256 hash of canonical JSON metadata
    category: Symbol,          // e.g. symbol_short!("data"), symbol_short!("fintech")
) -> u64                       // Assigned provider_id
```

### 4.2 Canonical Metadata Format (`metadata_hash`)

The `metadata_hash` argument is the SHA-256 digest of the following canonical JSON document stored on IPFS or served from your discovery endpoints:

```json
{
  "name": "Crypto Intelligence API",
  "endpoint": "https://x402.167-172-95-184.nip.io",
  "description": "Live x402 paid crypto market intelligence, portfolio tracking, and MCP agent tools.",
  "category": "fintech",
  "priceUsdc": 0.01,
  "owner": "GDEMO...",
  "discovery": {
    "manifest": "https://x402.167-172-95-184.nip.io/.well-known/x402",
    "openapi": "https://x402.167-172-95-184.nip.io/openapi.json",
    "llms": "https://x402.167-172-95-184.nip.io/llms.txt",
    "mcp": "https://x402.167-172-95-184.nip.io/mcp/tools"
  },
  "settlement": {
    "facilitator": "https://api.cdp.coinbase.com/platform/v2/x402",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }
}
```

---

## 5. Trust Score & Verification Pipeline

HANDLE evaluates services using a deterministic, explainable Trust Score ($0$ to $100$):

$$\text{TrustScore} = \text{round}\left(100 \cdot (w_1 \cdot \text{age} + w_2 \cdot \text{volume} + w_3 \cdot \text{kyb} + w_4 \cdot \text{claims} + w_5 \cdot \text{recency})\right)$$

| Component | Weight | Calculation | Description |
|---|---|---|---|
| **Volume** | $0.30$ | $\min(1, \log_{10}(\text{vol}_{30\text{d}} + 1) / 4)$ | 30-day settled payment volume |
| **KYB** | $0.30$ | Verified: $1.0$, Pending: $0.3$, None: $0.0$ | Business verification attestation |
| **Age** | $0.15$ | $\min(1, \text{days\_since\_reg} / 90)$ | Proven uptime and stability |
| **Claims** | $0.15$ | $1 - \min(1, \text{disputes} / \text{payments})$ | Success and dispute-free rate |
| **Recency** | $0.10$ | $\le 7\text{d}: 1.0, \le 30\text{d}: 0.5, > 30\text{d}: 0.0$ | Active transaction recency |

Settled on-chain transactions (such as verified CDP facilitator receipts or Soroban `log_payment` events) directly feed the volume and recency score components, enabling active providers to rapidly build reputational authority.

---

## 6. How to Submit Your Service for Indexing

1. **Host Discovery Endpoints**: Ensure your server responds with valid JSON/text at `/.well-known/x402`, `/openapi.json`, `/llms.txt`, and `/mcp/tools`.
2. **Register with Facilitator**: Register endpoints with your designated x402 facilitator (e.g. Coinbase CDP or Stellar x402 facilitator).
3. **Submit to HANDLE**: Open a PR or issue referencing your live URL. HANDLE's discovery crawler parses your manifest and indexes all endpoints into `discoveries/` and the BFF catalog.
