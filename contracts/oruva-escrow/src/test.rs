#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Events as _;
use soroban_sdk::{token, Env, Event as _, String};

/// One TUSD in the token's smallest unit (7 decimals).
const ONE_TUSD: i128 = 10_000_000;
/// The demo fare: 25 TUSD.
const FARE: i128 = 25 * ONE_TUSD;

struct Fixture<'a> {
    client: OruvaEscrowClient<'a>,
    token: token::TokenClient<'a>,
    token_address: Address,
    contract_id: Address,
    admin: Address,
    rider: Address,
    driver: Address,
    treasury: Address,
    external_wallet: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let rider = Address::generate(env);
    let driver = Address::generate(env);
    let treasury = Address::generate(env);
    let external_wallet = Address::generate(env);

    // Test fare token (Stellar Asset Contract) with the rider funded.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = sac.address();
    let sac_client = token::StellarAssetClient::new(env, &token_address);
    let token = token::TokenClient::new(env, &token_address);
    sac_client.mint(&rider, &(100 * ONE_TUSD));

    let contract_id = env.register(OruvaEscrow, ());
    let client = OruvaEscrowClient::new(env, &contract_id);
    client.init(&admin, &token_address, &treasury);

    Fixture {
        client,
        token,
        token_address,
        contract_id,
        admin,
        rider,
        driver,
        treasury,
        external_wallet,
    }
}

fn ride_id(env: &Env, id: &str) -> String {
    String::from_str(env, id)
}

#[test]
fn lock_moves_funds_and_records_ride() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);

    // The lock emits a FareLocked event from this contract. Events are only
    // visible for the last invocation, so check them before any other call.
    // (The token transfer event comes from the token contract, so filter by
    // contract.)
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        [FareLocked {
            ride_id: id.clone(),
            rider: f.rider.clone(),
            driver: f.driver.clone(),
            amount: FARE,
        }
        .to_xdr(&env, &f.contract_id)],
    );

    assert_eq!(f.token.balance(&f.rider), 100 * ONE_TUSD - FARE);
    assert_eq!(f.token.balance(&f.contract_id), FARE);
    assert_eq!(f.token.balance(&f.driver), 0);
    assert_eq!(
        f.client.get_ride(&id),
        Some(Ride {
            rider: f.rider.clone(),
            driver: f.driver.clone(),
            amount: FARE,
            status: RideStatus::Locked,
        })
    );
}

#[test]
fn release_credits_driver_balance() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.release_fare(&id);

    assert_eq!(f.token.balance(&f.driver), 0);
    assert_eq!(f.token.balance(&f.contract_id), FARE);
    assert_eq!(f.client.get_driver_balance(&f.driver), FARE);
    assert_eq!(
        f.client.get_ride(&id).unwrap().status,
        RideStatus::Released
    );
}

#[test]
fn withdraw_sends_ninety_percent_and_keeps_ten_percent() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.release_fare(&id);
    f.client.withdraw(&f.driver, &f.external_wallet, &FARE);

    assert_eq!(f.token.balance(&f.external_wallet), 22_500_0000);
    assert_eq!(f.token.balance(&f.treasury), 2_500_0000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_driver_balance(&f.driver), 0);
}

#[test]
fn partial_withdraw_keeps_remaining_balance() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");
    let withdrawal = 10 * ONE_TUSD;

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.release_fare(&id);
    f.client.withdraw(&f.driver, &f.external_wallet, &withdrawal);

    assert_eq!(f.token.balance(&f.external_wallet), 9 * ONE_TUSD);
    assert_eq!(f.token.balance(&f.treasury), ONE_TUSD);
    assert_eq!(f.token.balance(&f.contract_id), FARE - withdrawal);
    assert_eq!(f.client.get_driver_balance(&f.driver), FARE - withdrawal);
}

#[test]
fn withdraw_more_than_balance_fails() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.release_fare(&id);
    let res = f
        .client
        .try_withdraw(&f.driver, &f.external_wallet, &(FARE + 1));
    assert_eq!(res, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn withdraw_zero_amount_fails() {
    let env = Env::default();
    let f = setup(&env);
    let res = f.client.try_withdraw(&f.driver, &f.external_wallet, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn refund_returns_fare_to_rider() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.refund_fare(&id);

    assert_eq!(f.token.balance(&f.rider), 100 * ONE_TUSD);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(
        f.client.get_ride(&id).unwrap().status,
        RideStatus::Refunded
    );
}

#[test]
fn lock_twice_same_ride_fails() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    let res = f
        .client
        .try_lock_fare(&f.rider, &f.driver, &FARE, &id);
    assert_eq!(res, Err(Ok(Error::AlreadyExists)));
}

#[test]
fn release_after_refund_fails() {
    let env = Env::default();
    let f = setup(&env);
    let id = ride_id(&env, "ride-001");

    f.client.lock_fare(&f.rider, &f.driver, &FARE, &id);
    f.client.refund_fare(&id);
    let res = f.client.try_release_fare(&id);
    assert_eq!(res, Err(Ok(Error::NotLocked)));
}

#[test]
fn release_unknown_ride_fails() {
    let env = Env::default();
    let f = setup(&env);
    let res = f.client.try_release_fare(&ride_id(&env, "no-such-ride"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn lock_zero_amount_fails() {
    let env = Env::default();
    let f = setup(&env);
    let res = f
        .client
        .try_lock_fare(&f.rider, &f.driver, &0, &ride_id(&env, "ride-001"));
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn double_init_fails() {
    let env = Env::default();
    let f = setup(&env);
    let res = f.client.try_init(&f.admin, &f.token_address, &f.treasury);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn get_ride_unknown_returns_none() {
    let env = Env::default();
    let f = setup(&env);
    assert_eq!(f.client.get_ride(&ride_id(&env, "no-such-ride")), None);
}
