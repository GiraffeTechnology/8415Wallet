// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {ResponsibilityController} from "./ResponsibilityController.sol";
import {ControlledWallet} from "./ControlledWallet.sol";

/// @notice Optional, separate native-currency payment adapter. No token custody
/// and no authority over responsibility completion, detachment or return.
/// @dev UNTESTED DEVELOPMENT CANDIDATE. Transfer and funding are separate transactions.
contract NativeResponsibilityPayments {
    ResponsibilityController public immutable controller;
    bytes32 private constant TERMS_TYPE = keccak256(
        "8415Wallet/NativePayment/v1(uint256 chainId,address adapter,address controller,address token,uint256 tokenId,address fromAccount,address toAccount,uint256 amount)"
    );
    enum PaymentState { None, Funded, SettlementDue, RefundDue, Settled, Refunded }
    struct Payment {
        address payer;
        address payee;
        uint256 amount;
        PaymentState state;
    }
    mapping(bytes32 => Payment) private _payments;
    bool private _entered;

    error Unauthorized();
    error InvalidPayment();
    error OutcomeUnavailable();
    error PayoutFailed();
    error ReentrantCall();
    event Funded(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed payer, address payee, uint256 amount);
    event Allocated(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed recipient, uint256 amount, PaymentState state);
    event Withdrawn(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed recipient, uint256 amount, PaymentState state);

    constructor(address controller_) {
        if (controller_.code.length == 0) revert InvalidPayment();
        controller = ResponsibilityController(controller_);
    }

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    function termsHash(address token, uint256 tokenId, address fromAccount, address toAccount, uint256 amount)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(TERMS_TYPE, block.chainid, address(this), address(controller),
            token, tokenId, fromAccount, toAccount, amount));
    }

    function payment(bytes32 sequenceId, bytes32 legId) external view returns (Payment memory) {
        return _payments[keccak256(abi.encode(sequenceId, legId))];
    }

    /// @notice Funds an already accepted leg, never establishing authority to recall.
    function fund(bytes32 sequenceId, uint256 legIndex) external payable nonReentrant {
        ResponsibilityController.Sequence memory s = controller.sequence(sequenceId);
        ResponsibilityController.Leg memory leg = controller.legAt(sequenceId, legIndex);
        if (s.closed || leg.outcome != ResponsibilityController.Outcome.Active || msg.value == 0) revert InvalidPayment();
        address payer = ControlledWallet(leg.toAccount).owner();
        address payee = ControlledWallet(leg.fromAccount).owner();
        if (msg.sender != payer) revert Unauthorized();
        if (termsHash(s.token, s.tokenId, leg.fromAccount, leg.toAccount, msg.value) != leg.termsHash) revert InvalidPayment();
        bytes32 key = keccak256(abi.encode(sequenceId, leg.id));
        if (_payments[key].state != PaymentState.None) revert InvalidPayment();
        _payments[key] = Payment(payer, payee, msg.value, PaymentState.Funded);
        emit Funded(sequenceId, leg.id, payer, payee, msg.value);
    }

    /// @notice Anyone may allocate a terminal leg once. A failed payout never revives it.
    /// @dev Keyed by leg id, not position: a completed leg detaches from the chain
    /// before its payment settles, so its record is no longer there to read. The
    /// controller still answers how it ended, and payer, payee and amount come
    /// from this contract's own funding record rather than from the trade.
    function allocate(bytes32 sequenceId, bytes32 legId) external nonReentrant {
        Payment storage p = _payments[keccak256(abi.encode(sequenceId, legId))];
        if (p.state != PaymentState.Funded) revert InvalidPayment();
        ResponsibilityController.Outcome outcome = controller.legTerminalOutcome(sequenceId, legId);
        address recipient;
        if (outcome == ResponsibilityController.Outcome.Completed) {
            p.state = PaymentState.SettlementDue;
            recipient = p.payee;
        } else if (outcome == ResponsibilityController.Outcome.Returned) {
            p.state = PaymentState.RefundDue;
            recipient = p.payer;
        } else revert OutcomeUnavailable();
        emit Allocated(sequenceId, legId, recipient, p.amount, p.state);
    }

    /// @notice Only the exact allocated recipient can withdraw, to itself.
    function withdraw(bytes32 sequenceId, bytes32 legId) external nonReentrant {
        Payment storage p = _payments[keccak256(abi.encode(sequenceId, legId))];
        address recipient;
        if (p.state == PaymentState.SettlementDue) {
            recipient = p.payee;
            p.state = PaymentState.Settled;
        } else if (p.state == PaymentState.RefundDue) {
            recipient = p.payer;
            p.state = PaymentState.Refunded;
        } else revert InvalidPayment();
        if (msg.sender != recipient) revert Unauthorized();
        (bool ok,) = recipient.call{value: p.amount}("");
        if (!ok) revert PayoutFailed();
        emit Withdrawn(sequenceId, legId, recipient, p.amount, p.state);
    }
}
