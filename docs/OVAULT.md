# OVault — cross-chain deposits into TacitVault

This is the deployment and wiring guide for Tacit's LayerZero OVault layer: the two contracts in
`src/ovault/` that let someone holding FXRP on another chain deposit into `TacitVault`, and someone
holding `tFXRP` on another chain redeem out of it, in a single transaction and without ever holding
Coston2 gas.

It is an *addition* to the vault, not a change to it. Every cross-chain deposit still enters through
`TacitVault.deposit` and every cross-chain redemption still exits through `TacitVault.redeem`, so all
five on-chain guardrails apply unchanged. A cross-chain depositor is an ordinary depositor who
happened to arrive by bridge. Nothing here widens the enclave's authority.

## Contents

1. [Topology](#1-topology)
2. [Prerequisite: an FXRP asset OFT](#2-prerequisite-an-fxrp-asset-oft)
3. [Deploy the share OFT adapter](#3-deploy-the-share-oft-adapter)
4. [Deploy the composer](#4-deploy-the-composer)
5. [Wire the pathways](#5-wire-the-pathways)
6. [Allowances](#6-allowances)
7. [Depositing](#7-depositing)
8. [Decimals, and the dust step](#8-decimals-and-the-dust-step)
9. [What is not here](#9-what-is-not-here)

---

## 1. Topology

Hub and spoke. The vault, the shares, and the composer all live on Coston2; a spoke chain holds only
a share OFT and an FXRP OFT, and its messages are composed against the hub.

```
        spoke chain                      Coston2 (hub, EID 40294)
   ┌──────────────────┐            ┌──────────────────────────────────┐
   │  FXRP OFT        │──asset────▶│  FXRP OFT adapter                │
   │                  │  + compose │        │                         │
   │                  │            │        ▼                         │
   │                  │            │  TacitOVaultComposer             │
   │                  │            │        │  deposit()              │
   │                  │            │        ▼                         │
   │                  │            │  TacitVault  ──mints tFXRP──┐    │
   │  share OFT       │◀──shares───│  TacitShareOFTAdapter ◀─────┘    │
   └──────────────────┘            └──────────────────────────────────┘
```

The share adapter is a **lockbox**, not mint-burn. `tFXRP`'s `totalSupply()` is one half of the
exchange rate every depositor is priced against, so destroying supply here to recreate it on a spoke
would silently rewrite that rate for everyone who never left the hub. Shares are escrowed instead:
supply is constant, only custody moves. `VaultComposerSync` enforces this for us — its constructor
reverts `ShareOFTNotAdapter` unless `approvalRequired()` is true.

### LayerZero on Coston2

Coston2 is a LayerZero V2 chain. Every address below was read off-chain rather than taken from a
docs page, and can be re-read the same way:

| Thing | Address / value |
|---|---|
| Chain ID | `114` |
| Endpoint ID (EID) | `40294` |
| EndpointV2 | `0x6EDCE65403992e310A62460808c4b910D972f10f` |
| SendUln302 (default send library) | `0x00C5C0B8e0f75aB862CbAaeCfff499dB555FBDD2` |
| ReceiveUln302 (default receive library) | `0x1d186C560281B8F1AF831957ED5047fD3AB902F9` |
| Default executor | `0x9dB9Ca3305B48F196D18082e91cB64663b13d014` |
| Default required DVN | `0x12523de19dc41c91F7d2093E0CFbB76b17012C8d` |

```bash
cast call 0x6EDCE65403992e310A62460808c4b910D972f10f "eid()(uint32)" --rpc-url coston2
# 40294  — matches FLARE_V2_TESTNET in @layerzerolabs/lz-definitions
```

`40294` sits inside LayerZero's testnet EID band, which is what the wiring script uses to pick a
testnet DVN set over a mainnet one.

**We do not call `setConfig`.** The defaults above are already a working stack — one required DVN,
`maxMessageSize` 10000, 1 confirmation outbound and 2 inbound, uniform across every destination EID
tested (40161, 40245, 40231, 40232). Pinning an explicit executor and DVN set is the right call for
production, because it makes the security stack deterministic and independent of LayerZero's defaults
changing underneath you. It is not the right call here: `@layerzerolabs/lz-address-book` is not a
dependency of this repo, so there is no maintained source for per-chain DVN addresses to pin
*against*, and hardcoding the one testnet DVN above would be pinning to the default anyway. Wiring
therefore sets peers and enforced options only. If you take this to mainnet, add the `setConfig`
step — the deployment is not production-ready without it.

---

## 2. Prerequisite: an FXRP asset OFT

**Read this before deploying anything.** The composer's constructor requires an asset OFT whose
`token()` equals `vault.asset()` — that is, FXRP at
`0x0b6A3645c240605887a5532109323A3E12273dc7`. No such OFT adapter is known to exist on Coston2, and
this repo does not ship one.

That is a genuine gap, not a formality. Until an FXRP OFT adapter exists on Coston2 *and* has a peer
OFT deployed and wired on at least one spoke chain, the composer can be deployed but no cross-chain
deposit can actually complete. The two contracts in `src/ovault/` are the parts specific to Tacit;
the FXRP transport is generic and belongs to whoever wants to bridge FXRP.

Nothing about it needs customising. A plain LayerZero `OFTAdapter` over FXRP is sufficient:

```solidity
new OFTAdapter(
    0x0b6A3645c240605887a5532109323A3E12273dc7,  // FXRP on Coston2
    0x6EDCE65403992e310A62460808c4b910D972f10f,  // EndpointV2
    delegate
);
```

Set `ASSET_OFT` to its address once it exists. Everything from §3 onward assumes you have.

Resolve FXRP from the Flare contract registry rather than trusting the address above — it is what
`script/Deploy.s.sol` already does, via `getContractAddressByName("AssetManagerFXRP")` then
`fAsset()`.

---

## 3. Deploy the share OFT adapter

`TacitShareOFTAdapter` escrows `tFXRP` for shares that currently live on a spoke. One per
deployment, hub chain only.

**Required environment variables**

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | Deployer. Becomes both owner and LayerZero delegate. |
| `TACIT_VAULT` | The vault. It is its own share token, so this is also the token being escrowed. |
| `LZ_ENDPOINT` | EndpointV2. Defaults to `0x6EDCE65403992e310A62460808c4b910D972f10f`. |
| `STRANDED_FUNDS_RECIPIENT` | Recovery address for undeliverable inbound shares. Should be a multisig — it is a custodian of other people's shares, not a treasury. |

```bash
forge script script/ovault/DeployShareOFTAdapter.s.sol:DeployShareOFTAdapter \
  --rpc-url coston2 --broadcast --verify
```

**After deployment**: set `SHARE_OFT` in your environment and add `shareOFTAdapter` to
`ui/deployments.json`.

Two things to know about the recovery address. First, it is load-bearing: `_credit` reroutes to it
when an inbound delivery cannot reach its recipient, which is what stops a malformed destination from
locking shares in the adapter forever. Second, it is the *only* fallback — if the recovery transfer
also fails, the message reverts and the shares stay locked. Verify the address is reachable before
setting it, not after. `setStrandedFundsRecipient` exists to fix a bad one, but only while the
adapter is still able to transfer.

---

## 4. Deploy the composer

`TacitOVaultComposer` is what turns an inbound FXRP delivery plus a compose message into
`vault.deposit()` and an outbound share send.

**Required environment variables**

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | Deployer. Becomes owner. |
| `TACIT_VAULT` | The vault. Must be synchronous at the ERC-4626 surface — `TacitVault` is. |
| `ASSET_OFT` | FXRP OFT adapter from §2. Checked against `vault.asset()`. |
| `SHARE_OFT` | `TacitShareOFTAdapter` from §3. Checked to be a lockbox. |
| `STRANDED_FUNDS_RECIPIENT` | Recovery address for undeliverable refunds. |

```bash
forge script script/ovault/DeployComposer.s.sol:DeployComposer \
  --rpc-url coston2 --broadcast --verify
```

**After deployment**: set `TACIT_OVAULT_COMPOSER`, add `ovaultComposer` to `ui/deployments.json`, and
register the composer as the compose target on each spoke.

The constructor does three checks that between them catch every wiring mistake worth catching, so a
successful deploy is meaningful: `ASSET_OFT.token() == vault.asset()`, `SHARE_OFT.token() == vault`,
and `SHARE_OFT.approvalRequired() == true`. It also sets its own internal approvals — the composer
approves the vault to pull FXRP and approves the share adapter to pull `tFXRP`. You do not grant
those; see §6 for the ones you do.

### Why refunds get their own machinery

`TacitVault` has a state that *intentionally* rejects deposits: `deposit` and `mint` are
`whenNotPaused`, and `maxDeposit` returns 0 while paused, while `withdraw` and `redeem` are never
paused because exits stay open by design. So "a compose arrives while deposits are paused" is not an
exotic edge case — it is a state an operator can and should enter.

When it happens, `handleCompose` reverts, `lzCompose` catches, and `_refund` bridges the FXRP home.
The overrides in `TacitOVaultComposer` exist for the cases where even that is not enough, each
traceable to a specific base-contract behaviour rather than a hypothetical:

1. `_depositAndSend` / `_redeemAndSend` preserve `minAmountLD` into the OFT leg. The base asserts
   slippage against the vault output and then zeroes it, leaving the bridge leg unbounded.
2. `_sendLocal` refunds `msg.value` on a same-chain delivery. The base drops it, and its own comment
   concedes the native "accumulates in the contract and is locked".
3. `_refund` wraps the remote send in `try/catch` and escrows to the recovery address on failure. The
   base refund is a bare send with no fallback; if it reverts the tokens stay in the composer
   permanently.

Escrow is not a good outcome — it replaces a trustless refund with a human one. It is better than
funds that provably cannot move again. Watch `StrandedFundsRecovered` and
`StrandedSharesRecovered`: each one is someone whose funds are safe but not where they asked for
them, recoverable only by reading the intended recipient off the event and the source chain.

`rescueNative` covers the last gap — a recovery address that cannot accept native leaves a balance in
the composer with no other way out. It is native-only and cannot touch FXRP or shares.

---

## 5. Wire the pathways

Wiring is per-pathway and must be done from **both** ends. This repo only holds the hub side.

**Required environment variables**

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | Must be the OApp's delegate. |
| `SHARE_OFT` | `TacitShareOFTAdapter` on Coston2. |
| `SPOKE_EID` | Destination endpoint ID, e.g. `40245` for Base Sepolia. |
| `SPOKE_SHARE_OFT` | The share OFT on the spoke. |

```bash
forge script script/ovault/WireShareOFT.s.sol:WireShareOFT \
  --rpc-url coston2 --broadcast
```

Then run the spoke chain's equivalent, pointing back at Coston2 (`SPOKE_EID=40294`). A pathway wired
from one side only will accept nothing — `setPeer` is what authorises a source, and an unwired peer
is indistinguishable from an attacker.

### What the script sets

**Peers.** `setPeer(SPOKE_EID, bytes32(uint256(uint160(SPOKE_SHARE_OFT))))`.

**Enforced options.** Gas the executor is guaranteed to have on the destination, regardless of what
the sender specifies:

| Message type | Option | Gas |
|---|---|---|
| `SEND` (1) | `lzReceive` | 80,000 |
| `SEND_AND_CALL` (2) | `lzReceive` | 80,000 |
| `SEND_AND_CALL` (2) | `lzCompose` | 400,000 |

The `lzCompose` allowance is only needed on messages heading **toward the hub**, because the composer
is the only thing on either side that composes. 400,000 covers a `vault.deposit()` that unwinds and
re-enters venues plus an outbound OFT send. Underfunding it is the most common way a correctly-built
compose fails: the message arrives, the executor runs out of gas mid-`lzCompose`, and the depositor
ends up in the refund path for no reason other than a config number.

**Not set**: message libraries and `setConfig`. Both are left at the Coston2 defaults from §1. If you
need a non-default library, `setSendLibrary` / `setReceiveLibrary` must be guarded by a read of the
current value — the endpoint reverts `LZ_SameValue` on a no-op write.

### Ownership and the delegate diverge

Ownership and the LayerZero delegate are set together at construction and then move independently.
Completing an `Ownable2Step` handover leaves the **old** owner as delegate, still able to rewrite
peers and message libraries on an adapter it no longer owns. Call `setDelegate` explicitly after any
ownership transfer. This is silent when missed, which is why it is pinned as a test
(`test_transferOwnership_DoesNotMoveTheLayerZeroDelegate`).

---

## 6. Allowances

The composer grants its own internal approvals in its constructor. These are the ones a *user* has to
grant:

| Token | Spender | Granted by | Purpose |
|---|---|---|---|
| FXRP | `TacitOVaultComposer` | Depositor on the hub | `depositAndSend` pulls FXRP from the caller |
| `tFXRP` | `TacitShareOFTAdapter` | Share holder on the hub | Sending shares to a spoke escrows them |
| FXRP | FXRP OFT adapter | Sender on the hub | Bridging FXRP out without depositing |

A cross-chain depositor arriving from a spoke grants nothing on Coston2 — the executor delivers to
the composer directly. Allowances are only needed by someone already on the hub calling the composer
or an adapter themselves.

---

## 7. Depositing

`script/ovault/DepositAndSend.s.sol` deposits FXRP on Coston2 and sends the resulting shares to a
spoke. It is the hub-side half of the flow, useful for testing the composer before a spoke exists.

| Variable | Meaning |
|---|---|
| `PRIVATE_KEY` | Depositor. |
| `TACIT_OVAULT_COMPOSER` | The composer. |
| `ASSET_AMOUNT` | FXRP, 6 decimals. `100000000` is 100 FXRP. |
| `RECIPIENT` | Who receives shares on the spoke. Defaults to the sender. |
| `SPOKE_EID` | Destination endpoint ID. |

```bash
export ASSET_AMOUNT=100000000   # 100 FXRP — six decimals, not eighteen
export SPOKE_EID=40245
forge script script/ovault/DepositAndSend.s.sol:DepositAndSend \
  --rpc-url coston2 --broadcast
```

What it does: checks the FXRP balance, approves the composer if needed, builds a `SendParam` for the
spoke, quotes the LayerZero fee via `composer.quoteSend`, and calls `depositAndSend` with that fee
attached. `amountLD` is left at 0 — the composer overwrites it with the shares the vault actually
minted, which is not knowable before the deposit executes.

Set `minAmountLD` deliberately if you care about the outcome. It is enforced against the vault output
*and*, thanks to the override in §4, against the bridge leg. Leaving it at 0 means accepting whatever
arrives.

For a plain hub deposit with no bridge, call `TacitVault.deposit` — there is no reason to route
through the composer, and `script/Deploy.s.sol` already covers that path.

---

## 8. Decimals, and the dust step

FXRP has 6 decimals. `TacitVault` adds a 3-decimal virtual-share offset, so `tFXRP` has 9.
LayerZero's `sharedDecimals()` is 6.

```
decimalConversionRate = 10 ** (9 - 6) = 1000
```

Every cross-chain share send therefore truncates the low three digits — at most 999 share units,
which at the vault's initial rate is one wei of FXRP. The dust is truncated *before* the escrow pull,
so it stays with the sender; the alternative would leave a growing residue in the adapter that no
share on any chain accounts for.

Two consequences worth knowing before you debug them:

- A send of 1999 share units delivers 1000. If you set `minAmountLD = 1999`, it reverts with
  `SlippageExceeded(1000, 1999)` — a failure with nothing wrong on either chain. 1999 units simply
  cannot be expressed at 6 shared decimals.
- This is documented rather than fixed. Raising `sharedDecimals` would exclude any future spoke chain
  that cannot represent 9 decimals, which is the worse trade.

Amounts in the reference LayerZero examples are 18-decimal. Every figure in this guide is not.
`100000000000000000000` is 100 tokens there and 100 *trillion* FXRP here.

---

## 9. What is not here

Stated plainly rather than left to be discovered:

- **No FXRP OFT adapter.** §2. Without it, and without a peer on a spoke, no cross-chain deposit
  completes. This is the blocking prerequisite.
- **No spoke-side contracts.** A spoke needs its own share OFT (mint-burn, since the hub holds the
  escrow) and an FXRP OFT. Neither is in this repo, so §5's spoke half has nothing to point at yet.
  The wiring script takes the spoke EID and address as environment variables precisely so it does not
  have to assume one.
- **No explicit DVN or executor config.** §1. Defaults only. Add `setConfig` before mainnet.
- **No upgradeability.** The reference implementation this was modelled on puts both contracts behind
  UUPS proxies. These are plain deploys — simpler to audit and to reason about, and a redeploy plus
  re-wire is an acceptable migration path at this stage.

### Verifying on Coston2

`--verify` targets Blockscout via the `[etherscan]` block in `foundry.toml`. Forge frequently reports
verification as failed when the upload actually succeeded — the failure is in its status polling, not
the submission. Check the explorer before re-running anything.

### Tests

```bash
forge test --match-path 'test/ovault/*' -vv
```

53 tests: 33 for the composer, 20 for the share adapter. They cover the three overrides, all three
`_credit` reroute branches (`address(0)`, a token that reverts, a token that returns `false`), the
dust step in both directions, and the delegate-divergence case from §5. The share adapter tests run
against the real `TacitVault` rather than a mock with convenient decimals, which is what makes the
dust assertions mean anything.
