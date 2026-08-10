package main

import (
	"encoding/hex"
	"testing"

	"tacit/internal/ethabi"
	"tacit/internal/strategy"
)

func calmSignal() strategy.MarketSignal {
	// A real Coinpaprika XRP observation, matching test/EnclaveConformance.t.sol.
	return strategy.MarketSignal{
		PriceMicroUSD: 1_037_218,
		Volume24hUSD:  594_409_405,
		Change1hBps:   8,
		Change6hBps:   -54,
		Change24hBps:  -39,
	}
}

func twoVenues() []strategy.Venue {
	return []strategy.Venue{
		{Name: "conservative", RatePerYearBp: 800, CapBps: 6000, LiquidityBps: 10000},
		{Name: "aggressive", RatePerYearBp: 1500, CapBps: 6000, LiquidityBps: 10000},
	}
}

// The vault rejects any plan summing over 100%, so a strategy that over-allocates is not merely
// suboptimal — it is inert. This is the property most worth pinning.
func TestComputeNeverOverAllocates(t *testing.T) {
	p := strategy.DefaultParams()
	venues := twoVenues()

	cases := map[string]strategy.MarketSignal{
		"calm":       calmSignal(),
		"crash":      {PriceMicroUSD: 800_000, Volume24hUSD: 4_000_000_000, Change1hBps: -900, Change6hBps: -1800, Change24hBps: -2200},
		"melt-up":    {PriceMicroUSD: 1_500_000, Volume24hUSD: 6_000_000_000, Change1hBps: 600, Change6hBps: 1200, Change24hBps: 1800},
		"thin":       {PriceMicroUSD: 1_037_218, Volume24hUSD: 1_000_000, Change1hBps: 2, Change6hBps: 3, Change24hBps: 5},
		"degenerate": {},
	}

	for name, sig := range cases {
		t.Run(name, func(t *testing.T) {
			d := strategy.Compute(sig, venues, p)
			var sum uint16
			for i, target := range d.TargetBps {
				if target > venues[i].CapBps {
					t.Fatalf("venue %d target %d exceeds cap %d", i, target, venues[i].CapBps)
				}
				sum += target
			}
			if sum > 10000 {
				t.Fatalf("targets sum to %d, over 100%%", sum)
			}
		})
	}
}

// Volatility should reduce deployment. If this inverts, the vault leans in exactly when it should
// be stepping back.
func TestVolatilityReducesDeployment(t *testing.T) {
	p := strategy.DefaultParams()
	venues := twoVenues()

	calm := calmSignal()
	volatile := calmSignal()
	volatile.Change1hBps = 400
	volatile.Change6hBps = 900
	volatile.Change24hBps = 1500

	sum := func(d strategy.Decision) int {
		var s int
		for _, t := range d.TargetBps {
			s += int(t)
		}
		return s
	}

	calmTotal := sum(strategy.Compute(calm, venues, p))
	volatileTotal := sum(strategy.Compute(volatile, venues, p))

	if volatileTotal >= calmTotal {
		t.Fatalf("volatile deployment %d should be below calm %d", volatileTotal, calmTotal)
	}
}

// Unusable input must read as maximum risk, never as calm — a divide-by-zero that defaulted to
// "deploy everything" would be the worst possible failure mode.
func TestDegenerateSignalIsTreatedAsRisky(t *testing.T) {
	d := strategy.Compute(strategy.MarketSignal{}, twoVenues(), strategy.DefaultParams())
	for i, target := range d.TargetBps {
		if target != 0 {
			t.Fatalf("venue %d got %d on an empty signal; expected full retreat", i, target)
		}
	}
}

func TestHigherYieldVenueGetsMoreCapital(t *testing.T) {
	d := strategy.Compute(calmSignal(), twoVenues(), strategy.DefaultParams())
	if d.TargetBps[1] <= d.TargetBps[0] {
		t.Fatalf("expected the 15%% venue to outweigh the 8%% one, got %v", d.TargetBps)
	}
}

// Pins the exact vector asserted by test/EnclaveConformance.t.sol. If this changes, that Solidity
// test must be regenerated in the same commit or on-chain rebalances start failing as BadSigner.
func TestSignalHashMatchesSolidityVector(t *testing.T) {
	const want = "00cc5432c89bc2b487d78a3c3c3f74be53d507f523111c7c9c69f863a5402101"
	got := hex.EncodeToString(HashSignal(calmSignal()))
	if got != want {
		t.Fatalf("signal hash drifted from the Solidity vector:\n got  %s\n want %s", got, want)
	}
}

// abi.encodePacked pads ARRAY ELEMENTS to 32 bytes, unlike standalone value types. Packing two
// bytes per uint16 produces a valid signature over the wrong bytes, which on-chain surfaces only
// as an unexplained BadSigner revert.
func TestPackUint16SlicePadsToWords(t *testing.T) {
	packed := ethabi.PackUint16Slice([]uint16{1978, 4770})
	if len(packed) != 64 {
		t.Fatalf("expected 64 bytes (2 padded words), got %d", len(packed))
	}
	const want = "00000000000000000000000000000000000000000000000000000000000007ba" +
		"00000000000000000000000000000000000000000000000000000000000012a2"
	if got := hex.EncodeToString(packed); got != want {
		t.Fatalf("packing diverged from Solidity:\n got  %s\n want %s", got, want)
	}
}

// Returns are negative whenever XRP is down, so two's complement is on the hot path.
func TestNegativeInt256Encoding(t *testing.T) {
	w := ethabi.EncodeInt256(-54)
	const want = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffca"
	if got := hex.EncodeToString(w[:]); got != want {
		t.Fatalf("two's complement encoding wrong:\n got  %s\n want %s", got, want)
	}
}

func TestIdentityDerivation(t *testing.T) {
	raw, _ := hex.DecodeString("00000000000000000000000000000000000000000000000000000000000a11ce")
	key, err := ethabi.NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	const want = "e05fcc23807536bee418f142d19fa0d21bb0cff7"
	if got := hex.EncodeToString(key.Address[:]); got != want {
		t.Fatalf("address derivation wrong:\n got  %s\n want %s", got, want)
	}
}

// A fast move should read as more volatile than the same move spread over a day. Without the
// sqrt-time scaling the model would systematically under-react to exactly the moves that matter.
func TestRecentMoveCountsHarderThanSlowMove(t *testing.T) {
	p := strategy.DefaultParams()
	venues := twoVenues()

	slow := calmSignal()
	slow.Change1hBps, slow.Change6hBps, slow.Change24hBps = 0, 0, -300

	fast := calmSignal()
	fast.Change1hBps, fast.Change6hBps, fast.Change24hBps = -300, 0, 0

	sum := func(d strategy.Decision) int {
		var s int
		for _, t := range d.TargetBps {
			s += int(t)
		}
		return s
	}

	slowTotal := sum(strategy.Compute(slow, venues, p))
	fastTotal := sum(strategy.Compute(fast, venues, p))

	if fastTotal >= slowTotal {
		t.Fatalf("a 3%% move in one hour (%d) should deploy less than the same move over a day (%d)",
			fastTotal, slowTotal)
	}
}

// A crash must not somehow deploy more than a calm market.
func TestCrashDeploysLessThanCalm(t *testing.T) {
	p := strategy.DefaultParams()
	venues := twoVenues()

	crash := strategy.MarketSignal{
		PriceMicroUSD: 800_000, Volume24hUSD: 4_000_000_000,
		Change1hBps: -900, Change6hBps: -1800, Change24hBps: -2200,
	}

	sum := func(d strategy.Decision) int {
		var s int
		for _, t := range d.TargetBps {
			s += int(t)
		}
		return s
	}

	if sum(strategy.Compute(crash, venues, p)) >= sum(strategy.Compute(calmSignal(), venues, p)) {
		t.Fatal("crash conditions must not deploy more than calm conditions")
	}
}
