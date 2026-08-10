#!/usr/bin/env bash
#
# TacitVault walkthrough. Runs offline except for step 3, which hits the live FDC verifier.
#
#   ./demo.sh
#
set -euo pipefail

cd "$(dirname "$0")"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
rule() { printf '%s\n' "────────────────────────────────────────────────────────────────"; }

bold "1. Contract test suite"
rule
forge test --summary

bold "2. Attacking our own enclave"
rule
echo "Every plan below is correctly signed by the registered TEE identity."
echo "The vault rejects each one anyway — that is the trust model."
echo
forge test --match-contract AttackTheEnclave -vv 2>/dev/null \
  | grep -E "^\s+(===|ATTACK|RESIDUAL|->|Depositors|Vault assets|Enclave|All plans|attacker|venue|rebalance|This is|fully|alice|  rotate)" \
  | sed 's/^  //' || true

bold "3. The invariant campaign"
rule
echo "Hand-written attacks only prove the guardrails stop the attacks someone thought of."
echo "Here a hostile enclave holding the real signing key submits thousands of random plans."
echo
forge test --match-contract MaliciousEnclaveInvariant 2>/dev/null \
  | grep -E "^\[(PASS|FAIL)|submitPlan|Suite result" | sed 's/^  //' || true

bold "4. Live FDC Web2Json request (network)"
rule
echo "Submitting the market-signal request to Flare's testnet verifier..."
echo
python3 offchain/signal_source.py 2>&1 | tail -4

bold "5. Cross-language conformance"
rule
echo "The Go enclave signs; the Solidity vault must recover the same identity."
echo "Regenerate the vector with:  go test ./tee/..."
echo
(cd tee && go test ./... 2>&1 | tail -3)
forge test --match-contract EnclaveConformance -vv 2>/dev/null \
  | grep -E "recovered:|expected :|Suite result" | sed 's/^  //' || true

bold "6. The confidential enclave, live"
rule
if [ -z "${TACIT_TEE_KEY:-}" ]; then
  export TACIT_TEE_KEY=00000000000000000000000000000000000000000000000000000000000a11ce
  echo "(using the demo identity from .env.example)"
fi
export SIMULATED_TEE=true TACIT_LISTEN=:8099

(cd tee && go build -o /tmp/tacit-tee-demo .)
/tmp/tacit-tee-demo >/tmp/tacit-demo.log 2>&1 &
TEE_PID=$!
trap 'kill $TEE_PID 2>/dev/null || true' EXIT
sleep 2

echo "identity:"
curl -s http://127.0.0.1:8099/info | python3 -m json.tool
echo
echo "allocation for a real Bitstamp observation:"
curl -s -X POST http://127.0.0.1:8099/action \
  -H "Content-Type: application/json" \
  --data-binary @test/fixtures/enclave_request.json | python3 -m json.tool

rule
cat <<'EOF'

The enclave revealed an allocation and nothing else. Its weights, thresholds and
risk budget stayed inside the TEE.

Attestation is SIMULATED on Coston2, which is why the vault does not take the
enclave's word for anything: conservation, venue caps, turnover, the FTSO price
band and the FDC signal binding are all enforced on-chain.

The enclave controls strategy quality. It never controls fund safety.
EOF
