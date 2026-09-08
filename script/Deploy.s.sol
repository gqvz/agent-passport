// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {EACBaseRolesLib} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {AgentRegistrar} from "../src/AgentRegistrar.sol";
import {AgentReputation} from "../src/AgentReputation.sol";
import {HumanVerification} from "../src/HumanVerification.sol";

/// @title Deploy
/// @notice Deploys the Agent Passport stack (platform UserRegistry + shared
///         PermissionedResolver + the three Agent Passport contracts) on Sepolia and
///         wires the ENSv2 role grants.
///
/// @dev Prerequisites:
///      - The deployer owns the platform 2LD name (default `agentpassport.eth`) on
///        Sepolia ENSv2 with `ROLE_SET_SUBREGISTRY` / `ROLE_SET_RESOLVER` on the token.
///      - `PRIVATE_KEY` env: the deployer's key.
///      Env (all optional except PRIVATE_KEY):
///        PRIVATE_KEY  - deployer key (must own the 2LD name)
///        ROOT_NAME    - 2LD name, default "agentpassport.eth"
///        LEASE_DAYS   - agent name lease, default 365
///        SALT_NS      - namespace appended to deterministic salts, default "v1"
///
/// @dev NOT idempotent: the UserRegistry/Resolver proxies use CREATE2 with fixed salts, so a
///      second run on the same ROOT_NAME+SALT_NS pair reverts on `deployProxy`. For redeploys
///      bump SALT_NS (and ensure the deployer still holds the 2LD token roles).
contract Deploy is Script {
    // Current Sepolia ENSv2 deployments (lib/contracts-v2/contracts/deployments/sepolia).
    address constant VERIFIABLE_FACTORY = 0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F;
    address constant USER_REGISTRY_IMPL = 0x840Fa461059862Ea466A711E8C98c8dE732061C0;
    address constant ETH_REGISTRY = 0x67b728a792e789a8978b30cF1b3b641f19354b43;
    address constant RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;

    PermissionedRegistry public platformRegistry;
    PermissionedResolver public platformResolver;
    HumanVerification public humanVerification;
    AgentReputation public agentReputation;
    AgentRegistrar public agentRegistrar;
    string public rootName;

    function run() external returns (address, address, address, address, address) {
        rootName = vm.envOr("ROOT_NAME", string("agentpassport.eth"));
        uint256 leaseDays = vm.envOr("LEASE_DAYS", uint256(365));
        require(leaseDays > 0 && leaseDays <= 36500, "LEASE_DAYS out of range"); // guard the uint64 cast below
        uint64 leaseDuration = uint64(leaseDays * 1 days);
        string memory saltNs = vm.envOr("SALT_NS", string("v1"));
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        vm.startBroadcast(privateKey);

        // ---- 1. Deploy the platform UserRegistry through the ENSv2 VerifiableFactory ----
        VerifiableFactory factory = VerifiableFactory(VERIFIABLE_FACTORY);
        platformRegistry = PermissionedRegistry(
            address(
                factory.deployProxy(
                    USER_REGISTRY_IMPL,
                    uint256(keccak256(abi.encodePacked("UserRegistry", rootName, saltNs))),
                    abi.encodeCall(UserRegistry.initialize, (deployer, _platformRootRoles()))
                )
            )
        );

        // ---- 2. Deploy the shared PermissionedResolver ----
        platformResolver = PermissionedResolver(
            address(
                factory.deployProxy(
                    RESOLVER_IMPL,
                    uint256(keccak256(abi.encodePacked("Resolver", rootName, saltNs))),
                    abi.encodeCall(
                        PermissionedResolver.initialize,
                        (deployer, EACBaseRolesLib.ALL_ROLES, new bytes[](0))
                    )
                )
            )
        );

        // ---- 3. Point the 2LD name at both ----
        PermissionedRegistry(payable(ETH_REGISTRY)).setSubregistry(
            uint256(keccak256(bytes(_secondLevelLabel(rootName)))),
            platformRegistry
        );
        PermissionedRegistry(payable(ETH_REGISTRY)).setResolver(
            uint256(keccak256(bytes(_secondLevelLabel(rootName)))),
            address(platformResolver)
        );

        // ---- 4. Deploy the Agent Passport contracts ----
        humanVerification = new HumanVerification(deployer, address(platformResolver));
        agentReputation = new AgentReputation(deployer, address(platformResolver));
        agentRegistrar = new AgentRegistrar(
            address(platformRegistry),
            address(platformResolver),
            address(humanVerification),
            address(agentReputation),
            deployer,
            rootName,
            leaseDuration
        );
        _grantRoles();

        vm.stopBroadcast();

        console2.log("Agent Passport deployment complete.");
        console2.log("  2LD name         :", rootName);
        console2.log("  UserRegistry     :", address(platformRegistry));
        console2.log("  PermissionedRes  :", address(platformResolver));
        console2.log("  HumanVerification:", address(humanVerification));
        console2.log("  AgentReputation  :", address(agentReputation));
        console2.log("  AgentRegistrar   :", address(agentRegistrar));
        console2.log("  Lease            :", uint256(leaseDuration));
    }

    /// @notice Grants the registrar its registry + resolver roles.
    function _grantRoles() internal {
        platformRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER,
            address(agentRegistrar)
        );
        platformResolver.grantRootRoles(
            uint256(PermissionedResolverLib.ROLE_SET_ADDR_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_TEXT_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_DATA_ADMIN),
            address(agentRegistrar)
        );
    }

    /// @dev The 2LD label of ROOT_NAME (the label immediately left of the TLD dot).
    function _secondLevelLabel(string memory name) internal pure returns (string memory) {
        bytes memory b = bytes(name);
        uint256 n = b.length;
        uint256 dot = n;
        for (uint256 i = n; i > 0; i--) {
            if (b[i - 1] == ".") {
                dot = i - 1;
                break;
            }
        }
        uint256 start = 0;
        for (uint256 i = dot; i > 0; i--) {
            if (b[i - 1] == ".") {
                start = i;
                break;
            }
        }
        bytes memory out = new bytes(dot - start);
        for (uint256 i = start; i < dot; i++) out[i - start] = b[i];
        return string(out);
    }

    function _platformRootRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_UNREGISTER_ADMIN |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }
}