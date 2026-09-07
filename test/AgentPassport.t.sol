// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {UserRegistry} from "~src/registry/UserRegistry.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {ContractNamer} from "~src/utils/ContractNamer.sol";
import {LabelStore} from "~src/utils/LabelStore.sol";
import {PermissionedResolver} from "~src/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "~src/resolver/libraries/PermissionedResolverLib.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";

import {AgentRegistrar} from "../src/AgentRegistrar.sol";
import {AgentReputation} from "../src/AgentReputation.sol";
import {HumanVerification} from "../src/HumanVerification.sol";

/// @notice Deploys the full ENSv2 stack locally and exercises the Agent Passport flow,
///         verifying that Enhanced Access Control separates write-rights correctly.
contract AgentPassportTest is Test, ERC1155Holder {
    // ENSv2 infrastructure
    ContractNamer contractNamer;
    VerifiableFactory verifiableFactory;
    LabelStore labelStore;
    UserRegistry userRegistryImpl;
    PermissionedRegistry rootRegistry;
    PermissionedRegistry ethRegistry;
    PermissionedResolver resolverImpl;

    // Our platform root name
    string rootName = "mypassport.eth";
    PermissionedRegistry platformRegistry;

    // Our contracts
    HumanVerification humanVerification;
    AgentReputation agentReputation;
    AgentRegistrar agentRegistrar;

    // Accounts
    address verifier = makeAddr("verifier");
    address platform = makeAddr("platform");
    address human1 = makeAddr("human1");
    address human2 = makeAddr("human2");
    address bot = makeAddr("bot");
    address agentWallet1 = makeAddr("agentWallet1");
    address agentWallet2 = makeAddr("agentWallet2");

    bytes32 rootNode;

    function setUp() public {
        // ---- Deploy ENSv2 base stack (root + .eth registries) ----
        contractNamer = ContractNamer(
            address(
                new ERC1967Proxy(
                    address(new ContractNamer()),
                    abi.encodeCall(ContractNamer.initialize, (address(this)))
                )
            )
        );
        verifiableFactory = new VerifiableFactory();
        labelStore = new LabelStore(contractNamer);
        userRegistryImpl = new UserRegistry(labelStore, address(this));
        rootRegistry = new PermissionedRegistry(labelStore, address(this), _rootRegistryRootRoles());
        ethRegistry = new PermissionedRegistry(
            labelStore,
            address(this),
            _ethRegistryRootRoles()
        );
        rootRegistry.register(
            "eth",
            address(this),
            ethRegistry,
            address(0),
            _ethTokenRoles(),
            type(uint64).max
        );
        ethRegistry.setParent(rootRegistry, "eth");
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(this));

        // ---- Register our platform root 2LD name: mypassport.eth ----
        ethRegistry.register(
            "mypassport",
            address(this),
            IRegistry(address(0)),
            address(0),
            _registryTokenRoles(),
            type(uint64).max
        );
        rootNode = keccak256(
            abi.encodePacked(
                bytes32(0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae), // eth
                bytes32(uint256(keccak256(bytes("mypassport"))))
            )
        );

        // ---- Deploy a UserRegistry for our platform's agents ----
        platformRegistry = PermissionedRegistry(
            verifiableFactory.deployProxy(
                address(userRegistryImpl),
                uint256(keccak256(abi.encodePacked("UserRegistry", rootName))),
                abi.encodeCall(UserRegistry.initialize, (platform, _platformRegistryRoles()))
            )
        );

        // Point mypassport.eth at the platform UserRegistry
        ethRegistry.setSubregistry(uint256(keccak256(bytes("mypassport"))), platformRegistry);

        // ---- Deploy a shared PermissionedResolver ----
        resolverImpl = new PermissionedResolver(address(this));
        bytes memory initData = abi.encodeCall(
            PermissionedResolver.initialize,
            (platform, EACBaseRolesLib.ALL_ROLES, new bytes[](0))
        );
        PermissionedResolver resolver = PermissionedResolver(
            verifiableFactory.deployProxy(
                address(resolverImpl),
                uint256(keccak256(abi.encodePacked("Resolver", rootName))),
                initData
            )
        );

        // ---- Deploy our three contracts ----
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

        // ---- Grant roles ----
        // AgentRegistrar needs ROLE_REGISTRAR + ROLE_RENEW + ROLE_UNREGISTER on the platform registry.
        vm.prank(platform);
        platformRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER,
            address(agentRegistrar)
        );

        // AgentRegistrar needs resolver admin roles on the resolver's ROOT_RESOURCE so
        // it can configure per-name permissions.
        vm.prank(platform);
        resolver.grantRootRoles(
            uint256(PermissionedResolverLib.ROLE_SET_ADDR_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_CONTENTHASH_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_TEXT_ADMIN)
                | uint256(PermissionedResolverLib.ROLE_SET_DATA_ADMIN),
            address(agentRegistrar)
        );

        // HumanVerification is the trusted verifier writer of human-verified records
        // (it calls setText, protected by EAC on the key itself).
        // (happens per-name during registration)
    }

    ////////////////////////////////////////////////////////////////////////
    // Delegated helper contract for resolver reads
    ////////////////////////////////////////////////////////////////////////

    ////////////////////////////////////////////////////////////////////////
    // Tests
    ////////////////////////////////////////////////////////////////////////

    function test_registerAgent_gatedOnHumanVerification() public {
        // Human1 is verified via World Selfie Check proof.
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);

        // Agent owner must be verified; bot is not -> reverts.
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.NotHumanVerified.selector, bot));
        vm.prank(bot);
        agentRegistrar.registerAgent("agent-1", bot, agentWallet1);

        // Verified human can register.
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
        assertEq(node, keccak256(abi.encodePacked(rootNode, bytes32(uint256(keccak256(bytes("agent-1")))))));

        // The agent name is registered in the platform registry.
        IPermissionedRegistry.State memory state = platformRegistry.getState(
            uint256(keccak256(bytes("agent-1")))
        );
        assertEq(uint256(state.status), uint256(2), "agent should be REGISTERED");
        assertEq(state.latestOwner, human1, "owner is the human");
    }

    function test_eac_separatesWriteRights() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));

        // The owner CAN set the addr record and specific text keys (name/description/url).
        vm.prank(human1);
        resolver.setAddr(node, address(0xAAAA));
        assertEq(resolver.addr(node), address(0xAAAA), "addr set by owner");

        vm.prank(human1);
        resolver.setText(node, "description", "I am a trading agent");

        // The owner CANNOT set the "human-verified" text key - only HumanVerification may.
        vm.expectRevert();
        vm.prank(human1);
        resolver.setText(node, "human-verified", "true");

        // HumanVerification CAN set it (EAC grants it this specific key).
        humanVerification.ensureHumanVerifiedRecord(node, new bytes(0));
        assertEq(resolver.text(node, "human-verified"), "true", "human-verified written by HV");

        // The owner CANNOT set the "reputation" data key - only AgentReputation may.
        vm.expectRevert();
        vm.prank(human1);
        resolver.setData(node, "reputation", abi.encode(99));

        // AgentReputation CAN set the reputation record.
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 87);
        assertEq(agentReputation.readScore(node), 87, "score stored");
        assertEq(abi.decode(resolver.data(node, "reputation"), (uint256)), 87, "score on resolver");
    }

    function test_reputation_score_onlyScorer() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        // A random account cannot set the score.
        vm.expectRevert(abi.encodeWithSelector(AgentReputation.OnlyScorer.selector));
        vm.prank(bot);
        agentReputation.setScore(node, "agent-1", 50);

        // The scorer (platform) can.
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 92);
        assertEq(agentReputation.readScore(node), 92);
    }

    function test_multipleAgentsOneHuman() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-a", human1, agentWallet1);
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-b", human1, agentWallet2);

        IPermissionedRegistry.State memory sa = platformRegistry.getState(uint256(keccak256(bytes("agent-a"))));
        IPermissionedRegistry.State memory sb = platformRegistry.getState(uint256(keccak256(bytes("agent-b"))));
        assertEq(uint256(sa.status), 2);
        assertEq(uint256(sb.status), 2);
    }

    function test_revokeAgent_onlyPlatform() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        // Non-platform cannot revoke.
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.OnlyPlatform.selector));
        vm.prank(human1);
        agentRegistrar.revokeAgent("agent-1");

        // Platform can.
        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");
        IPermissionedRegistry.State memory state = platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(uint256(state.status), uint256(0), "agent unregistered");
    }

    ////////////////////////////////////////////////////////////////////////
    // Validation + edge case coverage
    ////////////////////////////////////////////////////////////////////////

    function test_registerAgent_rejects_invalid_inputs() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);

        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.InvalidOwner.selector));
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", address(0), agentWallet1);

        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.LabelTooShort.selector));
        vm.prank(human1);
        agentRegistrar.registerAgent("", human1, agentWallet1);

        // Invalid labels: dots, mixed case, leading/trailing hyphens, >63 bytes.
        string[4] memory badLabels = ["a.b", "Alias", "-lead", "trail-"];
        for (uint256 i = 0; i < badLabels.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.InvalidLabel.selector));
            vm.prank(human1);
            agentRegistrar.registerAgent(badLabels[i], human1, agentWallet1);
        }
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.InvalidLabel.selector));
        vm.prank(human1);
        agentRegistrar.registerAgent(_repeatStr(64, "a"), human1, agentWallet1);

        // Max-length (63 byte) label is accepted.
        vm.prank(human1);
        agentRegistrar.registerAgent(_repeatStr(63, "b"), human1, agentWallet1);
        IPermissionedRegistry.State memory maxSt =
            platformRegistry.getState(uint256(keccak256(bytes(_repeatStr(63, "b")))));
        assertEq(uint256(maxSt.status), uint256(2), "63-char label registered");

        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.InvalidAgentAddress.selector));
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, address(0));
    }

    function test_registerAgent_ownerMayDifferFromCaller() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(verifier);
        humanVerification.verifyHuman(human2, 67890);

        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human2, agentWallet1);

        IPermissionedRegistry.State memory state = platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(state.latestOwner, human2, "owner is the registered human");

        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));
        vm.prank(human2);
        resolver.setAddr(node, address(0xBBBB));
        assertEq(resolver.addr(node), address(0xBBBB), "owner can set addr");

        // The caller (not the owner) has no per-name resolver role.
        vm.expectRevert();
        vm.prank(human1);
        resolver.setAddr(node, address(0xCCCC));
    }

    function test_verifyHuman_onlyVerifier_and_revokeHuman() public {
        vm.expectRevert(abi.encodeWithSelector(HumanVerification.OnlyVerifier.selector));
        vm.prank(human1);
        humanVerification.verifyHuman(human1, 1);

        vm.expectRevert(abi.encodeWithSelector(HumanVerification.OnlyVerifier.selector));
        vm.prank(bot);
        humanVerification.revokeHuman(human1);
    }

    function test_verifyHuman_idempotent_and_revokeHuman_positive() public {
        // Re-verifying an already-verified human is allowed and stays verified.
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 111);
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 222); // updated nullifier, still verified
        assertTrue(humanVerification.isHumanVerified(human1));
        assertEq(humanVerification.nullifiers(human1), 222);

        // Positive revoke: verifier revokes, state flips, event emitted.
        vm.expectEmit(true, false, false, false, address(humanVerification));
        emit HumanVerification.HumanUnverified(human1);
        vm.prank(verifier);
        humanVerification.revokeHuman(human1);
        assertFalse(humanVerification.isHumanVerified(human1));
    }

    function test_revokedHuman_cannotRegisterAgent() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(verifier);
        humanVerification.revokeHuman(human1);

        assertFalse(humanVerification.isHumanVerified(human1));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistrar.NotHumanVerified.selector, human1));
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
    }

    function test_agentCanBeReRegistered_afterRevoke() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 87);

        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");

        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));
        assertEq(resolver.addr(node), address(0), "addr cleared on revoke");
        assertEq(resolver.text(node, "name"), "", "name cleared on revoke");
        vm.expectRevert();
        vm.prank(human1);
        resolver.setAddr(node, address(0xAAAA)); // owner per-name roles revoked

        IPermissionedRegistry.State memory st = platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(uint256(st.status), uint256(0), "unregistered");

        // Same label can be registered again with fresh records.
        vm.prank(human1);
        bytes32 node2 = agentRegistrar.registerAgent("agent-1", human1, agentWallet2);
        assertEq(node2, node, "same node for same label");

        IPermissionedRegistry.State memory st2 = platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(uint256(st2.status), uint256(2), "re-registered");
        assertEq(resolver.addr(node), agentWallet2, "addr rewritten");
        assertEq(resolver.text(node, "name"), "agent-1", "name rewritten");

        // Per-name resolver roles are re-granted to the (new) owner on re-register.
        vm.prank(human1);
        resolver.setAddr(node, address(0xDDDD));
        assertEq(resolver.addr(node), address(0xDDDD), "re-registered owner can set addr");

        // Expiry restarts at now + lease on re-registration.
        IPermissionedRegistry.State memory st3 =
            platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(st3.expiry, uint64(block.timestamp + 365 days), "re-registered expiry refreshed");
    }

    function test_revokeAgent_clearsOwnerTextPermissions_afterRevoke() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        // The owner writes their own records before revocation.
        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));
        vm.prank(human1);
        resolver.setText(node, "url", "https://agent.example");
        vm.prank(human1);
        resolver.setText(node, "description", "onchain agent");

        // After revocation, EVERY per-name owner write role is gone: addr, name,
        // description and url (the text-role revokes must not be missed).
        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");

        vm.expectRevert();
        vm.prank(human1);
        resolver.setText(node, "url", "https://evil.example");
        vm.expectRevert();
        vm.prank(human1);
        resolver.setText(node, "description", "hijacked");
        vm.expectRevert();
        vm.prank(human1);
        resolver.setText(node, "name", "hijacked");
        vm.expectRevert();
        vm.prank(human1);
        resolver.setAddr(node, address(0xBEEF));
    }

    function test_reRegisteredAgent_startsWithCleanPermissions() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(verifier);
        humanVerification.verifyHuman(human2, 67890);

        // Register for human2, revoke, then re-register the same label for human1.
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human2, agentWallet1);
        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, agentWallet2);

        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));

        // The OLD owner (human2) has no write roles on the re-registered node.
        vm.expectRevert();
        vm.prank(human2);
        resolver.setText(node, "url", "https://stale.example");
        vm.expectRevert();
        vm.prank(human2);
        resolver.setAddr(node, address(0xCAFE));

        // The NEW owner (human1) can write addr + url + name normally.
        vm.prank(human1);
        resolver.setAddr(node, address(0xDEAD));
        vm.prank(human1);
        resolver.setText(node, "url", "https://fresh.example");
        assertEq(resolver.addr(node), address(0xDEAD), "new owner addr");
        assertEq(resolver.text(node, "url"), "https://fresh.example", "new owner url");
    }

    function test_ensureHumanVerifiedRecord_accessAndIdempotency() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));

        // No ACL here BY DESIGN: the resolver's EAC only lets the HumanVerification
        // contract (not any direct caller) write the key, and the written value is
        // the constant "true". An arbitrary caller can therefore only re-assert the
        // existing status, never forge or remove it.
        vm.prank(bot);
        humanVerification.ensureHumanVerifiedRecord(node, new bytes(0));
        assertEq(resolver.text(node, "human-verified"), "true", "re-assert only");

        // Repeating the re-assertion is an idempotent no-op.
        humanVerification.ensureHumanVerifiedRecord(node, new bytes(0));
        assertEq(resolver.text(node, "human-verified"), "true");
    }

    function test_registerAgent_minimalSingleByteLabel() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);

        // The lower boundary of the 1-63 byte label range.
        vm.prank(human1);
        agentRegistrar.registerAgent("a", human1, agentWallet1);
        IPermissionedRegistry.State memory st = platformRegistry.getState(uint256(keccak256(bytes("a"))));
        assertEq(uint256(st.status), uint256(2), "1-char label registered");
    }

    function test_revokeAgent_neverRegistered_reverts() public {
        // Nothing was ever registered under this label: the registry rejects the
        // unregister with its LabelExpired error (expiry == 0 means never minted).
        vm.expectRevert();
        vm.prank(platform);
        agentRegistrar.revokeAgent("never-registered");

        // Double-revoke of an already-revoked label reverts the same way
        // (expiry is stamped to the revocation block).
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");
        vm.expectRevert();
        vm.prank(platform);
        agentRegistrar.revokeAgent("agent-1");
    }

    function test_setScore_boundaries() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        bytes32 node = agentRegistrar.registerAgent("agent-1", human1, agentWallet1);
        PermissionedResolver resolver = PermissionedResolver(address(agentRegistrar.RESOLVER()));

        // Score 0 propagates to both local + resolver stores.
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 0);
        assertEq(agentReputation.readScore(node), 0);
        assertEq(agentReputation.scores(node), 0, "public getter");
        assertEq(abi.decode(resolver.data(node, "reputation"), (uint256)), 0);

        // Out-of-range scores revert.
        vm.expectRevert(abi.encodeWithSelector(AgentReputation.ScoreOutOfRange.selector));
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 101);

        // Max allowed score.
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 100);
        assertEq(agentReputation.readScore(node), 100);

        // Scoring a never-permissioned node reverts on the resolver data write.
        vm.expectRevert();
        vm.prank(platform);
        agentReputation.setScore(bytes32(uint256(1)), "ghost", 50);
    }

    function test_nullifiers_readback() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        assertEq(humanVerification.nullifiers(human1), 12345);
    }

    function test_expiry_equalsNowPlusLease() public {
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);
        vm.prank(human1);
        agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        IPermissionedRegistry.State memory st = platformRegistry.getState(uint256(keccak256(bytes("agent-1"))));
        assertEq(st.expiry, uint64(block.timestamp + 365 days));
    }

    function test_registration_emits_events() public {
        // HumanVerified event on verifyHuman.
        vm.expectEmit(true, false, false, true, address(humanVerification));
        emit HumanVerification.HumanVerified(human1, 12345);
        vm.prank(verifier);
        humanVerification.verifyHuman(human1, 12345);

        vm.prank(human1);
        vm.recordLogs();
        agentRegistrar.registerAgent("agent-1", human1, agentWallet1);

        // AgentRegistered must be among the recorded logs.
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("AgentRegistered(bytes32,string,uint256,address,address,address,uint64)");
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                found = true;
                break;
            }
        }
        assertTrue(found, "AgentRegistered event emitted");

        // ScoreUpdated event on setScore.
        bytes32 node = keccak256(
            abi.encodePacked(rootNode, bytes32(uint256(keccak256(bytes("agent-1")))))
        );
        vm.expectEmit(true, true, false, false, address(agentReputation));
        emit AgentReputation.ScoreUpdated(node, "agent-1", 90, 0);
        vm.prank(platform);
        agentReputation.setScore(node, "agent-1", 90);
    }

    function _repeatStr(uint256 n, string memory s) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = bytes(s)[0];
        return string(out);
    }

    ////////////////////////////////////////////////////////////////////////
    // Role bitmaps
    ////////////////////////////////////////////////////////////////////////

    function _rootRegistryRootRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR |
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_REGISTER_RESERVED |
            RegistryRolesLib.ROLE_REGISTER_RESERVED_ADMIN |
            RegistryRolesLib.ROLE_SET_PARENT |
            RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }

    function _ethRegistryRootRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_REGISTER_RESERVED_ADMIN |
            RegistryRolesLib.ROLE_SET_PARENT |
            RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }

    function _ethTokenRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;
    }

    /// @dev Roles granted to the mypassport.eth token holder (address(this)).
    function _registryTokenRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
    }

    /// @dev Roles the platform gets on the UserRegistry's ROOT_RESOURCE.
    function _platformRegistryRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR |
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_UNREGISTER |
            RegistryRolesLib.ROLE_UNREGISTER_ADMIN |
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }
}
