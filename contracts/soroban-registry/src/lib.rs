#![no_std]
//! Flovia Registry — On-chain registry of providers + payment log.
//!
//! Storage layout:
//!   - DataKey::Admin              → Address (admin que puede pausar/transferir)
//!   - DataKey::Paused             → bool (freeze global del registry)
//!   - DataKey::LoggerAllowlist    → Vec<Address> (callers autorizados de log_payment)
//!   - DataKey::ProviderCounter    → u64 (auto-increment de provider_id)
//!   - DataKey::Provider(u64)      → Provider
//!   - DataKey::PaymentCounter     → u64
//!   - DataKey::Payment(u64)       → PaymentLog
//!   - DataKey::TxConsumed(BytesN<32>) → bool (replay protection)
//!
//! Events:
//!   ("registry", "prov_reg", id)        data = Provider
//!   ("registry", "prov_upd", id)        data = Provider
//!   ("registry", "prov_off", id)        data = ()
//!   ("registry", "prov_on", id)         data = ()
//!   ("registry", "pay_log", provider_id) data = PaymentLog
//!   ("registry", "paused", ())          data = ()
//!   ("registry", "unpause", ())         data = ()
//!   ("registry", "admin_chg", ())       data = Address (nuevo admin)
//!   ("registry", "log_add", addr)       data = ()
//!   ("registry", "log_del", addr)       data = ()

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, vec,
    Address, BytesN, Env, String, Symbol, Vec,
};

// ───────────────────────────── Errors

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    NotFound = 4,
    PaymentAlreadyLogged = 5,
    InvalidArgument = 6,
    Paused = 7,
    NotAllowlisted = 8,
}

// ───────────────────────────── Types

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provider {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub endpoint: String,
    pub price_stroops: u64,     // precio por call, en stroops de USDC
    pub payment_token: Address, // contrato del activo (USDC)
    pub metadata_hash: BytesN<32>,
    pub category: Symbol,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentLog {
    pub id: u64,
    pub provider_id: u64,
    pub payer: Address,
    pub amount: u64, // stroops
    pub tx_hash: BytesN<32>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Paused,
    LoggerAllowlist,
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
        env.storage()
            .instance()
            .set(&DataKey::ProviderCounter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::PaymentCounter, &0u64);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    // ─── Admin helpers ─────────────────────────────────────────

    /// Panics unless el llamador es el admin (firma requerida).
    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
    }

    /// Panics si el registry está pausado globalmente.
    fn require_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, Error::Paused);
        }
    }

    /// Lee la allowlist actual de callers autorizados de log_payment.
    fn logger_allowlist(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get::<DataKey, Vec<Address>>(&DataKey::LoggerAllowlist)
            .unwrap_or_else(|| vec![env])
    }

    // ─── Admin controls: pause / transfer ──────────────────────

    /// Congela el registry: bloquea writes de providers y pagos.
    /// Sólo el admin puede llamar. Las lecturas siguen disponibles.
    pub fn pause(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("registry"), symbol_short!("paused"), ()), ());
    }

    /// Reanuda operaciones tras un pause. Sólo el admin.
    pub fn unpause(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("unpause"), ()),
            (),
        );
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Transfiere el rol de admin a `new_admin`. Sólo el admin actual.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("admin_chg"), ()),
            new_admin,
        );
    }

    // ─── Admin controls: logger allowlist ──────────────────────

    /// Agrega un caller autorizado de log_payment. Sólo el admin. Idempotente.
    pub fn add_logger(env: Env, address: Address) {
        Self::require_admin(&env);
        let mut allowlist: Vec<Address> = Self::logger_allowlist(&env);
        if allowlist.iter().any(|a| a == address) {
            return;
        }
        allowlist.push_back(address.clone());
        env.storage()
            .instance()
            .set(&DataKey::LoggerAllowlist, &allowlist);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("log_add"), address),
            (),
        );
    }

    /// Remueve un caller de la allowlist de log_payment. Sólo el admin.
    pub fn remove_logger(env: Env, address: Address) {
        Self::require_admin(&env);
        let mut allowlist: Vec<Address> = Self::logger_allowlist(&env);
        let mut removed = false;
        let mut i: u32 = 0;
        while i < allowlist.len() {
            if allowlist.get(i) == Some(address.clone()) {
                allowlist.remove(i);
                removed = true;
                break;
            }
            i += 1;
        }
        if removed {
            env.storage()
                .instance()
                .set(&DataKey::LoggerAllowlist, &allowlist);
            env.events().publish(
                (symbol_short!("registry"), symbol_short!("log_del"), address),
                (),
            );
        }
    }

    pub fn is_logger(env: Env, address: Address) -> bool {
        Self::logger_allowlist(&env).iter().any(|a| a == address)
    }

    pub fn logger_count(env: Env) -> u32 {
        Self::logger_allowlist(&env).len()
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
        Self::require_not_paused(&env);
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

        env.storage()
            .persistent()
            .set(&DataKey::Provider(counter), &provider);
        env.storage()
            .instance()
            .set(&DataKey::ProviderCounter, &counter);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("prov_reg"),
                counter,
            ),
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
        Self::require_not_paused(&env);
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

        env.storage()
            .persistent()
            .set(&DataKey::Provider(provider_id), &p);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("prov_upd"),
                provider_id,
            ),
            p,
        );
    }

    /// Marca como inactivo. Requiere firma del owner.
    pub fn deactivate(env: Env, provider_id: u64) {
        Self::require_not_paused(&env);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = false;
        p.updated_at = env.ledger().timestamp();

        env.storage()
            .persistent()
            .set(&DataKey::Provider(provider_id), &p);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("prov_off"),
                provider_id,
            ),
            (),
        );
    }

    /// Reactiva un provider previamente desactivado. Requiere firma del owner.
    pub fn activate(env: Env, provider_id: u64) {
        Self::require_not_paused(&env);
        let mut p: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        p.owner.require_auth();

        p.active = true;
        p.updated_at = env.ledger().timestamp();

        env.storage()
            .persistent()
            .set(&DataKey::Provider(provider_id), &p);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("prov_on"),
                provider_id,
            ),
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

    /// Loguea un pago. Sólo callers en la allowlist (con su firma)
    /// pueden llamar; la unicidad de `tx_hash` sigue protegiendo contra replays.
    pub fn log_payment(
        env: Env,
        caller: Address,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        Self::require_not_paused(&env);

        // Sólo callers allowlisted (con auth) pueden loguear pagos
        let allowlist: Vec<Address> = Self::logger_allowlist(&env);
        if !allowlist.iter().any(|a| a == caller) {
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

        env.storage()
            .persistent()
            .set(&DataKey::Payment(counter), &log);
        env.storage().persistent().set(&consumed_key, &true);
        env.storage()
            .instance()
            .set(&DataKey::PaymentCounter, &counter);

        env.events().publish(
            (
                symbol_short!("registry"),
                symbol_short!("pay_log"),
                provider_id,
            ),
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
    pub fn list_payments(env: Env, provider_id: u64, from_id: u64, to_id: u64) -> Vec<PaymentLog> {
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
    use soroban_sdk::{
        testutils::Address as _, testutils::Ledger, BytesN, Env, IntoVal, String, Symbol,
    };

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
        let logger = Address::generate(&env);
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
        client.add_logger(&logger);

        let tx_hash = BytesN::from_array(&env, &[7u8; 32]);
        let pid1 = client.log_payment(&logger, &id, &payer, &50_000u64, &tx_hash);
        assert_eq!(pid1, 1);

        // Duplicado debe fallar
        let result = client.try_log_payment(&logger, &id, &payer, &50_000u64, &tx_hash);
        assert!(result.is_err());
    }

    #[test]
    fn logs_payment_requires_allowlisted_caller() {
        let (env, client, _) = setup();
        let owner = Address::generate(&env);
        let logger = Address::generate(&env);
        let stranger = Address::generate(&env);
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
        client.add_logger(&logger);

        let tx_hash = BytesN::from_array(&env, &[7u8; 32]);
        // Caller no allowlisted → NotAllowlisted
        let result = env.try_invoke_contract::<u64, Error>(
            &client.address,
            &Symbol::new(&env, "log_payment"),
            (
                stranger.clone(),
                id,
                payer.clone(),
                50_000u64,
                tx_hash.clone(),
            )
                .into_val(&env),
        );
        assert!(matches!(result, Err(Ok(Error::NotAllowlisted))));

        // Caller allowlisted → OK
        let pid = client.log_payment(&logger, &id, &payer, &50_000u64, &tx_hash);
        assert_eq!(pid, 1);
    }

    #[test]
    fn admin_pauses_and_unpauses() {
        let (env, client, _admin) = setup();
        assert_eq!(client.paused(), false);

        client.pause();
        assert_eq!(client.paused(), true);

        // Mutaciones bloqueadas mientras pausado
        let owner = Address::generate(&env);
        let result = env.try_invoke_contract::<u64, Error>(
            &client.address,
            &Symbol::new(&env, "register_provider"),
            (
                owner.clone(),
                String::from_str(&env, "X"),
                String::from_str(&env, "https://x.io"),
                10u64,
                Address::generate(&env),
                BytesN::from_array(&env, &[0u8; 32]),
                Symbol::new(&env, "data"),
            )
                .into_val(&env),
        );
        assert!(matches!(result, Err(Ok(Error::Paused))));

        let logger = Address::generate(&env);
        let result = env.try_invoke_contract::<u64, Error>(
            &client.address,
            &Symbol::new(&env, "log_payment"),
            (
                logger.clone(),
                1u64,
                owner.clone(),
                50_000u64,
                BytesN::from_array(&env, &[9u8; 32]),
            )
                .into_val(&env),
        );
        assert!(matches!(result, Err(Ok(Error::Paused))));

        // Lecturas siguen disponibles
        assert_eq!(client.provider_count(), 0);
        assert_eq!(client.logger_count(), 0);

        client.unpause();
        assert_eq!(client.paused(), false);
    }

    #[test]
    fn transfer_admin_changes_admin() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);
        assert_eq!(client.admin(), admin);

        client.transfer_admin(&new_admin);
        assert_eq!(client.admin(), new_admin);

        // El nuevo admin puede pausar
        client.pause();
        assert_eq!(client.paused(), true);
    }

    #[test]
    fn non_admin_cannot_use_admin_controls() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let contract_id = env.register_contract(None, FloviaRegistry);
        let client = FloviaRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);

        // Sin auth del admin, todos los controles fallan
        assert!(client.try_pause().is_err());
        assert!(client.try_unpause().is_err());
        assert!(client.try_transfer_admin(&attacker).is_err());
        assert!(client.try_add_logger(&attacker).is_err());
        assert!(client.try_remove_logger(&attacker).is_err());
    }

    #[test]
    fn logger_allowlist_is_admin_managed() {
        let (env, client, _admin) = setup();
        let logger = Address::generate(&env);
        let other = Address::generate(&env);

        assert_eq!(client.logger_count(), 0);
        assert_eq!(client.is_logger(&logger), false);

        client.add_logger(&logger);
        assert_eq!(client.logger_count(), 1);
        assert_eq!(client.is_logger(&logger), true);
        assert_eq!(client.is_logger(&other), false);

        // Idempotente
        client.add_logger(&logger);
        assert_eq!(client.logger_count(), 1);

        client.remove_logger(&logger);
        assert_eq!(client.logger_count(), 0);
        assert_eq!(client.is_logger(&logger), false);

        // Remover uno inexistente no revienta
        client.remove_logger(&other);
        assert_eq!(client.logger_count(), 0);
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
