// Command tacit-tee is the TacitVault confidential rebalancing extension.
//
// It follows the Flare Confidential Compute extension contract: a POST /action handler that
// receives an instruction, does its work, and returns a result signed by the machine's TEE
// identity, plus an /info endpoint exposing that identity.
//
// # Running it
//
// Inside FCC the process runs in a Confidential Space VM and the signing key is derived from the
// TEE. For local development and for the demo it runs as a plain HTTP service with a key from
// TACIT_TEE_KEY. Which mode is active is reported by /info as `simulated` and printed at
// startup — a simulated enclave that pretends otherwise is worse than no enclave at all.
//
// # What the chain trusts
//
// Nothing this service says is taken on faith. The vault checks conservation, venue caps,
// turnover, an FTSO price band and the FDC signal binding before applying any allocation. This
// service therefore controls *strategy quality*, never *fund safety*.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"tacit/internal/ethabi"
	"tacit/internal/strategy"
)

const (
	// Custom FCC op type. Deliberately not prefixed `F_` and not a reserved command name
	// (PAY, PROVE, VRF, KEY_*, TEE_*): a custom type that reuses a reserved command passes local
	// validation and is then silently never delivered, with no error surfaced anywhere.
	opType  = "TACIT"
	command = "REBALANCE"

	planTypeSignature = "RebalancePlan(uint256 nonce,uint64 deadline,bytes32 signalHash," +
		"uint256 refPriceMicroUsd,uint16[] targetBps)"
)

type venueInput struct {
	Name          string `json:"name"`
	RatePerYearBp uint64 `json:"ratePerYearBp"`
	CapBps        uint16 `json:"capBps"`
	LiquidityBps  uint16 `json:"liquidityBps"`
}

type actionRequest struct {
	OpType   string `json:"opType"`
	Command  string `json:"command"`
	ChainID  uint64 `json:"chainId"`
	Vault    string `json:"vault"`
	Nonce    uint64 `json:"nonce"`
	Deadline uint64 `json:"deadline"`

	Signal strategy.MarketSignal `json:"signal"`
	Venues []venueInput          `json:"venues"`
}

type actionResponse struct {
	Nonce            uint64   `json:"nonce"`
	Deadline         uint64   `json:"deadline"`
	SignalHash       string   `json:"signalHash"`
	RefPriceMicroUSD uint64   `json:"refPriceMicroUsd"`
	TargetBps        []uint16 `json:"targetBps"`
	Signature        string   `json:"signature"`
	Identity         string   `json:"identity"`
	Rationale        string   `json:"rationale"`
	Simulated        bool     `json:"simulated"`
}

type server struct {
	key       *ethabi.PrivateKey
	simulated bool
	params    strategy.Params
}

func main() {
	keyHex := strings.TrimPrefix(os.Getenv("TACIT_TEE_KEY"), "0x")
	if keyHex == "" {
		log.Fatal("TACIT_TEE_KEY is required (inside FCC this is the TEE-derived identity)")
	}
	raw, err := hex.DecodeString(keyHex)
	if err != nil {
		log.Fatalf("TACIT_TEE_KEY is not valid hex: %v", err)
	}
	key, err := ethabi.NewPrivateKey(raw)
	if err != nil {
		log.Fatalf("bad TACIT_TEE_KEY: %v", err)
	}

	// Mirrors Coston2's own flag. It changes no behaviour; it only keeps the claim made to
	// operators and to the demo accurate.
	simulated := strings.EqualFold(os.Getenv("SIMULATED_TEE"), "true")

	s := &server{key: key, simulated: simulated, params: strategy.DefaultParams()}

	mux := http.NewServeMux()
	mux.HandleFunc("/info", s.handleInfo)
	mux.HandleFunc("/action", s.handleAction)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	addr := os.Getenv("TACIT_LISTEN")
	if addr == "" {
		addr = ":8080"
	}

	log.Printf("tacit-tee listening on %s", addr)
	log.Printf("  identity : %s", s.identityHex())
	log.Printf("  op type  : %s/%s", opType, command)
	if simulated {
		log.Printf("  MODE     : SIMULATED (attestation is not real; on Coston2 this is expected)")
	} else {
		log.Printf("  MODE     : PRODUCTION (attestation expected to be verifiable)")
	}

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func (s *server) identityHex() string {
	return "0x" + hex.EncodeToString(s.key.Address[:])
}

func (s *server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"identity":  s.identityHex(),
		"opType":    opType,
		"command":   command,
		"simulated": s.simulated,
	})
}

func (s *server) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	var req actionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("bad request body: %v", err))
		return
	}
	if req.OpType != "" && req.OpType != opType {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown opType %q", req.OpType))
		return
	}
	if req.Command != "" && req.Command != command {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("unknown command %q", req.Command))
		return
	}
	vault, err := parseAddress(req.Vault)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Venues) == 0 {
		writeErr(w, http.StatusBadRequest, "at least one venue is required")
		return
	}

	venues := make([]strategy.Venue, len(req.Venues))
	for i, v := range req.Venues {
		venues[i] = strategy.Venue{
			Name:          v.Name,
			RatePerYearBp: v.RatePerYearBp,
			CapBps:        v.CapBps,
			LiquidityBps:  v.LiquidityBps,
		}
	}

	// --- the confidential step ---
	decision := strategy.Compute(req.Signal, venues, s.params)

	signalHash := HashSignal(req.Signal)

	deadline := req.Deadline
	if deadline == 0 {
		deadline = uint64(time.Now().Add(30 * time.Minute).Unix())
	}

	planHash, err := HashPlan(req.Nonce, deadline, signalHash, decision.RefPriceMicroUSD, decision.TargetBps)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("hash plan: %v", err))
		return
	}

	digest, err := ReplayDigest(req.ChainID, vault, planHash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("digest: %v", err))
		return
	}

	sig, err := s.key.Sign(ethabi.EthSignedMessageHash(digest))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("sign: %v", err))
		return
	}

	writeJSON(w, http.StatusOK, actionResponse{
		Nonce:            req.Nonce,
		Deadline:         deadline,
		SignalHash:       "0x" + hex.EncodeToString(signalHash),
		RefPriceMicroUSD: decision.RefPriceMicroUSD,
		TargetBps:        decision.TargetBps,
		Signature:        "0x" + hex.EncodeToString(sig),
		Identity:         s.identityHex(),
		Rationale:        decision.Rationale,
		Simulated:        s.simulated,
	})
}

// --- hashing, kept byte-identical to SignalTypes.sol ---

// HashSignal mirrors `SignalTypes.hashSignal`.
func HashSignal(s strategy.MarketSignal) []byte {
	return ethabi.Keccak256(ethabi.Concat(
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.LastMicroUSD)),
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.VWAPMicroUSD)),
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.HighMicroUSD)),
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.LowMicroUSD)),
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.VolumeXRP)),
		ethabi.EncodeInt256(s.ChangeBps),
		ethabi.EncodeUint256(new(big.Int).SetUint64(s.ObsTimestamp)),
	))
}

var planTypeHash = ethabi.Keccak256([]byte(planTypeSignature))

// HashPlan mirrors `SignalTypes.hashPlan`.
func HashPlan(nonce, deadline uint64, signalHash []byte, refPrice uint64, targets []uint16) ([]byte, error) {
	typeWord, err := ethabi.EncodeBytes32(planTypeHash)
	if err != nil {
		return nil, err
	}
	signalWord, err := ethabi.EncodeBytes32(signalHash)
	if err != nil {
		return nil, err
	}
	targetsWord, err := ethabi.EncodeBytes32(ethabi.Keccak256(ethabi.PackUint16Slice(targets)))
	if err != nil {
		return nil, err
	}

	return ethabi.Keccak256(ethabi.Concat(
		typeWord,
		ethabi.EncodeUint256(new(big.Int).SetUint64(nonce)),
		ethabi.EncodeUint256(new(big.Int).SetUint64(deadline)), // uint64 still occupies a full word
		signalWord,
		ethabi.EncodeUint256(new(big.Int).SetUint64(refPrice)),
		targetsWord,
	)), nil
}

// ReplayDigest binds a plan to one chain and one vault, so a signature cannot be replayed against
// a different deployment of the same contract.
func ReplayDigest(chainID uint64, vault [20]byte, planHash []byte) ([]byte, error) {
	planWord, err := ethabi.EncodeBytes32(planHash)
	if err != nil {
		return nil, err
	}
	return ethabi.Keccak256(ethabi.Concat(
		ethabi.EncodeUint256(new(big.Int).SetUint64(chainID)),
		ethabi.EncodeAddress(vault),
		planWord,
	)), nil
}

// --- small helpers ---

func parseAddress(s string) ([20]byte, error) {
	var out [20]byte
	raw, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil || len(raw) != 20 {
		return out, fmt.Errorf("vault must be a 20-byte hex address, got %q", s)
	}
	copy(out[:], raw)
	return out, nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
