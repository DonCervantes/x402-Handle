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
//!   - DataKey::Paused              → bool (absent means unpaused)
//!   - DataKey::Logger(Address)     → bool (allowlisted logger, absent means denied)
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
    Paused               = 7,
    NotAllowlisted       = 8,
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
    Paused,
    Logger(Address),
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
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Freeze provider and payment mutations. Reads and admin recovery remain available.
    pub fn pause(env: Env) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("paused")),
            (),
        );
    }

    pub fn unpause(env: Env) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("unpaused")),
            (),
        );
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Immediately rotate authority, requiring authorization from the current admin.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("admin_chg")),
            new_admin,
        );
    }

    /// Allow a logger to record payments. Membership alone does not authorize a call.
    pub fn add_logger(env: Env, logger: Address) {
        require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::Logger(logger.clone()), &true);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("log_add")),
            logger,
        );
    }

    pub fn remove_logger(env: Env, logger: Address) {
        require_admin(&env);
        env.storage()
            .instance()
            .remove(&DataKey::Logger(logger.clone()));
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("log_del")),
            logger,
        );
    }

    pub fn is_logger(env: Env, logger: Address) -> bool {
        env.storage().instance().has(&DataKey::Logger(logger))
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
        require_unpaused(&env);
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
        env.storage().instance().set(&DataKey::ProviderCounter, &counter);

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
        require_unpaused(&env);
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

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_upd"), provider_id),
            p,
        );
    }

    /// Marca como inactivo. Requiere firma del owner.
    pub fn deactivate(env: Env, provider_id: u64) {
        require_unpaused(&env);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = false;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::Provider(provider_id), &p);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_off"), provider_id),
            (),
        );
    }

    /// Reactiva un provider previamente desactivado. Requiere firma del owner.
    pub fn activate(env: Env, provider_id: u64) {
        require_unpaused(&env);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = true;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::Provider(provider_id), &p);

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

    /// Record a payment from an authenticated, allowlisted logger.
    /// The payer is recorded as metadata; it does not authorize the logger.
    /// Transaction hashes remain unique across all loggers.
    pub fn log_payment(
        env: Env,
        caller: Address,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        require_unpaused(&env);
        if !Self::is_logger(env.clone(), caller.clone()) {
            panic_with_error!(&env, Error::NotAllowlisted);
        }
        caller.require_auth();
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
        env.storage().persistent().set(&consumed_key, &true);
        env.storage().instance().set(&DataKey::PaymentCounter, &counter);

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

fn require_admin(env: &Env) {
    FloviaRegistry::admin(env.clone()).require_auth();
}

fn require_unpaused(env: &Env) {
    if FloviaRegistry::paused(env.clone()) {
        panic_with_error!(env, Error::Paused);
    }
}

// ───────────────────────────── Tests

#[cfg(test)]
mod admin_test;

#[cfg(test)]
mod test {
    use super::*;
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
        client.add_logger(&owner);
        let pid1 = client.log_payment(&owner, &id, &payer, &50_000u64, &tx_hash);
        assert_eq!(pid1, 1);

        // Duplicado debe fallar
        let result = client.try_log_payment(&owner, &id, &payer, &50_000u64, &tx_hash);
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
}
