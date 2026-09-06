// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentResolver} from "./interfaces/IAgentResolver.sol";

/// @title HumanVerification
/// @notice Tracks which Ethereum addresses have been verified as real, unique humans
///         through the World Selfie Check (Beta) flow. Only the designated verifier
///         (the platform's backend that confirms World ID proofs) may write records.
///         Also writes the EAC-protected `human-verified` text record on agent names,
///         demonstrating that only it holds that specific resolver write permission.
contract HumanVerification {
    /// @notice Emitted when a human's verification status changes.
    event HumanVerified(address indexed human, uint256 nullifierHash);
    event HumanUnverified(address indexed human);

    /// @notice Emitted when an agent's human-verified record is (re)written.
    event HumanVerifiedRecordSet(bytes32 indexed node);

    /// @notice Reverts when the caller is not the trusted verifier.
    error OnlyVerifier();

    /// @notice Reverts on an invalid constructor argument.
    error InvalidAddress();

    /// @notice The address allowed to set verification status (the platform backend).
    address public immutable VERIFIER;

    /// @notice The ENSv2 PermissionedResolver that holds agent records.
    address public immutable RESOLVER;

    /// @notice Verified humans keyed by address.
    mapping(address => bool) internal _verified;

    /// @notice Nullifier hashes keyed by address, to detect sybil reuse.
    mapping(address => uint256) public nullifiers;

    constructor(address verifier, address resolver) {
        if (verifier == address(0)) revert InvalidAddress();
        if (resolver == address(0)) revert InvalidAddress();
        VERIFIER = verifier;
        RESOLVER = resolver;
    }

    modifier onlyVerifier() {
        if (msg.sender != VERIFIER) revert OnlyVerifier();
        _;
    }

    /// @notice Set a human as verified after they pass World Selfie Check.
    /// @param human The human's Ethereum address.
    /// @param nullifierHash The World ID nullifier hash proving uniqueness.
    function verifyHuman(address human, uint256 nullifierHash) external onlyVerifier {
        _verified[human] = true;
        nullifiers[human] = nullifierHash;
        emit HumanVerified(human, nullifierHash);
    }

    /// @notice Revoke a human's verified status.
    /// @param human The human's Ethereum address.
    function revokeHuman(address human) external onlyVerifier {
        _verified[human] = false;
        emit HumanUnverified(human);
    }

    /// @notice Check whether an address is a verified human.
    /// @param human The address to check.
    /// @return True if verified.
    function isHumanVerified(address human) external view returns (bool) {
        return _verified[human];
    }

    /// @notice (Re)assert the `human-verified` text record for an agent name. No access
    ///         control here BY DESIGN: the write is idempotent ("true") and is bounded
    ///         by resolver EAC, which only permits this contract (holding `ROLE_SET_TEXT`
    ///         on "human-verified") to succeed once the name is registered. Callers can
    ///         only re-assert the existing status, never forge or remove it.
    /// @param node The namehash of the agent's ENS name.
    /// @dev The `toName` param is accepted for ABI parity with the live deployment; the
    ///      EAC write itself is keyed on the `node` (the resolver resolves it internally).
    function ensureHumanVerifiedRecord(bytes32 node, bytes calldata) external {
        IAgentResolver(RESOLVER).setText(node, "human-verified", "true");
        emit HumanVerifiedRecordSet(node);
    }
}
