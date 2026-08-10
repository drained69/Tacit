// Package strategy holds the confidential allocation model.
//
// This file is the reason the project needs a TEE at all. Everything else in this repository is
// public: the contracts, the invariants, the signal source, the jq filter. The weights and
// thresholds below are not, and on a thin-liquidity chain a published rebalancing rule is a rule
// that gets front-run or copied within hours. Inside a Flare Confidential Compute enclave this
// code is executed without being observable, and the only thing that leaves is a signed
// allocation — which the vault then bounds on-chain regardless of what this code decides.
//
// Nothing here is trusted by the chain. If this file were replaced wholesale by an adversary, the
// vault's conservation, cap, turnover, price-band and signal-binding checks would still hold. That
// separation is deliberate: strategy quality lives here, fund safety lives in Solidity.
package strategy

import "math"

// MarketSignal mirrors the FDC-attested observation, in the same units the contract sees.
//
// The shape is fixed by what the FDC data providers will actually fetch — see SignalTypes.sol.
// Three return horizons rather than a high–low range is not a compromise: the *shape* of recent
// movement carries more information than its extent. A market down 2% steadily over 24h and one
// that round-tripped 2% in the last hour have identical ranges and should be treated differently.
type MarketSignal struct {
	PriceMicroUSD uint64
	Volume24hUSD  uint64
	Change1hBps   int64
	Change6hBps   int64
	Change24hBps  int64
}

// Venue describes one allocatable destination as the enclave sees it.
type Venue struct {
	Name          string
	RatePerYearBp uint64 // headline yield, basis points
	CapBps        uint16 // on-chain cap; the enclave respects it so plans are not wasted
	LiquidityBps  uint16 // fraction withdrawable on demand
}

// Params are the confidential tunables. In production these are baked into the enclave image
// whose hash is allowlisted on-chain, so changing them changes the attested identity.
type Params struct {
	// Volatility above which the model begins retreating to idle, in 24h-equivalent basis points.
	VolCeilingBps float64
	// Volatility below which the model is willing to deploy its full risk budget.
	VolFloorBps float64
	// Maximum fraction of the vault deployed to venues under the calmest conditions.
	MaxDeployedBps float64
	// Minimum deployment, so the vault does not sit entirely idle in normal turbulence.
	MinDeployedBps float64
	// How sharply a negative 24h move reduces deployment, per basis point of decline.
	DrawdownSensitivity float64
	// Volume below which liquidity is considered thin enough to justify holding back, in USD.
	ThinVolumeUSD float64
	// How much harder a move in the last hour counts than the same move over 24h.
	RecentMoveWeight float64
	// Weight applied to yield when splitting the risk budget between venues.
	YieldTilt float64
}

// DefaultParams is a deliberately conservative starting point. Treat these as the enclave's
// secret; they are checked in here only so the demo is reproducible.
func DefaultParams() Params {
	return Params{
		VolCeilingBps:       400,
		VolFloorBps:         80,
		MaxDeployedBps:      9000,
		MinDeployedBps:      2000,
		DrawdownSensitivity: 12,
		ThinVolumeUSD:       200_000_000,
		RecentMoveWeight:    2.5,
		YieldTilt:           1.4,
	}
}

// Decision is what the enclave reveals: per-venue targets plus the reference price it used.
type Decision struct {
	TargetBps        []uint16
	RefPriceMicroUSD uint64
	// Rationale is emitted for operator logs only. It intentionally describes *what* was decided,
	// never the parameters that produced it, so logs do not leak the model.
	Rationale string
}

// Compute produces an allocation from one attested observation.
//
// The shape of the model: realised volatility and 24h drawdown set a single "risk budget" — how
// much of the vault should be deployed at all. That budget is then split across venues by yield,
// tilted by a confidential exponent and clipped to each venue's on-chain cap and liquidity.
func Compute(sig MarketSignal, venues []Venue, p Params) Decision {
	if len(venues) == 0 {
		return Decision{TargetBps: nil, RefPriceMicroUSD: sig.PriceMicroUSD, Rationale: "no venues"}
	}

	deployedBps := riskBudget(sig, p)
	weights := yieldWeights(venues, p)

	targets := make([]uint16, len(venues))
	var assigned float64
	for i, v := range venues {
		want := deployedBps * weights[i]

		// Never propose past the on-chain cap: the vault would reject the whole plan, and a
		// rejected plan is strictly worse than a slightly conservative one.
		if capBps := float64(v.CapBps); want > capBps {
			want = capBps
		}
		// Respect venue liquidity too, so the vault is not left unable to serve redemptions.
		if liq := float64(v.LiquidityBps); liq < 10000 {
			if ceiling := liq * 0.9; want > ceiling {
				want = ceiling
			}
		}
		targets[i] = uint16(want)
		assigned += want
	}

	// Rounding down per venue can leave a few basis points unallocated. That remainder stays idle,
	// which is safe and legal, so it is left alone rather than force-fitted into the last venue.
	_ = assigned

	return Decision{
		TargetBps:        targets,
		RefPriceMicroUSD: sig.PriceMicroUSD,
		Rationale:        describe(sig, deployedBps),
	}
}

// usable reports whether an observation is coherent enough to act on at all.
//
// This gate exists ahead of the risk budget because `MinDeployedBps` is a floor for *turbulent*
// markets, not for *unknown* ones. Without it, a zeroed or malformed observation falls through to
// the minimum deployment and the vault quietly puts capital to work on data it cannot interpret —
// the one case where doing nothing is unambiguously correct.
func usable(sig MarketSignal) bool {
	return sig.PriceMicroUSD > 0 && sig.Volume24hUSD > 0
}

// riskBudget maps market conditions to a total deployment level in basis points.
func riskBudget(sig MarketSignal, p Params) float64 {
	if !usable(sig) {
		return 0
	}

	volBps := realisedVolBps(sig)

	// Linear ramp between the calm and stressed volatility bounds.
	var calmness float64
	switch {
	case volBps <= p.VolFloorBps:
		calmness = 1
	case volBps >= p.VolCeilingBps:
		calmness = 0
	default:
		calmness = 1 - (volBps-p.VolFloorBps)/(p.VolCeilingBps-p.VolFloorBps)
	}

	budget := p.MinDeployedBps + calmness*(p.MaxDeployedBps-p.MinDeployedBps)

	// A negative 24h move reduces deployment further; a positive one is not rewarded, because
	// chasing strength is how yield vaults get caught holding the top.
	if sig.Change24hBps < 0 {
		budget -= float64(-sig.Change24hBps) * p.DrawdownSensitivity
	}

	// A sharp move in the last hour is a live event rather than history. It is weighted harder
	// than the 24h figure precisely because it is the part the vault might still be walking into.
	if sig.Change1hBps < 0 {
		budget -= float64(-sig.Change1hBps) * p.DrawdownSensitivity * p.RecentMoveWeight
	}

	// Thin volume means exit liquidity is uncertain, so hold back proportionally.
	if v := float64(sig.Volume24hUSD); v < p.ThinVolumeUSD && p.ThinVolumeUSD > 0 {
		budget *= math.Max(0.35, v/p.ThinVolumeUSD)
	}

	return clamp(budget, 0, p.MaxDeployedBps)
}

// realisedVolBps estimates volatility from the dispersion of returns across three horizons.
//
// Each return is scaled to a common 24h basis before comparing — a 1% move in an hour is far more
// volatile than 1% over a day, and treating them as equal would systematically under-read exactly
// the fast moves that matter. Scaling by sqrt(time) is the standard convention.
//
// The estimate is the largest of the three, not the average: volatility is a risk measure, and the
// worst horizon is the one that should size the position.
func realisedVolBps(sig MarketSignal) float64 {
	if !usable(sig) {
		return math.Inf(1) // unusable data reads as maximum risk, not as calm
	}

	scaled := []float64{
		math.Abs(float64(sig.Change1hBps)) * math.Sqrt(24),
		math.Abs(float64(sig.Change6hBps)) * math.Sqrt(4),
		math.Abs(float64(sig.Change24hBps)),
	}

	worst := 0.0
	for _, v := range scaled {
		if v > worst {
			worst = v
		}
	}
	return worst
}

// yieldWeights splits the risk budget across venues, favouring yield super-linearly.
func yieldWeights(venues []Venue, p Params) []float64 {
	weights := make([]float64, len(venues))
	var total float64
	for i, v := range venues {
		w := math.Pow(float64(v.RatePerYearBp), p.YieldTilt)
		weights[i] = w
		total += w
	}
	if total == 0 {
		// No venue advertises yield: spread evenly rather than dividing by zero.
		for i := range weights {
			weights[i] = 1 / float64(len(venues))
		}
		return weights
	}
	for i := range weights {
		weights[i] /= total
	}
	return weights
}

func describe(sig MarketSignal, deployedBps float64) string {
	switch {
	case !usable(sig):
		return "unusable observation; holding reserves"
	case deployedBps < 3000:
		return "stressed conditions; majority held idle"
	case deployedBps < 6500:
		return "mixed conditions; partial deployment"
	default:
		return "calm conditions; full risk budget deployed"
	}
}

func clamp(v, lo, hi float64) float64 {
	return math.Min(math.Max(v, lo), hi)
}
