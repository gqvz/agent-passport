// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {EACBaseRolesLib} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {LabelStore} from "@ensdomains/contracts-v2/utils/LabelStore.sol";

import {AgentRegistrar} from "../../src/AgentRegistrar.sol";
import {AgentReputation} from "../../src/AgentReputation.sol";
import {HumanVerification} from "../../src/HumanVerification.sol";

/// @notice End-to-end integration against the REAL Sepolia ENSv2 deployments, forked locally.
///         Impersonates the real ETHRegistrar to register a fresh `agentpassport.eth`, then
///         deploys the platform's UserRegistry + shared PermissionedResolver via the real
///         VerifiableFactory and runs the Agent Passport flow on-chain.
contract ForkIntegrationTest is Test {
    // Real Sepolia ENSv2 deployment addresses (lib/contracts-v2/contracts/deployments/sepolia).
    address constant VERIFIABLE_FACTORY = 0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F;
    address constant USER_REGISTRY_IMPL = 0x840Fa461059862Ea466A711E8C98c8dE732061C0;
    address constant ROOT_REGISTRY = 0x8115186E8f2E0B0281e86ab91f0f48Ba90364354;
    address constant ETH_REGISTRY = 0x67b728a792e789a8978b30cF1b3b641f19354b43;
    address constant RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;
    address constant UNIVERSAL_RESOLVER = 0x85eDf8B6b7D4211e2b07AA687506B746357B92cf;
    // The address holding ROLE_REGISTRAR on the Sepolia .eth registry.
    address constant ETH_REGISTRAR = 0xa4449a0dD2b83007553D9b1d28b583A46A805a30;

    PermissionedRegistry ethRegistry;
    LabelStore labelStore;
    VerifiableFactory factory;

    address platform = makeAddr("platform");
    address verifier = makeAddr("verifier");
    address human1 = makeAddr("human1");
    address bot = makeAddr("bot");
    address agentWallet = makeAddr("agentWallet");

    PermissionedResolver resolver;
    PermissionedRegistry platformRegistry;
    HumanVerification humanVerification;
    AgentReputation agentReputation;
    AgentRegistrar agentRegistrar;

    string rootName;
    string rootLabel;
    uint256 agentpassportTokenId;
    bytes32 rootNode;

    function setUp() public {
        vm.createSelectFork("sepolia");
        vm.label(VERIFIABLE_FACTORY, "VerifiableFactory");
        vm.label(USER_REGISTRY_IMPL, "UserRegistryImpl");
        vm.label(ROOT_REGISTRY, "RootRegistry");
        vm.label(ETH_REGISTRY, "ETHRegistry");
        vm.label(RESOLVER_IMPL, "PermissionedResolverImpl");
        vm.label(UNIVERSAL_RESOLVER, "UniversalResolverV2");
        vm.label(ETH_REGISTRAR, "ETHRegistrar");

        // `agentpassport.eth` is already registered on live Sepolia, so the fork test
        // exercises a fresh unclaimed 2LD derived from the fork block number.
        rootLabel = string.concat("forkpassport", vm.toString(block.number));
        rootName = string.concat(rootLabel, ".eth");
        agentpassportTokenId = uint256(keccak256(bytes(rootLabel)));

        ethRegistry = PermissionedRegistry(payable(ETH_REGISTRY));
        factory = VerifiableFactory(VERIFIABLE_FACTORY);

        // Fund accounts for gas.
        vm.deal(ETH_REGISTRAR, 10 ether);
        vm.deal(platform, 10 ether);
        vm.deal(verifier, 10 ether);
        vm.deal(human1, 10 ether);
        vm.deal(bot, 10 ether);

        // ---- 1. Register the fresh 2LD by impersonating the real ETHRegistrar ----
        // The registrar holds ROLE_REGISTRAR at the .eth registry's root resource.
        assertTrue(ethRegistry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, ETH_REGISTRAR));

        vm.prank(ETH_REGISTRAR);
        ethRegistry.register(
            rootLabel,
            platform,
            IRegistry(address(0)),
            address(0),
            _tokenAdminRoles(),
            type(uint64).max
        );
        IPermissionedRegistry.State memory rootState =
            ethRegistry.getState(agentpassportTokenId);
        assertEq(uint256(rootState.status), uint256(2), "2LD registered");
        assertEq(rootState.latestOwner, platform);

        // ---- 2. Deploy the platform UserRegistry via the real VerifiableFactory ----
        platformRegistry = PermissionedRegistry(
            factory.deployProxy(
                USER_REGISTRY_IMPL,
                uint256(keccak256("userRegistry.agentpassport")),
                abi.encodeCall(UserRegistry.initialize, (platform, _platformRootRoles()))
            )
        );

        // ---- 3. Deploy the shared PermissionedResolver via the real VerifiableFactory ----
        resolver = PermissionedResolver(
            factory.deployProxy(
                RESOLVER_IMPL,
                uint256(keccak256("resolver.agentpassport")),
                abi.encodeCall(PermissionedResolver.initialize, (platform, EACBaseRolesLib.ALL_ROLES, new bytes[](0)))
            )
        );

        // agentpassport.eth's subregistry -> platform UserRegistry; resolver -> shared resolver.
        vm.prank(platform);
        ethRegistry.setSubregistry(agentpassportTokenId, platformRegistry);
        vm.prank(platform);
        ethRegistry.setResolver(agentpassportTokenId, address(resolver));

        // ---- 4. Deploy our contracts ----
        humanVerification = new HumanVerification(verifier, address(resolver));
        agentReputation = new AgentReputation(platform, address(resolver));
        agentRegistrar = new AgentRegistrar(
            address(platformRegistry),
            address(resolver),
            address(humanVerification),
            address(agentReputation),
            platform,
            rootName,
            365 days
        );

        rootNode = _namehash(rootName);

        // ---- 5. Grant roles ----
        vm.prank(platform);
        platformRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER,
            address(agentRegistrar)
        );
        vm.prank(platform);
        resolver.grantRootRoles(
            uint256(PermissionedResolverLib.ROLE_SET_ADDR_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_TEXT_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_DATA_ADMIN),
            address(agentRegistrar)
        );
    }

    function test_fullFlow_onSepoliaENSv2() public {
        // ---- Human gate ----
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.NotHumanVerified.selector, bot));
        agentRegistrar.registerAgent("algo-1", bot, agentWallet);

        // Verifier confirms human1 through World Selfie Check.
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345678);

        // ---- Registered agent ----
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("algo-1", human1, agentWallet);

        bytes32 expectedNode = _namehash(string.concat("algo-1.", rootName));
        assertEq(node, expectedNode, "node is namehash of algo-1.<rootName>");

        IPermissionedRegistry.State memory state =
            platformRegistry.getState(uint256(keccak256(bytes("algo-1"))));
        assertEq(uint256(state.status), uint256(2), "agent registered on UserRegistry");
        assertEq(state.latestOwner, human1, "human owns agent name");

        // ---- Records were written through the shared resolver ----
        assertEq(resolver.addr(node), agentWallet, "addr points at agent contract");
        assertEq(resolver.text(node, "name"), "algo-1");
        assertEq(resolver.text(node, "human-verified"), "true", "human-verified stamp set");

        // ---- EAC: human owner controls description, but NOT human-verified/reputation ----
        vm.prank(human1);
        resolver.setText(node, "description", "high-frequency trading agent");
        assertEq(resolver.text(node, "description"), "high-frequency trading agent");

        vm.expectRevert();
        vm.prank(human1);
        resolver.setText(node, "human-verified", "false");

        vm.expectRevert();
        vm.prank(human1);
        resolver.setData(node, "reputation", abi.encode(0));

        // ---- Reputation: only AgentReputation writes the reputation data record ----
        vm.prank(platform);
        agentReputation.setScore(node, "algo-1", 94);
        assertEq(agentReputation.readScore(node), 94, "score stored on resolver");

        // ---- UniversalResolverV2 (real Sepolia) resolves the full name to our resolver ----
        bytes memory dnsName = _dnsEncode(string.concat("algo-1.", rootName));
        (bool ok, bytes memory ret) =
            UNIVERSAL_RESOLVER.staticcall(abi.encodeWithSignature("findResolver(bytes)", dnsName));
        assertTrue(ok, "findResolver call succeeded");
        (address foundResolver, , ) = abi.decode(ret, (address, bytes32, uint256));
        assertEq(foundResolver, address(resolver), "universal resolver finds our shared resolver");

        // ---- Revoke ----
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.OnlyPlatform.selector));
        vm.prank(human1);
        agentRegistrar.revokeAgent("algo-1");

        vm.prank(platform);
        agentRegistrar.revokeAgent("algo-1");
        IPermissionedRegistry.State memory stateAfter = platformRegistry.getState(uint256(keccak256(bytes("algo-1"))));
        assertEq(uint256(stateAfter.status), uint256(0), "agent revoked");
    }

    function _tokenAdminRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
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

    function _namehash(string memory name) internal pure returns (bytes32) {
        bytes32 node = bytes32(0);
        bytes memory nameBytes = bytes(name);
        uint256 n = nameBytes.length;
        uint256 end = n;
        for (uint256 i = n; i > 0; i--) {
            if (nameBytes[i - 1] == ".") {
                node = keccak256(abi.encodePacked(node, bytes32(uint256(keccak256(_slice(nameBytes, i, end))))));
                end = i - 1;
            }
        }
        if (end > 0) {
            node = keccak256(abi.encodePacked(node, bytes32(uint256(keccak256(_slice(nameBytes, 0, end))))));
        }
        return node;
    }

    function _dnsEncode(string memory name) internal pure returns (bytes memory) {
        bytes memory nameBytes = bytes(name);
        uint256 n = nameBytes.length;
        bytes memory dns = new bytes(n + 2);
        uint256 start = 0;
        uint256 cursor = 0;
        for (uint256 i = 0; i <= n; i++) {
            if (i == n || nameBytes[i] == ".") {
                uint256 size = i - start;
                dns[cursor] = bytes1(uint8(size));
                cursor++;
                for (uint256 j = 0; j < size; j++) {
                    dns[cursor + j] = nameBytes[start + j];
                }
                cursor += size;
                start = i + 1;
            }
        }
        return dns;
    }

    function _slice(bytes memory data, uint256 ostart, uint256 oend) internal pure returns (bytes memory) {
        bytes memory result = new bytes(oend - ostart);
        for (uint256 i = ostart; i < oend; i++) {
            result[i - ostart] = data[i];
        }
        return result;
    }
}