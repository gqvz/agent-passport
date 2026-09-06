// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHumanVerification
/// @notice Interface for the HumanVerification contract used by the AgentRegistrar.
interface IHumanVerification {
    /// @notice Check whether an address is a verified human.
    function isHumanVerified(address human) external view returns (bool);

    /// @notice Write the "human-verified" text record for an agent name, proving
    ///         that only this contract holds that specific write permission.
    function ensureHumanVerifiedRecord(bytes32 node, bytes calldata toName) external;
}
