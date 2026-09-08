// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {EACBaseRolesLib} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {AgentRegistrar} from "../src/AgentRegistrar.sol";
import {AgentReputation} from "../src/AgentReputation.sol";
import {HumanVerification} from "../src/HumanVerification.sol";

/// @title ForkDemo
/// @notice Broadcasts the full Agent Passport flow as REAL transactions against a running
///         Sepolia fork (anvil --fork-url <sepolia RPC>), producing real addresses and real
///         events that a subgraph can index. The one ENSv2 root-registration call is sent
///         impersonating the real Sepolia ETHRegistrar (enable it first:
///         `cast rpc anvil_impersonate <REGISTRAR>`).
///
/// @dev Requires three anvil accounts (platform / verifier / human). Run:
///      PLATFORM_KEY=.. VERIFIER_KEY=.. HUMAN_KEY=.. forge script script/ForkDemo.s.sol \
///          --rpc-url http://127.0.0.1:<fork-port> --broadcast
///      Writes script/fork-deploy.json with all addresses + namehashes.

/// @dev Historical note: this demo is superseded by `Deploy.s.sol` (real Sepolia) and
///      `test/fork/ForkIntegration.t.sol`. It is kept for local fork demos only.
contract ForkDemo is Script {
    address constant VERIFIABLE_FACTORY = 0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F;
    address constant USER_REGISTRY_IMPL = 0x840Fa461059862Ea466A711E8C98c8dE732061C0;
    address constant ETH_REGISTRY = 0x67b728a792e789a8978b30cF1b3b641f19354b43;
    address constant RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;
    address constant ETH_REGISTRAR = 0xa4449a0dD2b83007553D9b1d28b583A46A805a30;

    string constant ROOT_NAME = "agentpassport.eth";
    uint256 constant AGENTPASSPORT_TOKEN_ID = uint256(keccak256(bytes("agentpassport")));

    PermissionedRegistry public platformRegistry;
    PermissionedResolver public resolver;
    HumanVerification public humanVerification;
    AgentReputation public agentReputation;
    AgentRegistrar public agentRegistrar;
    address public platform;
    address public verifier;
    address public human;
    address public agentWallet;
    bytes32 public algo1Node;
    bytes32 public trader7Node;

    function run() external {
        uint256 platformKey = vm.envUint("PLATFORM_KEY");
        uint256 verifierKey = vm.envUint("VERIFIER_KEY");
        uint256 humanKey = vm.envUint("HUMAN_KEY");
        platform = vm.addr(platformKey);
        verifier = vm.addr(verifierKey);
        human = vm.addr(humanKey);
        agentWallet = vm.envOr("AGENT_WALLET", human);

        PermissionedRegistry ethRegistry = PermissionedRegistry(payable(ETH_REGISTRY));
        VerifiableFactory factory = VerifiableFactory(VERIFIABLE_FACTORY);

        // ---- 0. Register agentpassport.eth via the real ETHRegistrar (impersonated) ----
        if (_status(ethRegistry, AGENTPASSPORT_TOKEN_ID) != uint256(2)) {
            vm.broadcast(ETH_REGISTRAR);
            ethRegistry.register(
                "agentpassport",
                platform,
                IRegistry(address(0)),
                address(0),
                _tokenAdminRoles(),
                type(uint64).max
            );
            console2.log("registered agentpassport.eth (owner = platform)");
        } else {
            console2.log("agentpassport.eth already registered");
        }

        // ---- 1. Platform UserRegistry via the real VerifiableFactory ----
        vm.broadcast(platformKey);
        platformRegistry = PermissionedRegistry(
            address(
                factory.deployProxy(
                    USER_REGISTRY_IMPL,
                    uint256(keccak256("userRegistry.agentpassport")),
                    abi.encodeCall(UserRegistry.initialize, (platform, _platformRootRoles()))
                )
            )
        );

        // ---- 2. Shared PermissionedResolver ----
        vm.broadcast(platformKey);
        resolver = PermissionedResolver(
            address(
                factory.deployProxy(
                    RESOLVER_IMPL,
                    uint256(keccak256("resolver.agentpassport")),
                    abi.encodeCall(
                        PermissionedResolver.initialize,
                        (platform, EACBaseRolesLib.ALL_ROLES, new bytes[](0))
                    )
                )
            )
        );

        // ---- 3. Point agentpassport.eth at both ----
        vm.broadcast(platformKey);
        ethRegistry.setSubregistry(AGENTPASSPORT_TOKEN_ID, platformRegistry);
        vm.broadcast(platformKey);
        ethRegistry.setResolver(AGENTPASSPORT_TOKEN_ID, address(resolver));

        // ---- 4. Agent Passport contracts ----
        vm.broadcast(platformKey);
        humanVerification = new HumanVerification(verifier, address(resolver));
        vm.broadcast(platformKey);
        agentReputation = new AgentReputation(platform, address(resolver));
        vm.broadcast(platformKey);
        agentRegistrar = new AgentRegistrar(
            address(platformRegistry),
            address(resolver),
            address(humanVerification),
            address(agentReputation),
            platform,
            ROOT_NAME,
            365 days
        );

        _grantRoles();

        // ---- 6. Human gate: only a World Selfie Check verifier can mark a human ----
        vm.broadcast(verifierKey);
        humanVerification.verifyHuman(
            human,
            uint256(keccak256("nullifier:humans-0xAbC")) & type(uint128).max
        );

        // ---- 7. Register two agents as that human ----
        vm.broadcast(humanKey);
        algo1Node = agentRegistrar.registerAgent("algo-1", human, agentWallet);
        vm.broadcast(humanKey);
        trader7Node = agentRegistrar.registerAgent("trader-7", human, agentWallet);

        // ---- 8. Reputation scores from the platform scoring backend ----
        vm.broadcast(platformKey);
        agentReputation.setScore(algo1Node, "algo-1", 94);
        vm.broadcast(platformKey);
        agentReputation.setScore(trader7Node, "trader-7", 82);

        _logAndWriteConfig();
    }

    function _grantRoles() internal {
        uint256 platformKey = vm.envUint("PLATFORM_KEY");
        vm.broadcast(platformKey);
        platformRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER,
            address(agentRegistrar)
        );
        vm.broadcast(platformKey);
        resolver.grantRootRoles(
            uint256(PermissionedResolverLib.ROLE_SET_ADDR_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_TEXT_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_DATA_ADMIN),
            address(agentRegistrar)
        );
    }

    function _status(PermissionedRegistry registry, uint256 tokenId) internal view returns (uint256) {
        IPermissionedRegistry.State memory st = registry.getState(tokenId);
        return uint256(st.status);
    }

    function _logAndWriteConfig() internal {
        console2.log("=== Agent Passport on-chain demo (Sepolia fork) ===");
        console2.log("platformRegistry :", address(platformRegistry));
        console2.log("resolver        :", address(resolver));
        console2.log("humanVerification:", address(humanVerification));
        console2.log("agentReputation :", address(agentReputation));
        console2.log("agentRegistrar  :", address(agentRegistrar));
        console2.log("platform        :", platform);
        console2.log("verifier        :", verifier);
        console2.log("human           :", human);
        console2.log("agentWallet     :", agentWallet);
        console2.log("algo-1 node     :", vm.toString(algo1Node));
        console2.log("trader-7 node   :", vm.toString(trader7Node));

        string memory out = _configJson();
        console2.log(out);
        console2.log("FORK_DEPLOY_JSON_END");
    }

    function _configJson() internal view returns (string memory) {
        return string.concat(
            '{"agentRegistrar":"', vm.toString(address(agentRegistrar)),
            '","agentReputation":"', vm.toString(address(agentReputation)),
            '","humanVerification":"', vm.toString(address(humanVerification)),
            '","platformRegistry":"', vm.toString(address(platformRegistry)),
            '","resolver":"', vm.toString(address(resolver)),
            '","platform":"', vm.toString(platform),
            '","verifier":"', vm.toString(verifier),
            '","human":"', vm.toString(human),
            '","agentWallet":"', vm.toString(agentWallet),
            '","rootName":"', ROOT_NAME,
            '","algo1Node":"', vm.toString(algo1Node),
            '","trader7Node":"', vm.toString(trader7Node),
            '"}'
        );
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
}