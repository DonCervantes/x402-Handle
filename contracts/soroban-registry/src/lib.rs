#![no_std]
//! Flovia Registry — On-chain registry of providers + payment log.
//!
//! Storage layout:
//!   - DataKey::Admin                    → Address
//!   - DataKey::ProviderCounter          → u64
//!   - DataKey::Provider(u64)            → Provider
//!   - DataKey::Handle(String)            → u64
//!   - DataKey::PaymentCounter           → u64
//!   - DataKey::Payment(u64)             → PaymentLog
//!   - DataKey::TxConsumed(BytesN<32>)   → bool
//!
//! HANDLEs are human-readable provider aliases.
//! A HANDLE must be unique and follow the allowed format.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
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
    HandleAlreadyTaken   = 7,
}

// ───────────────────────────── Types

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provider {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub endpoint: String,
    pub price_stroops: u64,
    pub payment_token: Address,
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
    pub amount: u64,
    pub tx_hash: BytesN<32>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    ProviderCounter,
    Provider(u64),
    Handle(String),
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

    // ─── Provider management ───────────────────────────────────

    /// Registers a new provider.
    /// Requires the owner's signature.
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

    // ─── HANDLE management ─────────────────────────────────────

    /// Registers a unique human-readable HANDLE for a provider.
    ///
    /// HANDLE rules:
    /// - 1 to 64 bytes
    /// - lowercase letters a-z
    /// - digits 0-9
    /// - hyphens are allowed
    /// - cannot start or end with a hyphen
    /// - cannot contain consecutive hyphens
    ///
    /// Requires the provider owner's signature.
    pub fn register_handle(
        env: Env,
        provider_id: u64,
        handle: String,
    ) {
        let provider: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        provider.owner.require_auth();

        Self::valid_handle(&env, &handle);

        let handle_key = DataKey::Handle(handle.clone());

        if env.storage().persistent().has(&handle_key) {
            panic_with_error!(&env, Error::HandleAlreadyTaken);
        }

        env.storage()
            .persistent()
            .set(&handle_key, &provider_id);
    }

    /// Resolves a HANDLE to its provider ID.
    pub fn resolve_handle(env: Env, handle: String) -> u64 {
        Self::valid_handle(&env, &handle);

        env.storage()
            .persistent()
            .get(&DataKey::Handle(handle))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound))
    }

    /// Validates a provider HANDLE.
    ///
    /// Allowed:
    /// - a-z
    /// - 0-9
    /// - hyphen
    ///
    /// The HANDLE must be 1-64 bytes long and cannot begin/end
    /// with a hyphen or contain consecutive hyphens.
    fn valid_handle(env: &Env, handle: &String) {
        let bytes = handle.to_bytes();
        let len = bytes.len();

        if len == 0 || len > 64 {
            panic_with_error!(env, Error::InvalidArgument);
        }

        let mut index = 0;

        while index < len {
            let byte = bytes.get(index).unwrap();

            let is_lowercase_letter = byte >= 97 && byte <= 122;
            let is_digit = byte >= 48 && byte <= 57;
            let is_hyphen = byte == 45;

            if !is_lowercase_letter && !is_digit && !is_hyphen {
                panic_with_error!(env, Error::InvalidArgument);
            }

            if is_hyphen && (index == 0 || index == len - 1) {
                panic_with_error!(env, Error::InvalidArgument);
            }

            if is_hyphen && index > 0 {
                let previous = bytes.get(index - 1).unwrap();

                if previous == 45 {
                    panic_with_error!(env, Error::InvalidArgument);
                }
            }

            index += 1;
        }
    }

    /// Updates mutable provider fields.
    /// Requires the owner's signature.
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

    /// Deactivates a provider.
    /// Requires the owner's signature.
    pub fn deactivate(env: Env, provider_id: u64) {
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

    /// Reactivates a provider.
    /// Requires the owner's signature.
    pub fn activate(env: Env, provider_id: u64) {
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

    /// Returns providers in the inclusive [from_id, to_id] range.
    pub fn list_providers(
        env: Env,
        from_id: u64,
        to_id: u64,
    ) -> Vec<Provider> {
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

    /// Logs a payment.
    /// The tx_hash provides replay protection.
    pub fn log_payment(
        env: Env,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        let provider: Provider = env
            .storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

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

        env.storage()
            .persistent()
            .set(&consumed_key, &true);

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

    /// Lists payments in the inclusive range, filtered by provider.
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
    use soroban_sdk::{
        testutils::Address as _,
        testutils::Ledger,
        BytesN,
        Env,
        String,
        Symbol,
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
    fn registers_and_resolves_handle() {
        let (env, client, _) = setup();

        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);

        let provider_id = client.register_provider(
            &owner,
            &String::from_str(&env, "FX Rates Oracle"),
            &String::from_str(&env, "https://fx.example.com"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "fx"),
        );

        let handle = String::from_str(&env, "fx-oracle");

        client.register_handle(&provider_id, &handle);

        let resolved_id = client.resolve_handle(&handle);

        assert_eq!(resolved_id, provider_id);
    }

    #[test]
    fn rejects_duplicate_handle() {
        let (env, client, _) = setup();

        let owner1 = Address::generate(&env);
        let owner2 = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);

        let provider1 = client.register_provider(
            &owner1,
            &String::from_str(&env, "Provider One"),
            &String::from_str(&env, "https://one.example.com"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "one"),
        );

        let provider2 = client.register_provider(
            &owner2,
            &String::from_str(&env, "Provider Two"),
            &String::from_str(&env, "https://two.example.com"),
            &20u64,
            &token,
            &meta,
            &Symbol::new(&env, "two"),
        );

        let handle = String::from_str(&env, "same-handle");

        client.register_handle(&provider1, &handle);

        let result = client.try_register_handle(&provider2, &handle);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_handle() {
        let (env, client, _) = setup();

        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8; 32]);

        let provider_id = client.register_provider(
            &owner,
            &String::from_str(&env, "Provider"),
            &String::from_str(&env, "https://provider.example.com"),
            &10u64,
            &token,
            &meta,
            &Symbol::new(&env, "provider"),
        );

        let invalid_handle = String::from_str(&env, "Invalid_Handle");

        let result = client.try_register_handle(
            &provider_id,
            &invalid_handle,
        );

        assert!(result.is_err());
    }

    #[test]
    fn rejects_handle_for_unknown_provider() {
        let (env, client, _) = setup();

        let unknown_provider_id = 999u64;
        let handle = String::from_str(&env, "unknown-provider");

        let result = client.try_register_handle(
            &unknown_provider_id,
            &handle,
        );

        assert!(result.is_err());
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

        let pid1 = client.log_payment(
            &id,
            &payer,
            &50_000u64,
            &tx_hash,
        );

        assert_eq!(pid1, 1);

        let result = client.try_log_payment(
            &id,
            &payer,
            &50_000u64,
            &tx_hash,
        );

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

        env.ledger()
            .with_mut(|li| li.timestamp = 1_700_000_000);

        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let meta = BytesN::from_array(&env, &[0u8
