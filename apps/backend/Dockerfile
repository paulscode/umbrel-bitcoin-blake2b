# Multi-stage Dockerfile for Umbrel Bitcoin Node app
#
# * dev: `docker compose up` builds the **dev** stage only
# hot-reloading backend container (the UI dev server lives in its own
# apps/ui/Dockerfile; both share a hoisted node_modules volume in the compose file).
#
# * production: `docker build ...` produces a single self-contained image with backend + UI + bitcoind
# single final image that contains
#  – compiled backend
#  – bundled React UI (Vite output → dist/public)
#  – compiled shared libs (libs/settings, libs/shared-types)
#  – bitcoind + bitcoin-cli binaries

###########################################
# Bitcoind
###########################################
# The one bitcoind this image ships: Bitcoin Knots carrying the BLAKE2b
# proof-of-work change, from paulscode/knots-blake2b-startos. That image builds it
# from a pinned commit of bitcoinknots/bitcoin (the tag v29.4.1.knots20260508) and
# records the commit at /etc/knots-pinned-commit.
#
# Upstream ships ten and offers a picker. This ships one, and the reason is not
# tidiness. The other nine follow the chain that kept SHA256d. Selecting one would
# not be downgrading, it would be walking onto the other side of the August 2026
# split, onto a chain whose blocks this node's data directory cannot be used with.
# The picker is kept, with one entry, for when there is a second BLAKE2b build to
# choose between.
#
# Pinned by tag rather than digest, unlike the images this replaces, because it is
# ours and is rebuilt as part of the same release. The commit it was built from is
# copied in below and is the thing that actually identifies it.
FROM paulscode/knots-blake2b:1.0.9 AS bitcoind_blake2b

##########################################################
# Dependencies layer — install every workspace deps
# Functions as a shared cache for dev & app-builder stages
##########################################################
FROM node:20-slim AS deps
WORKDIR /repo

# Copy only dependency manifests to keep this layer cache-friendly
COPY package*.json ./
COPY apps/backend/package*.json apps/backend/
COPY apps/ui/package*.json apps/ui/

RUN npm ci --workspaces --include-workspace-root --install-strategy=hoisted

# Add npm binaries to PATH so subsequent stages can invoke tsc / vite / etc.
ENV PATH="/repo/node_modules/.bin:$PATH"

####################################################
# DEV-ONLY build stage: Backend hot-reload image
# - Not referenced by later COPY --from=… steps,
#   so it’s skipped during a plain `docker build`.
# - `docker compose up` targets it via `target: dev`
#   in the docker-compose.yml file.
####################################################
FROM deps AS dev
WORKDIR /repo/apps/backend

VOLUME /data

# bitcoind's shared libraries.
#
# The images this fork replaced needed none: they were built to be copied into an
# arbitrary runtime. Ours is a normal dynamically-linked Debian build, and
# node:20-slim carries neither libevent nor libsqlite3, so without this bitcoind
# exits immediately with
# "error while loading shared libraries: libevent_core-2.1.so.7".
#
# Both bookworm, so these are the same package names the node image installs.
# Keep this list in step with the runtime stage of
# paulscode/knots-blake2b-startos's Dockerfile; `ldd` on the binary is the check.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libevent-core-2.1-7 libevent-extra-2.1-7 libevent-pthreads-2.1-7 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# bitcoind binaries
RUN mkdir -p /opt/bitcoind/v29.4.1.knots20260508-blake2b
COPY --from=bitcoind_blake2b /usr/local/bin/bitcoind    /opt/bitcoind/v29.4.1.knots20260508-blake2b/bitcoind
COPY --from=bitcoind_blake2b /usr/local/bin/bitcoin-cli /opt/bitcoind/v29.4.1.knots20260508-blake2b/bitcoin-cli
# The commit that binary was built from, so a running container can say exactly
# what it is. The tag alone cannot: this is built from source, not from a signed
# release, and a tag can be moved.
COPY --from=bitcoind_blake2b /etc/knots-pinned-commit   /etc/knots-pinned-commit

# Give 1000:1000 write permisions to /opt/bitcoind (just directory) so we can flip the symbolic link while the container runs as 1000:1000
RUN chown 1000:1000 /opt/bitcoind

# Symbolic link for default bitcoind binary
RUN ln -sfn /opt/bitcoind/v29.4.1.knots20260508-blake2b /opt/bitcoind/current
RUN ln -sfn /opt/bitcoind/current/bitcoind    /usr/local/bin/bitcoind
RUN ln -sfn /opt/bitcoind/current/bitcoin-cli /usr/local/bin/bitcoin-cli

# Symlink for datadir so bitcoin-cli auto-finds the RPC cookie
# Allows exec'ing bitcoin-cli inside the container without specifying credentials
#
# /data, not /data/bitcoin, and it MUST agree with BITCOIN_DIR below. Upstream
# puts the chain in a `bitcoin` subdirectory; this app has kept it at the root of
# its data volume since it shipped, and moving it would mean asking every
# existing install to relocate several gigabytes of blocks.
#
# Getting this wrong is not a dangling symlink nobody notices. `bitcoind
# --version` creates the default datadir's `wallets` directory on the way past,
# so it fails outright on a symlink pointing nowhere. The bitcoind manager probes
# the binary that way to fill the version banner, catches the failure, and reports
# "unknown", which is how this was found: a working node with no version in its
# header.
RUN ln -sfn /data /root/.bitcoin
RUN mkdir -p /home/node \
 && ln -sfn /data /home/node/.bitcoin \
 && chown -h 1000:1000 /home/node/.bitcoin

CMD ["npm","run","dev"]

#################################################
# app-builder stage
#################################################
FROM deps AS app-builder
WORKDIR /repo
COPY . .

# build shared libraries (libs/*/dist)
# build backend (ts → js) (apps/backend/dist)
# bundle UI (vite build) (apps/ui/dist)
RUN tsc -b libs/shared-types libs/settings apps/backend \
 && npm run --workspace apps/ui build

########################################
# runtime stage — final production image
########################################
FROM node:20-slim AS runtime
WORKDIR /app

# Install production dependencies only
# Note: import-map lives in package.json, so is also needed so Node can resolve "#settings/#types"
  COPY package*.json ./
  COPY apps/backend/package*.json apps/backend/
  RUN npm ci --omit=dev --install-strategy=hoisted --ignore-scripts

# Backend JS bundle
COPY --from=app-builder /repo/apps/backend/dist ./dist

# Pre-bundled React UI → backend serves this from /public/*
COPY --from=app-builder /repo/apps/ui/dist ./dist/public

# Compiled shared libs (referenced at runtime via import-map)
COPY --from=app-builder /repo/libs/settings/dist ./libs/settings/dist
COPY --from=app-builder /repo/libs/shared-types/dist ./libs/shared-types/dist

# bitcoind's shared libraries.
#
# The images this fork replaced needed none: they were built to be copied into an
# arbitrary runtime. Ours is a normal dynamically-linked Debian build, and
# node:20-slim carries neither libevent nor libsqlite3, so without this bitcoind
# exits immediately with
# "error while loading shared libraries: libevent_core-2.1.so.7".
#
# Both bookworm, so these are the same package names the node image installs.
# Keep this list in step with the runtime stage of
# paulscode/knots-blake2b-startos's Dockerfile; `ldd` on the binary is the check.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libevent-core-2.1-7 libevent-extra-2.1-7 libevent-pthreads-2.1-7 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# bitcoind binaries
RUN mkdir -p /opt/bitcoind/v29.4.1.knots20260508-blake2b
COPY --from=bitcoind_blake2b /usr/local/bin/bitcoind    /opt/bitcoind/v29.4.1.knots20260508-blake2b/bitcoind
COPY --from=bitcoind_blake2b /usr/local/bin/bitcoin-cli /opt/bitcoind/v29.4.1.knots20260508-blake2b/bitcoin-cli
# The commit that binary was built from, so a running container can say exactly
# what it is. The tag alone cannot: this is built from source, not from a signed
# release, and a tag can be moved.
COPY --from=bitcoind_blake2b /etc/knots-pinned-commit   /etc/knots-pinned-commit

# Give 1000:1000 write permisions to /opt/bitcoind (just directory) so we can flip the symbolic link while the container runs as 1000:1000
RUN chown 1000:1000 /opt/bitcoind

# Symbolic link for default bitcoind binary
RUN ln -sfn /opt/bitcoind/v29.4.1.knots20260508-blake2b /opt/bitcoind/current
RUN ln -sfn /opt/bitcoind/current/bitcoind    /usr/local/bin/bitcoind
RUN ln -sfn /opt/bitcoind/current/bitcoin-cli /usr/local/bin/bitcoin-cli

# Symlink for datadir so bitcoin-cli auto-finds the RPC cookie
# Allows exec'ing bitcoin-cli inside the container without specifying credentials
#
# /data, not /data/bitcoin, and it MUST agree with BITCOIN_DIR below. Upstream
# puts the chain in a `bitcoin` subdirectory; this app has kept it at the root of
# its data volume since it shipped, and moving it would mean asking every
# existing install to relocate several gigabytes of blocks.
#
# Getting this wrong is not a dangling symlink nobody notices. `bitcoind
# --version` creates the default datadir's `wallets` directory on the way past,
# so it fails outright on a symlink pointing nowhere. The bitcoind manager probes
# the binary that way to fill the version banner, catches the failure, and reports
# "unknown", which is how this was found: a working node with no version in its
# header.
RUN ln -sfn /data /root/.bitcoin
RUN mkdir -p /home/node \
 && ln -sfn /data /home/node/.bitcoin \
 && chown -h 1000:1000 /home/node/.bitcoin

 RUN apt-get update && apt-get install -y \
    curl


ENV NODE_ENV=production

# Data dirs inside /data.
#
# BITCOIN_DIR must match the .bitcoin symlinks above; see the note there. The
# app's compose file sets both of these explicitly too, so the choice is visible
# where someone reads the app rather than only here.
ENV BITCOIN_DIR=/data
ENV APP_STATE_DIR=/data/app

# 3000 = HTTP API, 8332 = RPC, 8333 = P2P
EXPOSE 3000 8332 8333
# app and bitcoind data
VOLUME /data

CMD ["node", "dist/server.js"]