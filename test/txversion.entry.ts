// Bundle entry for test/txversion.test.mjs: the wire parser and the
// transaction shape from the RPC client, and the swap decoder that reads
// them, in one module graph.
export { MAX_SUPPORTED_TX_VERSION, parseWireTransaction, resolveAccountKeys } from '../electron/chain/rpcClient';
export { decodeWalletSwap } from '../electron/engine/walletSwap';
