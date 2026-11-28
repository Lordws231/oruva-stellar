//! Oruva CCTP wrapper (Soroban).
//!
//! Combines the two Stellar CCTP burn steps into one invocation so a
//! single user authorization covers both:
//!
//! 1. `approve` the TokenMessengerMinter to spend exactly the burn
//!    amount of the burn token, with a short expiration ledger.
//! 2. `deposit_for_burn` (or `deposit_for_burn_with_hook` when hook data
//!    is supplied) on the TokenMessengerMinter.
//!
//! The caller stays the depositor throughout: the wrapper never takes
//! custody of the tokens. CCTP pulls them from the caller with
//! `transfer_from` inside the same transaction, so the allowance set in
//! step 1 is consumed by step 2 and nothing is left approved if the
//! burn fails (the whole invocation rolls back).
//!
//! Route parameters follow `docs/platform-wiring-spec.md`: source
//! domain 27 (Stellar), destination domain 7 (Polygon), amounts kept at
//! 6-decimal precision inside Stellar 7-decimal units, finality
//! threshold 2000, and the 32-byte version 0 forwarding hook so Circle
//! submits the destination mint. The mint recipient is always an
//! explicit parameter. This contract hardcodes no recipient: Oruva's
//! Flutterwave Polygon USDC wallet is not confirmed yet, and testnet
//! proofs use a clearly labelled stand-in recipient.
//!
//! Testnet only. No real funds.
#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Bytes, BytesN, Env,
};

/// CCTP domain id for Stellar (the source domain of every burn here).
pub const STELLAR_DOMAIN: u32 = 27;
/// CCTP domain id for Polygon (Oruva's production destination).
pub const POLYGON_DOMAIN: u32 = 7;
/// Suggested ledgers the TokenMessengerMinter allowance stays valid.
/// The burn consumes it in the same transaction; the window only has
/// to cover the current ledger, so it is kept short. Callers pass
/// `current_ledger + APPROVE_LEDGER_WINDOW` as the burn's
/// `approve_expiration_ledger`.
pub const APPROVE_LEDGER_WINDOW: u32 = 100;

/// The slice of Circle's TokenMessengerMinter interface this wrapper
/// calls. Signatures match the deployed testnet contract
/// `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`.
#[contractclient(name = "TokenMessengerClient")]
pub trait TokenMessengerInterface {
    fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    );

    fn deposit_for_burn_with_hook(
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
    );
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Admin (the Oruva platform account) recorded at init.
    Admin,
    /// Circle TokenMessengerMinter contract.
    TokenMessenger,
    /// Burn token (the USDC Stellar Asset Contract).
    BurnToken,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidAmountPrecision = 4,
    InvalidRecipient = 5,
    InvalidDestinationDomain = 6,
    InvalidMaxFee = 7,
    InvalidHookData = 8,
    InvalidExpiration = 9,
}

/// Emitted after a burn is submitted through the wrapper.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnSubmitted {
    #[topic]
    pub caller: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub with_hook: bool,
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn read_token_messenger(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::TokenMessenger)
        .ok_or(Error::NotInitialized)
}

fn read_burn_token(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::BurnToken)
        .ok_or(Error::NotInitialized)
}

/// A mint recipient for an EVM destination is a 20-byte address
/// left-padded to 32 bytes. Anything else is malformed for the routes
/// this wrapper serves (Polygon in production): the first 12 bytes
/// must be zero and the address itself must not be the zero address.
fn validate_recipient(mint_recipient: &BytesN<32>) -> Result<(), Error> {
    let bytes = mint_recipient.to_array();
    if bytes[..12].iter().any(|b| *b != 0) {
        return Err(Error::InvalidRecipient);
    }
    if bytes[12..].iter().all(|b| *b == 0) {
        return Err(Error::InvalidRecipient);
    }
    Ok(())
}

#[contract]
pub struct OruvaCctpWrapper;

#[contractimpl]
impl OruvaCctpWrapper {
    /// One-time setup. `admin` is the Oruva platform account;
    /// `token_messenger` is Circle's TokenMessengerMinter and
    /// `burn_token` is the USDC Stellar Asset Contract.
    pub fn init(
        env: Env,
        admin: Address,
        token_messenger: Address,
        burn_token: Address,
    ) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TokenMessenger, &token_messenger);
        env.storage().instance().set(&DataKey::BurnToken, &burn_token);
        env.storage().instance().extend_ttl(50_000, 200_000);
        Ok(())
    }

    /// Approve the TokenMessengerMinter and burn in one invocation.
    ///
    /// `amount` and `max_fee` are Stellar 7-decimal units and must keep
    /// 6-decimal precision (CCTP carries 6 decimals), so both must be
    /// multiples of 10. `mint_recipient` and `destination_caller` are
    /// 32-byte CCTP values; pass 32 zero bytes for `destination_caller`
    /// when the Circle Forwarding Service should submit the mint.
    /// With `hook_data` present the wrapper calls
    /// `deposit_for_burn_with_hook`; without it, `deposit_for_burn`.
    ///
    /// `approve_expiration_ledger` is the expiration ledger for the
    /// allowance set in step 1. It is a parameter, not derived from
    /// the current ledger inside the call, because the caller's
    /// authorization covers the approve arguments: an expiration
    /// computed at execution time would differ from the one recorded
    /// at simulation time and the authorization would not match.
    /// Pass `current_ledger + APPROVE_LEDGER_WINDOW`.
    pub fn burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Option<Bytes>,
        approve_expiration_ledger: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount % 10 != 0 {
            return Err(Error::InvalidAmountPrecision);
        }
        if destination_domain == STELLAR_DOMAIN {
            return Err(Error::InvalidDestinationDomain);
        }
        validate_recipient(&mint_recipient)?;
        if max_fee < 0 || max_fee >= amount {
            return Err(Error::InvalidMaxFee);
        }
        if max_fee % 10 != 0 {
            return Err(Error::InvalidAmountPrecision);
        }
        let with_hook = match &hook_data {
            Some(hook) => {
                if hook.is_empty() {
                    return Err(Error::InvalidHookData);
                }
                true
            }
            None => false,
        };
        if approve_expiration_ledger <= env.ledger().sequence() {
            return Err(Error::InvalidExpiration);
        }

        let token_messenger = read_token_messenger(&env)?;
        let burn_token = read_burn_token(&env)?;

        let token_client = token::TokenClient::new(&env, &burn_token);
        token_client.approve(
            &caller,
            &token_messenger,
            &amount,
            &approve_expiration_ledger,
        );

        let messenger = TokenMessengerClient::new(&env, &token_messenger);
        match hook_data {
            Some(hook) => messenger.deposit_for_burn_with_hook(
                &caller,
                &amount,
                &destination_domain,
                &mint_recipient,
                &burn_token,
                &destination_caller,
                &max_fee,
                &min_finality_threshold,
                &hook,
            ),
            None => messenger.deposit_for_burn(
                &caller,
                &amount,
                &destination_domain,
                &mint_recipient,
                &burn_token,
                &destination_caller,
                &max_fee,
                &min_finality_threshold,
            ),
        }

        BurnSubmitted {
            caller,
            amount,
            destination_domain,
            mint_recipient,
            max_fee,
            min_finality_threshold,
            with_hook,
        }
        .publish(&env);
        Ok(())
    }

    /// The 32-byte version 0 CCTP forwarding hook
    /// (`cctp-forward` magic plus version byte), so callers do not
    /// have to rebuild it. Pass it as `hook_data` to have Circle
    /// submit the destination mint.
    pub fn forwarding_hook(env: Env) -> Bytes {
        Bytes::from_array(
            &env,
            &[
                0x63, 0x63, 0x74, 0x70, 0x2d, 0x66, 0x6f, 0x72, 0x77, 0x61, 0x72, 0x64, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00,
            ],
        )
    }

    /// Read the admin recorded at init.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        read_admin(&env)
    }

    /// Read the TokenMessengerMinter recorded at init.
    pub fn get_token_messenger(env: Env) -> Result<Address, Error> {
        read_token_messenger(&env)
    }

    /// Read the burn token recorded at init.
    pub fn get_burn_token(env: Env) -> Result<Address, Error> {
        read_burn_token(&env)
    }
}

mod test;
