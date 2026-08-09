package main

import (
	"encoding/hex"
	"testing"

	"tacit/internal/ethabi"
	"tacit/internal/strategy"
)

func calmSignal() strategy.MarketSignal {
	return strategy.MarketSignal{
		LastMicroUSD: 1_038_910,
		VWAPMicroUSD: 1_040_130,
		HighMicroUSD: 1_048_060,
		LowMicroUSD:  1_030_290,
		VolumeXRP:    8_957_657,
		ChangeBps:    -22,
		ObsTimestamp: 1_786_281_701,
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
		"crash":      {LastMicroUSD: 800_000, VWAPMicroUSD: 900_000, HighMicroUSD: 1_100_000, LowMicroUSD: 780_000, VolumeXRP: 40_000_000, ChangeBps: -2200, ObsTimestamp: 1},
		"melt-up":    {LastMicroUSD: 1_500_000, VWAPMicroUSD: 1_400_000, HighMicroUSD: 1_520_000, LowMicroUSD: 1_300_000, VolumeXRP: 60_000_000, ChangeBps: 1800, ObsTimestamp: 1},
		"thin":       {LastMicroUSD: 1_038_910, VWAPMicroUSD: 1_040_130, HighMicroUSD: 1_041_000, LowMicroUSD: 1_039_000, VolumeXRP: 50_000, ChangeBps: 5, ObsTimestamp: 1},
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
	volatile.HighMicroUSD = 1_200_000
	volatile.LowMicroUSD = 900_000

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
	const want = "992f847713d8504d9117a34c7d2490129b6e4475518f0a4f8df225eeb1781ec2"
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

// changeBps is negative whenever XRP is down on the day, so two's complement is on the hot path.
func TestNegativeInt256Encoding(t *testing.T) {
	w := ethabi.EncodeInt256(-22)
	const want = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffea"
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
