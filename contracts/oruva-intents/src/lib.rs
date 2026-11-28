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
//! Solver bonds are escrowed in this contract at registration. A
//! recorded penalty slashes the bond to the admin treasury sink, with
//! any shortfall tracked as penalty debt. A solver may claim an open
//! intent, which counts as an open obligation until a fill, refund,
//! cancel or penalty resolves it. Bond withdrawal returns the full
//! remaining bond and ends registration, and is only allowed after a
//! cooldown with no open obligations and no penalty debt.
//!
//! Testnet only. No real funds. No live fiat payout is claimed.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    String,
};

/// Ledgers a solver bond stays locked after the last solver activity
/// (registration, claim, fill, penalty, top up or obligation
/// resolution) before withdrawal is allowed. At roughly five seconds
/// per ledger this is about eighty minutes of dispute window.
pub const BOND_COOLDOWN_LEDGERS: u32 = 1_000;

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
    /// Solver that claimed the intent, if any. A claimed intent can
    /// only be filled by its claimant until the claim is resolved by
    /// a fill, refund, cancel or penalty.
    pub claimed_solver: Option<Address>,
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
    /// Asset the bond is denominated in. The bond is escrowed in this
    /// contract at registration and slashed or returned in this asset.
    pub bond_asset: Address,
    /// Bond still locked in this contract. Slashing reduces this
    /// amount, top ups increase it, withdrawal returns it in full.
    pub bond_amount: i128,
    /// Ledger sequence at registration.
    pub registered_at: u32,
    /// Ledger sequence of the last bond relevant activity:
    /// registration, claim, fill, penalty, top up or obligation
    /// resolution. Withdrawal needs BOND_COOLDOWN_LEDGERS to pass
    /// after this ledger.
    pub last_activity_ledger: u32,
    /// Intents this solver has claimed and not yet resolved by a
    /// fill, refund, cancel or penalty. Withdrawal is blocked while
    /// this count is above zero.
    pub open_obligations: u32,
    /// Slash amount owed beyond the locked bond. Withdrawal and new
    /// fills are blocked until a top up pays this amount to the
    /// admin treasury sink.
    pub penalty_debt: i128,
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
    BondCooldownActive = 25,
    OpenObligationsExist = 26,
    PenaltyDebtOutstanding = 27,
    InsufficientBond = 28,
    IntentAlreadyClaimed = 29,
    WrongSolver = 30,
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

/// Emitted when a solver registers and its bond is locked.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolverRegistered {
    #[topic]
    pub solver: Address,
    pub bond_asset: Address,
    pub bond_amount: i128,
}

/// Emitted when a penalty is recorded against a solver. Slashed funds
/// move to the admin treasury sink. Any slash shortfall beyond the
/// locked bond is tracked as penalty debt.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyRecorded {
    #[topic]
    pub solver: Address,
    pub intent_hash: String,
    pub reason: String,
    pub slash_amount: i128,
    pub slashed_amount: i128,
    pub remaining_bond: i128,
    pub penalty_debt: i128,
}

/// Emitted when a solver claims an open intent.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntentClaimed {
    #[topic]
    pub intent_hash: String,
    pub solver: Address,
}

/// Emitted when a solver tops up its bond. Any penalty debt is paid
/// to the admin treasury sink first, the remainder increases the bond.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondToppedUp {
    #[topic]
    pub solver: Address,
    pub amount: i128,
    pub bond_amount: i128,
    pub penalty_debt: i128,
}

/// Emitted when a solver withdraws its full remaining bond after the
/// cooldown with no open obligations. Withdrawal ends registration.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondWithdrawn {
    #[topic]
    pub solver: Address,
    pub bond_asset: Address,
    pub amount: i128,
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
                claimed_solver: None,
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

    /// Register as a solver and lock the bond in this contract. The
    /// bond moves from the solver to this contract in `bond_asset`
    /// and stays locked until slashing or withdrawal. The bond amount
    /// must be above zero.
    pub fn register_solver(
        env: Env,
        solver: Address,
        bond_asset: Address,
        bond_amount: i128,
    ) -> Result<(), Error> {
        solver.require_auth();
        if bond_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Solver(solver.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::SolverAlreadyRegistered);
        }
        let client = token::TokenClient::new(&env, &bond_asset);
        client.transfer(&solver, &env.current_contract_address(), &bond_amount);
        let now = env.ledger().sequence();
        write_solver(
            &env,
            &Solver {
                solver: solver.clone(),
                bond_asset: bond_asset.clone(),
                bond_amount,
                registered_at: now,
                last_activity_ledger: now,
                open_obligations: 0,
                penalty_debt: 0,
                fills: 0,
                penalties: 0,
            },
        );
        SolverRegistered {
            solver,
            bond_asset,
            bond_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Claim an open intent. Claiming records an open obligation for
    /// the solver: only the claimant may fill the intent, and bond
    /// withdrawal stays blocked until the claim is resolved by a
    /// fill, refund, cancel or penalty. Repeating a claim by the same
    /// solver is accepted without double counting.
    pub fn claim_intent(
        env: Env,
        solver: Address,
        intent_hash: String,
    ) -> Result<(), Error> {
        solver.require_auth();
        let mut solver_record = read_solver(&env, &solver)?;
        if solver_record.bond_amount <= 0 {
            return Err(Error::InsufficientBond);
        }
        if solver_record.penalty_debt > 0 {
            return Err(Error::PenaltyDebtOutstanding);
        }
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().sequence() > intent.deadline_ledger {
            return Err(Error::DeadlinePassed);
        }
        match &intent.claimed_solver {
            Some(claimant) if *claimant == solver => return Ok(()),
            Some(_) => return Err(Error::IntentAlreadyClaimed),
            None => {}
        }
        intent.claimed_solver = Some(solver.clone());
        write_intent(&env, &intent);
        solver_record.open_obligations += 1;
        solver_record.last_activity_ledger = env.ledger().sequence();
        write_solver(&env, &solver_record);
        IntentClaimed {
            intent_hash,
            solver,
        }
        .publish(&env);
        Ok(())
    }

    /// Top up the locked bond. The amount moves from the solver to
    /// this contract in the bond asset. Any penalty debt is paid to
    /// the admin treasury sink first, the remainder increases the
    /// bond. A top up restarts the withdrawal cooldown.
    pub fn top_up_bond(env: Env, solver: Address, amount: i128) -> Result<(), Error> {
        solver.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut solver_record = read_solver(&env, &solver)?;
        let client = token::TokenClient::new(&env, &solver_record.bond_asset);
        client.transfer(&solver, &env.current_contract_address(), &amount);
        let debt_paid = amount.min(solver_record.penalty_debt);
        if debt_paid > 0 {
            let admin = read_admin(&env)?;
            client.transfer(&env.current_contract_address(), &admin, &debt_paid);
            solver_record.penalty_debt -= debt_paid;
        }
        solver_record.bond_amount = solver_record
            .bond_amount
            .checked_add(amount - debt_paid)
            .ok_or(Error::InvalidAmount)?;
        solver_record.last_activity_ledger = env.ledger().sequence();
        let bond_amount = solver_record.bond_amount;
        let penalty_debt = solver_record.penalty_debt;
        write_solver(&env, &solver_record);
        BondToppedUp {
            solver,
            amount,
            bond_amount,
            penalty_debt,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw the full remaining bond and end registration. Only
    /// allowed after BOND_COOLDOWN_LEDGERS have passed since the last
    /// solver activity, with no open obligations and no penalty
    /// debt. The solver must register again before filling more
    /// intents.
    pub fn withdraw_bond(env: Env, solver: Address) -> Result<(), Error> {
        solver.require_auth();
        let solver_record = read_solver(&env, &solver)?;
        if solver_record.bond_amount <= 0 {
            return Err(Error::InsufficientBond);
        }
        if solver_record.open_obligations > 0 {
            return Err(Error::OpenObligationsExist);
        }
        if solver_record.penalty_debt > 0 {
            return Err(Error::PenaltyDebtOutstanding);
        }
        let ready_at = solver_record
            .last_activity_ledger
            .saturating_add(BOND_COOLDOWN_LEDGERS);
        if env.ledger().sequence() < ready_at {
            return Err(Error::BondCooldownActive);
        }
        let amount = solver_record.bond_amount;
        let bond_asset = solver_record.bond_asset.clone();
        let client = token::TokenClient::new(&env, &bond_asset);
        client.transfer(&env.current_contract_address(), &solver, &amount);
        env.storage()
            .persistent()
            .remove(&DataKey::Solver(solver.clone()));
        BondWithdrawn {
            solver,
            bond_asset,
            amount,
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

    /// Fill and settle an open intent. The solver must be registered
    /// with a positive bond and no penalty debt, the deadline must not
    /// have passed, the delivered amount must meet the minimum
    /// output, and the recipient must match the bound recipient. A
    /// claimed intent can only be filled by its claimant. Fare
    /// payment intents also need both confirmations. For Stellar
    /// output the solver output tokens move to the recipient in this
    /// call; for other output chains the solver records a non-empty
    /// evidence reference for the off-chain delivery. On settlement
    /// the locked input moves to the solver and any claim obligation
    /// is resolved.
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
        if solver_record.bond_amount <= 0 {
            return Err(Error::InsufficientBond);
        }
        if solver_record.penalty_debt > 0 {
            return Err(Error::PenaltyDebtOutstanding);
        }
        let mut intent = read_intent(&env, &intent_hash)?;
        if intent.status != IntentStatus::Open {
            return Err(Error::NotOpen);
        }
        if let Some(claimant) = &intent.claimed_solver {
            if *claimant != solver {
                return Err(Error::WrongSolver);
            }
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
        if intent.claimed_solver.is_some() {
            solver_record.open_obligations =
                solver_record.open_obligations.saturating_sub(1);
        }
        intent.status = IntentStatus::Settled;
        intent.solver = Some(solver.clone());
        intent.claimed_solver = None;
        intent.delivered_amount = delivered_amount;
        intent.evidence_ref = evidence_ref.clone();
        write_intent(&env, &intent);
        solver_record.fills += 1;
        solver_record.last_activity_ledger = env.ledger().sequence();
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
        if let Some(claimant) = intent.claimed_solver.take() {
            if let Ok(mut record) = read_solver(&env, &claimant) {
                record.open_obligations = record.open_obligations.saturating_sub(1);
                record.last_activity_ledger = env.ledger().sequence();
                write_solver(&env, &record);
            }
        }
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
        if let Some(claimant) = intent.claimed_solver.take() {
            if let Ok(mut record) = read_solver(&env, &claimant) {
                record.open_obligations = record.open_obligations.saturating_sub(1);
                record.last_activity_ledger = env.ledger().sequence();
                write_solver(&env, &record);
            }
        }
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

    /// Record a penalty against a solver for a failed or late fill
    /// and slash the bond. Slashed funds move from this contract to
    /// the admin treasury sink: the MVP has no separate treasury
    /// account, so the admin holds slashed funds for compensation
    /// handling. If the slash exceeds the locked bond, the whole
    /// bond is slashed and the shortfall is tracked as penalty debt
    /// until a top up pays it. If the named intent is open and
    /// claimed by this solver, the claim is released so another
    /// solver can fill it. The intent does not need to exist, so
    /// penalties for off-chain failures can still be recorded.
    pub fn record_penalty(
        env: Env,
        solver: Address,
        intent_hash: String,
        reason: String,
        slash_amount: i128,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        if slash_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let mut solver_record = read_solver(&env, &solver)?;
        let intent_key = DataKey::Intent(intent_hash.clone());
        if let Some(mut intent) = env
            .storage()
            .persistent()
            .get::<DataKey, Intent>(&intent_key)
        {
            let claimed_by_solver = matches!(
                &intent.claimed_solver,
                Some(claimant) if *claimant == solver
            );
            if intent.status == IntentStatus::Open && claimed_by_solver {
                intent.claimed_solver = None;
                write_intent(&env, &intent);
                solver_record.open_obligations =
                    solver_record.open_obligations.saturating_sub(1);
            }
        }
        let slashed_amount = slash_amount.min(solver_record.bond_amount);
        let shortfall = slash_amount - slashed_amount;
        solver_record.bond_amount -= slashed_amount;
        solver_record.penalty_debt = solver_record
            .penalty_debt
            .checked_add(shortfall)
            .ok_or(Error::InvalidAmount)?;
        solver_record.penalties += 1;
        solver_record.last_activity_ledger = env.ledger().sequence();
        if slashed_amount > 0 {
            let client = token::TokenClient::new(&env, &solver_record.bond_asset);
            client.transfer(&env.current_contract_address(), &admin, &slashed_amount);
        }
        let remaining_bond = solver_record.bond_amount;
        let penalty_debt = solver_record.penalty_debt;
        write_solver(&env, &solver_record);
        PenaltyRecorded {
            solver,
            intent_hash,
            reason,
            slash_amount,
            slashed_amount,
            remaining_bond,
            penalty_debt,
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
