// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {ResponsibilityController} from "./ResponsibilityController.sol";
import {ControlledWallet} from "./ControlledWallet.sol";

/// @notice Optional, separate native-currency payment adapter. No token custody
/// and no authority over responsibility completion, detachment or return.
/// @dev Reserve before forward; consumption and token movement commit atomically.
contract NativeResponsibilityPayments {
    ResponsibilityController public immutable controller;
    bytes32 private constant TERMS_TYPE = keccak256(
        "8415Wallet/NativePayment/v1(uint256 chainId,address adapter,address controller,address token,uint256 tokenId,address fromAccount,address toAccount,uint256 amount)"
    );
    enum PaymentState { None, Funded, SettlementDue, RefundDue, Settled, Refunded, Reserved }
    struct Payment {
        address payer;
        address payee;
        uint256 amount;
        PaymentState state;
    }
    mapping(bytes32 => Payment) private _payments;
    struct Reservation { bytes32 digest; uint256 revision; uint256 nonce; uint64 deadline; }
    mapping(bytes32 => Reservation) private _reservations;
    bool private _entered;

    error Unauthorized();
    error InvalidPayment();
    error OutcomeUnavailable();
    error PayoutFailed();
    error ReentrantCall();
    event Funded(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed payer, address payee, uint256 amount);
    event Reserved(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed payer, address payee, uint256 amount);
    event ReservationCancelled(bytes32 indexed sequenceId, bytes32 indexed legId, address indexed payer, uint256 amount);
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

    /// @notice Original buyer reserves exact signed terms before any token movement.
    function reserve(ResponsibilityController.ForwardConsent calldata c) external payable nonReentrant {
        ResponsibilityController.Sequence memory s = controller.sequence(c.sequenceId);
        if (controller.nativePayments() != address(this) || c.paymentAdapter != address(this) ||
            msg.value == 0 || msg.value != c.paymentAmount || c.legId == bytes32(0) ||
            s.closed || s.callbackRootPlusOne != 0 || s.revision != c.expectedRevision ||
            s.token != c.token || s.tokenId != c.tokenId || s.currentAccount != c.fromAccount ||
            !controller.registeredAccount(c.toAccount) || c.toAccount == c.fromAccount ||
            block.timestamp > c.deadline || controller.inheritedHash(c.sequenceId) != c.inheritedHash) revert InvalidPayment();
        // Use the controller's same eligibility checks, including its active
        // window, all historical leg IDs, authority, identity and token position.
        // Never take a reservation for a consent already impossible to forward.
        if (!controller.checkForwardEligibility(c)) revert InvalidPayment();
        address payer = ControlledWallet(c.toAccount).owner();
        address payee = ControlledWallet(c.fromAccount).owner();
        if (msg.sender != payer) revert Unauthorized();
        if (controller.recipientNonces(payer) != c.recipientNonce ||
            termsHash(c.token, c.tokenId, c.fromAccount, c.toAccount, msg.value) != c.termsHash) revert InvalidPayment();
        bytes32 key = keccak256(abi.encode(c.sequenceId, c.legId));
        if (_payments[key].state != PaymentState.None) revert InvalidPayment();
        _payments[key] = Payment(payer, payee, msg.value, PaymentState.Reserved);
        _reservations[key] = Reservation(controller.consentDigest(c), c.expectedRevision, c.recipientNonce, c.deadline);
        emit Reserved(c.sequenceId, c.legId, payer, payee, msg.value);
    }

    /// @notice Only controller, in the very transaction that forwards the accepted leg.
    function consumeReservation(ResponsibilityController.ForwardConsent calldata c) external nonReentrant {
        if (msg.sender != address(controller)) revert Unauthorized();
        bytes32 key = keccak256(abi.encode(c.sequenceId, c.legId));
        Payment storage p = _payments[key];
        if (p.state != PaymentState.Reserved || p.amount != c.paymentAmount ||
            _reservations[key].digest != controller.consentDigest(c)) revert InvalidPayment();
        p.state = PaymentState.Funded;
        emit Funded(c.sequenceId, c.legId, p.payer, p.payee, p.amount);
    }

    /// @notice Refund an unused reservation only after its exact consent is unusable.
    /// The payer can first explicitly invalidate its recipient nonce; no active leg is affected.
    function cancelReservation(bytes32 sequenceId, bytes32 legId) external nonReentrant {
        bytes32 key = keccak256(abi.encode(sequenceId, legId));
        Payment storage p = _payments[key];
        if (p.state != PaymentState.Reserved) revert InvalidPayment();
        if (msg.sender != p.payer) revert Unauthorized();
        Reservation storage r = _reservations[key];
        ResponsibilityController.Sequence memory s = controller.sequence(sequenceId);
        if (!s.closed && s.revision == r.revision && controller.recipientNonces(p.payer) == r.nonce &&
            block.timestamp <= r.deadline) revert OutcomeUnavailable();
        p.state = PaymentState.RefundDue;
        emit ReservationCancelled(sequenceId, legId, p.payer, p.amount);
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
