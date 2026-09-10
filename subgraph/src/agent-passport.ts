import { BigInt, Bytes, ethereum, store } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  AgentRevoked,
} from "../generated/AgentRegistrar/AgentRegistrar";
import {
  LabelRegistered,
  LabelUnregistered,
  ExpiryUpdated,
} from "../generated/UserRegistry/UserRegistry";
import { ScoreUpdated } from "../generated/AgentReputation/AgentReputation";
import {
  HumanVerified,
  HumanUnverified,
} from "../generated/HumanVerification/HumanVerification";
import { Agent, Human, LabelRecord, Platform } from "../generated/schema";

/// The AgentRegistrar contract that mints agent labels via the UserRegistry.
export const AGENT_REGISTRAR =
  "0xf160c7156ce7d4168b92daa9c72d1bbd64d82b2c";

/// Namehash of "agentpassport.eth" on ENSv2 (sepolia).
export const ROOT_NODE =
  "0x6cb10255454b479ceea770bad6b2d9671708bd9ceac2d8f193bc43d4672cbb4d";
export const ROOT_NAME = "agentpassport.eth";

function fullName(label: string): string {
  return label + "." + ROOT_NAME;
}

/// Resolve the label string for an agent token id.
function labelFor(tokenId: BigInt): string {
  let record = LabelRecord.load(tokenId.toHexString());
  return record != null && record.label.length > 0 ? record.label : "";
}

function ensureHuman(id: string): Human {
  let human = Human.load(id);
  if (human == null) {
    human = new Human(id);
    human.nullifierHash = BigInt.zero();
    human.verifiedAt = BigInt.zero();
    human.isVerified = false;
    human.save();
  }
  return human;
}

function ensurePlatform(): Platform {
  let platform = Platform.load(ROOT_NODE);
  if (platform == null) {
    platform = new Platform(ROOT_NODE);
    platform.rootName = ROOT_NAME;
    platform.agentCount = 0;
    platform.save();
  }
  return platform;
}

export function handleBlock(_block: ethereum.Block): void {
  // Seed the Platform aggregate at the first indexed block so the singleton
  // exists even before any agent registers on-chain.
  ensurePlatform();
}

export function handleLabelRegistered(event: LabelRegistered): void {
  if (event.params.sender.toHexString() != AGENT_REGISTRAR) {
    return;
  }
  let record = LabelRecord.load(event.params.tokenId.toHexString());
  if (record == null) {
    record = new LabelRecord(event.params.tokenId.toHexString());
    record.node = Bytes.fromHexString("0x00");
  }
  record.label = event.params.label;
  record.expiry = event.params.expiry;
  record.save();
}

export function handleLabelUnregistered(event: LabelUnregistered): void {
  if (event.params.sender.toHexString() != AGENT_REGISTRAR) {
    return;
  }
  let record = LabelRecord.load(event.params.tokenId.toHexString());
  if (record == null) {
    return;
  }
  // Agent.status is flipped to REVOKED by handleAgentRevoked (AgentRegistrar
  // event); here we only drop the label record that resolved the token id.
  store.remove("LabelRecord", event.params.tokenId.toHexString());
}

export function handleExpiryUpdated(event: ExpiryUpdated): void {
  // No sender gate: renewals may originate from the name owner (not just the
  // registrar). If the token id belongs to one of our labels the expiry update
  // is valid regardless of who triggered it.
  let record = LabelRecord.load(event.params.tokenId.toHexString());
  if (record == null) {
    return;
  }
  record.expiry = event.params.newExpiry;
  record.save();

  // Keep the Agent's own lease expiry in sync too (renewals happen outside the
  // registrar's AgentRegistered path). Node is only a 0x00 placeholder until
  // AgentRegistered backfills it, in which case there is no Agent yet.
  let agent = Agent.load(record.node.toHexString());
  if (agent != null) {
    agent.expiry = event.params.newExpiry;
    agent.save();
  }
}

export function handleAgentRegistered(event: AgentRegistered): void {
  let humanId = event.params.owner.toHexString();
  let human = ensureHuman(humanId);
  let label = labelFor(event.params.tokenId);

  // Keep the tokenId -> (label,node) index in sync with the agent record.
  let record = LabelRecord.load(event.params.tokenId.toHexString());
  if (record == null) {
    record = new LabelRecord(event.params.tokenId.toHexString());
    record.label = "";
  }
  record.node = event.params.node;
  record.expiry = event.params.expiry;
  record.save();

  let existing = Agent.load(event.params.node.toHexString());

  let agent = new Agent(event.params.node.toHexString());
  agent.label = label;
  agent.fullName = fullName(label);
  agent.tokenId = event.params.tokenId;
  agent.owner = humanId;
  agent.agentAddress = event.params.agentAddress;
  agent.resolver = event.params.resolver;
  agent.registeredAt = event.block.timestamp;
  agent.expiry = event.params.expiry;
  agent.status = "REGISTERED";
  agent.score = null;
  agent.scoreUpdatedAt = null;
  agent.save();

  let platform = ensurePlatform();
  // Count each distinct agent once (re-registration of a revoked label must
  // not double-count).
  if (existing == null) {
    platform.agentCount = platform.agentCount + 1;
  }
  platform.save();
}

export function handleAgentRevoked(event: AgentRevoked): void {
  let agent = Agent.load(event.params.node.toHexString());
  if (agent != null) {
    agent.status = "REVOKED";
    agent.save();
  }
}

export function handleScoreUpdated(event: ScoreUpdated): void {
  let agent = Agent.load(event.params.node.toHexString());
  if (agent != null) {
    agent.score = event.params.score;
    agent.scoreUpdatedAt = event.params.timestamp;
    agent.save();
  }
}

export function handleHumanVerified(event: HumanVerified): void {
  let human = ensureHuman(event.params.human.toHexString());
  human.nullifierHash = event.params.nullifierHash;
  human.verifiedAt = event.block.timestamp;
  human.isVerified = true;
  human.save();
}

export function handleHumanUnverified(event: HumanUnverified): void {
  let human = ensureHuman(event.params.human.toHexString());
  human.isVerified = false;
  human.save();
}