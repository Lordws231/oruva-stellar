//! Oruva fare escrow (Soroban).
//!
//! Holds a rider's fare in escrow for the duration of a ride and settles it
//! when the trip ends:
//!
//! - `lock_fare`   rider locks the fare when the ride is accepted.
//! - `release_fare` Oruva (admin) credits the fare to the driver's
//!   withdrawable balance on trip completion.
//! - `withdraw`    driver withdraws to an external Stellar wallet; Oruva
//!   keeps a 10% withdrawal charge and the driver submits (and pays for)
//!   the Stellar transaction.
//! - `refund_fare` Oruva (admin) refunds the fare to the rider on
//!   cancellation.
//!
//! The fare token is any Stellar Asset Contract token. In the live design the
//! fare moves in USDC; the testnet demo uses TUSD, a test-issued stand-in for
//! USDC (see the workspace README). The contract is token-agnostic, so
//! switching the fare token is a deployment configuration change, not a code
//! change.
//!
//! Testnet only. No real funds.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    String,
};

/// Lifecycle of one escrowed fare.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RideStatus {
    /// Fare is locked in the contract; the ride is in progress.
    Locked,
    /// Fare was credited to the driver's withdrawable balance on trip
    /// completion.
    Released,
    /// Fare was refunded to the rider on cancellation.
    Refunded,
}

/// One escrowed ride.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ride {
    pub rider: Address,
    pub driver: Address,
    /// Fare amount in the token's smallest unit (7 decimals, like stroops).
    pub amount: i128,
    pub status: RideStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Admin (the Oruva platform) that confirms completion / cancellation.
    Admin,
    /// Fare token (Stellar Asset Contract address).
    Token,
    /// Oruva treasury that receives the withdrawal charge.
    Treasury,
    /// One ride, keyed by its ride id.
    Ride(String),
    /// A driver's withdrawable fare balance, keyed by driver address.
    DriverBalance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    AlreadyExists = 3,
    NotFound = 4,
    NotLocked = 5,
    InvalidAmount = 6,
    InsufficientBalance = 7,
}

/// Emitted when a rider locks a fare.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FareLocked {
    #[topic]
    pub ride_id: String,
    pub rider: Address,
    pub driver: Address,
    pub amount: i128,
}

/// Emitted when a fare is released to the driver on trip completion.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FareReleased {
    #[topic]
    pub ride_id: String,
    pub rider: Address,
    pub driver: Address,
    pub amount: i128,
}

/// Emitted when a fare is refunded to the rider on cancellation.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FareRefunded {
    #[topic]
    pub ride_id: String,
    pub rider: Address,
    pub driver: Address,
    pub amount: i128,
}

/// Emitted when a driver withdraws to an external Stellar wallet.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DriverWithdrawal {
    #[topic]
    pub driver: Address,
    pub destination: Address,
    pub gross_amount: i128,
    pub fee_amount: i128,
    pub net_amount: i128,
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn read_token(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Token)
        .ok_or(Error::NotInitialized)
}

fn read_treasury(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .ok_or(Error::NotInitialized)
}

fn read_driver_balance(env: &Env, driver: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::DriverBalance(driver.clone()))
        .unwrap_or(0)
}

fn write_driver_balance(env: &Env, driver: &Address, amount: i128) {
    let key = DataKey::DriverBalance(driver.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage().persistent().extend_ttl(&key, 50_000, 200_000);
}

/// Oruva's withdrawal charge: exactly 10% of the gross withdrawal amount,
/// rounded down to the token's smallest unit.
fn withdrawal_fee(amount: i128) -> i128 {
    amount / 10
}

fn read_ride(env: &Env, ride_id: &String) -> Result<Ride, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Ride(ride_id.clone()))
        .ok_or(Error::NotFound)
}

fn write_ride(env: &Env, ride_id: &String, ride: &Ride) {
    let key = DataKey::Ride(ride_id.clone());
    env.storage().persistent().set(&key, ride);
    env.storage().persistent().extend_ttl(&key, 50_000, 200_000);
}

#[contract]
pub struct OruvaEscrow;

#[contractimpl]
impl OruvaEscrow {
    /// One-time setup. `admin` is the Oruva platform account that confirms
    /// trip completion and cancellation; `token` is the fare token contract;
    /// `treasury` receives Oruva's 10% withdrawal charge.
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        treasury: Address,
    ) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().extend_ttl(50_000, 200_000);
        Ok(())
    }

    /// Lock a fare: pulls `amount` of the fare token from the rider into this
    /// contract and records the ride as Locked. Each ride id may be used once.
    pub fn lock_fare(
        env: Env,
        rider: Address,
        driver: Address,
        amount: i128,
        ride_id: String,
    ) -> Result<(), Error> {
        rider.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Ride(ride_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        let token_addr = read_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        client.transfer(&rider, &env.current_contract_address(), &amount);
        write_ride(
            &env,
            &ride_id,
            &Ride {
                rider: rider.clone(),
                driver: driver.clone(),
                amount,
                status: RideStatus::Locked,
            },
        );
        FareLocked {
            ride_id,
            rider,
            driver,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Release a locked fare into the driver's withdrawable balance. Called
    /// by the admin when the trip completes. The tokens stay in this
    /// contract until the driver withdraws, converts, or is paid out by the
    /// platform backend.
    pub fn release_fare(env: Env, ride_id: String) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        let mut ride = read_ride(&env, &ride_id)?;
        if ride.status != RideStatus::Locked {
            return Err(Error::NotLocked);
        }
        let balance = read_driver_balance(&env, &ride.driver) + ride.amount;
        write_driver_balance(&env, &ride.driver, balance);
        ride.status = RideStatus::Released;
        write_ride(&env, &ride_id, &ride);
        FareReleased {
            ride_id,
            rider: ride.rider,
            driver: ride.driver,
            amount: ride.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw part or all of a driver's balance to an external Stellar
    /// wallet. The driver authorizes and submits this call, so the driver
    /// pays the Stellar transaction fee. Oruva keeps exactly 10% of the
    /// gross amount; the destination receives the remaining 90%.
    pub fn withdraw(
        env: Env,
        driver: Address,
        destination: Address,
        amount: i128,
    ) -> Result<(), Error> {
        driver.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let balance = read_driver_balance(&env, &driver);
        if balance < amount {
            return Err(Error::InsufficientBalance);
        }
        let fee_amount = withdrawal_fee(amount);
        let net_amount = amount - fee_amount;
        write_driver_balance(&env, &driver, balance - amount);

        let token_addr = read_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        if fee_amount > 0 {
            let treasury = read_treasury(&env)?;
            client.transfer(&env.current_contract_address(), &treasury, &fee_amount);
        }
        client.transfer(&env.current_contract_address(), &destination, &net_amount);

        DriverWithdrawal {
            driver,
            destination,
            gross_amount: amount,
            fee_amount,
            net_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Refund a locked fare to the rider. Called by the admin when the ride is
    /// cancelled.
    pub fn refund_fare(env: Env, ride_id: String) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        let mut ride = read_ride(&env, &ride_id)?;
        if ride.status != RideStatus::Locked {
            return Err(Error::NotLocked);
        }
        let token_addr = read_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &ride.rider, &ride.amount);
        ride.status = RideStatus::Refunded;
        write_ride(&env, &ride_id, &ride);
        FareRefunded {
            ride_id,
            rider: ride.rider,
            driver: ride.driver,
            amount: ride.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Read the stored state of one ride. Returns None for an unknown id.
    pub fn get_ride(env: Env, ride_id: String) -> Option<Ride> {
        env.storage().persistent().get(&DataKey::Ride(ride_id))
    }

    /// Read a driver's withdrawable balance in the fare token's smallest
    /// unit. Unknown drivers read as zero.
    pub fn get_driver_balance(env: Env, driver: Address) -> i128 {
        read_driver_balance(&env, &driver)
    }
}

mod test;
