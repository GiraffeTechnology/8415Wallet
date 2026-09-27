// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {NativeResponsibilityPayments} from "./NativeResponsibilityPayments.sol";

/// @notice Deploys the one fixed payment adapter implementation, and does
/// nothing else. It holds no state, no owner and no immutable, so its runtime
/// code is identical at every address and its hash is a constant anyone can
/// recompute from this source.
///
/// @dev It exists so the controller does not have to carry this contract's
/// creation bytecode inside its own. A controller records the factory address
/// and the code hash it will accept, both immutable, so what it adopts is
/// decided by code fixed at its construction rather than by whoever calls it.
/// The adapter's own constructor binds it to the controller passed here, and
/// that binding is immutable, so an adapter cannot be re-pointed afterwards.
contract NativePaymentsFactory {
    event NativePaymentsDeployed(address indexed controller, address indexed adapter);

    function deploy(address controller) external returns (address adapter) {
        adapter = address(new NativeResponsibilityPayments(controller));
        emit NativePaymentsDeployed(controller, adapter);
    }
}
