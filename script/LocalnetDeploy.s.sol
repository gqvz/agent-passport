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

/// @title LocalnetDeploy
/// @notice Broadcasts the full Agent Passport flow as REAL transactions against a fully
///         local ENSv2 devnet (`lib/contracts-v2/contracts` — `bun run devnet`, anvil :8545,
///         chain 31337). All ENSv2 protocol contracts (Registry, ETHRegistry, ETHRegistrar,
///         UserRegistry / PermissionedRegistry impls, PermissionedResolver impl,
///         VerifiableFactory) are deployed by the devnet; this script wires the platform.
///
/// @dev Requires three funded accounts. Run:
///      PLATFORM_KEY=.. VERIFIER_KEY=.. HUMAN_KEY=.. forge script script/LocalnetDeploy.s.sol \
///          --rpc-url http://127.0.0.1:8545 --broadcast
///      Writes script/localnet-deploy.json with all addresses + namehashes.
contract LocalnetDeploy is Script {
    // ENSv2 localnet addresses (deterministic per `bun run devnet`, see deployments/devnet-31337/).
    address constant VERIFIABLE_FACTORY = 0x4A679253410272dd5232B3Ff7cF5dbB88f295319;
    address constant USER_REGISTRY_IMPL = 0x4C4a2f8c81640e47606d3fd77B353E87Ba015584;
    address constant ETH_REGISTRY = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570;
    address constant RESOLVER_IMPL = 0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650;

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

        PermissionedRegistry pury = PermissionedRegistry(payable(ETH_REGISTRY));
        VerifiableFactory factory = VerifiableFactory(VERIFIABLE_FACTORY);

        // ---- 0. Grant ROLE_REGISTRAR at the ETHRegistry root to the platform (the same
        //          power the protocol registrar uses), then register agentpassport.eth. ----
        if (!pury.hasRoles(0, RegistryRolesLib.ROLE_REGISTRAR, platform)) {
            vm.broadcast(platformKey);
            pury.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, platform);
            console2.log("granted ROLE_REGISTRAR (root) to platform");
            _assert(pury.hasRoles(0, RegistryRolesLib.ROLE_REGISTRAR, platform), "role not granted");
        } else {
            console2.log("platform already has root ROLE_REGISTRAR");
        }

        if (_status(pury, AGENTPASSPORT_TOKEN_ID) != uint256(2)) {
            vm.broadcast(platformKey);
            pury.register(
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

        // ---- 1. Platform UserRegistry via the localnet VerifiableFactory ----
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
        pury.setSubregistry(AGENTPASSPORT_TOKEN_ID, platformRegistry);
        vm.broadcast(platformKey);
        pury.setResolver(AGENTPASSPORT_TOKEN_ID, address(resolver));

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
            uint256(keccak256("nullifier:humans-localnet-01")) & type(uint128).max
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

    function _assert(bool cond, string memory what) internal pure {
        if (!cond) revert(what);
    }

    function _logAndWriteConfig() internal {
        console2.log("=== Agent Passport on-chain demo (ENSv2 localnet) ===");
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
        console2.log("LOCALNET_DEPLOY_JSON_END");
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