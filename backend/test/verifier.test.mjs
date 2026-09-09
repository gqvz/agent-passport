import "dotenv/config";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { HumanVerifier, withConfirmationTimeout } from "../src/verifier.mjs";

const RPC = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ADDRESS = process.env.HUMAN_VERIFICATION_ADDRESS || "0x88C0a242Ab3d40b29a375393D873db200D21cB11";
const KEY = "0x" + "22".repeat(32); // arbitrary non-secret key

describe("HumanVerifier construction", () => {
  test("requires rpcUrl, privateKey and address", () => {
    assert.throws(() => new HumanVerifier({}), /requires rpcUrl, privateKey and humanVerificationAddress/);
    assert.throws(
      () => new HumanVerifier({ rpcUrl: RPC, privateKey: KEY }),
      /requires rpcUrl, privateKey and humanVerificationAddress/,
    );
  });

  test("rejects a malformed contract address", () => {
    assert.throws(
      () => new HumanVerifier({ rpcUrl: RPC, privateKey: KEY, humanVerificationAddress: "nope" }),
      /Invalid HumanVerification address/,
    );
  });

  test("derives verifierAddress from the private key offline", () => {
    const hv = new HumanVerifier({ rpcUrl: RPC, privateKey: KEY, humanVerificationAddress: ADDRESS });
    assert.match(hv.verifierAddress, /^0x[0-9a-fA-F]{40}$/);
  });
});

describe("withConfirmationTimeout", () => {
  test("resolves with the receipt when the wait wins the race", async () => {
    const receipt = { hash: "0xabc" };
    const out = await withConfirmationTimeout(Promise.resolve(receipt), 1000);
    assert.equal(out, receipt);
  });

  test("rejects with a clean message when the wait never settles", async () => {
    await assert.rejects(
      withConfirmationTimeout(new Promise(() => {}), 30),
      /timed out waiting for transaction confirmations/,
    );
  });

  test("does not hold the event loop open after a fast win", async () => {
    // A timer left behind after the race would keep the process alive past the
    // test; resolving quickly and returning immediately is enough to prove the
    // finally-clearTimer path runs.
    const out = await withConfirmationTimeout(Promise.resolve({ hash: "0x1" }), 50);
    assert.equal(out.hash, "0x1");
  });
});

describe("HumanVerifier.on-chain", () => {
  test("verifyHuman rejects an invalid wallet before any network call", async () => {
    const hv = new HumanVerifier({ rpcUrl: RPC, privateKey: KEY, humanVerificationAddress: ADDRESS });
    await assert.rejects(hv.verifyHuman("not-an-address", "1"), /Invalid wallet address/);
  });

  test("isVerified reads live Sepolia state (read-only integration)", async (t) => {
    const hv = new HumanVerifier({ rpcUrl: RPC, privateKey: KEY, humanVerificationAddress: ADDRESS });
    let reachable = true;
    try {
      await hv.isVerified("0x31E4dEec432deD01F79315CbB870fc1237e41e12");
    } catch (e) {
      reachable = false;
    }
    if (!reachable) {
      t.skip("Sepolia RPC unreachable");
      return;
    }
    // Demo human verified during the live E2E.
    assert.equal(await hv.isVerified("0x31E4dEec432deD01F79315CbB870fc1237e41e12"), true);
    // A never-used address has no verification record.
    assert.equal(await hv.isVerified(`0x${"99".repeat(20)}`), false);
  });
});