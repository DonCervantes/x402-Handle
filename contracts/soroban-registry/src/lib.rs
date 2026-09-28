#![no_std]
//! Flovia Registry — On-chain registry of providers + payment log.
//!
//! Storage layout:
//!   - DataKey::Admin               → Address (admin que puede pausar globalmente)
//!   - DataKey::ProviderCounter     → u64 (auto-increment de provider_id)
//!   - DataKey::Provider(u64)       → Provider
//!   - DataKey::PaymentCounter      → u64
//!   - DataKey::Payment(u64)        → PaymentLog
//!   - DataKey::TxConsumed(BytesN<32>) → bool (replay protection)
//!
//! TTL: every persistent write extends its entry (Provider, Payment,
//! TxConsumed) to TTL_EXTEND_TO = 518_400 ledgers (30 days) when fewer than
//! TTL_THRESHOLD = 120_960 ledgers (7 days) remain; `initialize` and every
//! mutating call do the same for the contract instance. See
//! docs/soroban-registry-ttl-runbook.md for the missed-TTL runbook.
//!
//! Events:
//!   ("registry", "provider_registered", id)        data = Provider
//!   ("registry", "provider_updated", id)           data = Provider
//!   ("registry", "provider_deactivated", id)       data = ()
//!   ("registry", "payment_logged", provider_id)    data = PaymentLog

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, vec, Address, BytesN, Env, String, Symbol, Vec,
};

// ───────────────────────────── Errors

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized       = 1,
    AlreadyInitialized   = 2,
    Unauthorized         = 3,
    NotFound             = 4,
    PaymentAlreadyLogged = 5,
    InvalidArgument      = 6,
}

// ───────────────────────────── TTL window (issue #88)
//
// Stellar ledgers close approximately every 5 s, so 17_280 ledgers ≈ 1 day.
// The documented TTL window for this contract is:
//
//   TTL_THRESHOLD = 7 days  = 120_960 ledgers = 604_800 seconds
//   TTL_EXTEND_TO = 30 days = 518_400 ledgers = 2_592_000 seconds
//
// Every persistent write re-extends its entry to `TTL_EXTEND_TO`, but only
// when fewer than `TTL_THRESHOLD` ledgers remain (otherwise the call is a
// no-op, so frequent writes do not pay rent twice). The same window is used
// for the contract instance (Admin, ProviderCounter, PaymentCounter and the
// WASM code entry share it).
//
// Both values must stay below the network parameter `max_entry_ttl`, which
// caps any single extension (6_312_000 ledgers ≈ 365 days on Public and in
// the test environment), and the contract must be written so entries are
// touched more often than `TTL_EXTEND_TO`. See
// `docs/soroban-registry-ttl-runbook.md` for what happens if a TTL is missed.
const TTL_THRESHOLD: u32 = 7 * 17_280; // 120_960 ledgers ≈ 7 days
const TTL_EXTEND_TO: u32 = 30 * 17_280; // 518_400 ledgers ≈ 30 days

/// Extends a persistent entry (Provider, Payment, TxConsumed) to the
/// documented TTL window: topped up to `TTL_EXTEND_TO` ledgers once fewer
/// than `TTL_THRESHOLD` ledgers remain, no-op otherwise.
fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Extends the contract instance (and WASM code) entry to the documented
/// TTL window. Instance keys `Admin`, `ProviderCounter` and `PaymentCounter`
/// are stored inside the instance entry, so this covers all of them.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

// ───────────────────────────── Types

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provider {
    pub id:             u64,
    pub owner:          Address,
    pub name:           String,
    pub endpoint:       String,
    pub price_stroops:  u64,     // precio por call, en stroops de USDC
    pub payment_token:  Address, // contrato del activo (USDC)
    pub metadata_hash:  BytesN<32>,
    pub category:       Symbol,
    pub created_at:     u64,
    pub updated_at:     u64,
    pub active:         bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentLog {
    pub id:           u64,
    pub provider_id:  u64,
    pub payer:        Address,
    pub amount:       u64,         // stroops
    pub tx_hash:      BytesN<32>,
    pub timestamp:    u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    ProviderCounter,
    Provider(u64),
    PaymentCounter,
    Payment(u64),
    TxConsumed(BytesN<32>),
}

// ───────────────────────────── Contract

#[contract]
pub struct FloviaRegistry;

#[contractimpl]
impl FloviaRegistry {
    // ─── Lifecycle ──────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::ProviderCounter, &0u64);
        env.storage().instance().set(&DataKey::PaymentCounter, &0u64);
        // Instance TTL window starts here and is renewed on every mutating
        // call (issue #88).
        extend_instance_ttl(&env);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    // ─── Provider management ───────────────────────────────────

    /// Registra un nuevo proveedor. Requiere firma del `owner`.
    /// Devuelve el provider_id asignado.
    pub fn register_provider(
        env: Env,
        owner: Address,
        name: String,
        endpoint: String,
        price_stroops: u64,
        payment_token: Address,
        metadata_hash: BytesN<32>,
        category: Symbol,
    ) -> u64 {
        owner.require_auth();

        if name.len() == 0 || endpoint.len() == 0 {
            panic_with_error!(&env, Error::InvalidArgument);
        }

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProviderCounter)
            .unwrap_or(0);
        counter += 1;

        let now = env.ledger().timestamp();
        let provider = Provider {
            id: counter,
            owner: owner.clone(),
            name,
            endpoint,
            price_stroops,
            payment_token,
            metadata_hash,
            category,
            created_at: now,
            updated_at: now,
            active: true,
        };

        env.storage().persistent().set(&DataKey::Provider(counter), &provider);
        extend_persistent_ttl(&env, &DataKey::Provider(counter));
        env.storage().instance().set(&DataKey::ProviderCounter, &counter);
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_reg"), counter),
            provider.clone(),
        );

        counter
    }

    /// Actualiza campos mutables del provider. Requiere firma del owner.
    pub fn update_provider(
        env: Env,
        provider_id: u64,
        price_stroops: u64,
        endpoint: String,
        metadata_hash: BytesN<32>,
    ) {
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.price_stroops = price_stroops;
        p.endpoint = endpoint;
        p.metadata_hash = metadata_hash;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::Provider(provider_id), &p);
        extend_persistent_ttl(&env, &DataKey::Provider(provider_id));
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_upd"), provider_id),
            p,
        );
    }

    /// Marca como inactivo. Requiere firma del owner.
    pub fn deactivate(env: Env, provider_id: u64) {
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = false;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::Provider(provider_id), &p);
        extend_persistent_ttl(&env, &DataKey::Provider(provider_id));
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_off"), provider_id),
            (),
        );
    }

    /// Reactiva un provider previamente desactivado. Requiere firma del owner.
    pub fn activate(env: Env, provider_id: u64) {
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = true;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::Provider(provider_id), &p);
        extend_persistent_ttl(&env, &DataKey::Provider(provider_id));
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_on"), provider_id),
            (),
        );
    }

    // ─── Reads ──────────────────────────────────────────────────

    pub fn get_provider(env: Env, provider_id: u64) -> Provider {
        env.storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound))
    }

    pub fn provider_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProviderCounter)
            .unwrap_or(0)
    }

    /// Devuelve los providers en rango [from_id, to_id] (inclusive).
    /// Si un id no existe, se omite. Pensado para paginación desde el indexer.
    pub fn list_providers(env: Env, from_id: u64, to_id: u64) -> Vec<Provider> {
        if from_id == 0 || to_id < from_id {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        let mut out: Vec<Provider> = vec![&env];
        let mut id = from_id;
        while id <= to_id {
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<DataKey, Provider>(&DataKey::Provider(id))
            {
                out.push_back(p);
            }
            id += 1;
        }
        out
    }

    // ─── Payment log ────────────────────────────────────────────

    /// Loguea un pago. Cualquiera puede llamar; la protección es
    /// la unicidad de `tx_hash` (replay-proof).
    /// En v2: restringir a llamadores autorizados (oracle, provider's middleware).
    pub fn log_payment(
        env: Env,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        // El provider debe existir
        let provider: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        // Replay protection
        let consumed_key = DataKey::TxConsumed(tx_hash.clone());
        if env.storage().persistent().has(&consumed_key) {
            panic_with_error!(&env, Error::PaymentAlreadyLogged);
        }

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PaymentCounter)
            .unwrap_or(0);
        counter += 1;

        let log = PaymentLog {
            id: counter,
            provider_id,
            payer: payer.clone(),
            amount,
            tx_hash: tx_hash.clone(),
            timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Payment(counter), &log);
        extend_persistent_ttl(&env, &DataKey::Payment(counter));
        env.storage().persistent().set(&consumed_key, &true);
        extend_persistent_ttl(&env, &consumed_key);
        env.storage().instance().set(&DataKey::PaymentCounter, &counter);
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("pay_log"), provider_id),
            log.clone(),
        );

        // silenciar warning por unused
        let _ = provider;

        counter
    }

    pub fn get_payment(env: Env, payment_id: u64) -> PaymentLog {
        env.storage()
            .persistent()
            .get(&DataKey::Payment(payment_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound))
    }

    pub fn payment_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::PaymentCounter)
            .unwrap_or(0)
    }

    /// Lista pagos en rango [from_id, to_id] filtrados por provider_id.
    /// Para uso del indexer / análisis off-chain.
    pub fn list_payments(
        env: Env,
        provider_id: u64,
        from_id: u64,
        to_id: u64,
    ) -> Vec<PaymentLog> {
        if from_id == 0 || to_id < from_id {
            panic_with_error!(&env, Error::InvalidArgument);
        }
        let mut out: Vec<PaymentLog> = vec![&env];
        let mut id = from_id;
        while id <= to_id {
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<DataKey, PaymentLog>(&DataKey::Payment(id))
            {
                if p.provider_id == provider_id {
                    out.push_back(p);
                }
            }
            id += 1;
        }
        out
    }
}

// ───────────────────────────── Tests

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, BytesN, Env, String, Symbol};

    fn setup() -> (Env, FloviaRegistryClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, FloviaRegistry);
        let client = FloviaRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, client, admin)
    }

    #[test]
    fn registers_and_reads_provider() {
        let (env, client, _admin) = setup();
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[1u8; 32]);

        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "FX Rates Oracle"),
            &String::from_str(&env, "https://fx.example.com/rate"),
            &50_000u64,
            &token,
            &meta,
            &Symbol::new(&env, "fx"),
        );
        assert_eq!(id, 1);
        let p = client.get_provider(&id);
        assert_eq!(p.id, 1);
        assert_eq!(p.owner, owner);
        assert_eq!(p.active, true);
        assert_eq!(client.provider_count(), 1);
    }

    #[test]
    fn updates_provider() {
        let (env, client, _) = setup();
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );

        let new_meta = BytesN::from_array(&env, &[9u8; 32]);
        client.update_provider(
            &id,
            &20u64,
            &String::from_str(&env, "https://x.io/v2"),
            &new_meta,
        );

        let p = client.get_provider(&id);
        assert_eq!(p.price_stroops, 20);
    }

    #[test]
    fn deactivates_and_activates() {
        let (env, client, _) = setup();
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );
        client.deactivate(&id);
        assert_eq!(client.get_provider(&id).active, false);
        client.activate(&id);
        assert_eq!(client.get_provider(&id).active, true);
    }

    #[test]
    fn logs_payment_and_rejects_duplicate() {
        let (env, client, _) = setup();
        let owner = Address::generate(&env);
        let payer = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );

        let tx_hash = BytesN::from_array(&env, &[7u8; 32]);
        let pid1 = client.log_payment(&id, &payer, &50_000u64, &tx_hash);
        assert_eq!(pid1, 1);

        // Duplicado debe fallar
        let result = client.try_log_payment(&id, &payer, &50_000u64, &tx_hash);
        assert!(result.is_err());
    }

    #[test]
    fn lists_providers_in_range() {
        let (env, client, _) = setup();
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        for i in 0..5 {
            let owner = Address::generate(&env);
            let _ = client.register_provider(
                &owner,
                &String::from_str(&env, "P"),
                &String::from_str(&env, "https://p"),
                &(10 + i as u64),
                &token,
                &meta,
                &Symbol::new(&env, "data"),
            );
        }
        let list = client.list_providers(&1, &5);
        assert_eq!(list.len(), 5);
    }

    #[test]
    fn ledger_timestamp_used() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );
        let p = client.get_provider(&id);
        assert_eq!(p.created_at, 1_700_000_000);
    }

    // ─── TTL window (issue #88) ────────────────────────────────────
    //
    // Chosen window, recorded here and in the constants at the top of
    // lib.rs (ledger ≈ 5 s → 17_280 ledgers ≈ 1 day):
    //
    //   TTL_THRESHOLD = 120_960 ledgers = 7 days  = 604_800 seconds
    //   TTL_EXTEND_TO = 518_400 ledgers = 30 days = 2_592_000 seconds
    //
    // Network settings are set explicitly so assertions are exact:
    // new persistent/instance entries start with `min_persistent_entry_ttl`
    // (minus one: the creation ledger counts) and any single extension is
    // capped by `max_entry_ttl` (Public/test default 6_312_000 ledgers).

    /// Creates an env with deterministic TTL-related network settings.
    fn ttl_env() -> Env {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100_000;
            li.min_persistent_entry_ttl = 500;
            li.max_entry_ttl = 6_312_000;
        });
        env.mock_all_auths();
        env
    }

    /// `initialize` and every persistent write extend to TTL_EXTEND_TO
    /// (518_400 ledgers ≈ 30 days): instance (Admin + counters), Provider,
    /// Payment and TxConsumed.
    #[test]
    fn extends_ttl_on_initialize_and_writes() {
        let env = ttl_env();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, FloviaRegistry);
        let client = FloviaRegistryClient::new(&env, &contract_id);

        // initialize → instance TTL window starts at TTL_EXTEND_TO.
        client.initialize(&admin);
        env.as_contract(&contract_id, || {
            assert_eq!(env.storage().instance().get_ttl(), TTL_EXTEND_TO);
        });

        // register_provider → Provider(id) extended.
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage().persistent().get_ttl(&DataKey::Provider(id)),
                TTL_EXTEND_TO
            );
            assert_eq!(env.storage().instance().get_ttl(), TTL_EXTEND_TO);
        });

        // log_payment → Payment(1) and the TxConsumed replay marker extended.
        let payer = Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.log_payment(&id, &payer, &50_000u64, &tx_hash);
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage().persistent().get_ttl(&DataKey::Payment(1)),
                TTL_EXTEND_TO
            );
            assert_eq!(
                env.storage()
                    .persistent()
                    .get_ttl(&DataKey::TxConsumed(tx_hash.clone())),
                TTL_EXTEND_TO
            );
            assert_eq!(env.storage().instance().get_ttl(), TTL_EXTEND_TO);
        });
    }

    /// Re-extension only happens below TTL_THRESHOLD (120_960 ledgers
    /// ≈ 7 days); above it the call is a documented no-op.
    #[test]
    fn extends_ttl_again_only_below_threshold() {
        let env = ttl_env();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, FloviaRegistry);
        let client = FloviaRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "https://x.io"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );

        // Advance 100_000 ledgers: 418_400 remain — still above
        // TTL_THRESHOLD, so update_provider must not top up.
        env.ledger().with_mut(|li| li.sequence_number += 100_000);
        client.update_provider(
            &id,
            &20u64,
            &String::from_str(&env, "https://x.io/v2"),
            &BytesN::from_array(&env, &[9u8; 32]),
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage().persistent().get_ttl(&DataKey::Provider(id)),
                TTL_EXTEND_TO - 100_000
            );
            assert_eq!(env.storage().instance().get_ttl(), TTL_EXTEND_TO - 100_000);
        });

        // Advance another 350_000 ledgers: 68_400 remain — below
        // TTL_THRESHOLD, so activate tops both back up to TTL_EXTEND_TO.
        env.ledger().with_mut(|li| li.sequence_number += 350_000);
        client.activate(&id);
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage().persistent().get_ttl(&DataKey::Provider(id)),
                TTL_EXTEND_TO
            );
            assert_eq!(env.storage().instance().get_ttl(), TTL_EXTEND_TO);
        });
    }
}
