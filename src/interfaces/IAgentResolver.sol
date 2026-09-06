// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgentResolver
/// @notice The subset of the ENSv2 PermissionedResolver interface used by the
///         AgentPassport contracts. Declares exactly the functions the registrar,
///         reputation, and verification contracts call.
interface IAgentResolver {
    /// @notice Set the Ethereum address record for a node.
    function setAddr(bytes32 node, address addr_) external;

    /// @notice Set the contenthash record for a node.
    function setContenthash(bytes32 node, bytes calldata hash) external;

    /// @notice Set a text record for a node.
    function setText(bytes32 node, string calldata key, string calldata value) external;

    /// @notice Set a data record for a node.
    function setData(bytes32 node, string calldata key, bytes calldata value) external;

    /// @notice Grant or revoke a role bitmap on a specific name.
    function authorizeNameRoles(
        bytes calldata toName,
        uint256 roleBitmap,
        address account,
        bool grant
    ) external returns (bool);

    /// @notice Grant or revoke ROLE_SET_TEXT for a specific text key on a name.
    function authorizeTextRoles(
        bytes calldata toName,
        string calldata key,
        address account,
        bool grant
    ) external returns (bool);

    /// @notice Grant or revoke ROLE_SET_DATA for a specific data key on a name.
    function authorizeDataRoles(
        bytes calldata toName,
        string calldata key,
        address account,
        bool grant
    ) external returns (bool);
}
