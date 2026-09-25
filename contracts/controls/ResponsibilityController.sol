// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {IERC165} from "../IERC165.sol";
import {IRegisterProjection} from "../IRegisterProjection.sol";
import {IProjectionSettlement} from "../IProjectionSettlement.sol";
import {ControlledWallet, IControlToken} from "./ControlledWallet.sol";
import {ControlSignatures} from "./ControlSignatures.sol";

/// @notice Independent application responsibility controls; never holds funds or tokens.
/// @dev UNTESTED DEVELOPMENT CANDIDATE. No protocol-state write methods are called.
/// An explicitly accepted, protocol-authorized registrar attests entry-to-occurrence
/// bindings. This extra application trust assumption is NOT proved by address equality.
contract ResponsibilityController {
    /// @notice How many legs may be UNRESOLVED at once. Detached history does not
    /// count: a completed prefix leaves the chain, so a token that keeps trading
    /// rolls A->B->C->D... forward indefinitely while AB, BC... detach behind it.
    ///
    /// A completed leg is not carried by the chain at all. Its storage is deleted
    /// when it detaches; what stays on chain is a constant-size commitment over
    /// every leg that has left, and the leg's full record is published in a
    /// LegDetached log for the register to hold and answer queries from. That is
    /// the same division the projection itself uses - the chain carries a
    /// commitment and a locator, the register carries the record - so the chain's
    /// state stays proportional to what is still in play, never to how much the
    /// token has ever traded.
    uint256 public constant MAX_ACTIVE_LEGS = 128;
    bytes32 public constant FORWARD_TYPEHASH = keccak256(
        "ForwardConsent(bytes32 sequenceId,uint256 expectedRevision,bytes32 legId,address token,uint256 tokenId,address fromAccount,address toAccount,bytes32 termsHash,bytes32 inheritedHash,address returnAuthority,bytes32 returnConditionHash,address evidenceAuthority,uint64 deadline,uint256 recipientNonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("8415Wallet ResponsibilityControls");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant INHERITED_SEED = keccak256("8415Wallet/ActiveResponsibilities/v1");
    bytes32 private constant DETACHED_SEED = keccak256("8415Wallet/DetachedResponsibilities/v1");

    enum Outcome { Active, Completed, Returning, Returned }
    struct Sequence {
        address token;
        uint256 tokenId;
        address initialAccount;
        address currentAccount;
        address evidenceAuthority;
        bytes32 registerId;
        bytes32 verificationProfile;
        bytes32 tokenCodeHash;
        uint256 revision;
        uint256 cursor;
        uint256 completedCount;
        uint256 callbackRootPlusOne;
        /// Legs ever appended, including those already detached. Occurrence
        /// numbers are absolute and never reused, so a detached leg's position
        /// keeps its meaning after its data is gone.
        uint256 appended;
        /// Folds every detached leg, in order. Constant size, and it is what
        /// makes a record the register returns checkable against this chain.
        bytes32 detachedCommitment;
        bool closed;
    }
    struct Leg {
        bytes32 id;
        address fromAccount;
        address toAccount;
        bytes32 termsHash;
        bytes32 acceptanceHash;
        address returnAuthority;
        bytes32 returnConditionHash;
        Outcome outcome;
    }
    struct ForwardConsent {
        bytes32 sequenceId;
        uint256 expectedRevision;
        bytes32 legId;
        address token;
        uint256 tokenId;
        address fromAccount;
        address toAccount;
        bytes32 termsHash;
        bytes32 inheritedHash;
        address returnAuthority;
        bytes32 returnConditionHash;
        address evidenceAuthority;
        uint64 deadline;
        uint256 recipientNonce;
    }
    struct AdmissionBinding {
        bool exists;
        uint256 occurrence;
        bytes32 immutableEntryHash;
    }

    mapping(address => address) public accountOf;
    mapping(address => bool) public registeredAccount;
    mapping(address => uint256) public recipientNonces;
    mapping(bytes32 => bytes32) private _currentSequence;
    mapping(bytes32 => Sequence) private _sequences;
    mapping(bytes32 => mapping(uint256 => Leg)) private _legs;
    mapping(bytes32 => mapping(bytes32 => uint256)) private _legIndexPlusOne;
    /// Whether a leg has completed and left the chain. One flag, not a record:
    /// an optional payment settles after its leg detaches, so the fact that it
    /// terminated has to outlive the trade data. Parties, terms, acceptance and
    /// return authority are gone - ask the register for those.
    mapping(bytes32 => mapping(bytes32 => bool)) private _detachedLeg;
    mapping(bytes32 => mapping(uint64 => AdmissionBinding)) private _admissionBindings;
    uint256 private _sequenceNonce;
    bool private _entered;

    error Unauthorized();
    error InvalidInput();
    error SequenceUnavailable();
    error RevisionMismatch();
    error ProjectionIdentityChanged();
    error UnsupportedProjection();
    error TokenLocationMismatch();
    error RecipientUnsupported();
    error ConsentRefused();
    error InheritanceMismatch();
    error CallbackActive();
    error ReturnBoundaryRefused();
    error CompletionEvidenceUnavailable();
    error CompletionConditionUnsatisfied();
    error AdmissionBindingImmutable();
    error SequenceRestartRequired();
    /// @notice The leg completed and left the chain. Its record is in its
    /// LegDetached log and at the register; it is not on chain to be read.
    error LegAtRegister();
    error ReentrantCall();

    event AccountCreated(address indexed owner, address indexed account);
    event SequenceOpened(bytes32 indexed sequenceId, address indexed token, uint256 indexed tokenId, address account, address evidenceAuthority);
    event Forwarded(bytes32 indexed sequenceId, bytes32 indexed legId, uint256 indexed occurrence, address fromAccount, address toAccount, bytes32 acceptanceHash, uint256 revision);
    event AdmissionBound(bytes32 indexed sequenceId, uint64 indexed version, uint256 indexed occurrence, bytes32 entryHash, uint256 revision);
    event PrefixCompleted(bytes32 indexed sequenceId, uint256 throughOccurrence, uint64 entryVersion, uint256 revision);
    /// @notice A completed leg leaving the chain, with the whole record it takes
    /// with it and the commitment that now covers it. This log is the register's
    /// copy: nothing here is readable from contract state afterwards.
    event LegDetached(
        bytes32 indexed sequenceId, bytes32 indexed legId, uint256 indexed occurrence,
        address fromAccount, address toAccount, bytes32 termsHash, bytes32 acceptanceHash,
        address returnAuthority, bytes32 returnConditionHash, bytes32 detachedCommitment
    );
    event ReturnBegun(bytes32 indexed sequenceId, bytes32 indexed rootLegId, bytes32 conditionHash, bytes32 evidenceCommitment, uint256 revision);
    event ReturnHopCompleted(bytes32 indexed sequenceId, bytes32 indexed legId, address fromAccount, address toAccount, uint256 revision);
    event SequenceClosed(bytes32 indexed sequenceId, uint256 revision);
    event RecipientNonceInvalidated(address indexed owner, uint256 nextNonce);

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    function createAccount() external nonReentrant returns (address account) {
        if (accountOf[msg.sender] != address(0)) revert InvalidInput();
        account = address(new ControlledWallet(msg.sender, address(this)));
        accountOf[msg.sender] = account;
        registeredAccount[account] = true;
        emit AccountCreated(msg.sender, account);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function consentDigest(ForwardConsent calldata consent) public view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), keccak256(abi.encode(FORWARD_TYPEHASH, consent))));
    }

    /// @notice Cryptographic check only; forward still checks nonce/revision/expiry/state atomically.
    function validateRecipientSignature(ForwardConsent calldata consent, bytes calldata signature)
        external view returns (bool)
    {
        if (!registeredAccount[consent.toAccount]) return false;
        return ControlSignatures.valid(ControlledWallet(consent.toAccount).owner(), consentDigest(consent), signature);
    }

    function invalidateRecipientNonce(uint256 nextNonce) external nonReentrant {
        if (nextNonce <= recipientNonces[msg.sender]) revert InvalidInput();
        recipientNonces[msg.sender] = nextNonce;
        emit RecipientNonceInvalidated(msg.sender, nextNonce);
    }

    function currentSequence(address token, uint256 tokenId) public view returns (bytes32) {
        return _currentSequence[keccak256(abi.encode(token, tokenId))];
    }

    function standaloneWithdrawalAllowed(address token, uint256 tokenId) external view returns (bool) {
        bytes32 id = currentSequence(token, tokenId);
        return id == bytes32(0) || _sequences[id].closed;
    }

    function sequence(bytes32 id) external view returns (Sequence memory) {
        if (_sequences[id].token == address(0)) revert SequenceUnavailable();
        return _sequences[id];
    }

    /// @notice Every leg the sequence has ever appended, detached ones included.
    /// Occurrence numbers are absolute, so this is the numbering, not the storage.
    function legCount(bytes32 id) external view returns (uint256) { return _sequences[id].appended; }

    /// @notice How many legs are still unresolved. This is what MAX_ACTIVE_LEGS
    /// bounds, and it is the length of the chain as a holder experiences it.
    function activeLegCount(bytes32 id) external view returns (uint256) {
        Sequence storage s = _sequences[id];
        return s.cursor - s.completedCount;
    }

    /// @notice Where the active window starts: the account the last detached leg
    /// handed the token to, or the sequence's opening account while nothing has
    /// detached. This is the earliest boundary a return can reach, and the chain
    /// knows it without keeping the leg that produced it.
    function boundaryAccount(bytes32 id) external view returns (address) {
        Sequence storage s = _sequences[id];
        if (s.token == address(0)) revert SequenceUnavailable();
        if (s.completedCount == 0) return s.initialAccount;
        return s.cursor > s.completedCount ? _legs[id][s.completedCount].fromAccount : s.currentAccount;
    }

    /// @notice How a leg ended, by id, whether or not it is still on chain.
    /// A detached leg answers Completed from a single flag; its record is not
    /// here. This exists so an optional payment adapter can settle a leg that
    /// has already left, without the chain keeping the trade to do it.
    function legTerminalOutcome(bytes32 id, bytes32 legId) external view returns (Outcome) {
        if (_detachedLeg[id][legId]) return Outcome.Completed;
        uint256 index = _legIndexPlusOne[id][legId];
        if (index == 0) revert InvalidInput();
        return _legs[id][index - 1].outcome;
    }

    /// @notice How many completed legs have left the chain, and the commitment
    /// folding them in order. Ask the register for the records themselves; a
    /// LegDetached log carries each one and checks against this value.
    function detached(bytes32 id) external view returns (uint256 count, bytes32 commitment) {
        Sequence storage s = _sequences[id];
        return (s.completedCount, s.detachedCommitment);
    }

    /// @notice An occurrence still carried by the chain. A detached one is not
    /// here: it reverts with LegDetached rather than returning an empty struct,
    /// so a caller is told where the record went instead of reading zeroes.
    function legAt(bytes32 id, uint256 index) external view returns (Leg memory) {
        Sequence storage s = _sequences[id];
        if (index >= s.appended) revert InvalidInput();
        if (index < s.completedCount) revert LegAtRegister();
        return _legs[id][index];
    }

    function admissionBinding(bytes32 id, uint64 version) external view returns (AdmissionBinding memory) {
        return _admissionBindings[id][version];
    }

    function openSequence(address token, uint256 tokenId, address evidenceAuthority)
        external nonReentrant returns (bytes32 id)
    {
        address account = accountOf[msg.sender];
        if (account == address(0) || evidenceAuthority == address(0)) revert Unauthorized();
        bytes32 oldId = currentSequence(token, tokenId);
        if (oldId != bytes32(0) && !_sequences[oldId].closed) revert SequenceUnavailable();
        _requireProjection(token);
        if (IControlToken(token).ownerOf(tokenId) != account) revert TokenLocationMismatch();
        if (!IProjectionSettlement(token).isSettlementAuthority(tokenId, evidenceAuthority)) revert Unauthorized();
        bytes32 registerId = IRegisterProjection(token).registerId();
        bytes32 profile = IProjectionSettlement(token).verificationProfile();
        if (registerId == bytes32(0) || profile == bytes32(0)) revert UnsupportedProjection();
        id = keccak256(abi.encode(block.chainid, address(this), token, tokenId, ++_sequenceNonce));
        _sequences[id] = Sequence({ token: token, tokenId: tokenId, initialAccount: account,
            currentAccount: account, evidenceAuthority: evidenceAuthority, registerId: registerId,
            verificationProfile: profile, tokenCodeHash: token.codehash, revision: 0,
            cursor: 0, completedCount: 0, callbackRootPlusOne: 0, appended: 0,
            detachedCommitment: bytes32(0), closed: false });
        _currentSequence[keccak256(abi.encode(token, tokenId))] = id;
        emit SequenceOpened(id, token, tokenId, account, evidenceAuthority);
    }

    function inheritedHash(bytes32 id) public view returns (bytes32 result) {
        if (_sequences[id].token == address(0)) revert SequenceUnavailable();
        result = keccak256(abi.encode(INHERITED_SEED, id));
        Sequence storage s = _sequences[id];
        // The window only. Legs below completedCount have detached and are not on
        // chain to read; legs above cursor are returned, not inherited. This runs
        // inside forward, so iterating anything but the window would make each
        // trade cost gas in proportion to every trade before it.
        for (uint256 i = s.completedCount; i < s.cursor; ++i) {
            Leg storage leg = _legs[id][i];
            if (leg.outcome == Outcome.Active) result = keccak256(abi.encode(
                result, leg.id, leg.termsHash, leg.acceptanceHash, leg.returnAuthority, leg.returnConditionHash
            ));
        }
    }

    /// @notice Seller's authenticated transaction + recipient's exact EIP-712/1271 consent.
    /// State, nonce and token movement revert together if any transfer/check fails.
    function forward(ForwardConsent calldata c, bytes calldata recipientSignature) external nonReentrant {
        Sequence storage s = _live(c.sequenceId, c.expectedRevision);
        _requireIdentity(s);
        if (s.callbackRootPlusOne != 0) revert CallbackActive();
        if (s.cursor != s.appended) revert SequenceRestartRequired();
        // The window is the unresolved tail, never the whole history.
        // A detached leg's index lookup is gone, so the uniqueness check has to
        // consult the detachment flag too. Without it a finished leg's id could be
        // reused by a new one, and legTerminalOutcome would then report that new,
        // still-active leg as Completed - which is what an attached payment pays
        // out on.
        if (s.cursor - s.completedCount >= MAX_ACTIVE_LEGS ||
            c.legId == bytes32(0) || _legIndexPlusOne[c.sequenceId][c.legId] != 0 ||
            _detachedLeg[c.sequenceId][c.legId] ||
            c.termsHash == bytes32(0) || c.returnAuthority == address(0) || c.returnConditionHash == bytes32(0)) revert InvalidInput();
        if (c.token != s.token || c.tokenId != s.tokenId || c.fromAccount != s.currentAccount ||
            c.evidenceAuthority != s.evidenceAuthority) revert InvalidInput();
        if (ControlledWallet(c.fromAccount).owner() != msg.sender) revert Unauthorized();
        if (!registeredAccount[c.toAccount] || c.toAccount == c.fromAccount) revert RecipientUnsupported();
        if (c.inheritedHash != inheritedHash(c.sequenceId)) revert InheritanceMismatch();
        if (block.timestamp > c.deadline) revert ConsentRefused();
        address recipientOwner = ControlledWallet(c.toAccount).owner();
        bytes32 digest = consentDigest(c);
        if (c.recipientNonce != recipientNonces[recipientOwner] ||
            !ControlSignatures.valid(recipientOwner, digest, recipientSignature)) revert ConsentRefused();
        if (IControlToken(s.token).ownerOf(s.tokenId) != c.fromAccount) revert TokenLocationMismatch();
        recipientNonces[recipientOwner]++;
        _legs[c.sequenceId][s.appended] = Leg({ id: c.legId, fromAccount: c.fromAccount,
            toAccount: c.toAccount, termsHash: c.termsHash, acceptanceHash: digest,
            returnAuthority: c.returnAuthority, returnConditionHash: c.returnConditionHash,
            outcome: Outcome.Active });
        s.appended += 1;
        _legIndexPlusOne[c.sequenceId][c.legId] = s.appended;
        s.cursor = s.appended;
        s.currentAccount = c.toAccount;
        s.revision++;
        ControlledWallet(c.fromAccount).controlTransfer(s.token, s.tokenId, c.toAccount);
        if (IControlToken(s.token).ownerOf(s.tokenId) != c.toAccount) revert TokenLocationMismatch();
        emit Forwarded(c.sequenceId, c.legId, s.appended, c.fromAccount, c.toAccount, digest, s.revision);
    }

    /// @notice The accepted registrar attests an admitted entry's specific occurrence.
    /// No numeric address ranking, Transfer-log heuristic, or caller's verified flag.
    /// Binding is immutable per entry version; equivocation is refused, not overwritten.
    function bindAdmission(bytes32 id, uint256 occurrence, uint64 version, uint256 expectedRevision)
        external nonReentrant
    {
        Sequence storage s = _live(id, expectedRevision);
        _requireIdentity(s);
        if (msg.sender != s.evidenceAuthority ||
            !IProjectionSettlement(s.token).isSettlementAuthority(s.tokenId, msg.sender)) revert Unauthorized();
        if (occurrence > s.appended || version == 0) revert InvalidInput();
        IRegisterProjection.RegisterEntry memory entry = IRegisterProjection(s.token).entryAt(s.tokenId, version);
        if (entry.version != version || entry.recordCommitment == bytes32(0) ||
            entry.holder != _position(id, occurrence)) revert CompletionEvidenceUnavailable();
        AdmissionBinding storage prior = _admissionBindings[id][version];
        bytes32 entryHash = _entryHash(entry);
        if (prior.exists) revert AdmissionBindingImmutable();
        prior.exists = true;
        prior.occurrence = occurrence;
        prior.immutableEntryHash = entryHash;
        s.revision++;
        emit AdmissionBound(id, version, occurrence, entryHash, s.revision);
    }

    /// @notice CP-01 is checked against the live projection in this transaction.
    /// ERC temporal finality is deliberately NOT an additional completion condition.
    function completeThrough(bytes32 id, bytes32 throughLegId, uint256 expectedRevision) external nonReentrant {
        Sequence storage s = _live(id, expectedRevision);
        _requireIdentity(s);
        if (s.callbackRootPlusOne != 0) revert CallbackActive();
        uint256 through = _legIndexPlusOne[id][throughLegId];
        if (through == 0 || through <= s.completedCount || through > s.cursor) revert CompletionConditionUnsatisfied();
        if (IControlToken(s.token).ownerOf(s.tokenId) != s.currentAccount) revert TokenLocationMismatch();
        if (block.timestamp > type(uint64).max) revert CompletionEvidenceUnavailable();
        uint64 instant = uint64(block.timestamp);
        IRegisterProjection.RegisterEntry memory entry = IRegisterProjection(s.token).entryAsOf(s.tokenId, instant);
        AdmissionBinding storage binding = _admissionBindings[id][entry.version];
        if (!binding.exists || binding.immutableEntryHash != _entryHash(entry) ||
            entry.holder != _position(id, binding.occurrence) ||
            IRegisterProjection(s.token).holderAsOf(s.tokenId, instant) != entry.holder)
            revert CompletionEvidenceUnavailable();
        if (binding.occurrence < through) revert CompletionConditionUnsatisfied();
        // Completed legs leave the chain here. Each one is folded into the
        // commitment, published whole in its own log for the register to hold,
        // and then deleted: the chain stops carrying a trade the moment it is
        // done with it, and what remains is proportional to what is still open.
        bytes32 commitment = s.detachedCommitment == bytes32(0)
            ? keccak256(abi.encode(DETACHED_SEED, id))
            : s.detachedCommitment;
        for (uint256 i = s.completedCount; i < through; ++i) {
            Leg storage leg = _legs[id][i];
            if (leg.outcome != Outcome.Active) revert CompletionConditionUnsatisfied();
            commitment = keccak256(abi.encode(commitment, i, leg.id, leg.fromAccount,
                leg.toAccount, leg.termsHash, leg.acceptanceHash, leg.returnAuthority,
                leg.returnConditionHash));
            emit LegDetached(id, leg.id, i, leg.fromAccount, leg.toAccount, leg.termsHash,
                leg.acceptanceHash, leg.returnAuthority, leg.returnConditionHash, commitment);
            // The id lookup goes too, so a detached leg cannot be named again as
            // a completion target or a return boundary. The terminal flag stays,
            // because a payment attached to this leg settles after this point.
            _detachedLeg[id][leg.id] = true;
            delete _legIndexPlusOne[id][leg.id];
            delete _legs[id][i];
        }
        s.detachedCommitment = commitment;
        s.completedCount = through;
        s.revision++;
        emit PrefixCompleted(id, through, entry.version, s.revision);
    }

    /// @notice Only the authority accepted in this leg can attest its accepted trigger.
    /// This is an authority-backed condition profile, not a proof that a legal remedy is due.
    function beginReturn(bytes32 id, bytes32 rootLegId, bytes32 conditionHash,
        bytes32 evidenceCommitment, uint256 expectedRevision) external nonReentrant
    {
        Sequence storage s = _live(id, expectedRevision);
        _requireIdentity(s);
        if (s.callbackRootPlusOne != 0) revert CallbackActive();
        uint256 root = _legIndexPlusOne[id][rootLegId];
        if (root == 0 || root <= s.completedCount || root > s.cursor) revert ReturnBoundaryRefused();
        Leg storage leg = _legs[id][root - 1];
        if (msg.sender != leg.returnAuthority) revert Unauthorized();
        if (conditionHash != leg.returnConditionHash || evidenceCommitment == bytes32(0)) revert InvalidInput();
        if (IControlToken(s.token).ownerOf(s.tokenId) != s.currentAccount) revert TokenLocationMismatch();
        for (uint256 i = root - 1; i < s.cursor; ++i) {
            if (_legs[id][i].outcome != Outcome.Active) revert ReturnBoundaryRefused();
            _legs[id][i].outcome = Outcome.Returning;
        }
        s.callbackRootPlusOne = root;
        s.revision++;
        emit ReturnBegun(id, rootLegId, conditionHash, evidenceCommitment, s.revision);
    }

    function returnHop(bytes32 id, bytes32 expectedLegId, uint256 expectedRevision) external nonReentrant {
        Sequence storage s = _live(id, expectedRevision);
        _requireIdentity(s);
        if (s.callbackRootPlusOne == 0 || s.cursor == 0) revert ReturnBoundaryRefused();
        Leg storage root = _legs[id][s.callbackRootPlusOne - 1];
        if (msg.sender != root.returnAuthority) revert Unauthorized();
        Leg storage leg = _legs[id][s.cursor - 1];
        if (leg.id != expectedLegId || leg.outcome != Outcome.Returning) revert ReturnBoundaryRefused();
        if (IControlToken(s.token).ownerOf(s.tokenId) != leg.toAccount || s.currentAccount != leg.toAccount)
            revert TokenLocationMismatch();
        leg.outcome = Outcome.Returned;
        s.cursor--;
        s.currentAccount = leg.fromAccount;
        s.revision++;
        if (s.cursor == s.callbackRootPlusOne - 1) s.callbackRootPlusOne = 0;
        ControlledWallet(leg.toAccount).controlTransfer(s.token, s.tokenId, leg.fromAccount);
        if (IControlToken(s.token).ownerOf(s.tokenId) != leg.fromAccount) revert TokenLocationMismatch();
        emit ReturnHopCompleted(id, leg.id, leg.toAccount, leg.fromAccount, s.revision);
    }

    /// @notice Exit only when no active responsibility remains. History is retained.
    /// A fresh sequence may then be opened, including after a completed reverse route.
    function closeSequence(bytes32 id, uint256 expectedRevision) external nonReentrant {
        Sequence storage s = _live(id, expectedRevision);
        _requireIdentity(s);
        if (ControlledWallet(s.currentAccount).owner() != msg.sender) revert Unauthorized();
        if (s.callbackRootPlusOne != 0 || s.cursor != s.completedCount) revert ReturnBoundaryRefused();
        if (IControlToken(s.token).ownerOf(s.tokenId) != s.currentAccount) revert TokenLocationMismatch();
        s.closed = true;
        s.revision++;
        emit SequenceClosed(id, s.revision);
    }

    function _live(bytes32 id, uint256 revision) private view returns (Sequence storage s) {
        s = _sequences[id];
        if (s.token == address(0) || s.closed) revert SequenceUnavailable();
        if (s.revision != revision) revert RevisionMismatch();
    }

    function _position(bytes32 id, uint256 occurrence) private view returns (address) {
        if (occurrence == 0) return _sequences[id].initialAccount;
        Sequence storage s = _sequences[id];
        if (occurrence > s.appended) revert CompletionEvidenceUnavailable();
        // The boundary occurrence still resolves: whoever the last detached leg
        // handed the token to is the account the window now starts from, and the
        // chain knows it without keeping that leg. This is what lets a register
        // still lagging at the boundary bind its admission there.
        if (occurrence == s.completedCount) {
            return occurrence == 0 ? s.initialAccount
                : (s.cursor > s.completedCount ? _legs[id][s.completedCount].fromAccount : s.currentAccount);
        }
        // Anything further back is gone. It costs nothing: completeThrough only
        // accepts a binding at or past the leg it completes, always above this.
        if (occurrence < s.completedCount) revert LegAtRegister();
        return _legs[id][occurrence - 1].toAccount;
    }

    function _entryHash(IRegisterProjection.RegisterEntry memory e) private pure returns (bytes32) {
        // supersededAt may legitimately change after a later admission; exclude it.
        return keccak256(abi.encode(e.recordCommitment, e.previousCommitment,
            e.registryReference, e.holder, e.version, e.effectiveAt));
    }

    function _requireIdentity(Sequence storage s) private view {
        if (s.token.codehash != s.tokenCodeHash || IRegisterProjection(s.token).registerId() != s.registerId ||
            IProjectionSettlement(s.token).verificationProfile() != s.verificationProfile)
            revert ProjectionIdentityChanged();
    }

    function _requireProjection(address token) private view {
        if (token.code.length == 0) revert UnsupportedProjection();
        if (!IERC165(token).supportsInterface(0x01ffc9a7) || IERC165(token).supportsInterface(0xffffffff) ||
            !IERC165(token).supportsInterface(0x80ac58cd) || !IERC165(token).supportsInterface(0x6309e170) ||
            !IERC165(token).supportsInterface(0xf4a7d71b)) revert UnsupportedProjection();
    }
}
