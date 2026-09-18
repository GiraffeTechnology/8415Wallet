// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {IERC165} from "../IERC165.sol";
import {IRegisterProjection} from "../IRegisterProjection.sol";

interface IERC721Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

/// @title Escrow for a trade whose register confirmation arrives afterwards
///
/// @notice ERC-8415 exists because two sequences describe one asset: the
/// ERC-721 position, which moves the moment a trade settles on chain, and the
/// register's confirmed holder, which moves only when a proof is admitted,
/// possibly much later and possibly never. A buyer who pays on the position
/// alone has paid for a record that may never follow. This contract holds both
/// sides of a trade until the register has actually confirmed the buyer, and
/// returns them if it has not by an agreed deadline.
///
/// It reads the projection. It never writes one: there is no path here that
/// admits an entry, opens or cancels a gap, or overrides a register record.
/// Money is the only thing this contract has authority over.
///
/// ## Release is deliberately gated on a provisional record
///
/// It would be natural to release only once the confirmation is *final*, and
/// it would deadlock. An instant is final exactly when
/// `firstEntry.effectiveAt <= t < latestEntry.effectiveAt`, so an instant is
/// final only once a *later* entry exists. The admitting entry's own effective
/// time is therefore never final at the moment it is admitted, and waiting for
/// it to become final means waiting for an unrelated future admission on the
/// same token — which may never come. Release here happens on an admitted but
/// provisional record, and callers are owed that fact plainly rather than a
/// contract that appears to wait for certainty and simply never pays.
///
/// ## Refund is not gated on cancellation
///
/// The reference escrow pattern is usually stated as "refund if the gap is
/// cancelled without admission". That is too narrow to be safe. A gap can
/// close three ways — ADMITTED, CANCELLED, SUPERSEDED — and it can also simply
/// expire while still open, or never be opened at all. An escrow keyed on
/// CANCELLED hangs forever in the other cases. The condition here is the
/// complement of release, measured against a deadline: if the register has not
/// confirmed the buyer by then, both sides go back. Nothing is read as a
/// rejection, because the protocol has no rejection: a cancellation ends a
/// contest and settles nothing.
contract ProjectionEscrow {
    /// @dev ERC-165 identifier of IRegisterProjection, frozen by the standard.
    bytes4 internal constant INTERFACE_REGISTER_PROJECTION = 0x6309e170;

    enum State { NONE, AWAITING_PAYMENT, FUNDED, RELEASED, REFUNDED, ABANDONED }

    struct Trade {
        /// The ERC-8415 conforming ERC-721. One contract: the standard is additive.
        address projection;
        uint256 tokenId;
        address seller;
        address buyer;
        uint256 price;
        /// `entryCount` at the moment the trade was funded. The releasing entry
        /// must come after it, so a buyer the register had already confirmed
        /// before this trade cannot release it without a new admission.
        uint64 entryCountAtFunding;
        /// By when the register must have confirmed the buyer.
        uint64 admissionDeadline;
        /// The latest `effectiveAt` the parties will accept on that entry.
        ///
        /// Without a bound, an entry admitted with an effective time centuries
        /// out would satisfy "the holder is the buyer" while asserting a
        /// confirmation nobody traded for — and, because effective times are
        /// strictly increasing, it would end the projection for this token
        /// permanently. There is deliberately no lower bound: invariant 3
        /// already forbids an effective time at or below the previous entry's.
        uint64 maxEffectiveAt;
        State state;
    }

    mapping(bytes32 => Trade) private _trades;
    uint256 private _entered;

    event TradeOpened(bytes32 indexed tradeId, address indexed projection, uint256 indexed tokenId, address seller, address buyer, uint256 price, uint64 admissionDeadline, uint64 maxEffectiveAt);
    event TradeFunded(bytes32 indexed tradeId, address indexed buyer, uint256 price, uint64 entryCountAtFunding);
    /// @param version The version of the entry that confirmed the buyer. Emitted
    /// so an auditor can re-check the release against the register's own walk.
    event TradeReleased(bytes32 indexed tradeId, address indexed buyer, uint64 version, uint64 effectiveAt);
    event TradeRefunded(bytes32 indexed tradeId, address indexed buyer, uint64 entryCountAtRefund);
    event TradeAbandoned(bytes32 indexed tradeId, address indexed seller);

    error AlreadyExists();
    error NotFound();
    error WrongState();
    error NotParty();
    error InvalidTerms();
    error NotAProjection();
    error WrongPayment();
    error NotConfirmed();
    error DeadlineNotPassed();
    error AlreadyConfirmed();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @notice Lock the asset. Called by the seller, who must have approved this
    /// contract for the token first.
    /// @dev The projection is required to advertise ERC-8415 through ERC-165
    /// before anything is locked. Without that check this contract would escrow
    /// a trade against an address that has no projection at all, and every
    /// later read would be meaningless rather than merely unfavourable.
    function open(
        bytes32 tradeId,
        address projection,
        uint256 tokenId,
        address buyer,
        uint256 price,
        uint64 admissionDeadline,
        uint64 maxEffectiveAt
    ) external nonReentrant {
        if (_trades[tradeId].state != State.NONE) revert AlreadyExists();
        if (buyer == address(0) || buyer == msg.sender) revert InvalidTerms();
        if (admissionDeadline <= block.timestamp) revert InvalidTerms();
        if (maxEffectiveAt == 0) revert InvalidTerms();
        if (!_advertisesProjection(projection)) revert NotAProjection();

        _trades[tradeId] = Trade({
            projection: projection,
            tokenId: tokenId,
            seller: msg.sender,
            buyer: buyer,
            price: price,
            entryCountAtFunding: 0,
            admissionDeadline: admissionDeadline,
            maxEffectiveAt: maxEffectiveAt,
            state: State.AWAITING_PAYMENT
        });

        IERC721Minimal(projection).transferFrom(msg.sender, address(this), tokenId);
        emit TradeOpened(tradeId, projection, tokenId, msg.sender, buyer, price, admissionDeadline, maxEffectiveAt);
    }

    /// @notice Pay in full. Called by the named buyer.
    /// @dev The entry count is snapshotted here rather than at `open`, so the
    /// window in which a confirming admission must land begins when both sides
    /// are actually committed.
    function fund(bytes32 tradeId) external payable nonReentrant {
        Trade storage trade = _trades[tradeId];
        if (trade.state == State.NONE) revert NotFound();
        if (trade.state != State.AWAITING_PAYMENT) revert WrongState();
        if (msg.sender != trade.buyer) revert NotParty();
        if (msg.value != trade.price) revert WrongPayment();

        uint64 count = IRegisterProjection(trade.projection).entryCount(trade.tokenId);
        trade.entryCountAtFunding = count;
        trade.state = State.FUNDED;
        emit TradeFunded(tradeId, msg.sender, msg.value, count);
    }

    /// @notice Hand the asset to the buyer and the money to the seller, once the
    /// register has confirmed the buyer.
    ///
    /// @dev Permissionless on purpose. The condition is objective and readable
    /// by anyone, so neither party can hold the trade hostage by declining to
    /// call. The projection is read inside this transaction, which is the shape
    /// the standard recommends: a read taken in an earlier transaction — even
    /// one in the same block — can be overtaken by an admission before the
    /// value moves.
    function release(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _trades[tradeId];
        if (trade.state == State.NONE) revert NotFound();
        if (trade.state != State.FUNDED) revert WrongState();

        (bool confirmed, uint64 version, uint64 effectiveAt) = _confirmation(trade);
        if (!confirmed) revert NotConfirmed();

        trade.state = State.RELEASED;
        emit TradeReleased(tradeId, trade.buyer, version, effectiveAt);

        IERC721Minimal(trade.projection).safeTransferFrom(address(this), trade.buyer, trade.tokenId);
        _pay(trade.seller, trade.price);
    }

    /// @notice Return both sides, once the deadline has passed without the
    /// register confirming the buyer.
    ///
    /// @dev Also permissionless, and also re-reads the projection rather than
    /// trusting the passage of time alone: if the confirmation did land, this
    /// must not claw an asset back from a buyer the register now recognises.
    function refund(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _trades[tradeId];
        if (trade.state == State.NONE) revert NotFound();
        if (trade.state != State.FUNDED) revert WrongState();
        if (block.timestamp <= trade.admissionDeadline) revert DeadlineNotPassed();

        (bool confirmed,,) = _confirmation(trade);
        if (confirmed) revert AlreadyConfirmed();

        trade.state = State.REFUNDED;
        emit TradeRefunded(tradeId, trade.buyer, _entryCountOrZero(trade));

        IERC721Minimal(trade.projection).safeTransferFrom(address(this), trade.seller, trade.tokenId);
        _pay(trade.buyer, trade.price);
    }

    /// @notice Take the asset back before the buyer has paid.
    function abandon(bytes32 tradeId) external nonReentrant {
        Trade storage trade = _trades[tradeId];
        if (trade.state == State.NONE) revert NotFound();
        if (trade.state != State.AWAITING_PAYMENT) revert WrongState();
        if (msg.sender != trade.seller) revert NotParty();

        trade.state = State.ABANDONED;
        emit TradeAbandoned(tradeId, trade.seller);
        IERC721Minimal(trade.projection).safeTransferFrom(address(this), trade.seller, trade.tokenId);
    }

    function tradeOf(bytes32 tradeId) external view returns (Trade memory) {
        return _trades[tradeId];
    }

    /// @notice Everything a front end needs about a trade, read atomically.
    ///
    /// @dev The three signals stay three values. `confirmed` is whether this
    /// escrow's release condition holds; `positionHolder` is `ownerOf`, which
    /// is this contract while the trade is live and is never the same fact as
    /// the confirmed holder; `gapOpen` is whether a settlement is in flight.
    /// None of them is a verdict, and `gapOpen` in particular decides nothing
    /// here: a gap being open does not mean the buyer will be admitted, and a
    /// gap being closed does not mean they were.
    function observe(bytes32 tradeId)
        external
        view
        returns (
            State state,
            bool confirmed,
            uint64 version,
            uint64 effectiveAt,
            address confirmedHolder,
            address positionHolder,
            uint64 entryCount
        )
    {
        Trade storage trade = _trades[tradeId];
        if (trade.state == State.NONE) revert NotFound();
        (confirmed, version, effectiveAt) = _confirmation(trade);
        entryCount = _entryCountOrZero(trade);
        try IRegisterProjection(trade.projection).currentEntry(trade.tokenId) returns (
            IRegisterProjection.RegisterEntry memory entry
        ) {
            confirmedHolder = entry.holder;
        } catch {
            confirmedHolder = address(0);
        }
        try IERC721Minimal(trade.projection).ownerOf(trade.tokenId) returns (address owner) {
            positionHolder = owner;
        } catch {
            positionHolder = address(0);
        }
        state = trade.state;
    }

    /// @dev Whether an address says it is an ERC-8415 projection.
    ///
    /// Wrapped, because the two ways of failing must land on one answer. A
    /// contract that implements ERC-165 and returns false is saying no; an
    /// address with no `supportsInterface` at all reverts, and an address with
    /// no code returns nothing. None of them is a projection, and a caller who
    /// pointed this at the wrong address is owed that sentence rather than a
    /// bare revert from a call they never knew was made.
    function _advertisesProjection(address projection) private view returns (bool) {
        if (projection.code.length == 0) return false;
        try IERC165(projection).supportsInterface(INTERFACE_REGISTER_PROJECTION) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev The whole release rule, in one place.
    ///
    /// Three things must hold together, and the reason for each is different:
    ///
    ///  - the latest entry names the buyer as the confirmed holder;
    ///  - its version is past the count taken when the trade was funded, so the
    ///    confirmation is one this trade produced rather than one that already
    ///    stood;
    ///  - its effective time is within the bound the parties agreed.
    ///
    /// A projection with no entries reverts rather than answering, so the call
    /// is wrapped: for this contract "the register does not answer" is not
    /// confirmation, and must not be an error that strands the trade either.
    function _confirmation(Trade storage trade)
        private
        view
        returns (bool confirmed, uint64 version, uint64 effectiveAt)
    {
        try IRegisterProjection(trade.projection).currentEntry(trade.tokenId) returns (
            IRegisterProjection.RegisterEntry memory entry
        ) {
            confirmed =
                entry.holder == trade.buyer &&
                entry.version > trade.entryCountAtFunding &&
                entry.effectiveAt <= trade.maxEffectiveAt;
            return (confirmed, entry.version, entry.effectiveAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _entryCountOrZero(Trade storage trade) private view returns (uint64) {
        try IRegisterProjection(trade.projection).entryCount(trade.tokenId) returns (uint64 count) {
            return count;
        } catch {
            return 0;
        }
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Lets the asset be safe-transferred in as well as pulled.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
