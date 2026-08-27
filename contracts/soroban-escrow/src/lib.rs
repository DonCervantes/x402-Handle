#![no_std]
//! HANDLE (Flovia) Escrow — optional on-chain escrow for x402 payments.
//!
//! Companion to `flovia-registry` (which stays non-custodial for the default
//! cheap path). Providers **opt in** per payout address with a policy
//! (`set_policy`); agents may then lock USDC in escrow for calls whose price
//! makes direct payment uncomfortable.
//!
//! Flow (see README for the full state machine):
//!   1. Provider opts in:      set_policy(enabled, min_lock_stroops, window)
//!   2. Agent approves + locks: token approve → lock(provider, amount, payment_ref)
//!   3. Provider delivers; the agent acks (`release`) or, if the agent is
//!      offline / malicious, a whitelisted oracle releases on proof of delivery.
//!   4. No ack before `deadline` → **timeout policy: REFUND TO AGENT**
//!      (permissionless, anyone can trigger).
//!   5. Agent or provider may `dispute` before the deadline; admin/oracle
//!      `resolve`s. Disputes feed the off-chain trust score (claimsFactor).
//!
//! No-unbounded-hold guarantees:
//!   - every escrow has a deadline; `refund` is permissionless at/after it;
//!   - a disputed-but-unresolved escrow becomes permissionlessly refundable
//!     at `deadline + MAX_DISPUTE_WINDOW_SECS` (hard cap);
//!   - the global pause blocks new `lock`s and `release`s, but never blocks
//!     `refund`, `dispute` or `resolve`, so funds can never be frozen forever.
//!
//! Storage layout:
//!   - DataKey::Admin            → Address (instance)
//!   - DataKey::PendingAdmin     → Address (instance)
//!   - DataKey::Token            → Address  (instance; USDC SAC pinned at init)
//!   - DataKey::Paused           → bool     (instance)
//!   - DataKey::EscrowCounter    → u64      (instance)
//!   - DataKey::Escrow(u64)      → Escrow   (persistent)
//!   - DataKey::RefIndex(b32)    → u64      (persistent; payment_ref → id)
//!   - DataKey::Policy(Address)  → ProviderPolicy (persistent)
//!   - DataKey::Oracle(Address)  → bool     (persistent)
//!
//! Events (topics = ("escrow", kind, id), data carries the full struct so the
//! indexer can mirror state idempotently from any single event):
//!   ("escrow", "lock",    id) data = Escrow
//!   ("escrow", "release", id) data = Escrow            (status = released)
//!   ("escrow", "refund",  id) data = Escrow            (status = refunded)
//!   ("escrow", "dispute", id) data = Escrow            (status = disputed)
//!   ("escrow", "resolve", id) data = Resolution        (terminal event follows)
//!   ("escrow", "policy",  provider) data = ProviderPolicy
//!   ("escrow", "oracle",  oracle)   data = bool
//!   ("escrow", "paused",  admin)    data = bool

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token, vec,
    Address, BytesN, Env, Symbol, Vec,
};

// ───────────────────────────── Constants

/// Shortest dispute window a provider may pick (60s keeps tests/demo viable).
pub const MIN_DISPUTE_WINDOW_SECS: u64 = 60;
/// Longest dispute window a provider may pick (30 days).
pub const MAX_DISPUTE_WINDOW_SECS: u64 = 2_592_000;

/// Status symbols stored/emitted on every Escrow.
pub const STATUS_LOCKED: Symbol = symbol_short!("locked");
pub const STATUS_RELEASED: Symbol = symbol_short!("released");
pub const STATUS_REFUNDED: Symbol = symbol_short!("refunded");
pub const STATUS_DISPUTED: Symbol = symbol_short!("disputed");

// ───────────────────────────── Errors

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized       = 1,
    AlreadyInitialized   = 2,
    Unauthorized         = 3,
    NotFound             = 4,
    PaymentRefAlreadyUsed = 5,
    InvalidArgument      = 6,
    EscrowNotLocked      = 7,
    DeadlineNotReached   = 8,
    DeadlinePassed       = 9,
    DisputeNotOpen       = 10,
    ProviderNotOptedIn   = 11,
    AmountBelowMinimum   = 12,
    Paused               = 13,
}

// ───────────────────────────── Types

/// Provider opt-in policy, keyed by the provider's payout address (the x402
/// `destination`). Providers that never set a policy keep the default cheap
/// direct-payment path — the registry remains non-custodial.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderPolicy {
    pub enabled: bool,
    /// Escrow only accepts locks ≥ this (calls below it stay on direct pay).
    pub min_lock_stroops: i128,
    /// Seconds from lock until the agent may permissionlessly refund.
    pub dispute_window_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: u64,
    /// Payout address of the provider (x402 challenge `destination`).
    pub provider: Address,
    /// Paying agent.
    pub agent: Address,
    /// Locked amount, in stroops (1e-7 USDC) of the pinned token.
    pub amount_stroops: i128,
    /// sha256 of the x402 payment tx hash / challenge id that this escrow
    /// settles. Unique: one escrow per on-chain payment reference.
    pub payment_ref: BytesN<32>,
    pub created_at: u64,
    /// Unix seconds after which the timeout policy (refund to agent) applies.
    pub deadline: u64,
    /// One of STATUS_* symbols (kept self-describing for the indexer).
    pub status: Symbol,
    pub disputed_at: Option<u64>,
    pub dispute_opener: Option<Address>,
    pub resolved_at: Option<u64>,
    pub resolver: Option<Address>,
}

/// Payload of the ("escrow","resolve",id) event.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolution {
    pub escrow: Escrow,
    pub resolver: Address,
    /// true → paid to provider; false → refunded to agent.
    pub release_to_provider: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    PendingAdmin,
    Token,
    Paused,
    EscrowCounter,
    Escrow(u64),
    RefIndex(BytesN<32>),
    Policy(Address),
    Oracle(Address),
}

// ───────────────────────────── Contract

#[contract]
pub struct FloviaEscrow;

#[contractimpl]
impl FloviaEscrow {
    // ─── Lifecycle / admin ───────────────────────────────────────

    /// One-time setup. `token` is the only asset this deployment may escrow
    /// (deploy one contract per payment asset; HANDLE uses USDC's SAC).
    pub fn initialize(env: Env, admin: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if admin == token {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Payment asset (SAC address) pinned at initialize.
    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Two-step admin handover: current admin proposes, next admin accepts.
    pub fn set_pending_admin(env: Env, new_admin: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
    }

    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
    }

    /// Global circuit breaker. While paused, `lock` and `release` are blocked;
    /// `refund`, `dispute` and `resolve` keep working so no funds are frozen.
    pub fn set_paused(env: Env, paused: bool) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events()
            .publish((symbol_short!("escrow"), symbol_short!("paused"), admin), paused);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    /// Whitelist / remove a delivery oracle (admin only). Oracles may `release`
    /// on proof of delivery and `resolve` disputes.
    pub fn set_oracle(env: Env, oracle: Address, enabled: bool) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if enabled {
            env.storage().persistent().set(&DataKey::Oracle(oracle.clone()), &true);
        } else {
            env.storage().persistent().remove(&DataKey::Oracle(oracle.clone()));
        }
        env.events()
            .publish((symbol_short!("escrow"), symbol_short!("oracle"), oracle), enabled);
    }

    pub fn is_oracle(env: Env, oracle: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Oracle(oracle))
            .unwrap_or(false)
    }

    // ─── Provider opt-in policy ──────────────────────────────────

    /// Provider opt-in, signed by the payout address. Window is bounded so a
    /// bad policy can never lock funds for more than MAX_DISPUTE_WINDOW_SECS.
    pub fn set_policy(
        env: Env,
        provider: Address,
        enabled: bool,
        min_lock_stroops: i128,
        dispute_window_secs: u64,
    ) {
        provider.require_auth();
        if min_lock_stroops < 0 {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        if dispute_window_secs < MIN_DISPUTE_WINDOW_SECS
            || dispute_window_secs > MAX_DISPUTE_WINDOW_SECS
        {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        let policy = ProviderPolicy {
            enabled,
            min_lock_stroops,
            dispute_window_secs,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Policy(provider.clone()), &policy);
        env.events()
            .publish((symbol_short!("escrow"), symbol_short!("policy"), provider), policy);
    }

    pub fn get_policy(env: Env, provider: Address) -> Option<ProviderPolicy> {
        env.storage().persistent().get(&DataKey::Policy(provider))
    }

    // ─── Escrow lifecycle ────────────────────────────────────────

    /// Agent locks `amount_stroops` for an x402 call to `provider`.
    ///
    /// Pull payment: the agent must have granted this contract a SAC allowance
    /// (approve) large enough for `amount_stroops`. The pull and the state
    /// update are atomic. `payment_ref` = sha256 of the payment tx hash /
    /// challenge id; one escrow per ref (replay protection, like the
    /// registry's log_payment).
    pub fn lock(
        env: Env,
        agent: Address,
        provider: Address,
        amount_stroops: i128,
        payment_ref: BytesN<32>,
    ) -> u64 {
        agent.require_auth();

        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidArgument);
        }

        let policy: ProviderPolicy = env
            .storage()
            .persistent()
            .get(&DataKey::Policy(provider.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ProviderNotOptedIn));
        if !policy.enabled {
            panic_with_error!(&env, Error::ProviderNotOptedIn);
        }
        if amount_stroops < policy.min_lock_stroops {
            panic_with_error!(&env, Error::AmountBelowMinimum);
        }

        let ref_key = DataKey::RefIndex(payment_ref.clone());
        if env.storage().persistent().has(&ref_key) {
            panic_with_error!(&env, Error::PaymentRefAlreadyUsed);
        }

        let mut id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        id += 1;

        let now = env.ledger().timestamp();
        let escrow = Escrow {
            id,
            provider: provider.clone(),
            agent: agent.clone(),
            amount_stroops,
            payment_ref: payment_ref.clone(),
            created_at: now,
            deadline: now + policy.dispute_window_secs,
            status: STATUS_LOCKED,
            disputed_at: None,
            dispute_opener: None,
            resolved_at: None,
            resolver: None,
        };

        let contract = env.current_contract_address();
        let token = Self::token(env.clone());
        let token_client = token::Client::new(&env, &token);
        // transfer_from(spender = this contract, from = agent, to = this contract)
        token_client.transfer_from(&contract, &agent, &contract, &amount_stroops);

        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);
        env.storage().persistent().set(&ref_key, &id);
        env.storage().instance().set(&DataKey::EscrowCounter, &id);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("lock"), id),
            escrow.clone(),
        );
        id
    }

    /// Release to the provider: the agent acks delivery, or a whitelisted
    /// oracle releases on proof of delivery. Only before the deadline.
    pub fn release(env: Env, caller: Address, escrow_id: u64) {
        caller.require_auth();

        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
        let mut escrow = Self::get_escrow(env.clone(), escrow_id);
        if escrow.status != STATUS_LOCKED {
            panic_with_error!(&env, Error::EscrowNotLocked);
        }
        let now = env.ledger().timestamp();
        if now >= escrow.deadline {
            panic_with_error!(&env, Error::DeadlinePassed);
        }
        if caller != escrow.agent && !Self::is_oracle(env.clone(), caller.clone()) {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let payee = escrow.provider.clone();
        Self::payout(&env, &mut escrow, &payee, STATUS_RELEASED);
    }

    /// Timeout policy: REFUND TO AGENT. Permissionless (keepers may trigger),
    /// works while paused, and is the guaranteed exit for stuck funds:
    ///   - status locked   → allowed at/after `deadline`;
    ///   - status disputed → allowed at/after `deadline + MAX_DISPUTE_WINDOW_SECS`
    ///     if still unresolved (hard cap on adjudication time).
    pub fn refund(env: Env, escrow_id: u64) {
        let mut escrow = Self::get_escrow(env.clone(), escrow_id);
        let now = env.ledger().timestamp();
        if escrow.status == STATUS_LOCKED {
            if now < escrow.deadline {
                panic_with_error!(&env, Error::DeadlineNotReached);
            }
        } else if escrow.status == STATUS_DISPUTED {
            // Hard cap on adjudication time (see crate docs).
            if now < escrow.deadline + MAX_DISPUTE_WINDOW_SECS {
                panic_with_error!(&env, Error::DeadlineNotReached);
            }
        } else {
            panic_with_error!(&env, Error::EscrowNotLocked);
        }
        let payee = escrow.agent.clone();
        Self::payout(&env, &mut escrow, &payee, STATUS_REFUNDED);
    }

    /// Agent or provider opens a dispute before the deadline. Freezes the
    /// escrow until an admin/oracle resolves it (or the hard cap refunds).
    pub fn dispute(env: Env, caller: Address, escrow_id: u64) {
        caller.require_auth();

        let mut escrow = Self::get_escrow(env.clone(), escrow_id);
        if escrow.status != STATUS_LOCKED {
            panic_with_error!(&env, Error::EscrowNotLocked);
        }
        let now = env.ledger().timestamp();
        if now >= escrow.deadline {
            panic_with_error!(&env, Error::DeadlinePassed);
        }
        if caller != escrow.agent && caller != escrow.provider {
            panic_with_error!(&env, Error::Unauthorized);
        }

        escrow.status = STATUS_DISPUTED;
        escrow.disputed_at = Some(now);
        escrow.dispute_opener = Some(caller.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (
                symbol_short!("escrow"),
                symbol_short!("dispute"),
                escrow_id,
            ),
            escrow,
        );
    }

    /// Admin or oracle resolves a dispute. Not blocked by the pause switch
    /// (admins must always be able to unstick funds).
    pub fn resolve(env: Env, caller: Address, escrow_id: u64, release_to_provider: bool) {
        caller.require_auth();

        let admin = Self::admin(env.clone());
        if caller != admin && !Self::is_oracle(env.clone(), caller.clone()) {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let mut escrow = Self::get_escrow(env.clone(), escrow_id);
        if escrow.status != STATUS_DISPUTED {
            panic_with_error!(&env, Error::DisputeNotOpen);
        }

        let now = env.ledger().timestamp();
        escrow.resolved_at = Some(now);
        escrow.resolver = Some(caller.clone());

        let payee = if release_to_provider {
            escrow.provider.clone()
        } else {
            escrow.agent.clone()
        };

        let resolution = Resolution {
            escrow: escrow.clone(),
            resolver: caller.clone(),
            release_to_provider,
        };
        Self::payout(
            &env,
            &mut escrow,
            &payee,
            if release_to_provider { STATUS_RELEASED } else { STATUS_REFUNDED },
        );
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("resolve"), escrow_id),
            resolution,
        );
    }

    // ─── Reads ───────────────────────────────────────────────────

    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound))
    }

    /// Escrow tied to an x402 payment reference (Err(NotFound) if none).
    pub fn get_escrow_by_ref(env: Env, payment_ref: BytesN<32>) -> Escrow {
        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RefIndex(payment_ref))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        Self::get_escrow(env, id)
    }

    pub fn escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0)
    }

    /// Escrows in range [from_id, to_id] (inclusive), for debugging/pagination.
    pub fn list_escrows(env: Env, from_id: u64, to_id: u64) -> Vec<Escrow> {
        if from_id == 0 || to_id < from_id {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        let mut out: Vec<Escrow> = vec![&env];
        let mut id = from_id;
        while id <= to_id {
            if let Some(e) = env
                .storage()
                .persistent()
                .get::<DataKey, Escrow>(&DataKey::Escrow(id))
            {
                out.push_back(e);
            }
            id += 1;
        }
        out
    }

    // ─── Internal ────────────────────────────────────────────────

    /// Transfers the escrowed amount to `payee`, sets the terminal `status`
    /// (RELEASED or REFUNDED, passed by the caller — never inferred from the
    /// payee, which would be ambiguous if agent == provider) and emits the
    /// terminal event. `resolved_at/resolver` are already set when this is
    /// called from `resolve`.
    fn payout(env: &Env, escrow: &mut Escrow, payee: &Address, status: Symbol) {
        let contract = env.current_contract_address();
        let token = Self::token(env.clone());
        let token_client = token::Client::new(env, &token);
        token_client.transfer(&contract, payee, &escrow.amount_stroops);

        escrow.status = status.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow.id), &escrow.clone());

        let topic_kind = if status == STATUS_RELEASED {
            symbol_short!("release")
        } else {
            symbol_short!("refund")
        };
        env.events().publish(
            (symbol_short!("escrow"), topic_kind, escrow.id),
            escrow.clone(),
        );
    }
}

// ───────────────────────────── Tests
//
// Issue #34 style: NO `mock_all_auths`. Every authorization is provided
// explicitly with `env.mock_auths(&[MockAuth { .. }])` describing the exact
// invocation tree (including the SAC `transfer_from` sub-invocation inside
// `lock`), so a call whose signer does not match the mocked tree fails —
// the negative tests rely on that.

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke};
    use soroban_sdk::{IntoVal, TryFromVal, Val};
    use soroban_sdk::token::StellarAssetClient;

    const WINDOW_SECS: u64 = 3_600; // 1h — inside [MIN, MAX]
    const PRICE_STROOPS: i128 = 50_000; // 0.005 USDC

    struct Fixture {
        env: Env,
        client: FloviaEscrowClient<'static>,
        escrow_id: Address,
        admin: Address,
        agent: Address,
        provider: Address,
        keeper: Address,
        oracle: Address,
        token: token::Client<'static>,
        token_id: Address,
    }

    fn setup() -> Fixture {
        let env = Env::default();
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let provider = Address::generate(&env);
        let keeper = Address::generate(&env);
        let oracle = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        let token = token::Client::new(&env, &token_id);

        let escrow_id = env.register_contract(None, FloviaEscrow);
        let client = FloviaEscrowClient::new(&env, &escrow_id);
        client.initialize(&admin, &token_id);

        Fixture {
            env,
            client,
            escrow_id,
            admin,
            agent,
            provider,
            keeper,
            oracle,
            token,
            token_id,
        }
    }

    /// Mock auth for the SAC admin mint.
    fn mint(f: &Fixture, to: &Address, amount: i128) {
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.token_id,
                fn_name: "mint",
                args: (to.clone(), amount).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        let sac = StellarAssetClient::new(&f.env, &f.token_id);
        sac.mint(to, &amount);
    }

    /// Mock auth for the agent's SAC allowance towards the escrow contract.
    fn approve(f: &Fixture, from: &Address, amount: i128) {
        let expiration = f.env.ledger().sequence() + 10_000;
        f.env.mock_auths(&[MockAuth {
            address: from,
            invoke: &MockAuthInvoke {
                contract: &f.token_id,
                fn_name: "approve",
                args: (
                    from.clone(),
                    f.escrow_id.clone(),
                    amount,
                    expiration,
                )
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.token.approve(from, &f.escrow_id, &amount, &expiration);
    }

    /// Provider opts in to escrow with the default test policy.
    fn opt_in(f: &Fixture) {
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (f.provider.clone(), true, 0i128, WINDOW_SECS).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client
            .set_policy(&f.provider, &true, &0, &WINDOW_SECS);
    }

    /// Mock the compound agent auth for `lock`: root = lock(), sub = the SAC
    /// transfer_from(spender=escrow, from=agent, to=escrow) it performs.
    fn lock_auth(f: &Fixture, agent: &Address, provider: &Address, amount: i128, payment_ref: &BytesN<32>) {
        f.env.mock_auths(&[MockAuth {
            address: agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "lock",
                args: (
                    agent.clone(),
                    provider.clone(),
                    amount,
                    payment_ref.clone(),
                )
                    .into_val(&f.env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &f.token_id,
                    fn_name: "transfer_from",
                    args: (
                        f.escrow_id.clone(),
                        agent.clone(),
                        f.escrow_id.clone(),
                        amount,
                    )
                        .into_val(&f.env),
                    sub_invokes: &[],
                }],
            },
        }]);
    }

    fn payment_ref(f: &Fixture, seed: u8) -> BytesN<32> {
        BytesN::from_array(&f.env, &[seed; 32])
    }

    /// Lock a fully-funded, opted-in escrow for the default price.
    fn lock_default(f: &Fixture, seed: u8) -> u64 {
        mint(f, &f.agent, PRICE_STROOPS * 10);
        opt_in(f);
        approve(f, &f.agent, PRICE_STROOPS);
        let r = payment_ref(f, seed);
        lock_auth(f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        f.client.lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
    }

    /// Kind symbols (topic[1]) of every emitted escrow event, in order.
    /// SAC token events (mint/transfer/...) share the event stream, so only
    /// events in the "escrow" namespace are collected.
    fn event_kinds(f: &Fixture) -> std::vec::Vec<Symbol> {
        f.env
            .events()
            .all()
            .iter()
            .filter_map(|(_, topics, _)| {
                let ns: Val = topics.get(0)?;
                if Symbol::try_from_val(&f.env, &ns).ok()? != symbol_short!("escrow") {
                    return None;
                }
                let v: Val = topics.get(1)?;
                Symbol::try_from_val(&f.env, &v).ok()
            })
            .collect()
    }

    // ─── Setup / policy ─────────────────────────────────────────

    #[test]
    fn initializes_once_and_pins_token() {
        let f = setup();
        assert_eq!(f.client.admin(), f.admin);
        assert_eq!(f.client.token(), f.token_id);
        assert_eq!(f.client.is_paused(), false);
        assert_eq!(f.client.escrow_count(), 0);
        // Double initialize must fail.
        assert!(f.client.try_initialize(&f.admin, &f.token_id).is_err());
    }

    #[test]
    fn policy_window_bounds_are_enforced() {
        let f = setup();
        // Too short.
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (f.provider.clone(), true, 0i128, MIN_DISPUTE_WINDOW_SECS - 1).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f
            .client
            .try_set_policy(&f.provider, &true, &0, &(MIN_DISPUTE_WINDOW_SECS - 1))
            .is_err());
        // Too long.
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (
                    f.provider.clone(),
                    true,
                    0i128,
                    MAX_DISPUTE_WINDOW_SECS + 1,
                )
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f
            .client
            .try_set_policy(&f.provider, &true, &0, &(MAX_DISPUTE_WINDOW_SECS + 1))
            .is_err());
        // Boundaries are accepted.
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (f.provider.clone(), true, 0i128, MIN_DISPUTE_WINDOW_SECS).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client
            .set_policy(&f.provider, &true, &0, &MIN_DISPUTE_WINDOW_SECS);
        let p = f.client.get_policy(&f.provider).unwrap();
        assert_eq!(p.enabled, true);
        assert_eq!(p.dispute_window_secs, MIN_DISPUTE_WINDOW_SECS);
    }

    #[test]
    fn policy_requires_provider_signature() {
        let f = setup();
        // No mock auth for the provider → signing as someone else must fail.
        assert!(f
            .client
            .try_set_policy(&f.provider, &true, &0, &WINDOW_SECS)
            .is_err());
        assert_eq!(f.client.get_policy(&f.provider), None);
    }

    // ─── lock ───────────────────────────────────────────────────

    #[test]
    fn lock_pulls_funds_and_sets_deadline() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS * 10);
        opt_in(&f);
        approve(&f, &f.agent, PRICE_STROOPS);

        f.env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let r = payment_ref(&f, 7);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        let id = f.client.lock(&f.agent, &f.provider, &PRICE_STROOPS, &r);

        assert_eq!(id, 1);
        assert_eq!(f.client.escrow_count(), 1);

        let e = f.client.get_escrow(&id);
        assert_eq!(e.agent, f.agent);
        assert_eq!(e.provider, f.provider);
        assert_eq!(e.amount_stroops, PRICE_STROOPS);
        assert_eq!(e.status, STATUS_LOCKED);
        assert_eq!(e.created_at, 1_700_000_000);
        assert_eq!(e.deadline, 1_700_000_000 + WINDOW_SECS);
        assert_eq!(e.disputed_at, None);
        assert_eq!(e.payment_ref, r);

        // Funds moved agent → escrow contract (pulled via SAC allowance).
        assert_eq!(f.token.balance(&f.agent), PRICE_STROOPS * 10 - PRICE_STROOPS);
        assert_eq!(f.token.balance(&f.escrow_id), PRICE_STROOPS);

        // Indexed by payment ref.
        assert_eq!(f.client.get_escrow_by_ref(&r).id, id);
    }

    #[test]
    fn lock_rejects_duplicate_payment_ref() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS * 10);
        opt_in(&f);
        let r = payment_ref(&f, 1);

        approve(&f, &f.agent, PRICE_STROOPS);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        f.client.lock(&f.agent, &f.provider, &PRICE_STROOPS, &r);

        // Second lock with the same ref fails (fresh allowance + auth).
        approve(&f, &f.agent, PRICE_STROOPS);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        assert!(f
            .client
            .try_lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
            .is_err());
        assert_eq!(f.client.escrow_count(), 1);
    }

    #[test]
    fn lock_requires_provider_opt_in() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS);
        // No policy → not opted in.
        approve(&f, &f.agent, PRICE_STROOPS);
        let r = payment_ref(&f, 2);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        assert!(f
            .client
            .try_lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
            .is_err());

        // Opted in but disabled → also rejected.
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (f.provider.clone(), false, 0i128, WINDOW_SECS).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_policy(&f.provider, &false, &0, &WINDOW_SECS);
        approve(&f, &f.agent, PRICE_STROOPS);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        assert!(f
            .client
            .try_lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
            .is_err());
    }

    #[test]
    fn lock_enforces_min_amount_and_positive_amount() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS * 10);
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_policy",
                args: (f.provider.clone(), true, PRICE_STROOPS, WINDOW_SECS).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client
            .set_policy(&f.provider, &true, &PRICE_STROOPS, &WINDOW_SECS);

        // Below the provider minimum.
        let small = PRICE_STROOPS - 1;
        approve(&f, &f.agent, small);
        let r = payment_ref(&f, 3);
        lock_auth(&f, &f.agent, &f.provider, small, &r);
        assert!(f.client.try_lock(&f.agent, &f.provider, &small, &r).is_err());

        // Zero amount.
        approve(&f, &f.agent, PRICE_STROOPS);
        let r0 = payment_ref(&f, 4);
        lock_auth(&f, &f.agent, &f.provider, 0, &r0);
        assert!(f.client.try_lock(&f.agent, &f.provider, &0, &r0).is_err());
    }

    #[test]
    fn lock_without_signature_fails() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS);
        opt_in(&f);
        approve(&f, &f.agent, PRICE_STROOPS);
        let r = payment_ref(&f, 5);
        // No mock auth at all: the agent's require_auth must reject this.
        assert!(f
            .client
            .try_lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
            .is_err());
        assert_eq!(f.client.escrow_count(), 0);
    }

    // ─── release ────────────────────────────────────────────────

    #[test]
    fn agent_release_pays_provider() {
        let f = setup();
        let id = lock_default(&f, 10);
        assert_eq!(f.token.balance(&f.provider), 0);

        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.release(&f.agent, &id);

        assert_eq!(f.token.balance(&f.provider), PRICE_STROOPS);
        assert_eq!(f.token.balance(&f.escrow_id), 0);
        assert_eq!(f.client.get_escrow(&id).status, STATUS_RELEASED);

        // Double release is rejected.
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_release(&f.agent, &id).is_err());
    }

    #[test]
    fn oracle_release_pays_provider_without_agent() {
        let f = setup();
        let id = lock_default(&f, 11);

        // Admin whitelists the oracle.
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_oracle",
                args: (f.oracle.clone(), true).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_oracle(&f.oracle, &true);
        assert_eq!(f.client.is_oracle(&f.oracle), true);

        f.env.mock_auths(&[MockAuth {
            address: &f.oracle,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.oracle.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.release(&f.oracle, &id);
        assert_eq!(f.token.balance(&f.provider), PRICE_STROOPS);
    }

    #[test]
    fn provider_cannot_release_own_escrow() {
        let f = setup();
        let id = lock_default(&f, 12);
        // Even with a *valid* provider signature the release must be rejected:
        // the caller is neither the agent nor a whitelisted oracle.
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.provider.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_release(&f.provider, &id).is_err());
        assert_eq!(f.token.balance(&f.provider), 0);
        assert_eq!(f.client.get_escrow(&id).status, STATUS_LOCKED);
    }

    #[test]
    fn release_after_deadline_is_rejected() {
        let f = setup();
        let id = lock_default(&f, 13);
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS); // at deadline

        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_release(&f.agent, &id).is_err());
    }

    // ─── refund (timeout policy: refund to agent) ───────────────

    #[test]
    fn refund_before_deadline_is_rejected() {
        let f = setup();
        let id = lock_default(&f, 20);
        // Permissionless call, but too early:
        assert!(f.client.try_refund(&id).is_err());
        assert_eq!(f.client.get_escrow(&id).status, STATUS_LOCKED);
    }

    #[test]
    fn refund_at_deadline_is_permissionless() {
        let f = setup();
        let id = lock_default(&f, 21);
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS); // == deadline

        // A random keeper (no auth, no stake) triggers the agent refund.
        f.client.refund(&id);

        assert_eq!(f.token.balance(&f.agent), PRICE_STROOPS * 10);
        assert_eq!(f.token.balance(&f.escrow_id), 0);
        assert_eq!(f.client.get_escrow(&id).status, STATUS_REFUNDED);
        // Idempotency: refunding again fails (already terminal).
        assert!(f.client.try_refund(&id).is_err());
    }

    // ─── dispute / resolve ──────────────────────────────────────

    #[test]
    fn agent_dispute_then_admin_resolves_for_provider() {
        let f = setup();
        let id = lock_default(&f, 30);

        // Agent disputes before the deadline.
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.agent, &id);

        let e = f.client.get_escrow(&id);
        assert_eq!(e.status, STATUS_DISPUTED);
        assert_eq!(e.dispute_opener, Some(f.agent.clone()));
        assert!(e.disputed_at.is_some());

        // While disputed, the plain timeout refund is blocked.
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS + 1);
        assert!(f.client.try_refund(&id).is_err());

        // Adjudication: admin resolves → release to provider.
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (f.admin.clone(), id, true).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.resolve(&f.admin, &id, &true);

        let e = f.client.get_escrow(&id);
        assert_eq!(e.status, STATUS_RELEASED);
        assert_eq!(e.resolver, Some(f.admin.clone()));
        assert!(e.resolved_at.is_some());
        assert_eq!(f.token.balance(&f.provider), PRICE_STROOPS);
    }

    #[test]
    fn provider_dispute_then_oracle_resolves_refund() {
        let f = setup();
        let id = lock_default(&f, 31);

        // Provider disputes (delivery claimed, agent unresponsive).
        f.env.mock_auths(&[MockAuth {
            address: &f.provider,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.provider.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.provider, &id);

        // Oracle resolves → refund to agent.
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_oracle",
                args: (f.oracle.clone(), true).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_oracle(&f.oracle, &true);

        f.env.mock_auths(&[MockAuth {
            address: &f.oracle,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (f.oracle.clone(), id, false).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.resolve(&f.oracle, &id, &false);

        assert_eq!(f.client.get_escrow(&id).status, STATUS_REFUNDED);
        assert_eq!(f.token.balance(&f.agent), PRICE_STROOPS * 10);
    }

    #[test]
    fn dispute_after_deadline_and_by_third_party_rejected() {
        let f = setup();
        let id = lock_default(&f, 32);
        let stranger = Address::generate(&f.env);

        // Third party cannot dispute even with a valid signature.
        f.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (stranger.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_dispute(&stranger, &id).is_err());

        // After the deadline nobody can dispute (timeout policy won).
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS + 1);
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_dispute(&f.agent, &id).is_err());
    }

    #[test]
    fn resolve_requires_admin_or_oracle_and_open_dispute() {
        let f = setup();
        let id = lock_default(&f, 33);

        // Not disputed → resolve rejected (even for admin).
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (f.admin.clone(), id, true).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_resolve(&f.admin, &id, &true).is_err());

        // Dispute it, then a random address must not resolve.
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.agent, &id);

        let stranger = Address::generate(&f.env);
        f.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (stranger.clone(), id, true).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_resolve(&stranger, &id, &true).is_err());
        assert_eq!(f.client.get_escrow(&id).status, STATUS_DISPUTED);
    }

    #[test]
    fn unresolved_dispute_hits_hard_cap_and_refunds_agent() {
        let f = setup();
        let id = lock_default(&f, 34);

        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.agent, &id);

        // deadline + MAX_DISPUTE_WINDOW_SECS − 1 → still frozen.
        f.env.ledger().with_mut(|li| {
            li.timestamp += WINDOW_SECS + MAX_DISPUTE_WINDOW_SECS - 1;
        });
        assert!(f.client.try_refund(&id).is_err());

        // One second later the hard cap kicks in: permissionless refund.
        f.env.ledger().with_mut(|li| li.timestamp += 1);
        f.client.refund(&id);
        assert_eq!(f.client.get_escrow(&id).status, STATUS_REFUNDED);
        assert_eq!(f.token.balance(&f.agent), PRICE_STROOPS * 10);
    }

    // ─── pause (no unbounded hold) ──────────────────────────────

    #[test]
    fn pause_blocks_lock_and_release_but_not_refund_or_resolve() {
        let f = setup();
        let id = lock_default(&f, 40);

        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_paused",
                args: (true,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_paused(&true);
        assert_eq!(f.client.is_paused(), true);

        // New locks blocked.
        mint(&f, &f.agent, PRICE_STROOPS);
        approve(&f, &f.agent, PRICE_STROOPS);
        let r = payment_ref(&f, 41);
        lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
        assert!(f
            .client
            .try_lock(&f.agent, &f.provider, &PRICE_STROOPS, &r)
            .is_err());

        // Release blocked while paused.
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_release(&f.agent, &id).is_err());

        // Dispute + admin resolve still work while paused.
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.agent, &id);
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (f.admin.clone(), id, false).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.resolve(&f.admin, &id, &false);
        // agent balance after refund = 450_000 (post-lock) + 50_000 (blocked
        // re-lock mint kept) + 50_000 (resolved refund)
        assert_eq!(f.token.balance(&f.agent), PRICE_STROOPS * 11);

        // Timeout refund also still works while paused (new escrow).
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_paused",
                args: (false,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_paused(&false);
        let id2 = lock_default(&f, 42);
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_paused",
                args: (true,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_paused(&true);
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS + 1);
        let before = f.token.balance(&f.agent);
        f.client.refund(&id2);
        assert_eq!(f.client.get_escrow(&id2).status, STATUS_REFUNDED);
        // Refund moved the escrowed amount back to the agent while paused.
        assert_eq!(f.token.balance(&f.agent), before + PRICE_STROOPS);
        assert_eq!(f.token.balance(&f.escrow_id), 0);
    }

    // ─── admin handover & misc ──────────────────────────────────

    #[test]
    fn two_step_admin_handover() {
        let f = setup();
        let new_admin = Address::generate(&f.env);

        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "set_pending_admin",
                args: (new_admin.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.set_pending_admin(&new_admin);

        // A caller that is not the pending admin cannot accept.
        assert!(f.client.try_accept_admin().is_err());

        f.env.mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "accept_admin",
                args: ().into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.accept_admin();
        assert_eq!(f.client.admin(), new_admin);
    }

    #[test]
    fn list_escrows_paginates() {
        let f = setup();
        mint(&f, &f.agent, PRICE_STROOPS * 3);
        opt_in(&f);
        for seed in [50u8, 51, 52] {
            approve(&f, &f.agent, PRICE_STROOPS);
            let r = payment_ref(&f, seed);
            lock_auth(&f, &f.agent, &f.provider, PRICE_STROOPS, &r);
            f.client.lock(&f.agent, &f.provider, &PRICE_STROOPS, &r);
        }
        let list = f.client.list_escrows(&1, &3);
        assert_eq!(list.len(), 3);
        let empty = f.client.list_escrows(&9, &12);
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn events_cover_lock_release_refund_dispute_lifecycle() {
        let f = setup();

        // 1) lock → release happy path.
        let id = lock_default(&f, 60);
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "release",
                args: (f.agent.clone(), id).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.release(&f.agent, &id);

        let kinds = event_kinds(&f);
        assert!(kinds.iter().any(|k| *k == symbol_short!("policy"))); // opt-in event
        assert!(kinds.iter().any(|k| *k == symbol_short!("lock")));
        assert!(kinds.iter().any(|k| *k == symbol_short!("release")));

        // 2) dispute → resolve(refund) path.
        let id2 = lock_default(&f, 61);
        f.env.mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "dispute",
                args: (f.agent.clone(), id2).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.dispute(&f.agent, &id2);
        f.env.mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.escrow_id,
                fn_name: "resolve",
                args: (f.admin.clone(), id2, false).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client.resolve(&f.admin, &id2, &false);

        // 3) timeout refund path.
        let id3 = lock_default(&f, 62);
        f.env
            .ledger()
            .with_mut(|li| li.timestamp += WINDOW_SECS + 1);
        f.client.refund(&id3);

        let kinds = event_kinds(&f);
        assert!(kinds.iter().any(|k| *k == symbol_short!("dispute")));
        assert!(kinds.iter().any(|k| *k == symbol_short!("resolve")));
        assert!(kinds
            .iter()
            .filter(|k| **k == symbol_short!("refund"))
            .count() >= 2);
        // One terminal event per escrow: 3 escrows → 3 release/refund events.
        let terminal = kinds
            .iter()
            .filter(|k| **k == symbol_short!("release") || **k == symbol_short!("refund"))
            .count();
        assert_eq!(terminal, 3);
    }
}
