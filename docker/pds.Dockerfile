# rsky-pds, built from the vendored tree with this stack's patches applied.
#
# rsky's own recipe builds straight from a GitHub commit, which leaves nowhere
# for a patch to land. Building from `vendor/rsky` — the same commit — keeps the
# source identical while letting `vendor/patches` apply, which is the sanctioned
# shape for a vendored change: reproducible, and never a working-tree edit
# inside the submodule. See `vendor/patches/README.md` for what each patch fixes.
#
# Both inputs arrive as named build contexts (`additional_contexts` in the
# compose file):
#   rsky    — vendor/rsky
#   patches — vendor/patches
FROM rust:1-bookworm AS builder

# `patch` is not in the Rust image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends patch && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/rsky
COPY --from=rsky . .
# A bind mount, so the patch files never become part of a layer. `--forward`
# makes a re-applied patch a skip rather than a prompt.
RUN --mount=type=bind,from=patches,target=/patches \
    for patch in /patches/*.patch; do \
      echo "=== applying $(basename "$patch")"; \
      patch -p1 --batch --forward --no-backup-if-mismatch -i "$patch" || exit 1; \
    done

ARG CARGO_BUILD_JOBS=default
RUN --mount=type=cache,id=rsky-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=rsky-pds-target,target=/usr/src/rsky/target \
    cargo build --release --package rsky-pds -j "$CARGO_BUILD_JOBS" && \
    cp target/release/rsky-pds /usr/local/bin/rsky-pds

FROM debian:bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/rsky
COPY --from=builder /usr/local/bin/rsky-pds rsky-pds
LABEL org.opencontainers.image.source=https://github.com/blacksky-algorithms/rsky
# Storage is sqlite + local disk (or S3): mount a volume at PDS_DATA_DIRECTORY.
# Required env: PDS_DATA_DIRECTORY, PDS_HOSTNAME, PDS_SERVICE_DID,
# PDS_JWT_KEY_K256_PRIVATE_KEY_HEX, PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX,
# PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX, PDS_DPOP_SECRET, PDS_ADMIN_PASS.
# See rsky-pds/README.md for the full reference.
CMD ["sh", "-c", "ROCKET_ADDRESS=0.0.0.0 ROCKET_PORT=${PORT:-2583} ./rsky-pds"]
