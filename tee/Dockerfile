# Reproducible image for the TacitVault FCC extension.
#
# The image hash is what gets allowlisted on-chain (`allow-tee-version`), so the build must be
# byte-reproducible: pinned base digests, no timestamps in the binary, no VCS stamping. Two builds
# of the same commit must produce the same hash, or registration is meaningless.
#
#   docker build -t tacit-tee:latest ./tee
#   docker run --rm -p 8080:8080 -e TACIT_TEE_KEY=... -e SIMULATED_TEE=true tacit-tee

FROM golang:1.23-alpine AS build

WORKDIR /src

# Dependencies first so the layer caches independently of source edits.
COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .

# -trimpath strips local paths; -buildvcs=false keeps git state out of the binary. Both are
# required for reproducibility. CGO is off so the result is a static binary.
ENV CGO_ENABLED=0 GOOS=linux
RUN go build \
      -trimpath \
      -buildvcs=false \
      -ldflags="-s -w -buildid=" \
      -o /out/tacit-tee .

# Distroless: no shell, no package manager, minimal surface to attest.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/tacit-tee /tacit-tee

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/tacit-tee"]
