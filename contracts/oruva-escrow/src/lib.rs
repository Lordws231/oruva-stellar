//! Oruva fare escrow (Soroban).
//!
//! Holds a rider's fare in escrow for the duration of a ride and settles it
//! when the trip ends:
//!
//! - `lock_fare`   rider locks the fare when the ride is accepted.
//! - `release_fare` Oruva (admin) releases the fare to the driver on trip
//!   completion.
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
    /// Fare was released to the driver on trip completion.
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
    /// One ride, keyed by its ride id.
    Ride(String),
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
    /// trip completion and cancellation; `token` is the fare token contract.
    pub fn init(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
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

    /// Release a locked fare to the driver. Called by the admin when the trip
    /// completes.
    pub fn release_fare(env: Env, ride_id: String) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        let mut ride = read_ride(&env, &ride_id)?;
        if ride.status != RideStatus::Locked {
            return Err(Error::NotLocked);
        }
        let token_addr = read_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        client.transfer(
            &env.current_contract_address(),
            &ride.driver,
            &ride.amount,
        );
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
}

mod test;
