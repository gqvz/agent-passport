// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentResolver} from "./interfaces/IAgentResolver.sol";

/// @title AgentReputation
/// @notice Stores and exposes reputation scores for registered agents. Scores are
///         written to each agent's ENSv2 resolver as an EAC-protected data record,
///         so only this contract (the scoring logic) can update them.
contract AgentReputation {
    /// @notice Emitted when an agent's score changes.
    event ScoreUpdated(bytes32 indexed node, string indexed label, uint256 score, uint256 timestamp);

    /// @notice Reverts when the caller is not the designated scorer.
    error OnlyScorer();

    /// @notice Reverts when a score falls outside the documented 0-100 range.
    error ScoreOutOfRange();

    /// @notice Reverts on an invalid constructor argument.
    error InvalidAddress();

    /// @notice The address allowed to update scores (the platform's scoring backend).
    address public immutable SCORER;

    /// @notice The ENSv2 PermissionedResolver that holds agent records.
    IAgentResolver public immutable RESOLVER;

    /// @notice Aggregate score for each agent node.
    mapping(bytes32 => uint256) public scores;

    constructor(address scorer, address resolver) {
        if (scorer == address(0)) revert InvalidAddress();
        if (resolver == address(0)) revert InvalidAddress();
        SCORER = scorer;
        RESOLVER = IAgentResolver(resolver);
    }

    modifier onlyScorer() {
        if (msg.sender != SCORER) revert OnlyScorer();
        _;
    }

    /// @notice Read an agent's reputation score from its resolver data record.
    function readScore(bytes32 node) public view returns (uint256) {
        return scores[node];
    }

    /// @notice Update an agent's reputation score.
    /// @dev Writes the score both locally and to the agent's resolver data record.
    ///      Only callable by the scorer. The caller must hold `ROLE_SET_DATA` on the
    ///      "reputation" key of the agent's name within the resolver.
    /// @param node The namehash of the agent's ENS name.
    /// @param label The agent's label (e.g. "agent-1").
    /// @param score The new reputation score (0-100).
    function setScore(bytes32 node, string calldata label, uint256 score) external onlyScorer {
        if (score > 100) revert ScoreOutOfRange();
        scores[node] = score;
        RESOLVER.setData(node, "reputation", abi.encode(score));
        emit ScoreUpdated(node, label, score, block.timestamp);
    }
}
