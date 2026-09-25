// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

interface IControlToken {
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IWalletControlPolicy {
    function standaloneWithdrawalAllowed(address token, uint256 tokenId) external view returns (bool);
}

/// @notice User-owned, immutable token account. No generic execution, approval,
/// delegatecall, upgrade or module installation surface. Not a payment escrow.
/// @dev Development candidate: integration/security/real-testnet validation pending.
contract ControlledWallet {
    address public immutable owner;
    address public immutable controller;
    bool private _entered;

    error Unauthorized();
    error ProtectedAsset();
    error InvalidRecipient();
    error TransferNotObserved();
    error ReentrantCall();

    constructor(address owner_, address controller_) {
        if (owner_ == address(0) || controller_ != msg.sender) revert Unauthorized();
        owner = owner_;
        controller = controller_;
    }

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    function controlTransfer(address token, uint256 tokenId, address to) external nonReentrant {
        if (msg.sender != controller) revert Unauthorized();
        _transfer(token, tokenId, to);
    }

    /// @notice Standalone transfer is available only outside an active controlled sequence.
    function withdrawStandalone(address token, uint256 tokenId, address to) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        if (!IWalletControlPolicy(controller).standaloneWithdrawalAllowed(token, tokenId)) revert ProtectedAsset();
        _transfer(token, tokenId, to);
    }

    function _transfer(address token, uint256 tokenId, address to) private {
        if (to == address(0) || to == address(this) || token.code.length == 0) revert InvalidRecipient();
        if (IControlToken(token).ownerOf(tokenId) != address(this)) revert TransferNotObserved();
        IControlToken(token).safeTransferFrom(address(this), to, tokenId);
        if (IControlToken(token).ownerOf(tokenId) != to) revert TransferNotObserved();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}
