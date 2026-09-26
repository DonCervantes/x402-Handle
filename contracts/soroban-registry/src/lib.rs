#![no_std]
//! Flovia Registry — On-chain registry of providers + payment log.
//!
//! Storage layout:
//!   - DataKey::Admin                  → Address (admin que puede pausar globalmente y rotar)
//!   - DataKey::Paused                 → bool (emergency stop switch)
//!   - DataKey::LoggerAllowlist(Addr)  → bool (authorized payment logging middleware/oracle)
//!   - DataKey::ProviderCounter        → u64 (auto-increment de provider_id)
//!   - DataKey::Provider(u64)          → Provider
//!   - DataKey::PaymentCounter         → u64
//!   - DataKey::Payment(u64)           → PaymentLog
//!   - DataKey::TxConsumed(BytesN<32>) → bool (replay protection)
//!
//! Events:
//!   ("registry", "provider_registered", id)        data = Provider
//!   ("registry", "provider_updated", id)           data = Provider
//!   ("registry", "provider_deactivated", id)       data = ()
//!   ("registry", "payment_logged", provider_id)    data = PaymentLog
//!   ("registry", "paused")                         data = ()
//!   ("registry", "unpaused")                       data = ()
//!   ("registry", "adm_xfer")                       data = new_admin Address
//!   ("registry", "log_allow")                      data = (logger Address, allowed bool)

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, vec, Address, BytesN, Env, String, Symbol, Vec,
};

// ───────────────────────────── TTL Constants

const DAY_IN_LEDGERS: u32 = 17_280;
const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (~30 days)
const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - DAY_IN_LEDGERS;

const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

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
    Paused,
    LoggerAllowlist(Address),
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
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ProviderCounter, &0u64);
        env.storage().instance().set(&DataKey::PaymentCounter, &0u64);
        extend_instance_ttl(&env);
    }

    pub fn admin(env: Env) -> Address {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("paused")),
            (),
        );
    }

    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("unpaused")),
            (),
        );
    }

    pub fn is_paused(env: Env) -> bool {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn transfer_admin(env: Env, new_admin: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        extend_instance_ttl(&env);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("adm_xfer")),
            new_admin,
        );
    }

    pub fn set_logger_allowed(env: Env, logger: Address, allowed: bool) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let key = DataKey::LoggerAllowlist(logger.clone());
        env.storage().persistent().set(&key, &allowed);
        extend_persistent_ttl(&env, &key);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("log_allow")),
            (logger, allowed),
        );
    }

    pub fn is_logger_allowed(env: Env, logger: Address) -> bool {
        let key = DataKey::LoggerAllowlist(logger);
        if let Some(allowed) = env.storage().persistent().get(&key) {
            extend_persistent_ttl(&env, &key);
            allowed
        } else {
            false
        }
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
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
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

        let prov_key = DataKey::Provider(counter);
        env.storage().persistent().set(&prov_key, &provider);
        extend_persistent_ttl(&env, &prov_key);

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
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
        let prov_key = DataKey::Provider(provider_id);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&prov_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.price_stroops = price_stroops;
        p.endpoint = endpoint;
        p.metadata_hash = metadata_hash;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&prov_key, &p);
        extend_persistent_ttl(&env, &prov_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_upd"), provider_id),
            p,
        );
    }

    /// Marca como inactivo. Requiere firma del owner.
    pub fn deactivate(env: Env, provider_id: u64) {
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
        let prov_key = DataKey::Provider(provider_id);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&prov_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = false;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&prov_key, &p);
        extend_persistent_ttl(&env, &prov_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_off"), provider_id),
            (),
        );
    }

    /// Reactiva un provider previamente desactivado. Requiere firma del owner.
    pub fn activate(env: Env, provider_id: u64) {
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, Error::Paused);
        }
        let prov_key = DataKey::Provider(provider_id);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&prov_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = true;
        p.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&prov_key, &p);
        extend_persistent_ttl(&env, &prov_key);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("prov_on"), provider_id),
            (),
        );
    }

    // ─── Reads ──────────────────────────────────────────────────

    pub fn get_provider(env: Env, provider_id: u64) -> Provider {
        let prov_key = DataKey::Provider(provider_id);
        let p: Provider = env
            .storage()
            .persistent()
            .get(&prov_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        extend_persistent_ttl(&env, &prov_key);
        p
    }

    pub fn provider_count(env: Env) -> u64 {
        extend_instance_ttl(&env);
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
            let prov_key = DataKey::Provider(id);
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<DataKey, Provider>(&prov_key)
            {
                extend_persistent_ttl(&env, &prov_key);
                out.push_back(p);
            }
            id += 1;
        }
        out
    }

    // ─── Payment log ────────────────────────────────────────────

    fn internal_log_payment(
        env: &Env,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        if Self::is_paused(env.clone()) {
            panic_with_error!(env, Error::Paused);
        }

        // El provider debe existir
        let prov_key = DataKey::Provider(provider_id);
        let _provider: Provider = env
            .storage()
            .persistent()
            .get(&prov_key)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotFound));
        extend_persistent_ttl(env, &prov_key);

        // Replay protection
        let consumed_key = DataKey::TxConsumed(tx_hash.clone());
        if env.storage().persistent().has(&consumed_key) {
            panic_with_error!(env, Error::PaymentAlreadyLogged);
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

        let pay_key = DataKey::Payment(counter);
        env.storage().persistent().set(&pay_key, &log);
        extend_persistent_ttl(env, &pay_key);

        env.storage().persistent().set(&consumed_key, &true);
        extend_persistent_ttl(env, &consumed_key);

        env.storage().instance().set(&DataKey::PaymentCounter, &counter);
        extend_instance_ttl(env);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("pay_log"), provider_id),
            log.clone(),
        );

        counter
    }

    /// Loguea un pago firmado directamente por el payer.
    pub fn log_payment(
        env: Env,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        payer.require_auth();
        Self::internal_log_payment(&env, provider_id, payer, amount, tx_hash)
    }

    /// Loguea un pago firmado por un logger autorizado (middleware / oracle).
    pub fn log_payment_as_logger(
        env: Env,
        logger: Address,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        logger.require_auth();
        if !Self::is_logger_allowed(env.clone(), logger) {
            panic_with_error!(&env, Error::Unauthorized);
        }
        Self::internal_log_payment(&env, provider_id, payer, amount, tx_hash)
    }

    pub fn get_payment(env: Env, payment_id: u64) -> PaymentLog {
        let pay_key = DataKey::Payment(payment_id);
        let log: PaymentLog = env
            .storage()
            .persistent()
            .get(&pay_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        extend_persistent_ttl(&env, &pay_key);
        log
    }

    pub fn payment_count(env: Env) -> u64 {
        extend_instance_ttl(&env);
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
            let pay_key = DataKey::Payment(id);
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<DataKey, PaymentLog>(&pay_key)
            {
                extend_persistent_ttl(&env, &pay_key);
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

    #[test]
    fn pause_and_unpause_behavior() {
        let (env, client, _admin) = setup();
        assert_eq!(client.is_paused(), false);

        client.pause();
        assert_eq!(client.is_paused(), true);

        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);

        // When paused, register_provider must fail
        let res = client.try_register_provider(
            &owner,
            &String::from_str(&env, "Blocked"),
            &String::from_str(&env, "https://blocked.io"),
            &100u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );
        assert!(res.is_err());

        // Unpause restores normal operation
        client.unpause();
        assert_eq!(client.is_paused(), false);

        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "Allowed"),
            &String::from_str(&env, "https://allowed.io"),
            &100u64,
            &token,
            &meta,
            &Symbol::new(&env, "data"),
        );
        assert_eq!(id, 1);
    }

    #[test]
    fn transfer_admin_updates_admin() {
        let (env, client, admin) = setup();
        assert_eq!(client.admin(), admin);

        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);
        assert_eq!(client.admin(), new_admin);

        // New admin can pause
        client.pause();
        assert_eq!(client.is_paused(), true);
    }

    #[test]
    fn logger_allowlist_and_payment_logging() {
        let (env, client, _admin) = setup();
        let owner = Address::generate(&env);
        let payer = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);
        let id = client.register_provider(
            &owner,
            &String::from_str(&env, "Service"),
            &String::from_str(&env, "https://service.io"),
            &1000u64,
            &token,
            &meta,
            &Symbol::new(&env, "api"),
        );

        let logger = Address::generate(&env);
        assert_eq!(client.is_logger_allowed(&logger), false);

        // Disallowed logger attempt fails
        let tx1 = BytesN::from_array(&env, &[11u8; 32]);
        let err_res = client.try_log_payment_as_logger(&logger, &id, &payer, &1000u64, &tx1);
        assert!(err_res.is_err());

        // Allow logger
        client.set_logger_allowed(&logger, &true);
        assert_eq!(client.is_logger_allowed(&logger), true);

        // Allowed logger succeeds
        let pid = client.log_payment_as_logger(&logger, &id, &payer, &1000u64, &tx1);
        assert_eq!(pid, 1);

        let log = client.get_payment(&pid);
        assert_eq!(log.amount, 1000);
        assert_eq!(log.payer, payer);
    }
}
