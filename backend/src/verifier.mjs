// On-chain verifier: sends { wallet, nullifier } to HumanVerification.verifyHuman
// on Sepolia so the ENSv2 agent-passport contracts treat the wallet as verified.

import { Contract, JsonRpcProvider, Wallet, isAddress } from "ethers";

const HUMAN_VERIFICATION_ABI = [
  "function verifyHuman(address human, uint256 nullifierHash) external",
  "function revokeHuman(address human) external",
  "function isHumanVerified(address human) public view returns (bool)",
  "function nullifiers(address) public view returns (uint256)",
];

export class HumanVerifier {
  constructor({ rpcUrl, privateKey, humanVerificationAddress, confirmations = 1, confirmationTimeoutMs = 60000 }) {
    if (!rpcUrl || !privateKey || !humanVerificationAddress) {
      throw new Error("HumanVerifier requires rpcUrl, privateKey and humanVerificationAddress");
    }
    if (!isAddress(humanVerificationAddress)) {
      throw new Error(`Invalid HumanVerification address: ${humanVerificationAddress}`);
    }
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(privateKey, this.provider);
    this.contract = new Contract(humanVerificationAddress, HUMAN_VERIFICATION_ABI, this.wallet);
    this.confirmations = confirmations;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
  }

  get verifierAddress() {
    return this.wallet.address;
  }

  async isVerified(human) {
    return this.contract.isHumanVerified(human);
  }

  async verifyHuman(human, nullifierHash) {
    if (!isAddress(human)) throw new Error(`Invalid wallet address: ${human}`);
    const tx = await this.contract.verifyHuman(human, BigInt(nullifierHash));
    const receipt = await withConfirmationTimeout(
      tx.wait(this.confirmations),
      this.confirmationTimeoutMs,
    );
    return { txHash: receipt.hash, human, nullifierHash: BigInt(nullifierHash).toString(10) };
  }
}

/**
 * Bound `wait` to a wall-clock timeout so a hung or congested RPC can never hold
 * the Express request open indefinitely. The rejection timer is always cleared so
 * the process exits cleanly.
 */
export function withConfirmationTimeout(wait, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for transaction confirmations")),
      timeoutMs,
    );
  });
  return Promise.race([wait, timeout]).finally(() => clearTimeout(timer));
}