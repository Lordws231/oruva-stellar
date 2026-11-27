#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::{token, Env, String};

const ONE: i128 = 10_000_000;
const INPUT: i128 = 50 * ONE;
const MIN_OUT: i128 = 49 * ONE;
const DEADLINE: u32 = 200;

struct Fixture<'a> {
    client: OruvaIntentsClient<'a>,
    in_token: token::TokenClient<'a>,
    out_token: token::TokenClient<'a>,
    in_asset: Address,
    out_asset: Address,
    contract_id: Address,
    user: Address,
    solver: Address,
    recipient: Address,
    driver: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let solver = Address::generate(env);
    let recipient = Address::generate(env);
    let driver = Address::generate(env);

    let in_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let in_asset = in_sac.address();
    token::StellarAssetClient::new(env, &in_asset).mint(&user, &(200 * ONE));
    let out_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let out_asset = out_sac.address();
    token::StellarAssetClient::new(env, &out_asset).mint(&solver, &(200 * ONE));

    let contract_id = env.register(OruvaIntents, ());
    let client = OruvaIntentsClient::new(env, &contract_id);
    client.init(&admin);
    client.register_solver(&solver, &(10 * ONE));

    Fixture {
        in_token: token::TokenClient::new(env, &in_asset),
        out_token: token::TokenClient::new(env, &out_asset),
        client,
        in_asset,
        out_asset,
        contract_id,
        user,
        solver,
        recipient,
        driver,
    }
}

fn hash(env: &Env, id: &str) -> String {
    String::from_str(env, id)
}

fn stellar(env: &Env) -> String {
    String::from_str(env, "stellar")
}

fn create_swap(env: &Env, f: &Fixture, id: &str) {
    f.client.create_intent(
        &f.user,
        &hash(env, id),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &stellar(env),
        &f.recipient,
        &DEADLINE,
        &IntentKind::SwapConvert,
        &None,
    );
}

#[test]
fn happy_path_settle_moves_both_assets() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-001");

    f.client.fill_intent(
        &f.solver,
        &hash(&env, "intent-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:fill-001"),
    );

    assert_eq!(f.out_token.balance(&f.recipient), MIN_OUT);
    assert_eq!(f.in_token.balance(&f.solver), INPUT);
    assert_eq!(f.in_token.balance(&f.contract_id), 0);
    let intent = f.client.get_intent(&hash(&env, "intent-001")).unwrap();
    assert_eq!(intent.status, IntentStatus::Settled);
    assert_eq!(intent.solver, Some(f.solver.clone()));
    assert_eq!(intent.delivered_amount, MIN_OUT);
    assert_eq!(f.client.get_solver(&f.solver).unwrap().fills, 1);
}

#[test]
fn settle_below_minimum_output_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-002");

    let res = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "intent-002"),
        &(MIN_OUT - 1),
        &f.recipient,
        &hash(&env, "evidence:low"),
    );
    assert_eq!(res, Err(Ok(Error::BelowMinimumOutput)));
    assert_eq!(
        f.client.get_intent(&hash(&env, "intent-002")).unwrap().status,
        IntentStatus::Open
    );
}

#[test]
fn settle_after_deadline_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-003");
    env.ledger().with_mut(|l| l.sequence_number = DEADLINE + 1);

    let res = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "intent-003"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:late"),
    );
    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn double_settle_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-004");
    f.client.fill_intent(
        &f.solver,
        &hash(&env, "intent-004"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:fill-004"),
    );

    let res = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "intent-004"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:again"),
    );
    assert_eq!(res, Err(Ok(Error::NotOpen)));
    assert_eq!(f.in_token.balance(&f.solver), INPUT);
}

#[test]
fn refund_after_deadline_works() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-005");
    env.ledger().with_mut(|l| l.sequence_number = DEADLINE + 1);

    f.client.refund_intent(&f.user, &hash(&env, "intent-005"));

    assert_eq!(f.in_token.balance(&f.user), 200 * ONE);
    assert_eq!(
        f.client.get_intent(&hash(&env, "intent-005")).unwrap().status,
        IntentStatus::Refunded
    );
}

#[test]
fn refund_before_deadline_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-006");

    let res = f.client.try_refund_intent(&f.user, &hash(&env, "intent-006"));
    assert_eq!(res, Err(Ok(Error::DeadlineNotReached)));
}

#[test]
fn cancel_before_fill_works() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-007");

    f.client.cancel_intent(&f.user, &hash(&env, "intent-007"));

    assert_eq!(f.in_token.balance(&f.user), 200 * ONE);
    assert_eq!(
        f.client.get_intent(&hash(&env, "intent-007")).unwrap().status,
        IntentStatus::Cancelled
    );
    let res = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "intent-007"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:cancelled"),
    );
    assert_eq!(res, Err(Ok(Error::NotOpen)));
}

#[test]
fn wrong_recipient_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-008");
    let stranger = Address::generate(&env);

    let res = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "intent-008"),
        &MIN_OUT,
        &stranger,
        &hash(&env, "evidence:wrong-recipient"),
    );
    assert_eq!(res, Err(Ok(Error::WrongRecipient)));
    assert_eq!(f.out_token.balance(&stranger), 0);
}

#[test]
fn fare_intent_needs_both_confirmations() {
    let env = Env::default();
    let f = setup(&env);
    f.client.create_intent(
        &f.user,
        &hash(&env, "fare-001"),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &stellar(&env),
        &f.recipient,
        &DEADLINE,
        &IntentKind::FarePayment,
        &Some(f.driver.clone()),
    );

    let no_proof = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "fare-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:fare"),
    );
    assert_eq!(no_proof, Err(Ok(Error::ArrivalProofMissing)));

    f.client.confirm_arrival(
        &f.driver,
        &hash(&env, "fare-001"),
        &hash(&env, "proof:arrival-001"),
    );
    let no_auth = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "fare-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:fare"),
    );
    assert_eq!(no_auth, Err(Ok(Error::PassengerAuthorizationMissing)));

    f.client.authorize_settlement(&f.user, &hash(&env, "fare-001"));
    f.client.fill_intent(
        &f.solver,
        &hash(&env, "fare-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "evidence:fare"),
    );
    assert_eq!(
        f.client.get_intent(&hash(&env, "fare-001")).unwrap().status,
        IntentStatus::Settled
    );
}

#[test]
fn solver_bond_and_penalty_recorded() {
    let env = Env::default();
    let f = setup(&env);

    let record = f.client.get_solver(&f.solver).unwrap();
    assert_eq!(record.bond_amount, 10 * ONE);
    assert_eq!(record.fills, 0);
    assert_eq!(record.penalties, 0);

    f.client.record_penalty(
        &f.solver,
        &hash(&env, "intent-missed"),
        &hash(&env, "late fill"),
    );
    assert_eq!(f.client.get_solver(&f.solver).unwrap().penalties, 1);
}

#[test]
fn cross_chain_fill_needs_evidence() {
    let env = Env::default();
    let f = setup(&env);
    f.client.create_intent(
        &f.user,
        &hash(&env, "xchain-001"),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &hash(&env, "polygon"),
        &f.recipient,
        &DEADLINE,
        &IntentKind::CrossChainPayout,
        &None,
    );

    let no_evidence = f.client.try_fill_intent(
        &f.solver,
        &hash(&env, "xchain-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, ""),
    );
    assert_eq!(no_evidence, Err(Ok(Error::EvidenceRequired)));

    f.client.fill_intent(
        &f.solver,
        &hash(&env, "xchain-001"),
        &MIN_OUT,
        &f.recipient,
        &hash(&env, "cctp:mint-001"),
    );
    let intent = f.client.get_intent(&hash(&env, "xchain-001")).unwrap();
    assert_eq!(intent.status, IntentStatus::Settled);
    assert_eq!(intent.evidence_ref, hash(&env, "cctp:mint-001"));
    assert_eq!(f.in_token.balance(&f.solver), INPUT);
}

#[test]
fn duplicate_intent_hash_fails() {
    let env = Env::default();
    let f = setup(&env);
    create_swap(&env, &f, "intent-009");

    let res = f.client.try_create_intent(
        &f.user,
        &hash(&env, "intent-009"),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &stellar(&env),
        &f.recipient,
        &DEADLINE,
        &IntentKind::SwapConvert,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::AlreadyExists)));
}

#[test]
fn empty_intent_hash_and_chain_fail() {
    let env = Env::default();
    let f = setup(&env);

    let empty_hash = f.client.try_create_intent(
        &f.user,
        &hash(&env, ""),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &stellar(&env),
        &f.recipient,
        &DEADLINE,
        &IntentKind::SwapConvert,
        &None,
    );
    assert_eq!(empty_hash, Err(Ok(Error::EmptyIntentHash)));

    let empty_chain = f.client.try_create_intent(
        &f.user,
        &hash(&env, "intent-empty-chain"),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &hash(&env, ""),
        &f.recipient,
        &DEADLINE,
        &IntentKind::SwapConvert,
        &None,
    );
    assert_eq!(empty_chain, Err(Ok(Error::EmptyOutputChain)));
}

#[test]
fn create_without_user_authorization_fails() {
    let env = Env::default();
    let f = setup(&env);
    // No authorization entries at all: the user's require_auth must fail,
    // which is the Soroban authorization-entry behaviour production
    // signing relies on.
    env.mock_auths(&[]);

    let res = f.client.try_create_intent(
        &f.user,
        &hash(&env, "intent-unauth"),
        &f.in_asset,
        &INPUT,
        &MIN_OUT,
        &f.out_asset,
        &stellar(&env),
        &f.recipient,
        &DEADLINE,
        &IntentKind::SwapConvert,
        &None,
    );
    assert!(res.is_err());
}
