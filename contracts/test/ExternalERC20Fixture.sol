// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

/// @dev Local-EVM negative-test helper. Its logs must not stand in for the token's logs.
contract ExternalERC20ForeignEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function emitTransfer(address from, address to, uint256 amount) external {
        emit Transfer(from, to, amount);
    }
}

/// @dev Local-EVM ERC-20 fixture, never a deployment or production token.
/// Mode zero provides ordinary six-decimal ERC-20 behavior, without ERC-165.
/// Other modes deliberately exercise incompatible return values, optional
/// metadata, fees, and untrustworthy event shapes. Matching an event cannot
/// prove arbitrary token economics or rule out fees/rebases in every token.
contract ExternalERC20Fixture {
    enum ReturnMode { True, Empty, False, Short, InvalidBool, TrailingData, Revert }
    enum MetadataMode { Present, Absent, Malformed }
    enum EffectMode { Exact, Fee, WrongFrom, WrongTo, IndexedAmount, ExtraData, Missing, OtherContract }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply = 10_000_000;
    ReturnMode public returnMode;
    MetadataMode public metadataMode;
    EffectMode public effectMode;
    ExternalERC20ForeignEmitter private immutable foreignEmitter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address holder, ReturnMode returnMode_, MetadataMode metadataMode_, EffectMode effectMode_) {
        balanceOf[holder] = totalSupply;
        returnMode = returnMode_;
        metadataMode = metadataMode_;
        effectMode = effectMode_;
        foreignEmitter = new ExternalERC20ForeignEmitter();
        emit Transfer(address(0), holder, totalSupply);
    }

    function name() external view returns (string memory) {
        require(metadataMode != MetadataMode.Absent, "METADATA_ABSENT");
        if (metadataMode == MetadataMode.Malformed) assembly { mstore(0, 1) return(31, 1) }
        return "Fixture USD";
    }

    function symbol() external view returns (string memory) {
        require(metadataMode != MetadataMode.Absent, "METADATA_ABSENT");
        if (metadataMode == MetadataMode.Malformed) assembly { mstore(0, 1) return(31, 1) }
        return "FUSD";
    }

    function decimals() external view returns (uint8) {
        require(metadataMode != MetadataMode.Absent, "METADATA_ABSENT");
        if (metadataMode == MetadataMode.Malformed) assembly { mstore(0, 256) return(0, 32) }
        return 6;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        ReturnMode mode = returnMode;
        require(mode != ReturnMode.Revert, "TRANSFER_REVERTED");
        if (mode == ReturnMode.False) return false;
        _move(msg.sender, to, amount);
        if (mode == ReturnMode.Empty) assembly { return(0, 0) }
        if (mode == ReturnMode.Short) assembly { mstore(0, 1) return(31, 1) }
        if (mode == ReturnMode.InvalidBool) assembly { mstore(0, 2) return(0, 32) }
        if (mode == ReturnMode.TrailingData) assembly { mstore(0, 1) mstore(32, 0) return(0, 64) }
        return true;
    }

    /// @dev Test-only rebase simulation: changes a balance without a transfer.
    /// Arbitrary rebase economics are unsupported; a prior exact Transfer event
    /// cannot certify that its recipient keeps that balance in a later block.
    function rebaseBalanceForTest(address holder, uint256 amount) external {
        totalSupply = totalSupply - balanceOf[holder] + amount;
        balanceOf[holder] = amount;
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "ZERO_RECIPIENT");
        balanceOf[from] -= amount;
        uint256 received = effectMode == EffectMode.Fee ? amount - 1 : amount;
        balanceOf[to] += received;
        totalSupply -= amount - received;
        if (effectMode == EffectMode.Missing) return;
        if (effectMode == EffectMode.OtherContract) {
            foreignEmitter.emitTransfer(from, to, amount);
            return;
        }
        bytes32 signature = keccak256("Transfer(address,address,uint256)");
        if (effectMode == EffectMode.IndexedAmount) {
            // Same signature as ERC-20, but the ERC-721 four-topic layout.
            assembly { log4(0, 0, signature, from, to, amount) }
        } else if (effectMode == EffectMode.ExtraData) {
            assembly { mstore(0, amount) mstore(32, 0) log3(0, 64, signature, from, to) }
        } else {
            emit Transfer(effectMode == EffectMode.WrongFrom ? address(this) : from,
                effectMode == EffectMode.WrongTo ? address(this) : to, received);
        }
    }
}
