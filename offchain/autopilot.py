"""Autopilot: the daemon that makes the rebalance loop self-driving.

Without this, the vault's `requestRebalance()` button emits an event that nothing listens to, and
a human has to open a terminal to move funds. The autopilot closes that gap: it watches for
`RebalanceRequested`, also runs on a slow heartbeat, and drives the same `run_cycle()` the manual
relayer uses.

It is trusted for LIVENESS ONLY. `executeRebalance` has no caller access control, so this key
needs gas and nothing else. Every value it carries is still attested by the FDC, signed by the
enclave, or re-derived on-chain -- a compromised autopilot can stall the vault or waste its own
gas, but it cannot move funds anywhere the vault's invariants forbid.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from eth_account import Account
from web3 import Web3

import fdc
from relayer import VAULT_ABI, enclave_identity, run_cycle

BACKOFF_MIN = 30
BACKOFF_MAX = 900
CURSOR_FILE = os.getenv("TACIT_CURSOR_FILE", ".autopilot-cursor")

# Coston2 public RPCs cap eth_getLogs ranges. Stay well inside it.
LOG_WINDOW = 2_000


class State:
    """Shared state between the loop and the status endpoint. Decoration over chain truth."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.phase = "starting"
        self.step = 0
        self.detail = ""
        self.last_cycle_at: int | None = None
        self.last_tx: str | None = None
        self.last_error: str | None = None
        self.cycles_ok = 0
        self.cycles_failed = 0
        self.blocked_by: list[str] = []

    def set(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def record_cycle(self, result) -> None:
        """Fold a finished CycleResult in, then drop back to idle."""
        with self._lock:
            self.last_cycle_at = int(time.time())
            self.last_tx = result.tx_hash
            if result.succeeded:
                self.cycles_ok += 1
                self.detail = f"nonce {result.nonce}: {result.rationale}"
            else:
                self.cycles_failed += 1
                self.detail = "last cycle did not complete"
            self.phase = "idle"
            self.step = 0

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "phase": self.phase,
                "step": self.step,
                "detail": self.detail,
                "lastCycleAt": self.last_cycle_at,
                "lastTx": self.last_tx,
                "lastError": self.last_error,
                "cyclesOk": self.cycles_ok,
                "cyclesFailed": self.cycles_failed,
                "blockedBy": list(self.blocked_by),
            }


def serve_status(state: State, port: int) -> None:
    """Expose the daemon's own view of itself. The UI treats this as a hint, never as truth."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if self.path.split("?")[0].rstrip("/") not in ("", "/status", "/health"):
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps(state.snapshot()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass  # keep the daemon's own log readable

    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


def read_cursor(default: int) -> int:
    try:
        with open(CURSOR_FILE) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return default


def write_cursor(block: int) -> None:
    try:
        with open(CURSOR_FILE, "w") as f:
            f.write(str(block))
    except OSError as e:
        print(f"warn: could not persist cursor ({e}); will re-scan from head on restart")


def seconds_until_eligible(vault) -> int:
    """How long until `executeRebalance` would clear the interval guard.

    Read from chain rather than assuming 300s -- `minRebalanceInterval` is owner-settable, and the
    guard is checked *inside* executeRebalance, i.e. after the FDC fee is paid and minutes of
    round-waiting have already elapsed. Gating here is what keeps a cycle from being wasted.
    """
    last = vault.functions.lastRebalanceAt().call()
    if last == 0:
        return 0
    interval = vault.functions.minRebalanceInterval().call()
    return max(0, (last + interval) - int(time.time()))


def preflight(w3: Web3, account, vault, enclave_url: str, min_balance_wei: int) -> list[tuple]:
    """Everything that would make a cycle fail, checked before an attestation fee is spent.

    Returns one `(name, value, problem_or_None)` row per check so the caller can print the
    chain-read value alongside the verdict -- a preflight you cannot read is not worth running.
    """
    rows: list[tuple] = []

    try:
        is_paused = vault.functions.paused().call()
        rows.append(("vault paused", str(is_paused), "vault is paused" if is_paused else None))
    except Exception as e:
        rows.append(("vault readable", "no", f"cannot read vault: {e}"))
        return rows  # nothing else will work either

    n = vault.functions.venueCount().call()
    rows.append(("venues", str(n), "vault has no venues configured" if n == 0 else None))

    cooldown = seconds_until_eligible(vault)
    rows.append(
        (
            "rebalance interval",
            "eligible now" if cooldown == 0 else f"{cooldown}s remaining",
            None if cooldown == 0 else f"too soon, {cooldown} seconds until eligible",
        )
    )

    balance = w3.eth.get_balance(account.address)
    rows.append(
        (
            "gas balance",
            f"{balance / 1e18:.4f} C2FLR",
            None
            if balance >= min_balance_wei
            else f"gas balance below floor {min_balance_wei / 1e18:.4f} C2FLR",
        )
    )

    identity = enclave_identity(enclave_url)
    if identity is None:
        rows.append(("enclave", "unreachable", f"enclave unreachable at {enclave_url}"))
    else:
        expected = vault.functions.teeIdentity().call()
        # Catching a mismatch here saves an attestation fee: every plan would revert BadSigner.
        mismatch = Web3.to_checksum_address(identity) != Web3.to_checksum_address(expected)
        rows.append(
            (
                "enclave identity",
                identity,
                f"enclave identity {identity} != vault teeIdentity {expected}"
                if mismatch
                else None,
            )
        )

    return rows


def poll_requests(w3: Web3, vault, cursor: int) -> tuple[bool, int]:
    """Scan an explicit block range for `RebalanceRequested`. Returns (found, new_cursor).

    Deliberately not `create_filter`: long-lived filter handles expire silently on public RPCs and
    the watcher would go quietly deaf, which is the worst failure mode for a liveness service.
    """
    head = w3.eth.block_number
    if cursor == head + 1:
        return False, cursor  # caught up; the common case between blocks, not an anomaly
    if head < cursor:
        # Genuinely ahead of the chain: a reorg, or a fresh node still syncing. Clamp forward, never
        # backwards -- rewinding would re-scan blocks already served and re-fire a served request.
        return False, head + 1

    found = False
    while cursor <= head:
        to_block = min(cursor + LOG_WINDOW, head)
        logs = vault.events.RebalanceRequested().get_logs(from_block=cursor, to_block=to_block)
        if logs:
            found = True
        cursor = to_block + 1
    return found, cursor


def one_pass(
    w3: Web3,
    account,
    vault,
    args,
    state: State,
    cursor: int,
    min_balance_wei: int,
    *,
    force: bool = False,
) -> tuple[int, bool]:
    """Evaluate triggers, run a cycle if warranted. Returns (new_cursor, ran_a_cycle)."""
    scanned_from = cursor
    requested, cursor = poll_requests(w3, vault, cursor)
    if not requested:
        # Nothing pending, so remembering how far we scanned costs nothing. While a request IS
        # pending the cursor stays put on disk: `requestRebalance` only emits an event, so this
        # cursor is the sole record that somebody asked. Advancing it before the cycle reaches a
        # decision would drop the request on any failure -- the button would silently do nothing.
        write_cursor(cursor)

    last = vault.functions.lastRebalanceAt().call()
    since = int(time.time()) - last
    due = since >= args.heartbeat

    if not (requested or due or force):
        state.set(
            phase="idle",
            step=0,
            detail=f"no request pending; heartbeat in {max(0, args.heartbeat - since)}s",
            blocked_by=[],
        )
        return cursor, False

    trigger = "requestRebalance" if requested else ("manual" if force else "heartbeat")
    print(f"[autopilot] {trigger} trigger - preflight")

    rows = preflight(w3, account, vault, args.enclave, min_balance_wei)
    for name, value, problem in rows:
        print(f"    {'FAIL' if problem else ' ok '}  {name:<20} {value}")
    problems = [p for _n, _v, p in rows if p]

    if problems:
        state.set(phase="blocked", step=0, detail="; ".join(problems), blocked_by=problems)
        print(f"[autopilot] holding: {problems[0]}")
        # Rewind to where this scan started so a pending request survives the hold. Preflight
        # failures are transient by nature -- a cooldown expires, the faucet refills, the enclave
        # comes back -- and the request should still be waiting when they clear.
        return (scanned_from if requested else cursor), False

    print("[autopilot] preflight clear - running a cycle")
    state.set(phase="working", step=0, detail=f"{trigger} trigger", blocked_by=[], last_error=None)

    def on_step(n: int, text: str) -> None:
        state.set(phase="working", step=n, detail=text)

    result = run_cycle(w3, account, vault, args.enclave, dry_run=args.dry_run, on_step=on_step)

    # The cycle reached a verdict, so the request is served and the cursor may move past it. A
    # raised exception skips this line by design: the request stays pending and the next pass, after
    # backoff, sees it again. That is the difference between a retry and a dropped button press.
    write_cursor(cursor)

    state.record_cycle(result)
    return cursor, True


def main() -> int:
    ap = argparse.ArgumentParser(
        description="TacitVault autopilot - self-driving rebalance loop",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--vault", required=True, help="TacitVault address")
    ap.add_argument(
        "--enclave", default=os.getenv("TACIT_ENCLAVE_URL", "http://127.0.0.1:8080")
    )
    ap.add_argument("--rpc", default=os.getenv("COSTON2_RPC", fdc.COSTON2_RPC))
    ap.add_argument(
        "--heartbeat",
        type=int,
        default=int(os.getenv("TACIT_HEARTBEAT", "3600")),
        help="run a cycle this often even without a button press (seconds)",
    )
    ap.add_argument(
        "--min-balance",
        type=float,
        default=float(os.getenv("TACIT_MIN_BALANCE", "0.05")),
        help="skip cycles while the key has less than this much C2FLR",
    )
    ap.add_argument(
        "--status-port", type=int, default=int(os.getenv("TACIT_STATUS_PORT", "9090"))
    )
    ap.add_argument("--dry-run", action="store_true", help="stop before executeRebalance")
    ap.add_argument(
        "--once",
        action="store_true",
        help="run a single evaluation pass, then exit (exit 0 if a cycle ran)",
    )
    args = ap.parse_args()

    pk = os.getenv("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY is required", file=sys.stderr)
        return 2
    account = Account.from_key(pk)

    w3 = Web3(Web3.HTTPProvider(args.rpc))
    vault = w3.eth.contract(address=Web3.to_checksum_address(args.vault), abi=VAULT_ABI)
    state = State()
    min_balance_wei = int(args.min_balance * 1e18)

    if not args.once:
        threading.Thread(target=serve_status, args=(state, args.status_port), daemon=True).start()
        print(f"[autopilot] status endpoint on :{args.status_port}")

    print(f"[autopilot] watching {args.vault} on chain {w3.eth.chain_id}")
    print(f"[autopilot] heartbeat {args.heartbeat}s, gas floor {args.min_balance} C2FLR")
    print(f"[autopilot] enclave {args.enclave}")
    if args.dry_run:
        print("[autopilot] dry-run: will stop before executeRebalance")

    cursor = read_cursor(w3.eth.block_number)
    state.set(phase="watching", detail=f"scanning from block {cursor}")

    wait = BACKOFF_MIN
    while True:
        try:
            # `--once` is a manual "try now": force past the trigger check so the preflight
            # always prints, which is what makes it useful for testing.
            cursor, ran = one_pass(
                w3, account, vault, args, state, cursor, min_balance_wei, force=args.once
            )
            wait = BACKOFF_MIN
        except KeyboardInterrupt:
            print("\n[autopilot] bye")
            return 0
        except Exception as e:
            # Never die. A liveness daemon that crashes on a transient RPC error is worse than
            # one that idles; the FDC round waiting already has its own retry/timeout ladder.
            state.set(phase="error", step=0, detail=str(e), last_error=str(e))
            print(f"[autopilot] error: {e}; backing off {wait}s")
            if args.once:
                return 1
            time.sleep(wait)
            wait = min(wait * 2, BACKOFF_MAX)
            continue

        if args.once:
            return 0 if ran else 1

        snap = state.snapshot()
        if snap["blockedBy"] or snap["phase"] == "error":
            time.sleep(min(60, max(wait, 15)))
            wait = min(wait * 2, BACKOFF_MAX)
        else:
            time.sleep(15)


if __name__ == "__main__":
    raise SystemExit(main())
