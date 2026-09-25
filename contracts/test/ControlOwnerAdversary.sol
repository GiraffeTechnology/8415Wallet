// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

/// @dev Test-only ERC-1271 owner exercising rejecting/reentrant payout boundaries.
/// Never a production custody contract. Deploy only in the adversarial suite.
contract ControlOwnerAdversary {
    address public immutable operator;
    mapping(bytes32 => bool) public approvedDigest;
    bool public rejectNative;
    address public reenterTarget;
    bytes public reenterData;
    bool public reenterSucceeded;
    constructor() { operator = msg.sender; }
    modifier onlyOperator() { require(msg.sender == operator, "OPERATOR_ONLY"); _; }
    function approveDigest(bytes32 digest, bool accepted) external onlyOperator { approvedDigest[digest] = accepted; }
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return approvedDigest[digest] && keccak256(signature) == keccak256(hex"aabb") ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function configure(bool reject_, address target, bytes calldata data) external onlyOperator {
        rejectNative = reject_; reenterTarget = target; reenterData = data; reenterSucceeded = false;
    }
    function execute(address target, bytes calldata data) external payable onlyOperator returns (bytes memory result) {
        (bool ok, bytes memory returned) = target.call{value:msg.value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(returned,32),mload(returned)) }
        return returned;
    }
    receive() external payable {
        require(!rejectNative, "TEST_PAYOUT_REFUSED");
        if (reenterTarget != address(0)) (reenterSucceeded,) = reenterTarget.call(reenterData);
    }
}
