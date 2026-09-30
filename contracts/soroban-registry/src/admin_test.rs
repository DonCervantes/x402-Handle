use super::*;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::IntoVal;

fn setup() -> (Env, Address, Address, Address, u64) {
    let env = Env::default();
    env.mock_all_auths();
    let contract = env.register_contract(None, FloviaRegistry);
    let client = FloviaRegistryClient::new(&env, &contract);
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    client.initialize(&admin);
    let id = client.register_provider(
        &owner,
        &String::from_str(&env, "Provider"),
        &String::from_str(&env, "https://example.com"),
        &10,
        &Address::generate(&env),
        &BytesN::from_array(&env, &[0; 32]),
        &symbol_short!("data"),
    );
    (env, contract, admin, owner, id)
}

#[test]
fn pause_blocks_all_data_writes_but_preserves_reads_and_recovery() {
    let (env, contract, admin, owner, id) = setup();
    let client = FloviaRegistryClient::new(&env, &contract);
    let hash = BytesN::from_array(&env, &[1; 32]);
    client.add_logger(&owner);
    client.log_payment(&owner, &id, &owner, &10, &hash);
    let provider = client.get_provider(&id);
    let payment = client.get_payment(&1);
    assert!(!client.paused());
    client.pause();
    assert!(client.paused());
    assert_eq!(
        client.try_register_provider(
            &owner,
            &provider.name,
            &provider.endpoint,
            &10,
            &provider.payment_token,
            &provider.metadata_hash,
            &provider.category,
        ),
        Err(Ok(Error::Paused.into()))
    );
    assert_eq!(
        client.try_update_provider(&id, &20, &provider.endpoint, &provider.metadata_hash),
        Err(Ok(Error::Paused.into()))
    );
    assert_eq!(client.try_deactivate(&id), Err(Ok(Error::Paused.into())));
    assert_eq!(client.try_activate(&id), Err(Ok(Error::Paused.into())));
    let next_hash = BytesN::from_array(&env, &[2; 32]);
    assert_eq!(
        client.try_log_payment(&owner, &id, &owner, &10, &next_hash),
        Err(Ok(Error::Paused.into()))
    );
    assert_eq!(client.get_provider(&id), provider);
    assert_eq!(client.get_payment(&1), payment);
    assert_eq!(client.provider_count(), 1);
    assert_eq!(client.payment_count(), 1);
    assert_eq!(client.list_providers(&1, &1).len(), 1);
    assert_eq!(client.list_payments(&id, &1, &1).len(), 1);
    client.remove_logger(&owner);
    client.add_logger(&owner);
    let next_admin = Address::generate(&env);
    client.transfer_admin(&next_admin);
    assert_eq!(client.admin(), next_admin);
    assert_ne!(client.admin(), admin);
    client.unpause();
    client.update_provider(&id, &20, &provider.endpoint, &provider.metadata_hash);
    client.deactivate(&id);
    client.activate(&id);
    assert_eq!(client.log_payment(&owner, &id, &owner, &10, &next_hash), 2);
    assert_eq!(client.get_provider(&id).price_stroops, 20);
}

#[test]
fn admin_controls_reject_missing_or_unrelated_authorization() {
    let (env, contract, admin, outsider, _) = setup();
    let client = FloviaRegistryClient::new(&env, &contract);
    env.mock_auths(&[]);
    assert!(client.try_pause().is_err());
    assert!(client.try_unpause().is_err());
    assert!(client.try_transfer_admin(&outsider).is_err());
    assert!(client.try_add_logger(&outsider).is_err());
    assert!(client.try_remove_logger(&outsider).is_err());
    assert!(client
        .mock_auths(&[MockAuth {
            address: &outsider,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "pause",
                args: ().into_val(&env),
                sub_invokes: &[]
            },
        }])
        .try_pause()
        .is_err());
    assert_eq!(client.admin(), admin);
    assert!(!client.paused());
    assert!(!client.is_logger(&outsider));
}

#[test]
fn transfer_requires_current_admin_and_revokes_old_admin() {
    let (env, contract, admin, next_admin, _) = setup();
    let client = FloviaRegistryClient::new(&env, &contract);
    env.mock_auths(&[]);
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "transfer_admin",
                args: (next_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .transfer_admin(&next_admin);
    assert_eq!(client.admin(), next_admin);
    assert!(client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "pause",
                args: ().into_val(&env),
                sub_invokes: &[]
            },
        }])
        .try_pause()
        .is_err());
    assert!(client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "transfer_admin",
                args: (admin.clone(),).into_val(&env),
                sub_invokes: &[]
            },
        }])
        .try_transfer_admin(&admin)
        .is_err());
    client
        .mock_auths(&[MockAuth {
            address: &next_admin,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "pause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .pause();
    assert!(client.paused());
}

#[test]
fn logger_membership_is_idempotent_and_revocable() {
    let (env, contract, _, logger, id) = setup();
    let client = FloviaRegistryClient::new(&env, &contract);
    let other = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[3; 32]);
    assert!(!client.is_logger(&logger));
    assert_eq!(
        client.try_log_payment(&logger, &id, &other, &10, &hash),
        Err(Ok(Error::NotAllowlisted.into()))
    );
    client.add_logger(&logger);
    client.add_logger(&logger);
    client.add_logger(&other);
    assert!(client.is_logger(&logger));
    assert_eq!(client.log_payment(&logger, &id, &other, &10, &hash), 1);
    client.remove_logger(&logger);
    client.remove_logger(&logger);
    assert!(!client.is_logger(&logger));
    assert!(client.is_logger(&other));
    let next_hash = BytesN::from_array(&env, &[4; 32]);
    assert_eq!(
        client.try_log_payment(&logger, &id, &other, &10, &next_hash),
        Err(Ok(Error::NotAllowlisted.into()))
    );
    assert_eq!(client.payment_count(), 1);
    client.add_logger(&logger);
    assert_eq!(client.log_payment(&logger, &id, &other, &10, &next_hash), 2);
    assert_eq!(
        client.try_log_payment(&other, &id, &other, &10, &next_hash),
        Err(Ok(Error::PaymentAlreadyLogged.into()))
    );
}

#[test]
fn allowlisted_logger_must_authorize_its_own_address() {
    let (env, contract, _, logger, id) = setup();
    let client = FloviaRegistryClient::new(&env, &contract);
    let payer = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[5; 32]);
    client.add_logger(&logger);
    env.mock_auths(&[]);
    assert!(client
        .try_log_payment(&logger, &id, &payer, &10, &hash)
        .is_err());
    assert!(client
        .mock_auths(&[MockAuth {
            address: &payer,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "log_payment",
                args: (logger.clone(), id, payer.clone(), 10u64, hash.clone()).into_val(&env),
                sub_invokes: &[]
            },
        }])
        .try_log_payment(&logger, &id, &payer, &10, &hash)
        .is_err());
    assert_eq!(client.payment_count(), 0);
    let payment_id = client
        .mock_auths(&[MockAuth {
            address: &logger,
            invoke: &MockAuthInvoke {
                contract: &contract,
                fn_name: "log_payment",
                args: (logger.clone(), id, payer.clone(), 10u64, hash.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .log_payment(&logger, &id, &payer, &10, &hash);
    assert_eq!(payment_id, 1);
    assert_eq!(client.get_payment(&payment_id).payer, payer);
}

#[test]
fn controls_reject_an_uninitialized_registry() {
    let env = Env::default();
    env.mock_all_auths();
    let contract = env.register_contract(None, FloviaRegistry);
    let client = FloviaRegistryClient::new(&env, &contract);
    let address = Address::generate(&env);
    assert_eq!(client.try_pause(), Err(Ok(Error::NotInitialized.into())));
    assert_eq!(client.try_unpause(), Err(Ok(Error::NotInitialized.into())));
    assert_eq!(
        client.try_transfer_admin(&address),
        Err(Ok(Error::NotInitialized.into()))
    );
    assert_eq!(
        client.try_add_logger(&address),
        Err(Ok(Error::NotInitialized.into()))
    );
    assert_eq!(
        client.try_remove_logger(&address),
        Err(Ok(Error::NotInitialized.into()))
    );
}
