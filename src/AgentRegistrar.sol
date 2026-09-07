// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {IHumanVerification} from "./interfaces/IHumanVerification.sol";
import {IAgentResolver} from "./interfaces/IAgentResolver.sol";

/// @title AgentRegistrar
/// @notice Registers ENSv2 agent subnames under the platform's root name, gated on the
///         owner being a World Selfie Check verified human. Sets up Enhanced Access
///         Control permissions so that:
///         - The `human-verified` text record is writable only by the HumanVerification contract.
///         - The `reputation` data record is writable only by the AgentReputation contract.
///         - The agent's human owner can manage general records (addr, contenthash, etc.).
contract AgentRegistrar {
    /// @notice Emitted when an agent is registered.
    event AgentRegistered(
        bytes32 indexed node,
        string indexed label,
        uint256 tokenId,
        address indexed owner,
        address agentAddress,
        address resolver,
        uint64 expiry
    );

    /// @notice Emitted when an agent's resolver permissions are configured.
    event AgentPermissionsConfigured(bytes32 indexed node, string indexed label);

    /// @notice Emitted when an agent passport is revoked.
    event AgentRevoked(bytes32 indexed node, string indexed label);

    ////////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////////

    error OnlyPlatform();
    error NotHumanVerified(address human);
    error InvalidOwner();
    error LabelTooShort();
    error InvalidLabel();
    error InvalidAgentAddress();
    error InvalidAddress();

    ////////////////////////////////////////////////////////////////////////////
    // Immutable configuration
    ////////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 subname registry that mints agent names.
    IPermissionedRegistry public immutable USER_REGISTRY;

    /// @notice The ENSv2 PermissionedResolver that holds agent records.
    IAgentResolver public immutable RESOLVER;

    /// @notice Tracks which humans are verified through World Selfie Check.
    IHumanVerification public immutable HUMAN_VERIFICATION;

    /// @notice The contract that owns reputation score write-permissions.
    address public immutable REPUTATION;

    /// @notice The address that may reconfigure the registrar (e.g. revoke agents).
    address public immutable PLATFORM;

    /// @notice The root name under which agents are registered (e.g. "mypassport.eth").
    string public ROOT_NAME;

    /// @notice Namehash of ROOT_NAME.
    bytes32 public immutable ROOT_NODE;

    /// @notice Duration of agent name lease in seconds.
    uint64 public immutable LEASE_DURATION;

    ////////////////////////////////////////////////////////////////////////////
    // Constructor
    ////////////////////////////////////////////////////////////////////////////

    constructor(
        address userRegistry,
        address resolver,
        address humanVerification,
        address reputation,
        address platform,
        string memory rootName,
        uint64 leaseDuration
    ) {
        if (userRegistry == address(0)) revert InvalidAddress();
        if (resolver == address(0)) revert InvalidAddress();
        if (humanVerification == address(0)) revert InvalidAddress();
        if (reputation == address(0)) revert InvalidAddress();
        if (platform == address(0)) revert InvalidAddress();
        USER_REGISTRY = IPermissionedRegistry(userRegistry);
        RESOLVER = IAgentResolver(resolver);
        HUMAN_VERIFICATION = IHumanVerification(humanVerification);
        REPUTATION = reputation;
        PLATFORM = platform;
        ROOT_NAME = rootName;
        ROOT_NODE = _namehash(rootName);
        LEASE_DURATION = leaseDuration;
    }

    modifier onlyPlatform() {
        if (msg.sender != PLATFORM) revert OnlyPlatform();
        _;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Public registration
    ////////////////////////////////////////////////////////////////////////////

    /// @notice Register a new agent under the platform root name.
    /// @dev The `owner` must be human-verified. The agent subname is registered on the
    ///      UserRegistry and the resolver is configured with fine-grained EAC permissions.
    /// @param label The agent's label (e.g. "agent-1"). Final name: `label.ROOT_NAME`.
    /// @param owner The human owner of the agent's name (receives registry + resolver roles).
    /// @param agentAddress The operational address of the agent itself.
    /// @return node The namehash of the agent's ENS name.
    function registerAgent(
        string calldata label,
        address owner,
        address agentAddress
    ) external returns (bytes32 node) {
        if (owner == address(0)) revert InvalidOwner();
        if (bytes(label).length == 0) revert LabelTooShort();
        if (!_isValidLabel(label)) revert InvalidLabel();
        if (agentAddress == address(0)) revert InvalidAgentAddress();
        if (!HUMAN_VERIFICATION.isHumanVerified(owner)) {
            revert NotHumanVerified(owner);
        }

        // 1. Register the subname on the UserRegistry. The owner receives a bitmap
        //    that lets them manage their own name (resolver, subregistry, transfer),
        //    but NOT unregister globally on our platform's behalf.
        uint256 tokenId = USER_REGISTRY.register(
            label,
            owner,
            IRegistry(address(0)),
            address(RESOLVER),
            _ownerRegistryRoleBitmap(),
            uint64(block.timestamp) + LEASE_DURATION
        );

        // 2. Compute the node (namehash of `label.ROOT_NAME`).
        node = _childNamehash(ROOT_NODE, uint256(keccak256(bytes(label))));

        // 3. Configure resolver permissions and write initial records.
        _configureResolverPermissions(node, label, owner, agentAddress);

        IPermissionedRegistry.State memory state = USER_REGISTRY.getState(uint256(keccak256(bytes(label))));
        emit AgentRegistered(
            node,
            label,
            tokenId,
            owner,
            agentAddress,
            address(RESOLVER),
            state.expiry
        );
        return node;
    }

    /// @notice Unregister (shut down) an agent. Platform only. The previous owner's
    ///         resolver permissions are revoked and the registrar-owned addr/name
    ///         records are zeroed, so a re-registration of the same label starts with
    ///         fresh ownership. Platform-managed records (human-verified text, the
    ///         reputation data record) intentionally persist across revocations.
    /// @param label The agent's label.
    function revokeAgent(string calldata label) external onlyPlatform returns (bytes32 node) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        IPermissionedRegistry.State memory st = USER_REGISTRY.getState(tokenId);
        node = _childNamehash(ROOT_NODE, tokenId);

        // Revoke the previous owner's per-name resolver permissions.
        if (st.latestOwner != address(0)) {
            bytes memory fullDns = _dnsEncode(string(abi.encodePacked(label, ".", ROOT_NAME)));
            RESOLVER.authorizeNameRoles(
                fullDns,
                uint256(PermissionedResolverLib.ROLE_SET_ADDR)
                    | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH),
                st.latestOwner,
                false
            );
            RESOLVER.authorizeTextRoles(fullDns, "description", st.latestOwner, false);
            RESOLVER.authorizeTextRoles(fullDns, "name", st.latestOwner, false);
            RESOLVER.authorizeTextRoles(fullDns, "url", st.latestOwner, false);

            // Clear the records the registrar itself is permitted to write.
            RESOLVER.setAddr(node, address(0));
            RESOLVER.setText(node, "name", "");

            // THEN drop the registrar's own write roles too: re-registration
            // re-grants them, and between revoke and re-register nothing on the
            // node should be writable.
            RESOLVER.authorizeNameRoles(fullDns, uint256(PermissionedResolverLib.ROLE_SET_ADDR), address(this), false);
            RESOLVER.authorizeTextRoles(fullDns, "name", address(this), false);
        }

        USER_REGISTRY.unregister(tokenId);
        emit AgentRevoked(node, label);
        return node;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Resolver permission configuration
    ////////////////////////////////////////////////////////////////////////////

    /// @dev The registry role bitmap granted to the agent's owner at registration time.
    ///      Grants resolver/subregistry/transfer control over their own name.
    function _ownerRegistryRoleBitmap() internal pure returns (uint256) {
        return uint256(RegistryRolesLib.ROLE_SET_RESOLVER)
            | uint256(RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN)
            | uint256(RegistryRolesLib.ROLE_SET_SUBREGISTRY)
            | uint256(RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN)
            | uint256(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN);
    }

    /// @dev Configures EAC permissions on the shared PermissionedResolver and writes
    ///      initial records.
    function _configureResolverPermissions(
        bytes32 node,
        string calldata label,
        address owner,
        address agentAddress
    ) internal {
        // DNS-encoded full name, e.g. "\x08agent-1\x0amypassport\x03eth\x00"
        bytes memory fullDns = _dnsEncode(
            string(abi.encodePacked(label, ".", ROOT_NAME))
        );

        // --- Owner permissions (name-level) ---
        // Owner can set any addr (any coin type) and contenthash on their name.
        RESOLVER.authorizeNameRoles(
            fullDns,
            uint256(PermissionedResolverLib.ROLE_SET_ADDR)
                | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH),
            owner,
            true
        );

        // Registrar itself may write the initial addr record at registration time.
        RESOLVER.authorizeNameRoles(fullDns, uint256(PermissionedResolverLib.ROLE_SET_ADDR), address(this), true);

        // Owner can set these specific text keys (NOT "human-verified").
        RESOLVER.authorizeTextRoles(fullDns, "description", owner, true);
        RESOLVER.authorizeTextRoles(fullDns, "name", owner, true);
        RESOLVER.authorizeTextRoles(fullDns, "url", owner, true);

        // Registrar writes the initial "name" record at registration time.
        RESOLVER.authorizeTextRoles(fullDns, "name", address(this), true);

        // --- Verifier permissions ---
        // HumanVerification contract may set ONLY the "human-verified" text key.
        RESOLVER.authorizeTextRoles(
            fullDns,
            "human-verified",
            address(HUMAN_VERIFICATION),
            true
        );

        // AgentReputation may set ONLY the "reputation" data key.
        RESOLVER.authorizeDataRoles(
            fullDns,
            "reputation",
            REPUTATION,
            true
        );

        // Write initial identity records.
        RESOLVER.setAddr(node, agentAddress);
        RESOLVER.setText(node, "name", label);

        // Write the human-verified flag via the HumanVerification contract to
        // demonstrate its exclusive write-right.
        HUMAN_VERIFICATION.ensureHumanVerifiedRecord(node, fullDns);

        emit AgentPermissionsConfigured(node, label);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Pure/helper functions
    ////////////////////////////////////////////////////////////////////////////

    /// @notice Validate an agent label. Must be a single DNS label: 1-63 bytes of
    ///         lowercase alphanumerics and hyphens (no dots, no leading/trailing
    ///         hyphens). This keeps `node == namehash(label.ROOT_NAME)` consistent
    ///         with the DNS encoding used for resolver EAC permissions.
    /// @param label The candidate label.
    /// @return True if the label is acceptable.
    function _isValidLabel(string calldata label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 n = b.length;
        if (n == 0 || n > 63) return false;
        for (uint256 i = 0; i < n; i++) {
            uint8 c = uint8(b[i]);
            bool alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a);
            bool hyphen = c == 0x2d;
            if (!alnum && !hyphen) return false;
            if (hyphen && (i == 0 || i == n - 1)) return false;
        }
        return true;
    }

    /// @notice Compute namehash of a dot-separated ENS name.
    function _namehash(string memory name) internal pure returns (bytes32) {
        bytes32 node = bytes32(0);
        bytes memory nameBytes = bytes(name);
        uint256 n = nameBytes.length;
        uint256 end = n;
        // Process labels from right (TLD) to left.
        for (uint256 i = n; i > 0; i--) {
            if (nameBytes[i - 1] == ".") {
                node = _childNamehash(node, uint256(keccak256(_slice(nameBytes, i, end))));
                end = i - 1;
            }
        }
        if (end > 0) {
            node = _childNamehash(node, uint256(keccak256(_slice(nameBytes, 0, end))));
        }
        return node;
    }

    /// @notice Compute a child namehash from a parent namehash and child labelhash.
    function _childNamehash(bytes32 parent, uint256 labelHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, bytes32(uint256(labelHash))));
    }

    /// @notice DNS-encode a full ENS name, e.g. "a.b.c" -> "\x01a\x01b\x01c\x00".
    function _dnsEncode(string memory name) internal pure returns (bytes memory) {
        bytes memory nameBytes = bytes(name);
        uint256 n = nameBytes.length;
        if (n == 0) return hex"00";
        bytes memory dns = new bytes(n + 2);
        uint256 start = 0;
        uint256 cursor = 0;
        for (uint256 i = 0; i <= n; i++) {
            if (i == n || nameBytes[i] == ".") {
                uint256 size = i - start;
                require(size > 0 && size <= 255, "bad label");
                dns[cursor] = bytes1(uint8(size));
                cursor++;
                for (uint256 j = 0; j < size; j++) {
                    dns[cursor + j] = nameBytes[start + j];
                }
                cursor += size;
                start = i + 1;
            }
        }
        return dns; // terminator byte stays zero
    }

    /// @notice Slice a byte array.
    function _slice(bytes memory data, uint256 ostart, uint256 oend) internal pure returns (bytes memory) {
        require(oend >= ostart, "bad slice");
        bytes memory result = new bytes(oend - ostart);
        for (uint256 i = ostart; i < oend; i++) {
            result[i - ostart] = data[i];
        }
        return result;
    }
}
