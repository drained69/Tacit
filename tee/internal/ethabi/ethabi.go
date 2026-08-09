// Package ethabi provides the minimal Ethereum encoding primitives the enclave needs.
//
// The enclave deliberately does not depend on go-ethereum. It needs keccak256, secp256k1 signing
// with a recovery id, and ABI encoding of a handful of static types — perhaps 150 lines of real
// work. Pulling in the full client for that would add hundreds of megabytes of transitive
// dependencies to an image whose hash has to be reproducible and allowlisted on-chain. A smaller
// image is a smaller thing to audit and a smaller thing to attest.
//
// Everything here is byte-compatible with `SignalTypes.sol`.
package ethabi

import (
	"fmt"
	"math/big"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
)

// Word is a single 32-byte ABI slot.
type Word [32]byte

// Keccak256 hashes the concatenation of its arguments.
func Keccak256(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// EncodeUint256 left-pads an unsigned value into one ABI word.
func EncodeUint256(v *big.Int) Word {
	var w Word
	v.FillBytes(w[:])
	return w
}

// EncodeInt256 encodes a signed value as two's complement.
//
// `changeBps` is genuinely negative whenever XRP is down on the day, so this path is exercised on
// most real observations, not just in tests.
func EncodeInt256(v int64) Word {
	var w Word
	if v >= 0 {
		big.NewInt(v).FillBytes(w[:])
		return w
	}
	// two's complement over 256 bits: 2^256 + v
	mod := new(big.Int).Lsh(big.NewInt(1), 256)
	mod.Add(mod, big.NewInt(v))
	mod.FillBytes(w[:])
	return w
}

// EncodeAddress right-aligns a 20-byte address into one word.
func EncodeAddress(addr [20]byte) Word {
	var w Word
	copy(w[12:], addr[:])
	return w
}

// EncodeBytes32 passes a 32-byte value through unchanged.
func EncodeBytes32(b []byte) (Word, error) {
	var w Word
	if len(b) != 32 {
		return w, fmt.Errorf("expected 32 bytes, got %d", len(b))
	}
	copy(w[:], b)
	return w, nil
}

// Concat flattens words into the calldata-style byte string `abi.encode` produces for static types.
func Concat(words ...Word) []byte {
	out := make([]byte, 0, len(words)*32)
	for _, w := range words {
		out = append(out, w[:]...)
	}
	return out
}

// PackUint16Slice reproduces `abi.encodePacked(uint16[])`.
//
// The subtlety that matters: `abi.encodePacked` does *not* pad standalone value types, but it
// *does* pad array elements to a full 32-byte word. So a two-element uint16[] encodes to 64 bytes,
// not 4. Packing two bytes per element — the intuitive reading of "packed" — produces a different
// hash, a valid signature over the wrong bytes, and a `BadSigner` revert with no clue as to why.
// Verified against Solidity 0.8.25 rather than taken from memory; see EnclaveConformance.t.sol.
//
// The length prefix is still omitted, which is what distinguishes this from `abi.encode`.
func PackUint16Slice(vs []uint16) []byte {
	out := make([]byte, 0, len(vs)*32)
	for _, v := range vs {
		var word Word
		word[30] = byte(v >> 8)
		word[31] = byte(v)
		out = append(out, word[:]...)
	}
	return out
}

// EthSignedMessageHash applies the EIP-191 personal-sign prefix.
func EthSignedMessageHash(digest []byte) []byte {
	return Keccak256([]byte("\x19Ethereum Signed Message:\n32"), digest)
}

// PrivateKey wraps a secp256k1 key and caches its Ethereum address.
type PrivateKey struct {
	key     *secp256k1.PrivateKey
	Address [20]byte
}

// NewPrivateKey builds a key from 32 raw bytes and derives its address.
func NewPrivateKey(raw []byte) (*PrivateKey, error) {
	if len(raw) != 32 {
		return nil, fmt.Errorf("private key must be 32 bytes, got %d", len(raw))
	}
	key := secp256k1.PrivKeyFromBytes(raw)

	// Address = last 20 bytes of keccak256 over the uncompressed public key, minus its 0x04 tag.
	pub := key.PubKey().SerializeUncompressed()
	sum := Keccak256(pub[1:])

	var addr [20]byte
	copy(addr[:], sum[12:])
	return &PrivateKey{key: key, Address: addr}, nil
}

// Sign produces a 65-byte [R || S || V] signature that Solidity's `ecrecover` accepts.
func (p *PrivateKey) Sign(hash []byte) ([]byte, error) {
	if len(hash) != 32 {
		return nil, fmt.Errorf("hash must be 32 bytes, got %d", len(hash))
	}

	// SignCompact returns [V || R || S] with V in 27..30 and, for a compressed key, +4.
	compact := ecdsa.SignCompact(p.key, hash, false)
	if len(compact) != 65 {
		return nil, fmt.Errorf("unexpected compact signature length %d", len(compact))
	}

	sig := make([]byte, 65)
	copy(sig[0:64], compact[1:])

	// Normalise the recovery id to the 27/28 that ecrecover expects.
	v := compact[0]
	if v >= 31 {
		v -= 4
	}
	sig[64] = v
	return sig, nil
}
