"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/engine/liveSigner.ts
var liveSigner_exports = {};
__export(liveSigner_exports, {
  executeTrade: () => executeTrade
});
module.exports = __toCommonJS(liveSigner_exports);
var import_web32 = require("@solana/web3.js");

// electron/engine/relayer.ts
var TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";
async function buildTrade(req) {
  try {
    const res = await fetch(TRADE_LOCAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: req.publicKey,
        action: req.action,
        mint: req.mint,
        amount: req.amount,
        denominatedInSol: req.denominatedInSol ? "true" : "false",
        slippage: req.slippage,
        priorityFee: req.priorityFee,
        pool: req.pool
      }),
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = (await res.text()).slice(0, 200) || detail;
      } catch {
      }
      return { ok: false, message: `Relayer rejected trade: ${detail}` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 64) return { ok: false, message: "Relayer returned an implausibly small transaction" };
    return { ok: true, message: "ok", tx: buf };
  } catch (err) {
    return { ok: false, message: `Relayer request failed: ${err.message}` };
  }
}

// electron/engine/rpcClient.ts
var nextId = 1;
async function call(httpUrl, method, params) {
  try {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(8e3)
    });
    if (!res.ok) return { ok: false, message: `RPC HTTP ${res.status}` };
    const body = await res.json();
    if (body.error) return { ok: false, message: body.error.message ?? "RPC error" };
    return { ok: true, message: "ok", data: body.result };
  } catch (err) {
    return { ok: false, message: err?.message ?? "RPC request failed" };
  }
}
async function getBalance(httpUrl, pubkey) {
  const r = await call(httpUrl, "getBalance", [pubkey, { commitment: "confirmed" }]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: "ok", data: r.data?.value ?? 0 };
}
async function getSignatureStatuses(httpUrl, signatures) {
  const r = await call(httpUrl, "getSignatureStatuses", [
    signatures,
    { searchTransactionHistory: false }
  ]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: "ok", data: r.data?.value ?? [] };
}
async function simulateTransaction(httpUrl, base64Tx, watchAddrs) {
  const r = await call(httpUrl, "simulateTransaction", [
    base64Tx,
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
      encoding: "base64",
      accounts: { addresses: watchAddrs, encoding: "base64" }
    }
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  const v = r.data.value;
  return {
    ok: true,
    message: "ok",
    data: {
      err: v.err,
      logs: v.logs ?? [],
      unitsConsumed: v.unitsConsumed ?? null,
      postLamports: (v.accounts ?? []).map((a) => a ? a.lamports : null)
    }
  };
}
async function sendRawTransaction(httpUrl, base64Tx) {
  return call(httpUrl, "sendTransaction", [
    base64Tx,
    { skipPreflight: true, maxRetries: 0, encoding: "base64", preflightCommitment: "processed" }
  ]);
}

// electron/system/wallet.ts
var import_electron = require("electron");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_ed25519 = require("@noble/curves/ed25519");
var import_web3 = require("@solana/web3.js");

// electron/engine/base58.ts
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var ALPHABET_MAP = {};
var ALPHABET_CODES = new Uint8Array(58);
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET[i]] = i;
  ALPHABET_CODES[i] = ALPHABET.charCodeAt(i);
}
var DIGITS = new Uint8Array(128);
var OUT_CODES = new Uint8Array(128);

// electron/system/wallet.ts
var cache = null;
function file() {
  return import_node_path.default.join(import_electron.app.getPath("userData"), "wallet.json");
}
function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(import_node_fs.default.readFileSync(file(), "utf8"));
    if (raw && raw.version === 1 && raw.publicKey && raw.secretEnc) cache = raw;
  } catch {
    cache = null;
  }
  return cache;
}
var fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
function decryptSecret(w) {
  const buf = Buffer.from(w.secretEnc, "base64");
  const hex = import_electron.safeStorage.decryptString(buf);
  return fromHex(hex);
}
function signVersionedTransaction(unsignedTx) {
  const w = load();
  if (!w) return { ok: false, message: "No wallet" };
  let secret = null;
  let kp = null;
  try {
    secret = decryptSecret(w);
    kp = import_web3.Keypair.fromSeed(secret);
    if (kp.publicKey.toBase58() !== w.publicKey) {
      return { ok: false, message: "Key mismatch \u2014 refusing to sign" };
    }
    const tx = import_web3.VersionedTransaction.deserialize(unsignedTx);
    const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
    if (feePayer !== w.publicKey) {
      return { ok: false, message: "Transaction fee payer is not this wallet \u2014 refusing to sign" };
    }
    if (tx.message.header.numRequiredSignatures !== 1) {
      return { ok: false, message: `Transaction needs ${tx.message.header.numRequiredSignatures} signers \u2014 refusing (expect 1)` };
    }
    tx.sign([kp]);
    return { ok: true, message: "signed", signed: tx.serialize() };
  } catch (err) {
    return { ok: false, message: `Signing failed: ${err.message}` };
  } finally {
    if (secret) secret.fill(0);
    kp = null;
  }
}
function publicKey() {
  return load()?.publicKey ?? null;
}

// electron/engine/liveSigner.ts
var LAMPORTS_PER_SOL = 1e9;
var ALLOWED_PROGRAMS = /* @__PURE__ */ new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  // pump
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  // pump-amm (pAMM…)
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  // pump fees
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  // token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  // ATA
  "11111111111111111111111111111111",
  // system
  "ComputeBudget111111111111111111111111111111",
  // compute budget
  "So11111111111111111111111111111111111111112"
  // wSOL mint (as account)
]);
async function executeTrade(p) {
  const owner = publicKey();
  if (!owner) return { ok: false, stage: "validate", message: "No trading wallet" };
  const built = await buildTrade({
    publicKey: owner,
    action: p.action,
    mint: p.mint,
    amount: p.amount,
    denominatedInSol: p.denominatedInSol,
    slippage: p.slippagePct,
    priorityFee: p.priorityFeeSol,
    pool: "auto"
  });
  if (!built.ok || !built.tx) return { ok: false, stage: "relayer", message: built.message };
  let tx;
  try {
    tx = import_web32.VersionedTransaction.deserialize(built.tx);
  } catch (err) {
    return { ok: false, stage: "validate", message: `Could not deserialize relayer tx: ${err.message}` };
  }
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== owner) {
    return { ok: false, stage: "validate", message: "Relayer tx fee payer is not our wallet \u2014 refusing" };
  }
  if (tx.message.header.numRequiredSignatures !== 1) {
    return { ok: false, stage: "validate", message: "Relayer tx requires more than our signature \u2014 refusing" };
  }
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const compiled = tx.message.compiledInstructions;
  for (const ix of compiled) {
    const pid = staticKeys[ix.programIdIndex];
    if (pid && !ALLOWED_PROGRAMS.has(pid)) {
      return { ok: false, stage: "validate", message: `Relayer tx calls a non-allowlisted program ${pid.slice(0, 8)}\u2026 \u2014 refusing` };
    }
  }
  const signedRes = signVersionedTransaction(built.tx);
  if (!signedRes.ok || !signedRes.signed) return { ok: false, stage: "sign", message: signedRes.message };
  const base64 = Buffer.from(signedRes.signed).toString("base64");
  const sim = await simulateTransaction(p.httpUrl, base64, [owner]);
  if (!sim.ok || !sim.data) return { ok: false, stage: "simulate", message: `Simulation call failed: ${sim.message}` };
  if (sim.data.err) {
    return { ok: false, stage: "simulate", message: `Simulation reverted: ${JSON.stringify(sim.data.err).slice(0, 160)}`, logs: sim.data.logs };
  }
  const preRes = await getBalance(p.httpUrl, owner);
  const preLamports = preRes.ok && preRes.data !== void 0 ? preRes.data : null;
  const postLamports = sim.data.postLamports[0];
  if (preLamports === null || postLamports === null) {
    return { ok: false, stage: "guard", message: "Could not read pre/post balance for the loss guard \u2014 refusing" };
  }
  const lossLamports = preLamports - postLamports;
  const lossSol = lossLamports / LAMPORTS_PER_SOL;
  const boundSol = p.maxLossSol + (p.action === "buy" && p.denominatedInSol ? p.amount : 0);
  if (lossSol > boundSol) {
    return {
      ok: false,
      stage: "guard",
      message: `Simulated loss ${lossSol.toFixed(5)} SOL exceeds bound ${boundSol.toFixed(5)} SOL \u2014 refusing to broadcast`,
      simulatedLossSol: lossSol
    };
  }
  if (p.simulateOnly) {
    return { ok: true, stage: "simulate", message: `Dry run OK \u2014 simulated loss ${lossSol.toFixed(5)} SOL, within bound`, simulatedLossSol: lossSol, logs: sim.data.logs };
  }
  const sent = await sendRawTransaction(p.httpUrl, base64);
  if (!sent.ok || !sent.data) return { ok: false, stage: "send", message: `Broadcast failed: ${sent.message}`, simulatedLossSol: lossSol };
  const signature = sent.data;
  const confirmed = await confirm(p.httpUrl, signature);
  return {
    ok: confirmed,
    stage: confirmed ? "done" : "confirm",
    message: confirmed ? `Landed ${signature.slice(0, 12)}\u2026` : `Submitted ${signature.slice(0, 12)}\u2026 (confirmation pending)`,
    signature,
    simulatedLossSol: lossSol
  };
}
async function confirm(httpUrl, signature) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r2) => setTimeout(r2, 1500));
    const r = await getSignatureStatuses(httpUrl, [signature]);
    if (r.ok && r.data) {
      const st = r.data[0];
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true;
      if (st?.err) return false;
    }
  }
  return false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  executeTrade
});
