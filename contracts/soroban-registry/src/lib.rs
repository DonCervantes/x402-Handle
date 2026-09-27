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
//!   - DataKey::EscrowCounter       → u64
//!   - DataKey::Escrow(u64)         → Escrow
//!   - DataKey::EscrowConfig(u64)   → EscrowConfig (por provider)
//!
//! Events:
//!   ("registry", "provider_registered", id)        data = Provider
//!   ("registry", "provider_updated", id)           data = Provider
//!   ("registry", "provider_deactivated", id)       data = ()
//!   ("registry", "payment_logged", provider_id)    data = PaymentLog
//!   ("escrow", "cfg_set", provider_id)             data = EscrowConfig
//!   ("escrow", "opened", escrow_id)                data = Escrow
//!   ("escrow", "disputed", escrow_id)              data = Escrow
//!   ("escrow", "released", escrow_id)              data = Escrow
//!   ("escrow", "refunded", escrow_id)              data = Escrow

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
    EscrowDisabled       = 7,  // el provider no optó por escrow
    EscrowWindowOpen     = 8,  // release intentado antes de release_at
    EscrowWindowClosed   = 9,  // disputa intentada después de release_at
    EscrowNotOpen        = 10, // la escrow no está Open (ya liberada/refundida/disputada)
    EscrowDisputed       = 11, // release intentado con disputa abierta
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

// ───────────────────────────── Escrow

/// Configuración de escrow **por provider**: el escrow es opt-in, así que un
/// provider que quiera cobrar directo (comportamiento v1) simplemente no la
/// habilita y [`FloviaRegistry::open_escrow`] le devuelve `EscrowDisabled`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowConfig {
    pub enabled:            bool,
    /// Ventana de disputa en segundos desde que se abre la escrow. Durante
    /// este período el payer puede disputar; al terminar sin disputa, los
    /// fondos quedan liberables al provider.
    pub dispute_window_secs: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    /// Fondos retenidos; todavía dentro (o esperando) la ventana de disputa.
    Open,
    /// Liberados al owner del provider al pasar la ventana sin disputa.
    Released,
    /// Devueltos al payer por resolución del admin tras una disputa.
    Refunded,
    /// Disputada dentro de la ventana; requiere resolución del admin.
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id:           u64,
    pub provider_id:  u64,
    pub payer:        Address,
    pub token:        Address,
    pub amount:       u64,        // stroops
    pub created_at:   u64,
    /// `created_at + dispute_window_secs`: el instante más temprano en el que
    /// los fondos pueden liberarse al provider, y el último en el que el payer
    /// todavía puede disputar.
    pub release_at:   u64,
    pub status:       EscrowStatus,
    /// 0 mientras no haya disputa.
    pub disputed_at:  u64,
    /// Hash del motivo de la disputa (off-chain); cero si no hay disputa.
    pub reason_hash:  BytesN<32>,
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
    EscrowCounter,
    Escrow(u64),
    EscrowConfig(u64),
}

/// Techo de la ventana de disputa: 90 días. Evita que un provider configure una
/// ventana tan larga que el payer nunca pueda cerrar el ciclo.
const MAX_DISPUTE_WINDOW_SECS: u64 = 90 * 24 * 60 * 60;

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
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
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

    // ─── Escrow + ventana de disputa ────────────────────────────

    /// Habilita/deshabilita el escrow para un provider y fija su ventana de
    /// disputa. Requiere firma del owner.
    ///
    /// El escrow es **opt-in por provider**: sin configuración, el provider
    /// sigue cobrando por transferencia directa (`log_payment`) como en v1.
    pub fn set_escrow_config(
        env: Env,
        provider_id: u64,
        enabled: bool,
        dispute_window_secs: u64,
    ) -> EscrowConfig {
        let provider: Provider = Self::provider_or_panic(&env, provider_id);
        provider.owner.require_auth();

        if enabled && (dispute_window_secs == 0 || dispute_window_secs > MAX_DISPUTE_WINDOW_SECS) {
            panic_with_error!(&env, Error::InvalidArgument);
        }

        let cfg = EscrowConfig { enabled, dispute_window_secs };
        env.storage()
            .persistent()
            .set(&DataKey::EscrowConfig(provider_id), &cfg);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("cfg_set"), provider_id),
            cfg.clone(),
        );

        cfg
    }

    /// Config de escrow del provider. Default: deshabilitado.
    pub fn get_escrow_config(env: Env, provider_id: u64) -> EscrowConfig {
        env.storage()
            .persistent()
            .get(&DataKey::EscrowConfig(provider_id))
            .unwrap_or(EscrowConfig { enabled: false, dispute_window_secs: 0 })
    }

    /// Abre una escrow: retiene `amount` stroops del `payer` en el contrato
    /// hasta que pase la ventana de disputa del provider.
    ///
    /// Requiere firma del payer. El `tx_hash` se marca como consumido, igual
    /// que en `log_payment`, así que un mismo pago on-chain no puede abrir dos
    /// escrows ni abrir una escrow y loguearse otra vez.
    pub fn open_escrow(
        env: Env,
        provider_id: u64,
        payer: Address,
        amount: u64,
        tx_hash: BytesN<32>,
    ) -> u64 {
        let provider = Self::provider_or_panic(&env, provider_id);
        let cfg = Self::get_escrow_config(env.clone(), provider_id);
        if !cfg.enabled {
            panic_with_error!(&env, Error::EscrowDisabled);
        }
        if amount == 0 {
            panic_with_error!(&env, Error::InvalidArgument);
        }

        payer.require_auth();

        let consumed_key = DataKey::TxConsumed(tx_hash.clone());
        if env.storage().persistent().has(&consumed_key) {
            panic_with_error!(&env, Error::PaymentAlreadyLogged);
        }

        // Custodia: el contrato retiene los fondos hasta que la ventana pase
        // (o hasta que el admin resuelva una disputa).
        let token = soroban_sdk::token::Client::new(&env, &provider.payment_token);
        token.transfer(
            &payer,
            &env.current_contract_address(),
            &(amount as i128),
        );

        let now = env.ledger().timestamp();
        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        counter += 1;

        let escrow = Escrow {
            id: counter,
            provider_id,
            payer: payer.clone(),
            token: provider.payment_token.clone(),
            amount,
            created_at: now,
            release_at: now + cfg.dispute_window_secs,
            status: EscrowStatus::Open,
            disputed_at: 0,
            reason_hash: BytesN::from_array(&env, &[0u8; 32]),
        };

        env.storage().persistent().set(&DataKey::Escrow(counter), &escrow);
        env.storage().persistent().set(&consumed_key, &true);
        env.storage().instance().set(&DataKey::EscrowCounter, &counter);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("opened"), counter),
            escrow.clone(),
        );

        counter
    }

    /// Disputa una escrow abierta. Sólo el payer (o el admin) puede disputar, y
    /// sólo dentro de la ventana: después de `release_at` los fondos ya son
    /// liberables al provider y la disputa se rechaza.
    pub fn dispute_escrow(
        env: Env,
        escrow_id: u64,
        caller: Address,
        reason_hash: BytesN<32>,
    ) -> Escrow {
        let mut escrow = Self::escrow_or_panic(&env, escrow_id);
        if escrow.status != EscrowStatus::Open {
            panic_with_error!(&env, Error::EscrowNotOpen);
        }

        let admin: Address = Self::admin(env.clone());
        if caller != escrow.payer && caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        caller.require_auth();

        let now = env.ledger().timestamp();
        if now > escrow.release_at {
            panic_with_error!(&env, Error::EscrowWindowClosed);
        }

        escrow.status = EscrowStatus::Disputed;
        escrow.disputed_at = now;
        escrow.reason_hash = reason_hash;

        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("disputed"), escrow_id),
            escrow.clone(),
        );

        escrow
    }

    /// Libera al provider una escrow cuya ventana de disputa ya pasó sin
    /// disputa. Es permissionless: cualquiera puede crankearla (el destino es
    /// el owner del provider, que ya está en el registry).
    pub fn release_escrow(env: Env, escrow_id: u64) -> Escrow {
        let mut escrow = Self::escrow_or_panic(&env, escrow_id);
        if escrow.status == EscrowStatus::Disputed {
            // Una disputa abierta sólo la cierra el admin con `resolve_dispute`.
            panic_with_error!(&env, Error::EscrowDisputed);
        }
        if escrow.status != EscrowStatus::Open {
            panic_with_error!(&env, Error::EscrowNotOpen);
        }

        let now = env.ledger().timestamp();
        if now < escrow.release_at {
            panic_with_error!(&env, Error::EscrowWindowOpen);
        }

        let provider = Self::provider_or_panic(&env, escrow.provider_id);
        let token = soroban_sdk::token::Client::new(&env, &escrow.token);
        token.transfer(
            &env.current_contract_address(),
            &provider.owner,
            &(escrow.amount as i128),
        );

        escrow.status = EscrowStatus::Released;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("released"), escrow_id),
            escrow.clone(),
        );

        escrow
    }

    /// Resuelve una disputa. Sólo el admin.
    ///
    /// `refund_to_payer = true` devuelve los fondos al payer; `false` los
    /// libera al provider (disputa rechazada).
    pub fn resolve_dispute(env: Env, escrow_id: u64, refund_to_payer: bool) -> Escrow {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();

        let mut escrow = Self::escrow_or_panic(&env, escrow_id);
        if escrow.status != EscrowStatus::Disputed {
            panic_with_error!(&env, Error::EscrowNotOpen);
        }

        let token = soroban_sdk::token::Client::new(&env, &escrow.token);
        let recipient = if refund_to_payer {
            escrow.status = EscrowStatus::Refunded;
            escrow.payer.clone()
        } else {
            escrow.status = EscrowStatus::Released;
            Self::provider_or_panic(&env, escrow.provider_id).owner
        };

        token.transfer(
            &env.current_contract_address(),
            &recipient,
            &(escrow.amount as i128),
        );

        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (
                symbol_short!("escrow"),
                if refund_to_payer { symbol_short!("refunded") } else { symbol_short!("released") },
                escrow_id,
            ),
            escrow.clone(),
        );

        escrow
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        Self::escrow_or_panic(&env, escrow_id)
    }

    pub fn escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0)
    }

    // ─── Internos ───────────────────────────────────────────────

    fn provider_or_panic(env: &Env, provider_id: u64) -> Provider {
        env.storage()
            .persistent()
            .get(&DataKey::Provider(provider_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::NotFound))
    }

    fn escrow_or_panic(env: &Env, escrow_id: u64) -> Escrow {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::NotFound))
    }
}

// ───────────────────────────── Tests

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::token::{StellarAssetClient, TokenClient};
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, BytesN, Env, String, Symbol};

    /// Asserts that a generated `try_*` wrapper failed with `expected`.
    ///
    /// The `try_*` wrappers return the contract error nested inside the host
    /// error (`Result<T, Result<soroban_sdk::Error, InvokeError>>`), so
    /// `assert_eq!(call, Err(Ok(Error::X)))` does not type check.
    fn assert_contract_error<T>(
        result: Result<T, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
        expected: Error,
    ) {
        let host_error = match result {
            Ok(_) => panic!("expected a contract error, but the call succeeded"),
            Err(Err(_)) => panic!("expected a contract error, but the call aborted"),
            Err(Ok(host_error)) => host_error,
        };
        assert_eq!(host_error, expected.into());
    }

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

    // ─── Escrow + ventana de disputa ────────────────────────────

    /// Escrow de un provider con USDC de prueba: `(provider_id, owner, token, payer)`.
    fn escrow_fixture(
        env: &Env,
        client: &FloviaRegistryClient<'static>,
        window_secs: u64,
    ) -> (u64, Address, Address, Address) {
        let owner = Address::generate(env);
        let payer = Address::generate(env);
        let token_admin = Address::generate(env);
        let token = env.register_stellar_asset_contract(token_admin);
        StellarAssetClient::new(env, &token).mint(&payer, &10_000i128);

        let id = client.register_provider(
            &owner,
            &String::from_str(env, "FX Rates Oracle"),
            &String::from_str(env, "https://fx.example.com/rate"),
            &50_000u64,
            &token,
            &BytesN::from_array(env, &[3u8; 32]),
            &Symbol::new(env, "fx"),
        );
        client.set_escrow_config(&id, &true, &window_secs);
        (id, owner, token, payer)
    }

    fn balances(env: &Env, token: &Address, payer: &Address, provider_owner: &Address, contract: &Address) -> (i128, i128, i128) {
        let tc = TokenClient::new(env, token);
        (tc.balance(payer), tc.balance(provider_owner), tc.balance(contract))
    }

    #[test]
    fn escrow_is_optional_per_provider() {
        let (env, client, _) = setup();
        let owner = Address::generate(&env);
        let payer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin);
        StellarAssetClient::new(&env, &token).mint(&payer, &10_000i128);

        let optimistic = client.register_provider(
            &owner,
            &String::from_str(&env, "Direct pay"),
            &String::from_str(&env, "https://direct.example.com"),
            &50_000u64,
            &token,
            &BytesN::from_array(&env, &[0u8; 32]),
            &Symbol::new(&env, "data"),
        );

        // Sin configuración el provider cobra directo: el escrow no aplica.
        assert_eq!(client.get_escrow_config(&optimistic).enabled, false);
        assert_contract_error(
            client.try_open_escrow(&optimistic, &payer, &1_000u64, &BytesN::from_array(&env, &[1u8; 32])),
            Error::EscrowDisabled,
        );

        // Al habilitarlo, la misma llamada retiene los fondos.
        client.set_escrow_config(&optimistic, &true, &3_600u64);
        let escrow_id = client.open_escrow(
            &optimistic,
            &payer,
            &1_000u64,
            &BytesN::from_array(&env, &[2u8; 32]),
        );
        assert_eq!(escrow_id, 1);
        assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Open);
        assert_eq!(client.get_escrow(&escrow_id).release_at, env.ledger().timestamp() + 3_600);
    }

    #[test]
    fn holds_funds_and_releases_to_the_provider_after_the_window() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let (provider_id, owner, token, payer) = escrow_fixture(&env, &client, 3_600);

        let escrow_id = client.open_escrow(
            &provider_id,
            &payer,
            &5_000u64,
            &BytesN::from_array(&env, &[4u8; 32]),
        );
        let contract = client.address.clone();

        // Los fondos quedan retenidos en el contrato, no en el provider.
        assert_eq!(balances(&env, &token, &payer, &owner, &contract), (5_000, 0, 5_000));

        // Release anticipado: rechazado, y sin mover fondos.
        assert_contract_error(
            client.try_release_escrow(&escrow_id),
            Error::EscrowWindowOpen,
        );
        assert_eq!(balances(&env, &token, &payer, &owner, &contract), (5_000, 0, 5_000));

        // Pasada la ventana sin disputa, los fondos se liberan al owner.
        env.ledger().with_mut(|li| li.timestamp += 3_600);
        let released = client.release_escrow(&escrow_id);
        assert_eq!(released.status, EscrowStatus::Released);
        assert_eq!(balances(&env, &token, &payer, &owner, &contract), (5_000, 5_000, 0));
        assert_eq!(client.escrow_count(), 1);

        // Un segundo release no puede volver a pagar.
        assert_contract_error(
            client.try_release_escrow(&escrow_id),
            Error::EscrowNotOpen,
        );
        assert_eq!(balances(&env, &token, &payer, &owner, &contract), (5_000, 5_000, 0));
    }

    #[test]
    fn a_dispute_inside_the_window_blocks_release_until_the_admin_resolves_it() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let (provider_id, owner, token, payer) = escrow_fixture(&env, &client, 3_600);
        let contract = client.address.clone();

        let escrow_id = client.open_escrow(
            &provider_id,
            &payer,
            &5_000u64,
            &BytesN::from_array(&env, &[5u8; 32]),
        );

        let disputed = client.dispute_escrow(
            &escrow_id,
            &payer,
            &BytesN::from_array(&env, &[9u8; 32]),
        );
        assert_eq!(disputed.status, EscrowStatus::Disputed);
        assert_eq!(disputed.disputed_at, 1_700_000_000);

        // Aunque pase la ventana, con disputa abierta nada se libera solo.
        env.ledger().with_mut(|li| li.timestamp += 10_000);
        assert_contract_error(
            client.try_release_escrow(&escrow_id),
            Error::EscrowDisputed,
        );

        // El admin resuelve a favor del payer: se devuelve el depósito.
        let resolved = client.resolve_dispute(&escrow_id, &true);
        assert_eq!(resolved.status, EscrowStatus::Refunded);
        assert_eq!(balances(&env, &token, &payer, &owner, &contract), (10_000, 0, 0));
    }

    #[test]
    fn a_dispute_after_the_window_is_rejected() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let (provider_id, _owner, _token, payer) = escrow_fixture(&env, &client, 3_600);

        let escrow_id = client.open_escrow(
            &provider_id,
            &payer,
            &5_000u64,
            &BytesN::from_array(&env, &[6u8; 32]),
        );

        env.ledger().with_mut(|li| li.timestamp += 3_601);
        assert_contract_error(
            client.try_dispute_escrow(&escrow_id, &payer, &BytesN::from_array(&env, &[9u8; 32])),
            Error::EscrowWindowClosed,
        );
    }

    #[test]
    fn a_dispute_rejected_by_the_admin_releases_to_the_provider() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let (provider_id, owner, token, payer) = escrow_fixture(&env, &client, 3_600);

        let escrow_id = client.open_escrow(
            &provider_id,
            &payer,
            &5_000u64,
            &BytesN::from_array(&env, &[7u8; 32]),
        );
        client.dispute_escrow(&escrow_id, &payer, &BytesN::from_array(&env, &[9u8; 32]));

        let resolved = client.resolve_dispute(&escrow_id, &false);
        assert_eq!(resolved.status, EscrowStatus::Released);
        assert_eq!(
            balances(&env, &token, &payer, &owner, &client.address.clone()),
            (5_000, 5_000, 0)
        );
    }

    #[test]
    fn escrow_config_is_validated() {
        let (env, client, _) = setup();
        let (provider_id, _owner, _token, _payer) = escrow_fixture(&env, &client, 3_600);

        // Ventana cero (o desmedida) con escrow habilitado: inválida.
        assert_contract_error(
            client.try_set_escrow_config(&provider_id, &true, &0u64),
            Error::InvalidArgument,
        );
        assert_contract_error(
            client.try_set_escrow_config(&provider_id, &true, &(MAX_DISPUTE_WINDOW_SECS + 1)),
            Error::InvalidArgument,
        );
        // Un provider inexistente no puede configurarse.
        assert_contract_error(
            client.try_set_escrow_config(&99u64, &true, &3_600u64),
            Error::NotFound,
        );
        // La config anterior sigue vigente tras los rechazos.
        assert_eq!(client.get_escrow_config(&provider_id).dispute_window_secs, 3_600);
    }

    #[test]
    fn an_escrow_cannot_reuse_a_tx_hash_already_logged_as_a_payment() {
        let (env, client, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);
        let (provider_id, _owner, _token, payer) = escrow_fixture(&env, &client, 3_600);
        let tx_hash = BytesN::from_array(&env, &[8u8; 32]);

        client.log_payment(&provider_id, &payer, &5_000u64, &tx_hash);

        assert_contract_error(
            client.try_open_escrow(&provider_id, &payer, &5_000u64, &tx_hash),
            Error::PaymentAlreadyLogged,
        );

        // Y el mismo hash no puede abrir dos escrows.
        let fresh = BytesN::from_array(&env, &[10u8; 32]);
        let first = client.open_escrow(&provider_id, &payer, &1_000u64, &fresh);
        assert_contract_error(
            client.try_open_escrow(&provider_id, &payer, &1_000u64, &fresh),
            Error::PaymentAlreadyLogged,
        );
        assert_eq!(client.get_escrow(&first).amount, 1_000);
    }
}
