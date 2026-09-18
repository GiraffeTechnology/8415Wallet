// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {IRegisterProjection} from "./IRegisterProjection.sol";
import {IProjectionSettlement} from "./IProjectionSettlement.sol";

/// @notice Exposes the ERC-165 identifiers the standard freezes, computed by
/// the compiler from the interfaces themselves rather than written down.
///
/// The Kit does not get to choose these values. If a signature in either
/// interface ever drifts, `type(...).interfaceId` moves and the conformance
/// test comparing these against 0x6309e170 and 0xf4a7d71b fails, which is the
/// point: a drifted interface is a non-conforming one.
contract InterfaceIds {
    function registerProjectionId() external pure returns (bytes4) {
        return type(IRegisterProjection).interfaceId;
    }

    function projectionSettlementId() external pure returns (bytes4) {
        return type(IProjectionSettlement).interfaceId;
    }
}
