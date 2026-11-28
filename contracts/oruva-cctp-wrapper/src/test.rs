#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Events as _;
use soroban_sdk::{contract, contractimpl, contracttype, token, Env, Event as _};

/// One USDC in Stellar 7-decimal units.
const ONE_USDC: i128 = 10_000_000;
/// Forward fee for a 1 USDC burn, 7-decimal units (0.054898 USDC).
const MAX_FEE: i128 = 548_980;
const FINALITY: u32 = 2000;

/// What the mock TokenMessenger recorded for its last burn call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MockBurn {
    pub caller: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub burn_token: Address,
    pub destination_caller: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub hook_data: Bytes,
    pub with_hook: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MockKey {
    LastBurn,
}

/// Stand-in for Circle's TokenMessengerMinter. Like the real contract
/// it requires the caller's authorization and pulls the burn amount
/// with `transfer_from`, so a burn only succeeds when the wrapper's
/// approve step set the allowance first. It holds the pulled tokens
/// instead of burning them; the tests assert on balances, allowance
/// and the recorded call.
#[contract]
pub struct MockTokenMessenger;

#[contractimpl]
impl MockTokenMessenger {
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        Self::record(
            &env,
            MockBurn {
                caller,
                amount,
                destination_domain,
                mint_recipient,
                burn_token,
                destination_caller,
                max_fee,
                min_finality_threshold,
                hook_data: Bytes::new(&env),
                with_hook: false,
            },
        );
    }

    pub fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    ) {
        Self::record(
            &env,
            MockBurn {
                caller,
                amount,
                destination_domain,
                mint_recipient,
                burn_token,
                destination_caller,
                max_fee,
                min_finality_threshold,
                hook_data,
                with_hook: true,
            },
        );
    }

    pub fn get_last_burn(env: Env) -> Option<MockBurn> {
        env.storage().instance().get(&MockKey::LastBurn)
    }

    fn record(env: &Env, burn: MockBurn) {
        burn.caller.require_auth();
        let client = token::TokenClient::new(env, &burn.burn_token);
        client.transfer_from(
            &env.current_contract_address(),
            &burn.caller,
            &env.current_contract_address(),
            &burn.amount,
        );
        env.storage().instance().set(&MockKey::LastBurn, &burn);
    }
}

struct Fixture<'a> {
    client: OruvaCctpWrapperClient<'a>,
    messenger: MockTokenMessengerClient<'a>,
    token: token::TokenClient<'a>,
    token_address: Address,
    contract_id: Address,
    messenger_id: Address,
    admin: Address,
    caller: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let caller = Address::generate(env);

    // Test USDC (Stellar Asset Contract) with the caller funded.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = sac.address();
    let sac_client = token::StellarAssetClient::new(env, &token_address);
    let token = token::TokenClient::new(env, &token_address);
    sac_client.mint(&caller, &(10 * ONE_USDC));

    let messenger_id = env.register(MockTokenMessenger, ());
    let messenger = MockTokenMessengerClient::new(env, &messenger_id);

    let contract_id = env.register(OruvaCctpWrapper, ());
    let client = OruvaCctpWrapperClient::new(env, &contract_id);
    client.init(&admin, &messenger_id, &token_address);

    Fixture {
        client,
        messenger,
        token,
        token_address,
        contract_id,
        messenger_id,
        admin,
        caller,
    }
}

/// The stand-in EVM recipient used by the testnet proofs, left-padded
/// to 32 bytes: 0xdceec8abca729fb0b40e86b98baebba9a59e818f.
fn recipient(env: &Env) -> BytesN<32> {
    BytesN::from_array(
        env,
        &[
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xdc, 0xee, 0xc8, 0xab, 0xca, 0x72, 0x9f, 0xb0,
            0xb4, 0x0e, 0x86, 0xb9, 0x8b, 0xae, 0xbb, 0xa9, 0xa5, 0x9e, 0x81, 0x8f,
        ],
    )
}

fn zero32(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// The approve expiration a caller passes: current ledger plus the
/// wrapper's suggested window.
fn expiration(env: &Env) -> u32 {
    env.ledger().sequence() + APPROVE_LEDGER_WINDOW
}

#[test]
fn burn_with_hook_approves_and_burns_in_one_call() {
    let env = Env::default();
    let f = setup(&env);
    let hook = f.client.forwarding_hook();

    f.client.burn(
        &f.caller,
        &(2 * ONE_USDC),
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &Some(hook.clone()),
    &expiration(&env),
    );

    // The wrapper emits BurnSubmitted; check before any other call.
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        [BurnSubmitted {
            caller: f.caller.clone(),
            amount: 2 * ONE_USDC,
            destination_domain: POLYGON_DOMAIN,
            mint_recipient: recipient(&env),
            max_fee: MAX_FEE,
            min_finality_threshold: FINALITY,
            with_hook: true,
        }
        .to_xdr(&env, &f.contract_id)],
    );

    // Funds moved caller -> TokenMessenger in the same call, the
    // wrapper itself holds nothing, and the allowance is consumed.
    assert_eq!(f.token.balance(&f.caller), 8 * ONE_USDC);
    assert_eq!(f.token.balance(&f.messenger_id), 2 * ONE_USDC);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.token.allowance(&f.caller, &f.messenger_id), 0);

    // The messenger saw exactly the burn parameters, hook included.
    let recorded = f.messenger.get_last_burn().expect("burn recorded");
    assert_eq!(
        recorded,
        MockBurn {
            caller: f.caller.clone(),
            amount: 2 * ONE_USDC,
            destination_domain: POLYGON_DOMAIN,
            mint_recipient: recipient(&env),
            burn_token: f.token_address.clone(),
            destination_caller: zero32(&env),
            max_fee: MAX_FEE,
            min_finality_threshold: FINALITY,
            hook_data: hook,
            with_hook: true,
        }
    );
}

#[test]
fn burn_without_hook_uses_plain_deposit_for_burn() {
    let env = Env::default();
    let f = setup(&env);

    f.client.burn(
        &f.caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &0,
        &FINALITY,
        &None,
    &expiration(&env),
    );

    assert_eq!(f.token.balance(&f.caller), 9 * ONE_USDC);
    assert_eq!(f.token.balance(&f.messenger_id), ONE_USDC);
    let recorded = f.messenger.get_last_burn().expect("burn recorded");
    assert!(!recorded.with_hook);
    assert!(recorded.hook_data.is_empty());
    assert_eq!(recorded.max_fee, 0);
}

#[test]
fn forwarding_hook_matches_the_recorded_bytes() {
    let env = Env::default();
    let f = setup(&env);
    // 0x636374702d666f72776172640000000000000000000000000000000000000000
    let expected = Bytes::from_array(
        &env,
        &[
            0x63, 0x63, 0x74, 0x70, 0x2d, 0x66, 0x6f, 0x72, 0x77, 0x61, 0x72, 0x64, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ],
    );
    assert_eq!(f.client.forwarding_hook(), expected);
}

#[test]
fn zero_and_negative_amounts_fail() {
    let env = Env::default();
    let f = setup(&env);
    for amount in [0, -ONE_USDC] {
        let result = f.client.try_burn(
            &f.caller,
            &amount,
            &POLYGON_DOMAIN,
            &recipient(&env),
            &zero32(&env),
            &MAX_FEE,
            &FINALITY,
            &None,
        &expiration(&env),
        );
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }
    assert_eq!(f.token.balance(&f.caller), 10 * ONE_USDC);
    assert!(f.messenger.get_last_burn().is_none());
}

#[test]
fn amount_below_six_decimal_precision_fails() {
    let env = Env::default();
    let f = setup(&env);
    // One 7-decimal unit past a 6-decimal amount: CCTP cannot carry it.
    let result = f.client.try_burn(
        &f.caller,
        &(ONE_USDC + 1),
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmountPrecision)));
}

#[test]
fn zero_recipient_fails() {
    let env = Env::default();
    let f = setup(&env);
    let result = f.client.try_burn(
        &f.caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &zero32(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidRecipient)));
}

#[test]
fn malformed_recipient_fails() {
    let env = Env::default();
    let f = setup(&env);
    // Address bytes pushed into the padding area: not a left-padded
    // EVM address.
    let mut bytes = [0u8; 32];
    bytes[0] = 0xdc;
    bytes[31] = 0x8f;
    let bad = BytesN::from_array(&env, &bytes);
    let result = f.client.try_burn(
        &f.caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &bad,
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidRecipient)));
}

#[test]
fn stellar_destination_domain_fails() {
    let env = Env::default();
    let f = setup(&env);
    let result = f.client.try_burn(
        &f.caller,
        &ONE_USDC,
        &STELLAR_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidDestinationDomain)));
}

#[test]
fn max_fee_at_or_above_amount_fails() {
    let env = Env::default();
    let f = setup(&env);
    for max_fee in [ONE_USDC, ONE_USDC + 10, -10] {
        let result = f.client.try_burn(
            &f.caller,
            &ONE_USDC,
            &POLYGON_DOMAIN,
            &recipient(&env),
            &zero32(&env),
            &max_fee,
            &FINALITY,
            &None,
        &expiration(&env),
        );
        assert_eq!(result, Err(Ok(Error::InvalidMaxFee)));
    }
}

#[test]
fn empty_hook_data_fails() {
    let env = Env::default();
    let f = setup(&env);
    let result = f.client.try_burn(
        &f.caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &Some(Bytes::new(&env)),
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::InvalidHookData)));
}

#[test]
fn expired_approve_expiration_fails() {
    let env = Env::default();
    let f = setup(&env);
    // An expiration at or before the current ledger can never cover
    // the approve, so the wrapper refuses before touching funds.
    let result = f.client.try_burn(
        &f.caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
        &env.ledger().sequence(),
    );
    assert_eq!(result, Err(Ok(Error::InvalidExpiration)));
    assert_eq!(f.token.balance(&f.caller), 10 * ONE_USDC);
}

#[test]
fn burn_more_than_balance_fails_and_rolls_back() {
    let env = Env::default();
    let f = setup(&env);
    // Caller holds 10 USDC; burning 11 must fail inside the pull, and
    // the approve from the same invocation must roll back with it.
    let result = f.client.try_burn(
        &f.caller,
        &(11 * ONE_USDC),
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert!(result.is_err());
    assert_eq!(f.token.balance(&f.caller), 10 * ONE_USDC);
    assert_eq!(f.token.balance(&f.messenger_id), 0);
    assert_eq!(f.token.allowance(&f.caller, &f.messenger_id), 0);
    assert!(f.messenger.get_last_burn().is_none());
}

#[test]
fn burn_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let caller = Address::generate(&env);
    let contract_id = env.register(OruvaCctpWrapper, ());
    let client = OruvaCctpWrapperClient::new(&env, &contract_id);
    let result = client.try_burn(
        &caller,
        &ONE_USDC,
        &POLYGON_DOMAIN,
        &recipient(&env),
        &zero32(&env),
        &MAX_FEE,
        &FINALITY,
        &None,
    &expiration(&env),
    );
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn double_init_fails() {
    let env = Env::default();
    let f = setup(&env);
    let result = f
        .client
        .try_init(&f.admin, &f.messenger_id, &f.token_address);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn getters_return_the_init_config() {
    let env = Env::default();
    let f = setup(&env);
    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_token_messenger(), f.messenger_id);
    assert_eq!(f.client.get_burn_token(), f.token_address);
}
