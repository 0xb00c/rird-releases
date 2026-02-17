/**
 * Identity - Monero Wallet Management
 *
 * Manages Monero wallet creation and balance queries via remote node RPC.
 * Does NOT require a full chain sync -- connects to a public remote node.
 *
 * Wallet generation follows the real Monero key derivation:
 *   - Random 32-byte spend private key, reduced mod l
 *   - Spend public key = spend_priv * G (Ed25519 base point)
 *   - View private key = Keccak-256(spend_priv), reduced mod l
 *   - View public key = view_priv * G
 *   - Address = base58_monero(prefix || spend_pub || view_pub || checksum)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Point } from "@noble/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletInfo {
  address: string;
  viewKey: string;
  spendKey: string;
  createdAt: number;
  testnet: boolean;
}

export interface WalletBalance {
  balance: bigint;
  unlockedBalance: bigint;
}

interface WalletConfig {
  remoteNode: string;
  testnet: boolean;
}

interface SerializedWallet {
  address: string;
  viewKey: string;
  spendKey: string;
  createdAt: number;
  testnet: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WALLET_PATH = join(homedir(), ".rird", "identity", "wallet.json");
const DEFAULT_REMOTE_NODE = "node.moneroworld.com:18089";
const TESTNET_REMOTE_NODE = "testnet.community.rino.io:28081";

// Monero address prefix bytes
const MAINNET_PREFIX = 0x12; // 18
const TESTNET_PREFIX = 0x35; // 53

// Ed25519 group order (l)
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

// Monero Base58 alphabet (same chars as Bitcoin, but different block encoding)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Full block sizes for Monero Base58 encoding
// Each 8-byte input block produces 11 Base58 characters.
// The last partial block of N bytes produces a specific number of characters.
const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;

// Mapping: input byte count -> encoded character count for partial blocks
const ENCODED_BLOCK_SIZES: Record<number, number> = {
  0: 0,
  1: 2,
  2: 3,
  3: 5,
  4: 6,
  5: 7,
  6: 9,
  7: 10,
  8: 11,
};

// ---------------------------------------------------------------------------
// Scalar reduction mod l
// ---------------------------------------------------------------------------

/**
 * Reduce a 32-byte little-endian scalar mod l (Ed25519 group order).
 * This is the sc_reduce32 operation used in Monero key derivation.
 */
function scReduce32(input: Uint8Array): Uint8Array {
  // Read 32-byte little-endian integer
  let scalar = 0n;
  for (let i = 31; i >= 0; i--) {
    scalar = (scalar << 8n) | BigInt(input[i]);
  }

  // Reduce mod l
  scalar = ((scalar % L) + L) % L;

  // Write back as 32-byte little-endian
  const result = new Uint8Array(32);
  let val = scalar;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return result;
}

/**
 * Convert a 32-byte little-endian scalar to a bigint.
 */
function scalarToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 31; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Monero Base58 encoding (block-based, NOT Bitcoin Base58)
// ---------------------------------------------------------------------------

/**
 * Encode a single block of bytes (up to 8 bytes) into Monero Base58.
 * Full 8-byte blocks produce exactly 11 characters.
 * Partial blocks produce the number of characters from ENCODED_BLOCK_SIZES.
 */
function encodeBlock(data: Uint8Array, outputSize: number): string {
  // Convert bytes to big-endian number
  let num = 0n;
  for (let i = 0; i < data.length; i++) {
    num = (num << 8n) | BigInt(data[i]);
  }

  // Convert to Base58, filling to exactly outputSize characters
  const chars: string[] = new Array(outputSize);
  for (let i = outputSize - 1; i >= 0; i--) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    chars[i] = BASE58_ALPHABET[remainder];
  }

  return chars.join("");
}

/**
 * Decode a single Monero Base58 block back to bytes.
 */
function decodeBlock(encoded: string, outputSize: number): Uint8Array {
  let num = 0n;
  for (let i = 0; i < encoded.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(encoded[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base58 character: ${encoded[i]}`);
    }
    num = num * 58n + BigInt(idx);
  }

  // Convert to big-endian bytes of the specified output size
  const result = new Uint8Array(outputSize);
  for (let i = outputSize - 1; i >= 0; i--) {
    result[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return result;
}

/**
 * Monero Base58 encode. Splits input into 8-byte blocks, encodes each
 * to 11 characters. The last block may be shorter.
 *
 * Standard Monero address = 69 raw bytes:
 *   8 full blocks (64 bytes) = 88 chars
 *   1 partial block (5 bytes) = 7 chars
 *   Total = 95 characters
 */
export function cnBase58Encode(data: Uint8Array): string {
  const fullBlocks = Math.floor(data.length / FULL_BLOCK_SIZE);
  const lastBlockSize = data.length % FULL_BLOCK_SIZE;

  let result = "";

  for (let i = 0; i < fullBlocks; i++) {
    const blockStart = i * FULL_BLOCK_SIZE;
    const block = data.slice(blockStart, blockStart + FULL_BLOCK_SIZE);
    result += encodeBlock(block, FULL_ENCODED_BLOCK_SIZE);
  }

  if (lastBlockSize > 0) {
    const lastBlock = data.slice(fullBlocks * FULL_BLOCK_SIZE);
    const encodedSize = ENCODED_BLOCK_SIZES[lastBlockSize];
    if (encodedSize === undefined) {
      throw new Error(`Invalid last block size: ${lastBlockSize}`);
    }
    result += encodeBlock(lastBlock, encodedSize);
  }

  return result;
}

/**
 * Monero Base58 decode. Reverses the block-based encoding.
 */
export function cnBase58Decode(encoded: string): Uint8Array {
  // For a standard 95-char address: 8 full blocks (88 chars) + 1 partial block (7 chars)
  // We need to figure out the raw byte length. The encoded length tells us.
  const fullEncodedBlocks = Math.floor(encoded.length / FULL_ENCODED_BLOCK_SIZE);
  const lastEncodedSize = encoded.length % FULL_ENCODED_BLOCK_SIZE;

  // Find the last block's byte size from encoded size
  let lastBlockSize = 0;
  if (lastEncodedSize > 0) {
    for (const [byteSize, encSize] of Object.entries(ENCODED_BLOCK_SIZES)) {
      if (encSize === lastEncodedSize) {
        lastBlockSize = parseInt(byteSize, 10);
        break;
      }
    }
    if (lastBlockSize === 0 && lastEncodedSize !== 0) {
      throw new Error(`Invalid encoded last block size: ${lastEncodedSize}`);
    }
  }

  const totalBytes = fullEncodedBlocks * FULL_BLOCK_SIZE + lastBlockSize;
  const result = new Uint8Array(totalBytes);

  for (let i = 0; i < fullEncodedBlocks; i++) {
    const encStart = i * FULL_ENCODED_BLOCK_SIZE;
    const encBlock = encoded.slice(encStart, encStart + FULL_ENCODED_BLOCK_SIZE);
    const decoded = decodeBlock(encBlock, FULL_BLOCK_SIZE);
    result.set(decoded, i * FULL_BLOCK_SIZE);
  }

  if (lastBlockSize > 0) {
    const encBlock = encoded.slice(fullEncodedBlocks * FULL_ENCODED_BLOCK_SIZE);
    const decoded = decodeBlock(encBlock, lastBlockSize);
    result.set(decoded, fullEncodedBlocks * FULL_BLOCK_SIZE);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Monero address construction
// ---------------------------------------------------------------------------

/**
 * Compute Keccak-256 checksum: first 4 bytes of Keccak-256(data).
 */
function addressChecksum(data: Uint8Array): Uint8Array {
  const hash = keccak_256(data);
  return hash.slice(0, 4);
}

/**
 * Build a standard Monero address from public spend and view keys.
 *
 * Format (69 bytes raw):
 *   [1 byte prefix] [32 bytes spend pub] [32 bytes view pub] [4 bytes checksum]
 *
 * Checksum = first 4 bytes of Keccak-256(prefix + spend_pub + view_pub)
 *
 * Then Monero Base58 encode -> 95 character address.
 */
function buildAddress(
  prefix: number,
  spendPub: Uint8Array,
  viewPub: Uint8Array
): string {
  // 1 + 32 + 32 = 65 bytes for checksum input
  const checksumInput = new Uint8Array(65);
  checksumInput[0] = prefix;
  checksumInput.set(spendPub, 1);
  checksumInput.set(viewPub, 33);

  const checksum = addressChecksum(checksumInput);

  // Full address data: 65 + 4 = 69 bytes
  const addressData = new Uint8Array(69);
  addressData.set(checksumInput);
  addressData.set(checksum, 65);

  return cnBase58Encode(addressData);
}

/**
 * Validate a Monero address by decoding and checking the checksum.
 */
export function validateAddress(address: string): boolean {
  try {
    const decoded = cnBase58Decode(address);
    if (decoded.length !== 69) {
      return false;
    }

    const prefix = decoded[0];
    if (prefix !== MAINNET_PREFIX && prefix !== TESTNET_PREFIX) {
      return false;
    }

    // Verify checksum
    const checksumInput = decoded.slice(0, 65);
    const expectedChecksum = addressChecksum(checksumInput);
    const actualChecksum = decoded.slice(65, 69);

    return (
      expectedChecksum[0] === actualChecksum[0] &&
      expectedChecksum[1] === actualChecksum[1] &&
      expectedChecksum[2] === actualChecksum[2] &&
      expectedChecksum[3] === actualChecksum[3]
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet creation (proper Monero key derivation)
// ---------------------------------------------------------------------------

export async function createWallet(
  config: WalletConfig = { remoteNode: DEFAULT_REMOTE_NODE, testnet: true },
  savePath: string = DEFAULT_WALLET_PATH
): Promise<WalletInfo> {
  const prefix = config.testnet ? TESTNET_PREFIX : MAINNET_PREFIX;

  // 1. Generate random 32-byte seed and reduce mod l for spend private key
  const spendPrivRaw = randomBytes(32);
  const spendPriv = scReduce32(spendPrivRaw);
  const spendPrivScalar = scalarToBigInt(spendPriv);

  // Ensure non-zero scalar (astronomically unlikely, but be safe)
  if (spendPrivScalar === 0n) {
    throw new Error("Generated zero spend key, please retry");
  }

  // 2. Derive spend public key: spend_priv * G
  const spendPubPoint = Point.BASE.multiply(spendPrivScalar);
  const spendPub = spendPubPoint.toRawBytes();

  // 3. Derive view private key: Keccak-256(spend_priv), reduced mod l
  const viewPrivRaw = keccak_256(spendPriv);
  const viewPriv = scReduce32(viewPrivRaw);
  const viewPrivScalar = scalarToBigInt(viewPriv);

  if (viewPrivScalar === 0n) {
    throw new Error("Derived zero view key, please retry");
  }

  // 4. Derive view public key: view_priv * G
  const viewPubPoint = Point.BASE.multiply(viewPrivScalar);
  const viewPub = viewPubPoint.toRawBytes();

  // 5. Build address with Monero Base58 encoding and Keccak-256 checksum
  const address = buildAddress(prefix, spendPub, viewPub);

  const wallet: WalletInfo = {
    address,
    viewKey: Buffer.from(viewPriv).toString("hex"),
    spendKey: Buffer.from(spendPriv).toString("hex"),
    createdAt: Math.floor(Date.now() / 1000),
    testnet: config.testnet,
  };

  // Save wallet
  const dir = dirname(savePath);
  await mkdir(dir, { recursive: true });

  const serialized: SerializedWallet = { ...wallet };
  await writeFile(savePath, JSON.stringify(serialized, null, 2), {
    mode: 0o600,
  });

  console.log(`[wallet] Created new ${config.testnet ? "testnet" : "mainnet"} wallet`);
  console.log(`[wallet] Address: ${address.slice(0, 20)}...`);

  return wallet;
}

// ---------------------------------------------------------------------------
// Wallet loading
// ---------------------------------------------------------------------------

export async function loadWallet(
  path: string = DEFAULT_WALLET_PATH
): Promise<WalletInfo | null> {
  if (!existsSync(path)) {
    return null;
  }

  const raw = await readFile(path, "utf-8");
  const serialized: SerializedWallet = JSON.parse(raw);

  return {
    address: serialized.address,
    viewKey: serialized.viewKey,
    spendKey: serialized.spendKey,
    createdAt: serialized.createdAt,
    testnet: serialized.testnet,
  };
}

export async function loadOrCreateWallet(
  config: WalletConfig = { remoteNode: DEFAULT_REMOTE_NODE, testnet: true },
  path: string = DEFAULT_WALLET_PATH
): Promise<WalletInfo> {
  const existing = await loadWallet(path);
  if (existing) {
    return existing;
  }
  return createWallet(config, path);
}

// ---------------------------------------------------------------------------
// Balance queries via JSON-RPC to remote node
// ---------------------------------------------------------------------------

export async function getBalance(
  wallet: WalletInfo,
  remoteNode: string = DEFAULT_REMOTE_NODE
): Promise<WalletBalance> {
  const url = formatNodeUrl(remoteNode, wallet.testnet);

  try {
    const response = await fetch(`${url}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "0",
        method: "get_balance",
        params: {
          account_index: 0,
          address_indices: [0],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      result?: { balance: number; unlocked_balance: number };
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`RPC error: ${data.error.message}`);
    }

    return {
      balance: BigInt(data.result?.balance || 0),
      unlockedBalance: BigInt(data.result?.unlocked_balance || 0),
    };
  } catch (err) {
    console.error(`[wallet] Failed to query balance: ${err}`);
    return { balance: 0n, unlockedBalance: 0n };
  }
}

export async function getAddress(wallet: WalletInfo): Promise<string> {
  return wallet.address;
}

// ---------------------------------------------------------------------------
// XMR formatting
// ---------------------------------------------------------------------------

const PICONERO_FACTOR = 1_000_000_000_000n;

export function formatXmr(piconeros: bigint): string {
  const whole = piconeros / PICONERO_FACTOR;
  const frac = piconeros % PICONERO_FACTOR;
  const fracStr = frac.toString().padStart(12, "0");
  return `${whole}.${fracStr.slice(0, 6)}`;
}

export function parseXmr(xmrStr: string): bigint {
  const parts = xmrStr.split(".");
  const whole = BigInt(parts[0] || "0") * PICONERO_FACTOR;
  if (parts.length === 1) return whole;

  const fracStr = (parts[1] || "0").padEnd(12, "0").slice(0, 12);
  return whole + BigInt(fracStr);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNodeUrl(node: string, testnet: boolean): string {
  const nodeAddr = testnet ? TESTNET_REMOTE_NODE : node;
  if (nodeAddr.startsWith("http")) return nodeAddr;
  return `http://${nodeAddr}`;
}
