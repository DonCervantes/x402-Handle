# Auditoría end-to-end — DonCervantes/x402-Handle

| Campo | Valor |
| --- | --- |
| Repositorio | [DonCervantes/x402-Handle](https://github.com/DonCervantes/x402-Handle) |
| HEAD auditado | `5ae52a2495b6c7d28bae498ad8bdcbcd57d4767b` (branch `main`, 2026-07-01) |
| Producto declarado | HANDLE — discovery and trust layer for agentic x402 payments on Stellar (SCF hackathon) |
| Código heredado | Fork/rename de **Flovia** (PoC x402 × MPP × Solana) |
| Fecha de auditoría | 2026-08-26 |
| Alcance | Código, contratos Soroban, BFF, frontend, CI/CD, docs, higiene del repo. Sin pentest en vivo ni secrets de GitHub Actions. |

---

## 1. Resumen ejecutivo

HANDLE es un monorepo Bun/TypeScript con un contrato Soroban (`contracts/soroban-registry`), middleware x402 sobre Stellar (`packages/x402-stellar`), BFF, frontend Next.js y un indexer hacia Postgres. El núcleo de **descubrimiento + pago USDC en Stellar** está esbozado y es creíble como demo de hackathon.

No está listo para producción ni para presentar como “trust layer” verificable:

1. El middleware **emite `expires_at` pero no lo aplica**, y **acepta el memo que manda el cliente** (header o query) en lugar de un challenge persistido en servidor.
2. El anti-replay es un **Map en memoria con TTL 24h**: tras el TTL (o un restart / segunda instancia) la misma `tx_hash` puede volver a comprar el recurso.
3. `log_payment` en Soroban es **público**: cualquiera infla volumen y, con KYB mock + disputas siempre en 0, el Trust Score se puede sesgar.
4. `POST /stellar/playground/pay` y los pay de showcase **gastan wallets del servidor sin autenticación real**.
5. El README raíz, Lightsail, showcase Solana/Stripe y `docs/status.md` siguen siendo **Flovia/Solana**, en contradicción con el pitch Stellar-only.

**No se encontraron private keys live commiteadas.** `.env` y `accounts.local.md` están en gitignore.

### Veredicto

| Dimensión | Nota | Comentario |
| --- | --- | --- |
| Madurez de producto | PoC / hackathon | Rename incompleto; dualidad Flovia + HANDLE |
| Seguridad de pagos x402 | Insuficiente | Expiry, binding de memo, replay |
| Trust / KYB | Cosmético | Mock SEP-12, claims=0, `log_payment` abierto |
| API BFF | Riesgo alto si se expone | Pay drains + LLM sin auth; CORS/rate-limit ausentes |
| Contratos | Incompleto para trust | Admin muerto; log público |
| Ingeniería / CI | Parcial | `verify` no cubre x402-stellar, agent-sdk ni `cargo test` |
| Documentación | Divergente | README Solana vs landing “no EVM, no Solana” |

---

## 2. Arquitectura observada

```
Agente / UI
    │
    ├─ apps/frontend (Next.js) ──rewrite──► apps/bff
    │                                            │
    ├─ packages/agent-sdk ──402──► provider HTTP (apps/demo-provider)
    │                                  │
    │                                  ▼
    │                           packages/x402-stellar
    │                           (Horizon verify + replay Map)
    │                                  │
    │                                  ▼
    └─ contracts/soroban-registry ◄── log_payment (sin auth)
                 │
                 ▼
         apps/cli/indexer.ts ──► Postgres (Supabase)
```

Workspaces: `apps/{bff,cli,data,demo-provider,frontend}`, `packages/{agent-sdk,contracts,intelligence,sources,x402-stellar}`.

CI (`bun run verify`) solo recorre: contracts, sources, intelligence, cli, data, bff, frontend. **Quedan fuera** `x402-stellar`, `agent-sdk`, `demo-provider` y el crate Rust.

---

## 3. Lo que está bien

- Verificación de pago **consulta Horizon**; no confía el monto/destino solo en el body del cliente.
- Refresh AEO usa `timingSafeEqual` y se deshabilita si `BFF_X402_REFRESH_TOKEN` está vacío.
- Queries Postgres en BFF usan tagged templates de Bun (menor riesgo de SQLi clásico).
- Gitignore cubre `.env`, DBs y reports.
- Hay tests de intelligence/trust, BFF routes y frontend; Biome formatea en CI.
- Deploy Lightsail usa llave SSH efímera y `chmod 600` (patrón razonable).
- El contrato marca `tx_hash` como consumido on-chain **si** alguien llama `log_payment` (útil, pero no sustituye auth).

---

## 4. Hallazgos (por severidad)

### Críticos

#### C1. `expires_at` del challenge nunca se valida

`packages/x402-stellar/src/server.ts` escribe TTL (default 300s) en el 402. `types.ts` define `challenge_expired`. Ni `server.ts` ni `verify.ts` comparan el reloj con `expires_at`. Un pago con un memo “viejo” (o inventado) sigue siendo válido si Horizon muestra esa memo y el USDC correcto.

**Impacto:** challenges eternos; el TTL es cosmética.

**Fix:** persistir memo → `{expires_at, amount, destination}` y rechazar expirados/desconocidos **antes** de Horizon.

#### C2. Memo elegido por el cliente, no por el servidor

Tras el 402 el servidor **olvida** el memo. En el cobro acepta `X-PAYMENT: hash;memo=...` o `?memo=`. Cualquiera que pague USDC al `destination` con un memo que elija puede redimir el recurso, sin haber recibido ese challenge.

**Impacto:** no hay binding challenge↔pago; un pago “genérico” al merchant se reutiliza como x402.

**Fix:** store de challenges emitidos; rechazar memos no emitidos; quitar fallback de query string.

#### C3. Replay cache con TTL 24h + memoria de proceso

`replay-cache.ts`: si `Date.now() - consumedAt > ttl`, `has()` borra y devuelve `false`. Tras 24h (o restart, o segunda réplica) la misma `tx_hash` compra de nuevo. `has()` + `verify` + `add()` además tiene **TOCTOU**: dos requests paralelos pueden pasar ambos el `has()`.

**Fix:** set duradero (Redis/Postgres) **sin** expirar IDs de pago exitosos; `add` atómico (SET NX); opcionalmente exigir `TxConsumed` on-chain antes de `next()`.

#### C4. `POST /stellar/playground/pay` sin auth

`apps/bff/src/http.ts` (~280–287): cualquier POST con `{ providerId }` ejecuta `runPlaygroundPayment`, que firma con `DEMO_AGENT_SECRET`. El frontend reescribe `/api` al BFF.

**Impacto:** drenaje de la wallet demo en testnet (o peor si se configura mainnet).

**Fix:** sesión/CAPTCHA/API key, cupo diario, desactivar en deploys públicos.

#### C5. Showcase pay con header estático

`x-flovia-showcase-pay: solana-mpp` / `stripe-mpp` no es secreto. Si existen `SOLANA_MPP_PAYER_PRIVATE_KEY` o `MPPX_PRIVATE_KEY` en Lightsail, un POST las gasta.

**Fix:** secret rotatorio, CSRF, rate-limit, no inyectar payer keys en el path HANDLE.

#### C6. `log_payment` público en Soroban

```265:267:contracts/soroban-registry/src/lib.rs
    /// Loguea un pago. Cualquiera puede llamar; la protección es
    /// la unicidad de `tx_hash` (replay-proof).
```

No hay prueba de que el pago existiera en Horizon ni de que el `amount`/`payer` sean reales. El indexer persiste `pay_log` y alimenta volumen del Trust Score.

**Fix:** `require_auth` del owner del provider o de un oracle allowlisteado; no confiar el amount del caller.

---

### Altos

#### A1. Montos con `Number()` (IEEE-754)

`verify.ts` compara `Number(payment.amount) < Number(opts.expected.amountUsdc)`. `onchain-log.ts` hace `BigInt(Math.round(Number(payment.amount) * 10_000_000))`. Riesgo de redondeo / underpay sutil.

**Fix:** stroops `BigInt` o decimal de escala fija.

#### A2. Solo la primera payment op cuenta

`.find()` sobre `payment` / `path_payment_*`. Un decoy primero + pago real después (o al revés) puede saltarse checks. `path_payment` usa campos de amount distintos a `payment`.

**Fix:** exigir una sola op de pago que cumpla todo, o escanear **todas** y requerir un match completo; mapear amount por tipo de op.

#### A3. Agent SDK paga al `destination` del 402 del endpoint

No cruza con `owner` del registry. Un provider registrado con endpoint malicioso desvía USDC.

**Fix:** pin de destination on-chain; HTTPS allowlist; network pin.

#### A4. BFF sin CORS explícito ni rate limiting

`Bun.serve({ fetch })` sin política CORS ni límites. Playground, LLM y refresh son abusables.

#### A5. Rutas LLM / upsell sin autenticación

Si Bedrock/Qvac está configurado, cualquiera que alcance el BFF (o el rewrite de Next) genera costo.

#### A6. KYB mock presentado como señal de trust

`packages/sources/src/kyb/mock.ts`: “Reemplazar en mes 1-3”. Providers 1–3 salen `verified`. Landing habla de KYB real.

#### A7. Factor claims siempre perfecto

`getDisputeCount` retorna 0. Con cualquier pago, `claimsFactor` → 1.0 (15% del score “limpio”).

#### A8. Cliente x402 no espera confirmación Horizon

`confirmationTimeoutMs` existe; tras `submitTransaction` reintenta con `X-PAYMENT` al momento → `tx_not_found` / carreras.

---

### Medios

#### M1. `onchain-log`: `while (status === "NOT_FOUND")` sin tope

Puede colgar el proceso del provider.

#### M2. Indexer no maneja `prov_off` / `prov_on`

Providers desactivados pueden quedar `active` en Postgres.

#### M3. Cursor de ledger (`POLL_LIMIT = 1000`) frágil

Huecos o re-scan bajo carga; falta paginar hasta vaciar la ventana.

#### M4. Stub SEP-12: `anchorBaseUrl` arbitrario (SSRF futuro)

#### M5. README raíz = Flovia × Solana; landing = Stellar-only

#### M6. Showcase Solana/Stripe y secrets Lightsail siguen en el path de deploy

Incluye fallback `MAIN_HITPAY_*` → `DEVELOP_HITPAY_*` (prod hereda sandbox).

#### M7. CI no testea el código de pago ni Soroban

`packages/x402-stellar` **cero tests** pese a que el README del paquete dice `bun test`.

#### M8. Admin del contrato no se usa tras `initialize`

No hay pause, transfer admin, ni allowlist de loggers.

#### M9. `docs/status.md` afirma BFF “solo GET / 405 en no-GET”

El código ya tiene POSTs (playground, AEO refresh, showcase). Docs de arquitectura desactualizados.

#### M10. `vercel.json` construye solo frontend

`outputDirectory: ".next"` en raíz es frágil en monorepo; BFF no viaja en ese deploy → páginas `force-dynamic` contra localhost/BFF ausente.

---

### Bajos / higiene

| ID | Hallazgo |
| --- | --- |
| L1 | `/health` expone memoria, commit, startedAt |
| L2 | `DEMO_PROVIDER_SECRET!` sin guard |
| L3 | Packages `@flovia/*`, servicio `flovia-bff`, memos `fl-*` |
| L4 | Solana MPP secret cae a `crypto.randomBytes` si falta env |
| L5 | Biome **linter disabled** (`biome.json`) |
| L6 | Sin `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, Dependabot, CODEOWNERS |
| L7 | `main` **no protegida**; 1 issue abierto (API x402 en **Base**, no Stellar) |
| L8 | `CLAUDE.md` vacío (9 bytes); AGENTS.md aún asume Flovia/cli-first |
| L9 | Sin secret scanning en CI |
| L10 | `verify.ts` usa `any` en Horizon tx/ops |

---

## 5. Flujo de pago (donde se rompe)

```
1. GET recurso sin X-PAYMENT
      → 402 { memo, expires_at, amount, destination }     [memo no se guarda]
2. Agente paga USDC en Stellar con algún memo
3. POST recurso  X-PAYMENT: tx;memo=<lo que el cliente quiera>
      → Horizon: tx ok, memo match (el que dijo el cliente), amount Number()
      → replay Map.has (TTL 24h, RAM)
      → next() + opcional log_payment (cualquiera puede mentir amount)
4. Indexer pay_log → volumen → Trust Score (KYB mock, disputes=0)
```

El eslabón débil no es Horizon; es **estado de challenge + replay + autenticación del log + honestidad del score**.

---

## 6. Producto vs código

| Promesa (landing / SCF) | Realidad en `main` |
| --- | --- |
| HANDLE, Stellar-only, no EVM/Solana | README Flovia/Solana; showcase Stripe/Solana; collectors Goldrush/Dune |
| Trust layer + KYB | Mock + claims=0 + log público |
| Registry on-chain de providers | Existe; admin inútil; deactivate no indexado |
| SDK para agentes | Paga el 402 ciegamente |
| Demo playground | Funciona… y es un faucet abierto |

Issue GitHub existente [#1](https://github.com/DonCervantes/x402-Handle/issues/1): alguien ofrece indexar un API x402 en **Base/USDC**. El producto HANDLE no tiene un formato de registro documentado para terceros (y el README no explica HANDLE).

---

## 7. Prioridad de remediación

1. Binding + expiry de challenges; replay duradero y atómico (C1–C3).
2. Cerrar pay drains (C4–C5) antes de cualquier URL pública.
3. Autorizar `log_payment`; etiquetar KYB/claims como demo (C6, A6, A7).
4. Montos en stroops; ops completas; pin de destination en el SDK (A1–A3).
5. Tests + CI de `x402-stellar`, `agent-sdk`, `cargo test` (M7).
6. README HANDLE, quitar Solana del deploy, LICENSE/SECURITY, branch protection (M5–M6, L6–L7).

---

## 8. Issues sugeridas (28) para mejorar el proyecto

Abiertas en GitHub como [#2](https://github.com/DonCervantes/x402-Handle/issues/2)–[#29](https://github.com/DonCervantes/x402-Handle/issues/29) (la [#1](https://github.com/DonCervantes/x402-Handle/issues/1) es un registro Base ajeno). Priorizar P0/P1.

### P0 — seguridad de pagos

**Issue 1 — `x402: enforce challenge expiry and persist issued memos`**  
Labels: `bug`, `security`, `x402-stellar`  
`expires_at` se serializa pero nunca se chequea; el memo no se guarda. Persistir memo→{exp, amount, dest} y rechazar expirados/desconocidos.

**Issue 2 — `x402: reject client-supplied memos; drop query-string fallback`**  
Labels: `security`, `x402-stellar`  
Hoy el memo sale de `X-PAYMENT` o `?memo=`. Solo aceptar memos emitidos por este servidor.

**Issue 3 — `x402: durable replay store (no 24h TTL, no process memory)`**  
Labels: `security`, `x402-stellar`  
TTL permite redimir la misma tx; restart/multi-instancia bypass. Redis/Postgres SET NX; nunca expirar hashes cobrados.

**Issue 4 — `x402: close TOCTOU race between replay has() and add()`**  
Labels: `security`, `x402-stellar`  
Dos requests paralelos con la misma `tx_hash` pueden verificar ambos. Consume atómico.

**Issue 5 — `BFF: authenticate and rate-limit POST /stellar/playground/pay`**  
Labels: `security`, `bff`  
Endpoint gasta `DEMO_AGENT_SECRET` sin auth. Cupos, auth, kill-switch en prod.

**Issue 6 — `Showcase: replace static x-flovia-showcase-pay headers before spending keys`**  
Labels: `security`, `bff`, `showcase`  
Header público no es credencial. No deployar payer keys en HANDLE.

**Issue 7 — `Soroban: require auth on log_payment (oracle or provider owner)`**  
Labels: `security`, `soroban`  
Hoy cualquiera forja volumen/payer/amount. Allowlist + no confiar amount del caller.

### P1 — correctness / trust

**Issue 8 — `x402: compare USDC amounts in stroops / BigInt, not Number()`**  
Labels: `bug`, `x402-stellar`

**Issue 9 — `x402: validate all payment operations; handle path_payment amount fields`**  
Labels: `bug`, `x402-stellar`

**Issue 10 — `agent-sdk: bind 402 destination to on-chain registry owner`**  
Labels: `security`, `agent-sdk`

**Issue 11 — `x402 client: poll Horizon until confirmed before sending X-PAYMENT`**  
Labels: `bug`, `x402-stellar`

**Issue 12 — `Trust: label mock KYB in UI and stop ranking as verified identity`**  
Labels: `trust`, `product`  
`packages/sources/src/kyb/mock.ts`. Badge “demo”.

**Issue 13 — `Trust: neutralize claims factor until a dispute system exists`**  
Labels: `trust`  
`getDisputeCount` siempre 0 → 15% del score inflado.

**Issue 14 — `Indexer: handle prov_off / prov_on so deactivated providers leave the catalog`**  
Labels: `indexer`, `bug`

**Issue 15 — `Indexer: paginate Soroban events and advance ledger cursor monotonically`**  
Labels: `indexer`

**Issue 16 — `onchain-log: bound Soroban getTransaction wait loop`**  
Labels: `bug`, `reliability`

**Issue 17 — `Soroban: implement admin pause, transfer_admin, logger allowlist`**  
Labels: `soroban`

**Issue 18 — `KYB: allowlist SEP-12 anchor URLs (SSRF)**`  
Labels: `security`, `kyb`

### P2 — plataforma / CI / producto

**Issue 19 — `BFF: CORS allowlist + rate limits on pay, LLM, and refresh`**  
Labels: `bff`, `security`

**Issue 20 — `BFF: authenticate LLM / upsell routes to prevent cost abuse`**  
Labels: `bff`, `security`

**Issue 21 — `CI: include x402-stellar, agent-sdk, demo-provider, and cargo test`**  
Labels: `ci`  
Hoy `scripts/run-workspace-script.ts` los omite.

**Issue 22 — `x402-stellar: add unit tests (expiry, memo bind, underpay, replay, asset)`**  
Labels: `test`  
Cero archivos de test en el paquete.

**Issue 23 — `Docs: rewrite root README for HANDLE / Stellar (retire Solana hero)`**  
Labels: `docs`  
Alinear con `landing-copy.ts` y `docs/FLOVIA-STELLAR.md`.

**Issue 24 — `Deploy: remove Solana/Stripe MPP secrets and routes from HANDLE Lightsail path`**  
Labels: `deploy`  
Fail-closed si faltan `MAIN_*`; no heredar `DEVELOP_*`.

**Issue 25 — `Docs: fix status.md BFF read-only claim (POSTs already exist)`**  
Labels: `docs`

**Issue 26 — `Repo hygiene: add LICENSE, SECURITY.md, Dependabot, secret scanning, branch protection`**  
Labels: `meta`  
`main` no protegida; sin licencia = riesgo legal para SCF/open-source.

**Issue 27 — `Branding: reconcile @flovia/* packages, flovia-bff, and fl- memos with HANDLE`**  
Labels: `chore`

**Issue 28 — `Product: document HANDLE provider registration for third parties`**  
Labels: `product`, `docs`  
Issue #1 pide formato de registro; no hay spec pública HANDLE (y es Stellar, no Base). Cerrar o responder #1 con el alcance real.

---

## 9. Issues extra (backlog, si se quieren más de 28)

29. Enable Biome linter (hoy `linter.enabled: false`).  
30. Fail closed when `SOLANA_MPP_SECRET_KEY` / `DEMO_PROVIDER_SECRET` missing.  
31. Shrink `/health` for public networks.  
32. Fix Vercel `outputDirectory` / split frontend vs BFF deploys.  
33. Add CODEOWNERS + PR template.  
34. i18n: landing EN/ES vs resto de la app en un solo idioma.  
35. `list_providers` on-chain O(n) — paginar / índice off-chain único.  
36. E2E Playwright del flujo 402 (hoy no hay E2E de browser).  
37. Changelog / semver para `@flovia/x402-stellar`.  
38. Quitar Co-Authored-By Claude de la política si se quiere cumplir `AGENTS.md`.

---

## 10. Método y límites

- Revisión estática del tree en `main` @ `5ae52a2`.
- No se ejecutó `bun run verify` ni `cargo test` (auditoría de diseño/código).
- No se inspeccionaron GitHub Actions secrets ni la instancia Lightsail.
- No se explotaron los hallazgos (solo lectura).

**Confianza:** alta en C1–C6, A1–A8 y gaps de CI/docs (código leído). Media en explotabilidad exacta de path_payment y en el estado real del deploy (si Lightsail/Vercel están vivos).
