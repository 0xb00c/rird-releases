# Decentralized AI Agent Protocol -- Technical Research

Compiled 2026-02-16. Covers libp2p networking, Tor integration, cryptographic identity, Monero payments, ActivityPub federation, and local storage for building a decentralized AI agent protocol.

---

## Table of Contents

1. [libp2p JavaScript](#1-libp2p-javascript)
2. [Tor from Node.js](#2-tor-from-nodejs)
3. [Identity and Crypto](#3-identity-and-crypto)
4. [Monero](#4-monero)
5. [ActivityPub (Self-Hosted Per Agent)](#5-activitypub-self-hosted-per-agent)
6. [Storage](#6-storage)

---

## 1. libp2p JavaScript

### 1.1 Current npm Packages and Versions

| Package | Version | Purpose |
|---------|---------|---------|
| `libp2p` | 3.1.3 | Core library |
| `@libp2p/tcp` | 11.0.7 | TCP transport |
| `@libp2p/websockets` | 10.0.0 | WebSocket transport |
| `@chainsafe/libp2p-noise` | latest | Noise Protocol encryption |
| `@libp2p/yamux` | 8.0.1 | Yamux stream multiplexer |
| `@chainsafe/libp2p-gossipsub` | latest | Gossipsub pubsub |
| `@libp2p/kad-dht` | latest | Kademlia DHT |
| `@libp2p/mdns` | latest | mDNS LAN discovery |
| `@libp2p/bootstrap` | latest | Bootstrap/seed peers |

Install all core packages:

```bash
npm install libp2p @libp2p/tcp @libp2p/websockets @chainsafe/libp2p-noise \
  @libp2p/yamux @chainsafe/libp2p-gossipsub @libp2p/kad-dht \
  @libp2p/mdns @libp2p/bootstrap
```

### 1.2 Full Node Configuration

```typescript
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@libp2p/yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { kadDHT } from '@libp2p/kad-dht'
import { mdns } from '@libp2p/mdns'
import { bootstrap } from '@libp2p/bootstrap'

const node = await createLibp2p({
  addresses: {
    listen: [
      '/ip4/0.0.0.0/tcp/9000',
      '/ip4/0.0.0.0/tcp/9001/ws'
    ]
  },
  transports: [tcp(), webSockets()],
  streamMuxers: [yamux()],
  connectionEncrypters: [noise()],
  peerDiscovery: [
    mdns({
      interval: 10000,        // query every 10s
      serviceTag: 'agent-net' // custom service name
    }),
    bootstrap({
      list: [
        '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
        // ... additional seed peers
      ],
      timeout: 1000,
      tagTTL: 120000  // 2 minutes, set to Infinity for persistent connections
    })
  ],
  services: {
    dht: kadDHT({
      // clientMode: true  // set for light nodes that don't serve DHT queries
    }),
    pubsub: gossipsub({
      emitSelf: false,            // don't echo own messages
      gossipIncoming: true,       // automatically gossip incoming subscribed messages
      fallbackToFloodsub: true,   // fallback if peer doesn't support gossipsub
      floodPublish: true,         // send self-published to all peers
      doPX: false,                // enable only on well-connected bootstrap nodes
      // seenTTL: 120000,         // message dedup window (default ~2 minutes)
      // mcacheLength: 5,         // number of history windows in message cache
      // mcacheGossip: 3,         // number of history windows to gossip about
    })
  },
  connectionManager: {
    maxConnections: 100,               // total connection limit (default 100)
    maxIncomingPendingConnections: 100  // pending unupgraded connections
  }
})

await node.start()
console.log('Peer ID:', node.peerId.toString())
console.log('Listening on:', node.getMultiaddrs().map(ma => ma.toString()))
```

### 1.3 Gossipsub Topic Configuration and Message Propagation

```typescript
// Subscribe to a topic
const topic = 'agent/tasks/v1'
node.services.pubsub.subscribe(topic)

// Listen for messages
node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic === topic) {
    const data = new TextDecoder().decode(evt.detail.data)
    console.log(`From ${evt.detail.from}: ${data}`)
  }
})

// Publish a message
const msg = new TextEncoder().encode(JSON.stringify({
  type: 'task_offer',
  agentId: node.peerId.toString(),
  task: 'web-scrape',
  price: 0.001,
  timestamp: Date.now()
}))
await node.services.pubsub.publish(topic, msg)
```

**Message TTL and Deduplication:**

- Gossipsub uses a `seenTTL` parameter (default ~120 seconds) to deduplicate messages. Messages seen within this window are dropped.
- There is no per-message TTL field in the gossipsub spec. Application-level TTL must be implemented by including a timestamp in the message body and having receivers discard expired messages.
- The message cache (`mcache`) stores recent messages for IWANT/IHAVE gossip exchanges. Configure `mcacheLength` (number of heartbeat windows, default 5) and `mcacheGossip` (windows to gossip about, default 3).

**Gotcha:** Gossipsub does not guarantee message ordering or delivery. For reliable delivery, implement application-level acknowledgments.

### 1.4 Direct Streams for Private Peer-to-Peer Messages

libp2p supports custom protocol handlers for direct, encrypted, bidirectional streams between two specific peers:

```typescript
// Define a custom protocol
const DM_PROTOCOL = '/agent/dm/1.0.0'

// Register handler on receiving node
await node.handle(DM_PROTOCOL, async ({ stream, connection }) => {
  const peerId = connection.remotePeer.toString()

  // Read incoming data
  const chunks: Uint8Array[] = []
  for await (const chunk of stream.source) {
    chunks.push(chunk.subarray())
  }
  const message = new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap(c => [...c]))
  )
  console.log(`DM from ${peerId}: ${message}`)

  // Optionally write a response
  const response = new TextEncoder().encode('ACK')
  await stream.sink([response])
}, {
  maxInboundStreams: 32,
  maxOutboundStreams: 32
})

// Send a direct message to a specific peer
async function sendDirectMessage(targetPeerId: string, message: string) {
  const stream = await node.dialProtocol(targetPeerId, DM_PROTOCOL)
  const data = new TextEncoder().encode(message)
  await stream.sink([data])

  // Read response
  const chunks: Uint8Array[] = []
  for await (const chunk of stream.source) {
    chunks.push(chunk.subarray())
  }
  return new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap(c => [...c]))
  )
}
```

**Key point:** All libp2p streams are encrypted via Noise protocol by default. The stream is a raw bidirectional binary channel -- the application defines the wire format (protobuf, JSON, etc.).

### 1.5 mDNS for LAN Peer Discovery

```typescript
import { mdns } from '@libp2p/mdns'

// Configuration options:
const mdnsConfig = mdns({
  // peerName: 'custom-name',  // announce name (default: random)
  broadcast: true,              // announce presence (default: false)
  interval: 10000,              // query interval ms (default: 10000)
  serviceTag: 'agent-mesh'      // service name (default: 'ipfs.local')
})

// Listen for discovered peers
node.addEventListener('peer:discovery', (evt) => {
  console.log('Discovered LAN peer:', evt.detail.id.toString())
  // Peers are automatically added to the peer store
  // Connection manager will dial them if needed
})
```

**Limitation:** mDNS only works on the local network. For WAN discovery, combine with DHT and/or bootstrap peers.

### 1.6 Bootstrap/Seed Peer Mechanisms

```typescript
import { bootstrap } from '@libp2p/bootstrap'

const bootstrapConfig = bootstrap({
  list: [
    // Multiaddr format: /ip4/<IP>/tcp/<PORT>/p2p/<PEER_ID>
    '/ip4/seed1.example.com/tcp/9000/p2p/12D3KooW...',
    '/ip4/seed2.example.com/tcp/9000/p2p/12D3KooW...',
    // Can also use DNS:
    '/dns4/seed.agent-network.onion/tcp/9000/p2p/12D3KooW...',
  ],
  timeout: 3000,    // discovery timeout ms
  tagName: 'bootstrap',
  tagValue: 50,     // peer priority (higher = less likely to be pruned)
  tagTTL: 120000    // tag expiry ms; set Infinity for permanent connections
})
```

**Bootstrap strategy:**
- Bootstrap peers are discovered after `timeout` and added to the peer store.
- They are tagged with `tagValue: 50` by default. When `maxConnections` is reached, lower-tagged peers are pruned first.
- For browser nodes that need persistent bootstrap connections, set `tagTTL: Infinity`.
- Combine with Kademlia DHT for organic peer discovery after initial bootstrap.

### 1.7 Performance: Max Peer Connections

**Default limits (js-libp2p):**
- `maxConnections`: **100** (combined inbound + outbound)
- `maxIncomingPendingConnections`: **100** (unupgraded connections)
- `inboundConnectionThreshold`: Rate limit per peer per second

**Practical limits for a JS node:**
- A Node.js process can comfortably handle **200-500 connections** with moderate message rates.
- Each connection uses ~50-100KB of memory (Noise handshake buffers, stream state).
- At 500 connections with active gossipsub, expect **~200-500MB RSS** memory usage.
- CPU becomes the bottleneck before memory for message-heavy workloads (signature verification, encryption).
- For a lightweight agent node, **50-100 connections** is recommended as a safe operating range.

**Tuning recommendations:**
```typescript
connectionManager: {
  maxConnections: 300,               // aggressive for a relay/seed node
  maxIncomingPendingConnections: 50,  // reduce if under DoS
  // Peer prioritization via tags:
  // Higher tag values = higher priority = last to be pruned
}
```

### 1.8 Routing libp2p Over Tor (SOCKS Proxy Transport)

**Status:** There is NO official SOCKS5/Tor transport for js-libp2p. The Rust implementation has `rust-libp2p-tokio-socks5`, but JavaScript requires a custom approach.

**Custom approach -- wrapping TCP transport through SOCKS5:**

```typescript
import { SocksClient } from 'socks'
import net from 'node:net'

// Custom transport that routes TCP through Tor's SOCKS5 proxy
async function dialThroughTor(host: string, port: number): Promise<net.Socket> {
  const info = await SocksClient.createConnection({
    proxy: {
      host: '127.0.0.1',
      port: 9050,  // Tor SOCKS5 port
      type: 5
    },
    command: 'connect',
    destination: { host, port }
  })
  return info.socket
}

// For .onion addresses, the Tor daemon resolves them internally.
// You would need to implement a custom libp2p Transport class
// that uses SocksClient instead of raw TCP connections.
```

**Known limitations:**
- js-libp2p's transport interface expects specific multiaddr patterns; `.onion` addresses are not natively supported.
- You must write a custom `Transport` implementation that wraps the SOCKS5 dial.
- UDP-based transports (QUIC, WebRTC) cannot traverse Tor.
- Latency increases significantly (300-800ms per hop through Tor).
- The Rust implementation (`comit-network/rust-libp2p-tokio-socks5`) provides a reference for how to build this.

---

## 2. Tor from Node.js

### 2.1 Key npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `granax` / `@deadcanaries/granax` | 3.2.x | Tor Control Protocol client; spawns bundled Tor |
| `socks` | 2.8.x | SOCKS4/4a/5 client (for outbound via Tor) |
| `socks-proxy-agent` | 8.0.5 | http.Agent for routing fetch/got through SOCKS5 |
| `tor-request` | latest | Simple wrapper for HTTP requests over Tor |
| `tor-router` | 4.0.x | Multi-instance Tor with round-robin SOCKS proxy |
| `proxysocket` | latest | Socket connections via SOCKS5 |

### 2.2 Spawning Tor Subprocess

**Using granax (self-contained Tor):**

```typescript
// granax bundles the Tor binary -- downloads Tor Browser Bundle on npm install
// On Linux, set GRANAX_USE_SYSTEM_TOR=1 to use system-installed tor
const tor = require('@deadcanaries/granax')()

tor.on('ready', () => {
  console.log('Tor is ready')
  console.log('SOCKS port:', tor.socksPort)   // typically 9050
  console.log('Control port:', tor.controlPort)
})

tor.on('error', (err: Error) => {
  console.error('Tor error:', err)
})
```

**Using system Tor manually:**

```typescript
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Ensure torrc has: ControlPort 9051, SocksPort 9050
const torProcess = spawn('tor', ['-f', '/etc/tor/torrc'], {
  stdio: ['ignore', 'pipe', 'pipe']
})

torProcess.stdout.on('data', (data: Buffer) => {
  const line = data.toString()
  if (line.includes('Bootstrapped 100%')) {
    console.log('Tor fully bootstrapped')
  }
})
```

### 2.3 Creating .onion Hidden Services Programmatically (v3)

```typescript
import http from 'node:http'

const tor = require('@deadcanaries/granax')()

tor.on('ready', () => {
  // Start a local HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', agent: 'my-agent-id' }))
  })
  server.listen(8080, '127.0.0.1')

  // Create a v3 hidden service pointing to our local server
  tor.createHiddenService('127.0.0.1:8080', (err: Error, result: any) => {
    if (err) throw err

    // result.serviceId = the .onion address (without .onion suffix)
    // result.privateKey = the ed25519 private key for the service
    console.log(`Hidden service: ${result.serviceId}.onion`)
    console.log(`Private key: ${result.privateKey}`)

    // IMPORTANT: Save the private key to recreate the same .onion address later
    // The .onion address is derived from the ed25519 public key
  })
})
```

**v3 onion address details:**
- v3 addresses are 56 characters (base32-encoded ed25519 public key + version byte + checksum).
- The private key is an ed25519 key pair.
- Addresses look like: `vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion`

### 2.4 Serving HTTP Over .onion

```typescript
import http from 'node:http'
import express from 'express'

const app = express()

// ActivityPub endpoints served over .onion
app.get('/.well-known/webfinger', (req, res) => {
  // ... WebFinger response
})

app.get('/actor', (req, res) => {
  // ... Actor JSON
})

app.post('/inbox', (req, res) => {
  // ... Handle incoming AP activities
})

// Bind to localhost only -- Tor handles external routing
const server = http.createServer(app)
server.listen(8080, '127.0.0.1', () => {
  console.log('HTTP server on 127.0.0.1:8080')
  // Then create hidden service pointing to 127.0.0.1:8080
})
```

### 2.5 SOCKS5 Proxy for Outbound Connections

```typescript
import { SocksProxyAgent } from 'socks-proxy-agent'

// Create an agent that routes through Tor
const torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050')
// Note: socks5h means DNS resolution happens on the SOCKS server (Tor)
// This is critical for .onion address resolution

// Use with fetch (Node 18+)
const response = await fetch('http://example.onion/api/status', {
  agent: torAgent
})

// Use with the 'socks' package directly for raw TCP
import { SocksClient } from 'socks'

const connection = await SocksClient.createConnection({
  proxy: {
    host: '127.0.0.1',
    port: 9050,
    type: 5
  },
  command: 'connect',
  destination: {
    host: 'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion',
    port: 80
  }
})

// connection.socket is a regular net.Socket tunneled through Tor
connection.socket.write('GET / HTTP/1.1\r\nHost: example.onion\r\n\r\n')
```

### 2.6 Known Limitations and Gotchas

- **granax on Linux:** Set `GRANAX_USE_SYSTEM_TOR=1` to avoid downloading the full Tor Browser Bundle (~80MB). System Tor is lighter.
- **Cookie auth:** If using system Tor, the Node.js process must have read access to `/var/lib/tor/control_auth_cookie`. Run as the same user as Tor or add to the `debian-tor` group.
- **Port conflicts:** If Tor is already running system-wide, granax will fail to bind its control port. Use `HashedControlPassword` in torrc for shared access.
- **Hidden service startup:** It takes 30-120 seconds for a new hidden service to be published to the Tor network and become reachable.
- **No UDP:** Tor only supports TCP. WebRTC, QUIC, and UDP-based protocols will not work.
- **Bandwidth:** Tor circuits are slow (typically 1-5 Mbps) with high latency (200-800ms RTT). Design protocols accordingly.
- **DNS leaks:** Always use `socks5h://` (not `socks5://`) so DNS resolution happens inside Tor, not locally.

---

## 3. Identity and Crypto

### 3.1 npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `@noble/ed25519` | 2.x | Standalone 5KB ed25519 (sign/verify) |
| `@noble/curves` | latest | Full curve library (ed25519, secp256k1, etc.) |
| `@noble/hashes` | 2.0.1 | SHA, BLAKE2, BLAKE3, Keccak, HMAC, HKDF, etc. |

All noble libraries are audited (6 audits total), zero-dependency, and pure JavaScript.

### 3.2 Ed25519 Keypair Generation, Signing, Verification

```typescript
import { ed25519 } from '@noble/curves/ed25519'
import { randomBytes } from '@noble/hashes/utils'

// --- Generate keypair ---
const privateKey = randomBytes(32)  // 32 bytes of cryptographic randomness
const publicKey = ed25519.getPublicKey(privateKey)

console.log('Private key:', Buffer.from(privateKey).toString('hex'))
console.log('Public key:', Buffer.from(publicKey).toString('hex'))

// --- Sign a message ---
const message = new TextEncoder().encode('task-offer:web-scrape:0.001xmr')
const signature = ed25519.sign(message, privateKey)

// --- Verify a signature ---
const isValid = ed25519.verify(signature, message, publicKey)
console.log('Signature valid:', isValid)  // true

// --- Using the standalone @noble/ed25519 package (smaller, 5KB) ---
import * as ed from '@noble/ed25519'

// Same API but requires setting sha512 sync function:
import { sha512 } from '@noble/hashes/sha2'
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))

const privKey = ed.utils.randomPrivateKey()
const pubKey = ed.getPublicKeySync(privKey)
const sig = ed.signSync(message, privKey)
const valid = ed.verifySync(sig, message, pubKey)
```

### 3.3 BLAKE3 Hashing

```typescript
import { blake3 } from '@noble/hashes/blake3'

// Basic hashing
const data = new TextEncoder().encode('agent-identity-payload')
const hash = blake3(data)
console.log('BLAKE3:', Buffer.from(hash).toString('hex'))
// Output: 32-byte hash as Uint8Array

// Streaming / incremental hashing (for large data)
import { blake3 as Blake3 } from '@noble/hashes/blake3'
const hasher = Blake3.create({})
hasher.update(new TextEncoder().encode('chunk1'))
hasher.update(new TextEncoder().encode('chunk2'))
const digest = hasher.digest()

// Key derivation with context
// blake3 supports a keyed mode and a derive_key mode
import { blake3 as blake3Hash } from '@noble/hashes/blake3'
// For keyed hashing, pass a 32-byte key:
const key = randomBytes(32)
const mac = blake3Hash(data, { key })
```

**Important:** BLAKE3 in @noble/hashes has NOT been audited (the audit covers SHA, BLAKE2, RIPEMD, HMAC, HKDF, PBKDF2, Scrypt but explicitly excludes blake3, sha3-addons, sha1, and argon2). For security-critical applications, consider using audited BLAKE2b instead:

```typescript
import { blake2b } from '@noble/hashes/blake2b'
const hash = blake2b(data, { dkLen: 32 })  // 32-byte output
```

### 3.4 Deriving Monero Wallet Keys from Ed25519 Seed

Monero uses a variant of Ed25519 on the Twisted Edwards curve. The key derivation process:

1. **Private spend key** = the 32-byte seed (reduced mod l, the curve order)
2. **Private view key** = Keccak-256(private_spend_key), then reduced mod l
3. **Public spend key** = private_spend_key * G (ed25519 base point multiplication)
4. **Public view key** = private_view_key * G

```typescript
import { keccak_256 } from '@noble/hashes/sha3'
import { ed25519 } from '@noble/curves/ed25519'

// WARNING: Monero uses a DIFFERENT ed25519 curve cofactor handling than standard
// ed25519. The scalar reduction step is critical. This is a SIMPLIFIED illustration.
// For production, use monero-ts or a dedicated Monero crypto library.

function scalarReduce32(scalar: Uint8Array): Uint8Array {
  // Reduce a 32-byte scalar modulo the curve order l
  // l = 2^252 + 27742317777372353535851937790883648493
  // This requires big-integer arithmetic
  // In practice, use monero-ts's built-in functions
  const ed = ed25519.CURVE
  const num = BigInt('0x' + Buffer.from(scalar).reverse().toString('hex'))
  const reduced = num % ed.n
  const bytes = new Uint8Array(32)
  let r = reduced
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(r & 0xffn)
    r >>= 8n
  }
  return bytes
}

// Step 1: Generate or import a 32-byte seed
const seed = randomBytes(32)

// Step 2: Private spend key = seed reduced mod l
const privateSpendKey = scalarReduce32(seed)

// Step 3: Private view key = Keccak256(private_spend_key) reduced mod l
const viewKeyHash = keccak_256(privateSpendKey)
const privateViewKey = scalarReduce32(viewKeyHash)

// Step 4: Public keys via scalar multiplication
const publicSpendKey = ed25519.getPublicKey(privateSpendKey)
const publicViewKey = ed25519.getPublicKey(privateViewKey)

// Step 5: Monero address = base58(prefix + publicSpendKey + publicViewKey + checksum)
// Mainnet prefix: 0x12
// The checksum is first 4 bytes of Keccak256(prefix + pubSpend + pubView)
```

**CRITICAL CAVEAT:** Monero's ed25519 implementation differs from standard ed25519 in subtle ways (scalar clamping, cofactor handling). The above is illustrative. For production use:
- Use `monero-ts` which includes proper WebAssembly bindings to the official Monero C++ crypto.
- Or use the `monero-wallet-rpc` approach where the daemon handles all key derivation.

### 3.5 Key Storage Best Practices

```typescript
import { scrypt } from '@noble/hashes/scrypt'
import { randomBytes } from '@noble/hashes/utils'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'

// Encrypt a private key for storage
function encryptKey(privateKey: Uint8Array, passphrase: string): {
  salt: Uint8Array
  nonce: Uint8Array
  encrypted: Uint8Array
} {
  const salt = randomBytes(32)
  const nonce = randomBytes(24)  // xchacha20 uses 24-byte nonce

  // Derive encryption key from passphrase
  const derivedKey = scrypt(
    new TextEncoder().encode(passphrase),
    salt,
    { N: 2 ** 18, r: 8, p: 1, dkLen: 32 }  // ~1 second on modern hardware
  )

  // Encrypt with XChaCha20-Poly1305
  const cipher = xchacha20poly1305(derivedKey, nonce)
  const encrypted = cipher.encrypt(privateKey)

  return { salt, nonce, encrypted }
}

// Storage locations (XDG Base Directory spec):
// Linux:   ~/.local/share/agent-protocol/keys/
// macOS:   ~/Library/Application Support/agent-protocol/keys/
// Windows: %APPDATA%/agent-protocol/keys/
```

**Recommendations:**
- Never store unencrypted private keys on disk.
- Use scrypt (not bcrypt) for passphrase-based key derivation -- it is memory-hard.
- Store encrypted keys in the XDG data directory (`$XDG_DATA_HOME/agent-protocol/`).
- For ephemeral agent sessions, keep keys only in memory and derive per-session.
- Back up the seed phrase; all keys are deterministically derivable from it.

---

## 4. Monero

### 4.1 npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `monero-ts` | latest | Full TypeScript library (RPC + WASM bindings to monero v0.18.4.4) |
| `monero-javascript` | legacy | Predecessor to monero-ts (same author) |

`monero-ts` is the recommended package. It supports:
- Wallet RPC client (`MoneroWalletRpc`)
- Full wallet via WebAssembly (`MoneroWalletFull`)
- Keys-only wallet (`MoneroWalletKeys`) -- lightest, no network needed
- View-only wallets
- Multisig wallets
- Daemon RPC client
- 300+ passing Mocha tests

### 4.2 Basic Usage with monero-ts

```typescript
import * as moneroTs from 'monero-ts'

// --- Connect to wallet RPC ---
const walletRpc = await moneroTs.connectToWalletRpc(
  'http://localhost:28084',  // monero-wallet-rpc address
  'rpc_user',
  'rpc_password'
)

// Create a new wallet
await walletRpc.createWallet({
  path: 'agent-wallet',
  password: 'strong-passphrase',
  language: 'English'
})

// Or open an existing wallet
await walletRpc.openWallet('agent-wallet', 'strong-passphrase')

// Get address
const address = await walletRpc.getPrimaryAddress()
console.log('Monero address:', address)

// Get balance
const balance = await walletRpc.getBalance()
console.log('Balance:', moneroTs.GenUtils.toString(balance))

// Send XMR
const tx = await walletRpc.createTx({
  accountIndex: 0,
  address: 'recipient-monero-address...',
  amount: BigInt('100000000000')  // in atomic units (1 XMR = 1e12)
})
await walletRpc.relayTx(tx)

// --- Keys-only wallet (no network, no sync) ---
const keysWallet = await moneroTs.createWalletKeys({
  networkType: moneroTs.MoneroNetworkType.MAINNET,
  language: 'English'
})
const seed = await keysWallet.getSeed()
const spendKey = await keysWallet.getPrivateSpendKey()
const viewKey = await keysWallet.getPrivateViewKey()
```

### 4.3 Remote Public Nodes

Public remote nodes allow wallet operation without running a full node (180+ GB blockchain):

| Node | Address | Notes |
|------|---------|-------|
| MoneroWorld | `node.moneroworld.com:18089` | Load-balanced community nodes |
| xmr.ditatompel.com | Check list at site | Curated node list |
| nodes.monero.com | Check list at site | Another aggregator |
| monero.fail | Check list at site | Most comprehensive list |

```typescript
// Connect wallet RPC to a remote daemon
// Start monero-wallet-rpc with:
// monero-wallet-rpc --daemon-address node.moneroworld.com:18089 \
//   --rpc-bind-port 28084 --rpc-login user:pass --wallet-dir /wallets

// Or use monero-ts's full wallet (WASM) with remote daemon
const wallet = await moneroTs.createWalletFull({
  path: 'agent-wallet',
  password: 'passphrase',
  networkType: moneroTs.MoneroNetworkType.MAINNET,
  server: {
    uri: 'http://node.moneroworld.com:18089'
  }
})
```

**Privacy warning:** Remote nodes can see your IP and which transactions you're interested in. For maximum privacy:
- Run your own node, or
- Route connections through Tor: `monero-wallet-rpc --proxy 127.0.0.1:9050`

### 4.4 Wallet Creation Without Full Chain Sync

Three approaches, from lightest to heaviest:

**1. Keys-only wallet (no sync needed):**
```typescript
const wallet = await moneroTs.createWalletKeys({
  networkType: moneroTs.MoneroNetworkType.MAINNET,
  language: 'English'
})
// Can generate addresses, sign messages, but cannot check balance or send
```

**2. View-only wallet (partial sync):**
```typescript
const wallet = await moneroTs.createWalletFull({
  path: 'view-only-wallet',
  password: 'pass',
  networkType: moneroTs.MoneroNetworkType.MAINNET,
  primaryAddress: 'monero-address...',
  privateViewKey: 'hex-view-key...',
  server: { uri: 'http://node.moneroworld.com:18089' },
  restoreHeight: 3000000  // skip scanning old blocks
})
// Can see incoming funds but cannot spend
```

**3. RPC wallet with `restoreHeight`:**
```typescript
await walletRpc.createWallet({
  path: 'fresh-wallet',
  password: 'pass',
  restoreHeight: 3100000  // start from recent block
})
// Only syncs from the specified height forward -- minutes instead of hours
```

### 4.5 Time-Locked Transactions for Escrow Patterns

Monero's `unlock_time` field allows time-locking transaction outputs:

```typescript
// Send with unlock_time (funds locked until block height or timestamp)
const tx = await walletRpc.createTx({
  accountIndex: 0,
  address: 'recipient-address...',
  amount: BigInt('500000000000'),  // 0.5 XMR
  // unlock_time < 500,000,000 = block height
  // unlock_time >= 500,000,000 = Unix timestamp
  unlockTime: 3200000  // locked until block 3,200,000
})
```

**MAJOR LIMITATIONS of unlock_time for escrow:**
- `unlock_time` locks ALL outputs of the transaction (including change sent back to sender).
- There is no "conditional release" -- once the timelock expires, the recipient can spend unconditionally.
- `unlock_time` is visible on-chain, reducing privacy.
- The Monero community has discussed deprecating/removing unlock_time due to privacy concerns.
- It cannot implement "release on condition X" -- it is purely time-based.

**Better escrow approach -- 2-of-3 Multisig:**

```typescript
// 2-of-3 multisig: Buyer + Seller + Arbiter
// Any 2 of 3 can sign a transaction

// Step 1: Each party creates a wallet
const buyerWallet = await moneroTs.createWalletFull({ /* ... */ })
const sellerWallet = await moneroTs.createWalletFull({ /* ... */ })
const arbiterWallet = await moneroTs.createWalletFull({ /* ... */ })

// Step 2: Prepare multisig on each wallet
const buyerPrep = await buyerWallet.prepareMultisig()
const sellerPrep = await sellerWallet.prepareMultisig()
const arbiterPrep = await arbiterWallet.prepareMultisig()

// Step 3: Exchange preparation hex and make multisig
// Each wallet receives the OTHER two parties' prep hex
await buyerWallet.makeMultisig(
  [sellerPrep, arbiterPrep],
  2,   // threshold
  ''   // password
)
await sellerWallet.makeMultisig(
  [buyerPrep, arbiterPrep],
  2,
  ''
)
await arbiterWallet.makeMultisig(
  [buyerPrep, sellerPrep],
  2,
  ''
)

// Step 4: Exchange multisig info for finalization
// (Required for M-of-N where M != N)
const buyerInfo = await buyerWallet.exchangeMultisigKeys(
  [await sellerWallet.getMultisigHex(), await arbiterWallet.getMultisigHex()],
  ''
)
// ... repeat for other wallets

// Step 5: Fund the multisig address
// Buyer sends XMR to the multisig address

// Step 6: To release funds, any 2 parties create and co-sign a tx
// e.g., Buyer + Seller agree:
const txHex = await buyerWallet.createTx({ /* to seller */ })
// Send txHex to seller for co-signing
const signedTx = await sellerWallet.signMultisigTxHex(txHex)
await sellerWallet.submitMultisigTxHex(signedTx)
```

### 4.6 Testnet Setup

```bash
# Start testnet daemon
monerod --testnet --rpc-bind-port 28081 --data-dir ~/.monero-testnet

# Start testnet wallet RPC
monero-wallet-rpc --testnet \
  --daemon-address 127.0.0.1:28081 \
  --rpc-bind-port 28084 \
  --rpc-login user:pass \
  --wallet-dir /tmp/test-wallets

# Mine blocks to get testnet XMR (solo mine on testnet)
# In monero-wallet-cli --testnet:
# start_mining <address> 1
```

```typescript
// Connect monero-ts to testnet
const wallet = await moneroTs.connectToWalletRpc(
  'http://localhost:28084', 'user', 'pass'
)
// All operations work identically to mainnet
```

**Stagenet** is an alternative to testnet that more closely mirrors mainnet behavior:
```bash
monerod --stagenet --rpc-bind-port 38081
monero-wallet-rpc --stagenet --daemon-address 127.0.0.1:38081 --rpc-bind-port 38084
```

### 4.7 Minimum Viable Escrow

For a decentralized AI agent protocol, the simplest viable escrow:

1. **Buyer** and **seller** agent each generate keys.
2. Create a **2-of-2 multisig** wallet (simplest -- no arbiter needed for happy path).
3. Buyer funds the multisig address.
4. Seller performs the task.
5. **Happy path:** Buyer co-signs release to seller.
6. **Dispute:** Without an arbiter, funds are stuck. For dispute resolution, use **2-of-3** with a network-elected arbiter node.

**Time-bounded escrow** (hybrid approach):
- Use 2-of-2 multisig for the escrow wallet.
- Buyer pre-signs a time-locked refund transaction (returns funds to buyer after N blocks).
- Seller must complete the task and get buyer's co-signature before the refund timelock expires.
- If the seller disappears, buyer gets automatic refund after timeout.

**Cost:** Each Monero transaction costs approximately 0.0001-0.001 XMR in fees (~$0.01-0.10 at current rates).

---

## 5. ActivityPub (Self-Hosted Per Agent)

### 5.1 Minimum Viable AP Actor from a Node.js Process

An agent needs four HTTP endpoints to participate in the Fediverse:

1. `/.well-known/webfinger` -- account discovery
2. `/actor` (or `/users/<name>`) -- actor profile
3. `/outbox` -- list of activities
4. `/inbox` -- receive activities from other servers

### 5.2 WebFinger Endpoint

```typescript
import express from 'express'
const app = express()

const DOMAIN = 'agent123.example.com'
// or for .onion: 'abc123xyz.onion'
const ACTOR_URL = `https://${DOMAIN}/actor`

app.get('/.well-known/webfinger', (req, res) => {
  const resource = req.query.resource as string

  if (resource !== `acct:agent@${DOMAIN}`) {
    return res.status(404).json({ error: 'Not found' })
  }

  res.setHeader('Content-Type', 'application/jrd+json')
  res.json({
    subject: `acct:agent@${DOMAIN}`,
    aliases: [ACTOR_URL],
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: ACTOR_URL
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `https://${DOMAIN}/`
      }
    ]
  })
})
```

### 5.3 Actor Endpoint

```typescript
import crypto from 'node:crypto'

// Generate RSA keypair for HTTP signatures
// NOTE: Mastodon requires RSA-SHA256 (not Ed25519 yet)
const { publicKey: pubKeyPem, privateKey: privKeyPem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

app.get('/actor', (req, res) => {
  res.setHeader('Content-Type', 'application/activity+json')
  res.json({
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1'
    ],
    id: ACTOR_URL,
    type: 'Service',  // 'Service' for bots/agents, 'Person' for humans
    preferredUsername: 'agent',
    name: 'AI Agent #123',
    summary: 'Autonomous AI agent offering web scraping services',
    inbox: `https://${DOMAIN}/inbox`,
    outbox: `https://${DOMAIN}/outbox`,
    followers: `https://${DOMAIN}/followers`,
    following: `https://${DOMAIN}/following`,
    url: `https://${DOMAIN}/`,
    publicKey: {
      id: `${ACTOR_URL}#main-key`,
      owner: ACTOR_URL,
      publicKeyPem: pubKeyPem
    },
    endpoints: {
      sharedInbox: `https://${DOMAIN}/inbox`
    }
  })
})
```

### 5.4 Outbox Endpoint

```typescript
// In-memory store (use SQLite in production)
const activities: any[] = []

app.get('/outbox', (req, res) => {
  res.setHeader('Content-Type', 'application/activity+json')
  res.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `https://${DOMAIN}/outbox`,
    type: 'OrderedCollection',
    totalItems: activities.length,
    orderedItems: activities
  })
})

// Publish a Note
function createNote(content: string): object {
  const noteId = `https://${DOMAIN}/notes/${crypto.randomUUID()}`
  const note = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${noteId}/activity`,
    type: 'Create',
    actor: ACTOR_URL,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`https://${DOMAIN}/followers`],
    object: {
      id: noteId,
      type: 'Note',
      published: new Date().toISOString(),
      attributedTo: ACTOR_URL,
      content: `<p>${content}</p>`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`https://${DOMAIN}/followers`]
    }
  }
  activities.unshift(note)
  return note
}
```

### 5.5 Inbox Endpoint

```typescript
app.post('/inbox', express.json({ type: 'application/activity+json' }), async (req, res) => {
  const activity = req.body

  // 1. Verify HTTP signature (CRITICAL for federation)
  const signatureValid = await verifyHttpSignature(req)
  if (!signatureValid) {
    return res.status(403).json({ error: 'Invalid signature' })
  }

  // 2. Process the activity
  switch (activity.type) {
    case 'Follow':
      // Auto-accept follows
      await sendActivity(activity.actor, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `https://${DOMAIN}/activities/${crypto.randomUUID()}`,
        type: 'Accept',
        actor: ACTOR_URL,
        object: activity
      })
      break

    case 'Create':
      // Handle incoming notes/messages
      console.log('Received:', activity.object.content)
      break

    case 'Undo':
      if (activity.object.type === 'Follow') {
        // Handle unfollow
      }
      break
  }

  res.status(202).end()
})
```

### 5.6 HTTP Signatures for AP

```typescript
import crypto from 'node:crypto'

// Sign an outgoing request (draft-cavage-http-signatures-12)
async function signRequest(
  method: string,
  url: string,
  body: string,
  privateKey: string,
  keyId: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url)
  const date = new Date().toUTCString()
  const digest = `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`

  // Construct the signing string
  const signingString = [
    `(request-target): ${method.toLowerCase()} ${urlObj.pathname}`,
    `host: ${urlObj.host}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n')

  // Sign with RSA-SHA256
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(signingString)
  const signature = signer.sign(privateKey, 'base64')

  return {
    'Host': urlObj.host,
    'Date': date,
    'Digest': digest,
    'Signature': `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
    'Content-Type': 'application/activity+json'
  }
}

// Verify an incoming signed request
async function verifyHttpSignature(req: express.Request): Promise<boolean> {
  const sigHeader = req.headers.signature as string
  if (!sigHeader) return false

  // Parse signature header
  const params: Record<string, string> = {}
  sigHeader.split(',').forEach(part => {
    const [key, ...rest] = part.split('=')
    params[key.trim()] = rest.join('=').replace(/^"|"$/g, '')
  })

  // Fetch the signer's public key from their actor endpoint
  const actorRes = await fetch(params.keyId, {
    headers: { 'Accept': 'application/activity+json' }
  })
  const actor = await actorRes.json()
  const publicKeyPem = actor.publicKey.publicKeyPem

  // Reconstruct the signing string
  const headers = params.headers.split(' ')
  const signingString = headers.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${req.method.toLowerCase()} ${req.path}`
    }
    return `${h}: ${req.headers[h]}`
  }).join('\n')

  // Verify
  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(signingString)
  return verifier.verify(publicKeyPem, params.signature, 'base64')
}

// Send a signed activity to a remote inbox
async function sendActivity(inboxUrl: string, activity: object): Promise<void> {
  const body = JSON.stringify(activity)
  const keyId = `${ACTOR_URL}#main-key`
  const headers = await signRequest('POST', inboxUrl, body, privKeyPem, keyId)

  await fetch(inboxUrl, {
    method: 'POST',
    headers,
    body
  })
}
```

### 5.7 npm Packages for AP

| Package | Purpose |
|---------|---------|
| `activitypub-express` | Express middleware with MongoDB storage |
| `activitypub-http-signatures` | HTTP signature creation/verification |
| `@misskey-dev/node-http-message-signatures` | RFC 9421 HTTP signatures |

For a minimal agent, you likely do not need any AP library -- the protocol is just JSON over HTTP with RSA signatures. The code above is self-contained.

### 5.8 .onion AP Federation Status

**Confirmed: .onion-only ActivityPub servers cannot federate with clearnet Mastodon instances by default.**

- Mastodon **can** be configured to serve over Tor (as a `.onion` hidden service) and federate with other `.onion` instances.
- Mastodon uses **Privoxy** to bridge HTTP requests to SOCKS5/Tor for outbound `.onion` requests.
- Clearnet Mastodon instances **cannot resolve** `.onion` addresses unless their admin has explicitly configured Tor routing.
- **Pleroma** has built-in "onion federation" support that makes this easier than Mastodon.

**The fundamental problem:** When your actor URL is `http://abc123.onion/actor`, a clearnet Mastodon server cannot fetch that URL to verify HTTP signatures or retrieve your actor profile.

### 5.9 Clearnet Relay Pattern for Bridging

To bridge `.onion` agents to the clearnet Fediverse:

```
.onion Agent <--Tor--> Clearnet Bridge Relay <--HTTPS--> Mastodon Instances

Bridge Relay responsibilities:
1. Has a clearnet domain (e.g., relay.agent-network.com)
2. Proxies WebFinger: /.well-known/webfinger?resource=acct:agent123@relay.agent-network.com
   -> forwards to agent's .onion WebFinger (over Tor)
3. Proxies actor endpoints: /users/agent123 -> agent's .onion /actor
4. Proxies inbox: receives activities from clearnet, forwards to agent's .onion inbox
5. Proxies outbox: fetches from agent's .onion outbox, serves to clearnet

The agent's actor URL becomes:
  https://relay.agent-network.com/users/agent123
  (instead of http://abc123.onion/actor)
```

**Architecture:**
- Each agent registers with the relay using a signed request (proving ownership of their ed25519 key).
- The relay maintains a mapping: `agent123 -> abc123.onion`
- The relay signs all outbound activities with its own RSA key on behalf of the agent.
- This is a centralization tradeoff -- the relay is a trust point. Mitigate by running multiple relays.

### 5.10 Note Format

A minimal ActivityPub Note for agent communication:

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://domain.com/notes/uuid-here",
  "type": "Note",
  "published": "2026-02-16T12:00:00Z",
  "attributedTo": "https://domain.com/actor",
  "content": "<p>Task completed: scraped 500 records from target.com</p>",
  "to": ["https://www.w3.org/ns/activitystreams#Public"],
  "cc": ["https://domain.com/followers"],
  "tag": [
    {
      "type": "Hashtag",
      "name": "#agent-task",
      "href": "https://domain.com/tags/agent-task"
    }
  ],
  "attachment": [
    {
      "type": "Document",
      "mediaType": "application/json",
      "url": "https://domain.com/results/uuid.json",
      "name": "task-results.json"
    }
  ]
}
```

**What Mastodon requires for a Note to display properly:**
- `content` must be HTML (not plain text).
- `published` must be ISO 8601.
- `attributedTo` must resolve to a valid actor.
- `to`/`cc` arrays must be present.
- Max content length: 500 characters by default (configurable per instance).
- `@context` must include `https://www.w3.org/ns/activitystreams`.

---

## 6. Storage

### 6.1 better-sqlite3

**Version:** 12.6.2 (as of February 2026)

**Why better-sqlite3:**
- Fastest SQLite library for Node.js (synchronous API is paradoxically faster than async alternatives).
- 62,554 inserts/sec individual, 4,141 tx/sec for 100-row batch transactions.
- Handles 2,000+ queries/sec with 5-way joins on 60GB databases.
- Zero-dependency (besides the native SQLite build).
- WAL mode support for concurrent reads + writes.

```typescript
import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import { mkdirSync } from 'node:fs'

// --- State directory setup ---
function getStateDir(): string {
  const platform = os.platform()

  if (platform === 'linux') {
    // XDG Base Directory Specification
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
    return path.join(xdgData, 'agent-protocol')
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'agent-protocol')
  } else {
    // Windows
    return path.join(process.env.APPDATA || os.homedir(), 'agent-protocol')
  }
}

const stateDir = getStateDir()
mkdirSync(stateDir, { recursive: true })

// --- Initialize database ---
const db = new Database(path.join(stateDir, 'agent.db'))

// CRITICAL: Enable WAL mode for performance
db.pragma('journal_mode = WAL')

// Additional performance pragmas
db.pragma('synchronous = NORMAL')     // safer than OFF, faster than FULL
db.pragma('cache_size = -64000')      // 64MB cache
db.pragma('temp_store = MEMORY')
db.pragma('mmap_size = 268435456')    // 256MB mmap

// --- Schema creation ---
db.exec(`
  -- Agent identity
  CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key BLOB NOT NULL,
    encrypted_private_key BLOB NOT NULL,
    salt BLOB NOT NULL,
    nonce BLOB NOT NULL,
    monero_address TEXT,
    onion_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Peer registry (discovered via DHT/gossipsub)
  CREATE TABLE IF NOT EXISTS peers (
    peer_id TEXT PRIMARY KEY,
    public_key BLOB,
    onion_address TEXT,
    monero_address TEXT,
    reputation_score REAL DEFAULT 0.5,
    last_seen TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_peers_reputation ON peers(reputation_score DESC);
  CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen DESC);

  -- Task marketplace
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    requester_peer_id TEXT NOT NULL,
    assigned_peer_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    price_atomic_units INTEGER,
    escrow_txid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (requester_peer_id) REFERENCES peers(peer_id),
    FOREIGN KEY (assigned_peer_id) REFERENCES peers(peer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

  -- ActivityPub activities (inbox + outbox)
  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    object_json TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
  CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor);
  CREATE INDEX IF NOT EXISTS idx_activities_dir ON activities(direction);
  CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);

  -- Gossipsub message log (for dedup and audit)
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    from_peer TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
  CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);

  -- Monero transaction tracking
  CREATE TABLE IF NOT EXISTS transactions (
    txid TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('escrow_fund', 'escrow_release', 'escrow_refund', 'payment')),
    amount_atomic INTEGER NOT NULL,
    counterparty_peer_id TEXT,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    block_height INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_tx_task ON transactions(task_id);
`)
```

### 6.2 Prepared Statements for Performance

```typescript
// Prepared statements are significantly faster for repeated operations
const insertPeer = db.prepare(`
  INSERT INTO peers (peer_id, public_key, onion_address, last_seen)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(peer_id) DO UPDATE SET
    last_seen = datetime('now'),
    onion_address = COALESCE(excluded.onion_address, onion_address)
`)

const findPeersByReputation = db.prepare(`
  SELECT * FROM peers
  WHERE reputation_score >= ?
  ORDER BY reputation_score DESC
  LIMIT ?
`)

const insertActivity = db.prepare(`
  INSERT INTO activities (id, type, actor, object_json, direction)
  VALUES (?, ?, ?, ?, ?)
`)

// Batch operations use transactions for atomicity + speed
const insertManyPeers = db.transaction((peers: Array<{id: string, key: Buffer, onion: string}>) => {
  for (const peer of peers) {
    insertPeer.run(peer.id, peer.key, peer.onion)
  }
})

// Usage:
insertManyPeers([
  { id: '12D3KooW...', key: Buffer.from('...'), onion: 'abc.onion' },
  { id: '12D3KooX...', key: Buffer.from('...'), onion: 'def.onion' },
])

// Cleanup old data
const pruneOldMessages = db.prepare(`
  DELETE FROM messages WHERE received_at < datetime('now', '-7 days')
`)
```

### 6.3 State Directory Patterns

Following the XDG Base Directory Specification:

```
$XDG_DATA_HOME/agent-protocol/     (default: ~/.local/share/agent-protocol/)
  agent.db                          # Main SQLite database
  identity/
    keypair.enc                     # Encrypted ed25519 keypair
    rsa-keypair.enc                 # Encrypted RSA keypair (for AP HTTP sigs)
  tor/
    hidden_service/                 # Tor hidden service keys (if self-managed)
      hostname
      hs_ed25519_public_key
      hs_ed25519_secret_key
  monero/
    wallet-keys/                    # Monero wallet files (if using local wallet)

$XDG_STATE_HOME/agent-protocol/    (default: ~/.local/state/agent-protocol/)
  logs/
    agent.log                       # Application logs
  tor/
    data/                           # Tor data directory (cached descriptors, etc.)

$XDG_CONFIG_HOME/agent-protocol/   (default: ~/.config/agent-protocol/)
  config.toml                       # User configuration
    # [network]
    # bootstrap_peers = ["/ip4/..."]
    # max_connections = 100
    # [monero]
    # daemon_address = "node.moneroworld.com:18089"
    # network = "mainnet"
    # [tor]
    # socks_port = 9050
    # control_port = 9051

$XDG_CACHE_HOME/agent-protocol/    (default: ~/.cache/agent-protocol/)
  # Ephemeral data that can be safely deleted
```

### 6.4 better-sqlite3 Performance Characteristics

| Operation | Throughput | Notes |
|-----------|-----------|-------|
| Individual INSERT | ~62,000 ops/sec | Single row, WAL mode |
| Batch INSERT (100/tx) | ~4,100 tx/sec (410K rows/sec) | Wrapped in transaction |
| SELECT with index | ~100,000+ ops/sec | Single-key lookup |
| Complex JOIN (5-way) | ~2,000 ops/sec | On 60GB database |
| Memory usage | ~5-10MB base | Plus cache_size setting |

**Known limitations:**
- **Single writer:** SQLite allows only one writer at a time. WAL mode allows concurrent reads during writes, but multiple concurrent writes will serialize.
- **Native addon:** Requires compilation on install (`node-gyp`). Pre-built binaries available for most platforms via `prebuild`.
- **Max database size:** 281 TB theoretical, but practical limit is disk space.
- **No built-in replication:** SQLite is a local database. For multi-node scenarios, each agent has its own database. Use gossipsub/DHT for data exchange.
- **String vs. BLOB:** Store binary data (keys, hashes) as BLOB, not hex strings, for space efficiency and query performance.

### 6.5 Gotchas

- **Always enable WAL mode** (`pragma journal_mode = WAL`) -- without it, readers block writers and vice versa.
- **Use transactions for batch writes** -- inserting 1000 rows without a transaction is 1000x slower than wrapping in `db.transaction()`.
- **Close the database on process exit** -- unclosed databases can leave WAL files that need recovery:
  ```typescript
  process.on('exit', () => db.close())
  process.on('SIGINT', () => { db.close(); process.exit(0) })
  ```
- **datetime('now') is UTC** -- SQLite's `datetime('now')` returns UTC. Be consistent.
- **Integer precision:** SQLite integers are 64-bit. Monero atomic units (piconeros) fit in 64 bits.

---

## Cross-Cutting Concerns

### Putting It All Together: Agent Boot Sequence

```
1. Load/create identity (ed25519 keypair from encrypted storage)
2. Initialize SQLite database (schema, WAL mode, indexes)
3. Start Tor subprocess (granax or system tor)
4. Create .onion hidden service -> get .onion address
5. Start HTTP server on localhost (AP endpoints, agent API)
6. Point hidden service to HTTP server
7. Create libp2p node:
   - TCP transport (optionally through Tor SOCKS5)
   - Noise encryption (uses agent's ed25519 key as libp2p peer ID)
   - Yamux stream muxer
   - mDNS for LAN discovery
   - Bootstrap peers for WAN discovery
   - Kademlia DHT for peer/content routing
   - Gossipsub for pub/sub messaging
8. Subscribe to gossipsub topics (task marketplace, agent directory)
9. Register custom protocol handlers (direct messages, task negotiation)
10. Connect to Monero wallet (RPC or WASM)
11. Announce presence on gossipsub with .onion address and capabilities
12. Begin accepting tasks / publishing services
```

### Security Model Summary

| Layer | Mechanism |
|-------|-----------|
| Network anonymity | Tor (.onion hidden services, SOCKS5 outbound) |
| Transport encryption | Noise Protocol (libp2p) |
| Identity | Ed25519 keypairs (agent identity, Monero keys, Tor keys) |
| Message authentication | Ed25519 signatures on gossipsub messages |
| Federation authentication | RSA-SHA256 HTTP signatures (ActivityPub) |
| Payment privacy | Monero (ring signatures, stealth addresses, RingCT) |
| Escrow | 2-of-3 Monero multisig |
| Local storage encryption | XChaCha20-Poly1305 with scrypt-derived key |

---

## Sources

### libp2p
- [js-libp2p GitHub](https://github.com/libp2p/js-libp2p)
- [libp2p npm](https://www.npmjs.com/package/libp2p)
- [js-libp2p LIMITS.md](https://github.com/libp2p/js-libp2p/blob/main/doc/LIMITS.md)
- [js-libp2p CONFIGURATION.md](https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md)
- [@chainsafe/libp2p-gossipsub](https://github.com/ChainSafe/js-libp2p-gossipsub)
- [@libp2p/kad-dht npm](https://www.npmjs.com/package/@libp2p/kad-dht)
- [@libp2p/mdns npm](https://www.npmjs.com/package/@libp2p/mdns)
- [@libp2p/bootstrap npm](https://www.npmjs.com/package/@libp2p/bootstrap)
- [Gossipsub v1.0 spec](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.0.md)
- [Noise Protocol in libp2p](https://docs.libp2p.io/concepts/secure-comm/noise/)
- [js-libp2p custom protocols example](https://github.com/libp2p/js-libp2p-example-custom-protocols)
- [SOCKS proxy transport issue (js)](https://github.com/libp2p/js-libp2p/issues/142)
- [rust-libp2p-tokio-socks5](https://github.com/comit-network/rust-libp2p-tokio-socks5)
- [DoS Mitigation](https://docs.libp2p.io/concepts/security/dos-mitigation/)

### Tor
- [granax GitHub](https://github.com/161chihuahuas/granax)
- [@deadcanaries/granax npm](https://www.npmjs.com/package/@deadcanaries/granax)
- [socks npm](https://www.npmjs.com/package/socks)
- [socks-proxy-agent npm](https://www.npmjs.com/package/socks-proxy-agent)
- [tor-router npm](https://www.npmjs.com/package/tor-router)
- [Tor Onion v3 Hidden Service](https://www.jamieweb.net/blog/onionv3-hidden-service/)
- [Set up Your Onion Service](https://community.torproject.org/onion-services/setup/)

### Identity and Crypto
- [Noble cryptography](https://paulmillr.com/noble/)
- [@noble/ed25519 npm](https://www.npmjs.com/package/@noble/ed25519)
- [@noble/curves npm](https://www.npmjs.com/package/@noble/curves)
- [@noble/hashes npm](https://www.npmjs.com/package/@noble/hashes)
- [noble-hashes BLAKE3 source](https://github.com/paulmillr/noble-hashes/blob/main/src/blake3.ts)
- [Monero Private Keys](https://docs.getmonero.org/cryptography/asymmetric/private-key/)
- [Monero Standard Address](https://docs.getmonero.org/public-address/standard-address/)
- [Monero Spend Key](https://www.getmonero.org/resources/moneropedia/spendkey.html)

### Monero
- [monero-ts GitHub](https://github.com/woodser/monero-ts)
- [monero-ts npm](https://www.npmjs.com/package/monero-ts)
- [monero-ts creating wallets](https://github.com/woodser/monero-ts/blob/master/docs/developer_guide/creating_wallets.md)
- [monero-ts multisig wallets](https://github.com/woodser/monero-ts/blob/master/docs/developer_guide/multisig_wallets.md)
- [monero-ts view-only/offline](https://github.com/woodser/monero-ts/blob/master/docs/developer_guide/view_only_offline.md)
- [Monero Wallet RPC documentation](https://www.getmonero.org/resources/developer-guides/wallet-rpc.html)
- [Monero Multisignature docs](https://docs.getmonero.org/multisignature/)
- [Monero Networks (testnet/stagenet)](https://docs.getmonero.org/infrastructure/networks/)
- [Transaction Unlock Time](https://www.getmonero.org/resources/moneropedia/unlocktime.html)
- [Monero timelock vulnerabilities](https://thecharlatan.ch/Monero-Unlock-Time-Vulns/)
- [Public Remote Nodes](https://xmr.ditatompel.com/remote-nodes)
- [MoneroWorld](https://moneroworld.com/)

### ActivityPub
- [ActivityPub W3C spec](https://www.w3.org/TR/activitypub/)
- [Mastodon ActivityPub docs](https://docs.joinmastodon.org/spec/activitypub/)
- [Mastodon Security (HTTP sigs)](https://docs.joinmastodon.org/spec/security/)
- [WebFinger - Mastodon docs](https://docs.joinmastodon.org/spec/webfinger/)
- [How to implement a basic ActivityPub server (Mastodon blog)](https://blog.joinmastodon.org/2018/06/how-to-implement-a-basic-activitypub-server/)
- [express-activitypub reference](https://github.com/dariusk/express-activitypub)
- [activitypub-express npm](https://www.npmjs.com/package/activitypub-express)
- [activitypub-http-signatures npm](https://www.npmjs.com/package/activitypub-http-signatures)
- [Mastodon Tor onion services](https://docs.joinmastodon.org/admin/optional/tor/)
- [Pleroma Onion Federation](https://docs-develop.pleroma.social/backend/configuration/onion_federation/)
- [ActivityPub and HTTP Signatures spec](https://swicg.github.io/activitypub-http-signature/)

### Storage
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3)
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)
- [xdg-basedir npm](https://www.npmjs.com/package/xdg-basedir)
