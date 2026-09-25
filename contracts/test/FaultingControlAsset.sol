// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

/// @dev Deliberately incomplete test double for atomic transfer-failure and
/// identity-drift NEGATIVES ONLY. Never substitute for the real ERC reference
/// in positive conformance, admission, completion or public-testnet evidence.
contract FaultingControlAsset {
    address public owner;
    address public registrar;
    bool public failTransfers;
    bool public rejectInterface;
    bytes32 public registerId = keccak256("FAULT_INJECTION_ONLY_REGISTER");
    bytes32 public verificationProfile = keccak256("FAULT_INJECTION_ONLY_PROFILE");
    constructor(address initialOwner, address registrar_) { owner = initialOwner; registrar = registrar_; }
    function configureRegistrar(address registrar_) external { registrar = registrar_; }
    function configure(bool fail_, bool reject_, bytes32 profile) external {
        failTransfers = fail_; rejectInterface = reject_; verificationProfile = profile;
    }
    function supportsInterface(bytes4 id) external view returns (bool) {
        return !rejectInterface && (id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x6309e170 || id == 0xf4a7d71b);
    }
    function isSettlementAuthority(uint256, address account) external view returns (bool) { return account == registrar; }
    function ownerOf(uint256) external view returns (address) { return owner; }
    function safeTransferFrom(address from, address to, uint256) external {
        require(!failTransfers && msg.sender == owner && from == owner, "INJECTED_TRANSFER_FAILURE");
        owner = to;
    }
}
