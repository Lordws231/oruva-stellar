//! Oruva Stellar Intents (Soroban), testnet MVP.
//!
//! A user locks an input asset with a signed intent: single-use intent
//! hash, minimum output, output asset/chain/recipient binding, deadline,
//! and intent kind. A registered solver fills the intent by delivering at
//! least the minimum output to the bound recipient; settlement releases
//! the locked input to the solver and records the fill evidence. After
//! the deadline an unsettled intent refunds to the user. Fare payment
//! intents reuse the oruva-escrow dual-confirmation pattern: settlement
//! needs the driver's arrival proof reference plus passenger
//! authorization.
//!
//! Cross-chain fills (output chain other than Stellar) are solver
//! attested in this MVP: the solver records an evidence reference (for
//! example a CCTP mint hash or a 1Click delivery reference) and the
//! contract enforces amount, recipient binding, deadline and single use.
//! Production cross-chain settlement needs delivery proof verification;
//! see docs/oruva-stellar-intents.md.
//!
//! Testnet only. No real funds. No live fiat payout is claimed.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    String,
};

/// What the intent is for. Mobility fare and payout intents are Oruva's
/// first vertical; the other kinds are the generic developer platform
/// intent types.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IntentKind {
    FarePayment,
    DriverPayout,
    AutomaticConvert,
    ManualConvert,
    SwapConvert,
    CrossChainPayout,
    EscrowRelease,
    RecurringSession,
    AgentPayment,
    BulkDisbursement,
    AnchorOffRamp,
    AnchorOnRamp,
}

/// Lifecycle of one intent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IntentStatus {
    /// Input locked, waiting for a solver fill.
    Open,
    /// Filled and settled. Terminal: can never settle again.
    Settled,
    /// Input returned to the user after the deadline. Terminal.
    Refunded,
    /// Cancelled by the user before any fill. Terminal.
    Cancelled,
}

/// One intent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Intent {
    pub user: Address,
    /// Single-use intent hash supplied by the creator (for example a hash
    /// of the signed intent payload).
    pub intent_hash: String,
    pub input_asset: Address,
    pub input_amount: i128,
    pub min_output_amount: i128,
    pub output_asset: Address,
    /// Output chain label: "stellar" for on-chain fills, otherwise the
    /// destination chain label (for example "polygon" or "xrpl").
    pub output_chain: String,
    /// Bound recipient of the output. Fills to any other recipient fail.
    pub recipient: Address,
    /// Last ledger sequence at which a fill may settle.
    pub deadline_ledger: u32,
    pub kind: IntentKind,
    pub status: IntentStatus,
    /// Driver for fare payment intents (arrival proof signer).
    pub driver: Option<Address>,
    /// Arrival proof reference recorded by the driver, if any.
    pub arrival_proof: Option<String>,
    /// Whether the passenger has authorized settlement (fare intents).
    pub passenger_authorized: bool,
    /// Solver that settled the intent, once settled.
    pub solver: Option<Address>,
    /// Output amount delivered at settlement.
    pub delivered_amount: i128,
    /// Fill evidence reference recorded at settlement.
    pub evidence_ref: String,
}

/// A registered solver.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Solver {
    pub solver: Address,
    /// Bond amount declared at registration. MVP records the field and
    /// emits it; bond escrow and slashing economics are later scope.
    pub bond_amount: i128,
    pub fills: u32,
    pub penalties: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Intent(String),
    Solver(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    AlreadyExists = 3,
    NotFound = 4,
    NotOpen = 5,
    InvalidAmount = 6,
    InvalidDeadline = 7,
    DeadlinePassed = 8,
    DeadlineNotReached = 9,
    BelowMinimumOutput = 10,
    WrongRecipient = 11,
    WrongUser = 12,
    WrongDriver = 13,
    DriverRequired = 14,
    NotFareIntent = 15,
    ArrivalProofMissing = 16,
    PassengerAuthorizationMissing = 17,
    EmptyArrivalProof = 18,
    ArrivalAlreadyConfirmed = 19,
    SolverNotRegistered = 20,
    SolverAlreadyRegistered = 21,
    EvidenceRequired = 22,
    EmptyIntentHash = 23,
    EmptyOutputChain = 24,
}

/// Emitted when an intent is created and its input is locked.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentCreated {
    #[topic]
    pub intent_hash: String,
    pub user: Address,
    pub input_asset: Address,
    pub input_amount: i128,
    pub min_output_amount: i128,
    pub recipient: Address,
    pub deadline_ledger: u32,
}

/// Emitted when a solver fills an intent.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentFilled {
    #[topic]
    pub intent_hash: String,
    pub solver: Address,
    pub delivered_amount: i128,
    pub recipient: Address,
}

/// Emitted when an intent settles and the locked input is released.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentSettled {
    #[topic]
    pub intent_hash: String,
    pub solver: Address,
    pub delivered_amount: i128,
    pub evidence_ref: String,
}

/// Emitted when an unsettled intent refunds after its deadline.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentRefunded {
    #[topic]
    pub intent_hash: String,
    pub user: Address,
    pub input_amount: i128,
}

/// Emitted when a user cancels an open intent before any fill.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentCancelled {
    #[topic]
    pub intent_hash: String,
    pub user: Address,
    pub input_amount: i128,
}

/// Emitted when the driver records an arrival proof for a fare intent.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArrivalConfirmed {
    #[topic]
    pub intent_hash: String,
    pub driver: Address,
    pub proof_ref: String,
}

/// Emitted when the passenger authorizes settlement of a fare intent.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementAuthorized {
    #[topic]
    pub intent_hash: String,
    pub user: Address,
}

/// Emitted when a solver registers with a declared bond.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolverRegistered {
    #[topic]
    pub solver: Address,
    pub bond_amount: i128,
}

/// Emitted when a penalty is recorded against a solver.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyRecorded {
    #[topic]
    pub solver: Address,
    pub intent_hash: String,
    pub reason: String,
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn read_intent(env: &Env, intent_hash: &String) -> Result<Intent, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Intent(intent_hash.clone()))
        .ok_or(Error::NotFound)
}

fn write_intent(env: &Env, intent: &Intent) {
    let key = DataKey::Intent(intent.intent_hash.clone());
    env.storage().persistent().set(&key, intent);
    env.storage().persistent().extend_ttl(&key, 50_000, 200_000);
}

fn read_solver(env: &Env, solver: &Address) -> Result<Solver, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Solver(solver.clone()))
        .ok_or(Error::SolverNotRegistered)
}

fn write_solver(env: &Env, solver: &Solver) {
    let key = DataKey::Solver(solver.solver.clone());
    env.storage().persistent().set(&key, solver);
    env.storage().persistent().extend_ttl(&key, 50_000, 200_000);
}

fn is_stellar_chain(env: &Env, output_chain: &String) -> bool {
    *output_chain == String::from_str(env, "stellar")
}

#[contract]
pub struct OruvaIntents;

#[contractimpl]
impl OruvaIntents {
    /// One-time setup. `admin` records solver penalties and is the Oruva
    /// platform account in the MVP.
    pub fn init(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().extend_ttl(50_000, 200_000);
        Ok(())
    }

    /// Create an intent: pulls `input_amount` of `input_asset` from the
    /// user into this contract. Each intent hash may be used once, ever:
    /// a settled, refunded or cancelled intent can never be recreated or
    /// settled again. Fare payment intents must name the driver whose
    /// arrival proof settlement will require.
    #[allow(clippy::too_many_arguments)]
    pub fn create_intent(
        env: Env,
        user: Address,
        intent_hash: String,
        input_asset: Address,
        input_amount: i128,
        min_output_amount: i128,
        output_asset: Address,
        output_chain: String,
        recipient: Address,
        deadline_ledger: u32,
        kind: IntentKind,
        driver: Option<Address>,
    ) -> Result<(), Error> {
        user.require_auth();
        if intent_hash.is_empty() {
            return Err(Error::EmptyIntentHash);
        }
        if output_chain.is_empty() {
            return Err(Error::EmptyOutputChain);
        }
        if input_amount <= 0 || min_output_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if deadline_ledger <= env.ledger().sequence() {
            return Err(Error::InvalidDeadline);
        }
        if kind == IntentKind::FarePayment && driver.is_none() {
            return Err(Error::DriverRequired);
        }
        let key = DataKey::Intent(intent_hash.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        let client = token::TokenClient::new(&env, &input_asset);
        client.transfer(&user, &env.current_contract_address(), &input_amount);
        write_intent(
            &env,
            &Intent {
                user: user.clone(),
                intent_hash: intent_hash.clone(),
                input_asset: input_asset.clone(),
                input_amount,
                min_output_amount,
                output_asset,
                output_chain,
                recipient: recipient.clone(),
                deadline_ledger,
                kind,
                status: IntentStatus::Open,
                driver,
                arrival_proof: None,
                passenger_authorized: false,
                solver: None,
                delivered_amount: 0,
                evidence_ref: String::from_str(&env, ""),
            },
        );
        IntentCreated {
            intent_hash,
            user,
            input_asset,
            input_amount,
            min_output_amount,
            recipient,
            deadline_ledger,
        }
        .publish(&env);
        Ok(())
    }

    /// Register as a solver with a declared bond amount. The MVP records
    /// the bond field; bond escrow and slashing are later scope.
    pub fn register_solver(
        env: Env,
        solver: Address,
        bond_amount: i128,
    ) -> Result<(), Error> {
        solver.require_auth();
        if bond_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Solver(solver.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::SolverAlreadyRegistered);
        }
        write_solver(
            &env,
            &Solver {
                solver: solver.clone(),
                bond_amount,
                fills: 0,
                penalties: 0,
            },
        );
        SolverRegistered {
            solver,
            bond_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Record the driver's arrival proof for a fare payment intent. Same
    /// retry-safe rule as oruva-escrow: the first proof wins, repeating
    /// it is accepted, a different proof is rejected.
    pub fn confirm_arrival(
        env: Env,
        driver: Address,
        intent_hash: String,
        proof_ref: String,
    ) -> Result<(), Error> {
        driver.require_auth();
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if intent.kind != IntentKind::FarePayment {
            return Err(Error::NotFareIntent);
        }
        match &intent.driver {
            Some(expected) if *expected == driver => {}
            _ => return Err(Error::WrongDriver),
        }
        if proof_ref.is_empty() {
            return Err(Error::EmptyArrivalProof);
        }
        match &intent.arrival_proof {
            Some(existing) if *existing == proof_ref => return Ok(()),
            Some(_) => return Err(Error::ArrivalAlreadyConfirmed),
            None => {}
        }
        intent.arrival_proof = Some(proof_ref.clone());
        write_intent(&env, &intent);
        ArrivalConfirmed {
            intent_hash,
            driver,
            proof_ref,
        }
        .publish(&env);
        Ok(())
    }

    /// Authorize settlement of a fare payment intent. Only the intent
    /// user (the passenger) may authorize. Repeating is accepted.
    pub fn authorize_settlement(
        env: Env,
        user: Address,
        intent_hash: String,
    ) -> Result<(), Error> {
        user.require_auth();
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if intent.kind != IntentKind::FarePayment {
            return Err(Error::NotFareIntent);
        }
        if user != intent.user {
            return Err(Error::WrongUser);
        }
        if intent.passenger_authorized {
            return Ok(());
        }
        intent.passenger_authorized = true;
        write_intent(&env, &intent);
        SettlementAuthorized { intent_hash, user }.publish(&env);
        Ok(())
    }

    /// Fill and settle an open intent. The solver must be registered,
    /// the deadline must not have passed, the delivered amount must meet
    /// the minimum output, and the recipient must match the bound
    /// recipient. Fare payment intents also need both confirmations.
    /// For Stellar output the solver's output tokens move to the
    /// recipient in this call; for other output chains the solver records
    /// a non-empty evidence reference for the off-chain delivery. On
    /// settlement the locked input moves to the solver.
    pub fn fill_intent(
        env: Env,
        solver: Address,
        intent_hash: String,
        delivered_amount: i128,
        recipient: Address,
        evidence_ref: String,
    ) -> Result<(), Error> {
        solver.require_auth();
        let mut solver_record = read_solver(&env, &solver)?;
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().sequence() > intent.deadline_ledger {
            return Err(Error::DeadlinePassed);
        }
        if delivered_amount < intent.min_output_amount {
            return Err(Error::BelowMinimumOutput);
        }
        if recipient != intent.recipient {
            return Err(Error::WrongRecipient);
        }
        if intent.kind == IntentKind::FarePayment {
            if intent.arrival_proof.is_none() {
                return Err(Error::ArrivalProofMissing);
            }
            if !intent.passenger_authorized {
                return Err(Error::PassengerAuthorizationMissing);
            }
        }
        if is_stellar_chain(&env, &intent.output_chain) {
            let out_client = token::TokenClient::new(&env, &intent.output_asset);
            out_client.transfer(&solver, &recipient, &delivered_amount);
        } else if evidence_ref.is_empty() {
            return Err(Error::EvidenceRequired);
        }
        let in_client = token::TokenClient::new(&env, &intent.input_asset);
        in_client.transfer(
            &env.current_contract_address(),
            &solver,
            &intent.input_amount,
        );
        intent.status = IntentStatus::Settled;
        intent.solver = Some(solver.clone());
        intent.delivered_amount = delivered_amount;
        intent.evidence_ref = evidence_ref.clone();
        write_intent(&env, &intent);
        solver_record.fills += 1;
        write_solver(&env, &solver_record);
        IntentFilled {
            intent_hash: intent_hash.clone(),
            solver: solver.clone(),
            delivered_amount,
            recipient,
        }
        .publish(&env);
        IntentSettled {
            intent_hash,
            solver,
            delivered_amount,
            evidence_ref,
        }
        .publish(&env);
        Ok(())
    }

    /// Refund an unsettled intent after its deadline. Only the intent
    /// user may reclaim, and only once the deadline has passed.
    pub fn refund_intent(
        env: Env,
        user: Address,
        intent_hash: String,
    ) -> Result<(), Error> {
        user.require_auth();
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if user != intent.user {
            return Err(Error::WrongUser);
        }
        if env.ledger().sequence() <= intent.deadline_ledger {
            return Err(Error::DeadlineNotReached);
        }
        let client = token::TokenClient::new(&env, &intent.input_asset);
        client.transfer(&env.current_contract_address(), &user, &intent.input_amount);
        intent.status = IntentStatus::Refunded;
        write_intent(&env, &intent);
        IntentRefunded {
            intent_hash,
            user,
            input_amount: intent.input_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Cancel an open intent before any fill. Only the intent user may
    /// cancel; the locked input returns immediately.
    pub fn cancel_intent(
        env: Env,
        user: Address,
        intent_hash: String,
    ) -> Result<(), Error> {
        user.require_auth();
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if user != intent.user {
            return Err(Error::WrongUser);
        }
        let client = token::TokenClient::new(&env, &intent.input_asset);
        client.transfer(&env.current_contract_address(), &user, &intent.input_amount);
        intent.status = IntentStatus::Cancelled;
        write_intent(&env, &intent);
        IntentCancelled {
            intent_hash,
            user,
            input_amount: intent.input_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Record a penalty against a solver for a failed or late fill. MVP
    /// records and emits only; bond slashing economics are later scope.
    pub fn record_penalty(
        env: Env,
        solver: Address,
        intent_hash: String,
        reason: String,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        let mut solver_record = read_solver(&env, &solver)?;
        solver_record.penalties += 1;
        write_solver(&env, &solver_record);
        PenaltyRecorded {
            solver,
            intent_hash,
            reason,
        }
        .publish(&env);
        Ok(())
    }

    /// Read one intent. Returns None for an unknown hash.
    pub fn get_intent(env: Env, intent_hash: String) -> Option<Intent> {
        env.storage().persistent().get(&DataKey::Intent(intent_hash))
    }

    /// Read one solver record. Returns None if not registered.
    pub fn get_solver(env: Env, solver: Address) -> Option<Solver> {
        env.storage().persistent().get(&DataKey::Solver(solver))
    }
}

mod test;
