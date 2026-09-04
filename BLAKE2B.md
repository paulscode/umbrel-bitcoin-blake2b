# What this fork changes

A fork of [Retropex/umbrel-bitcoin](https://github.com/Retropex/umbrel-bitcoin),
which is itself a fork of
[getumbrel/umbrel-bitcoin](https://github.com/getumbrel/umbrel-bitcoin), running
Bitcoin Knots with the **BLAKE2b proof-of-work change** instead of the Knots that
follows the chain which kept SHA256d.

It backs the `paulscode-knots-blake2b` app in
[paulscode/umbrel-store](https://github.com/paulscode/umbrel-store).

The fork is kept deliberately small, so it keeps getting upstream's fixes. Six
changes, and nothing else:

## 1. One bitcoind, and it is ours

`apps/backend/Dockerfile` replaces ten `ghcr.io/retropex/bitcoin` stages with one
`paulscode/knots-blake2b`, which builds Knots from a pinned commit of
`bitcoinknots/bitcoin`. The commit is copied to `/etc/knots-pinned-commit` so a
running container can say exactly what it is; a tag cannot, because this is built
from source rather than from a signed release.

`AVAILABLE_BITCOIN_KNOTS_VERSIONS` in `libs/settings/settings.meta.ts` has one
entry to match, and the entry must equal the directory name under `/opt/bitcoind`
exactly, because the bitcoind manager builds the path from it.

**The nine removed versions are not older versions of this node.** They follow the
other side of the August 2026 split. Offering them in the version picker would not
be offering a downgrade, it would be offering a different chain, against a data
directory that cannot be used with it. The picker is kept, with one entry, for
when there is a second BLAKE2b build to choose between.

## 2. bitcoind's shared libraries

The images this replaced were built to be copied into an arbitrary runtime. Ours
is a normal dynamically-linked Debian build, and `node:20-slim` carries neither
libevent nor libsqlite3, so the runtime and dev stages install them. Without it
bitcoind exits immediately with `error while loading shared libraries:
libevent_core-2.1.so.7`.

Keep the list in step with the runtime stage of `paulscode/knots-blake2b-startos`'s
Dockerfile. `ldd /opt/bitcoind/current/bitcoind` is the check.

## 3. The chain lives at /data, not /data/bitcoin

`BITCOIN_DIR` and the two `.bitcoin` symlinks point at `/data`. The app has kept
its chain at the root of its data volume since it shipped, and moving it would
mean asking every existing install to relocate several gigabytes of blocks.

**The symlinks and `BITCOIN_DIR` must agree.** If they do not, the failure is not
a dangling link nobody notices: `bitcoind --version` creates the default datadir's
`wallets` directory on the way past, so it fails outright, and the bitcoind
manager probes the binary that way to fill the version banner. The symptom is a
working node whose header says "Bitcoin Knots" with no version after it.

## 4. Mainnet only

The Bitcoin Network setting has one option. BLAKE2b is scheduled on mainnet in
this build and nowhere usable: regtest takes its activation height from
`-testactivationheight`, which this app does not pass, so a regtest node here
follows SHA256d forever; testnet4's compiled activation height does not match the
live testnet4 fork, so a node there stalls one block below it looking healthy; and
signet and testnet3 have no BLAKE2b schedule at all.

Every one of those is a node that runs, connects, and quietly does the wrong
thing, which is worse than an option that is not there.

## 5. Pruned by default

`prune` defaults to 5 GB rather than 0. This node is meant to run beside a node on
the other chain, and two full copies do not fit on the machines it is for.

## 6. blocknotify points at the BLAKE2b gateway

`http://paulscode-datum-blake2b_gateway_1:7152/NOTIFY` rather than the official
Datum app. That one mines the chain which kept SHA256d, and telling it about this
chain's blocks would be notifying the wrong gateway.

The `case 'datum'` arm also regains its missing `break`. Without it the key falls
through to the default arm and `datum=1` is written into `bitcoin.conf`; bitcoind
only warns ("Ignoring unknown configuration value datum"), so nothing breaks, but
the warning is on every start. Lost upstream in the revert of the `consensusrules`
option, which took the `break` with it. Worth sending back.

## Also worth sending upstream

`.dockerignore` now excludes `**/*.tsbuildinfo`. It already excluded `**/dist`,
but `apps/backend/tsconfig.tsbuildinfo` sits outside `dist` and was copied into
the build context. tsc then reads it, concludes everything is up to date, emits
nothing, and the image build fails at
`COPY --from=app-builder /repo/apps/backend/dist` with "not found". It only bites
when someone has run `tsc -b` in their working tree first, which is exactly what
anyone changing `libs/settings` does.

## Building

```bash
docker build -f apps/backend/Dockerfile --target runtime \
  -t paulscode/umbrel-bitcoin-blake2b:<tag> .
```

Multi-arch, for publishing:

```bash
docker buildx build --builder aw-release --platform linux/amd64,linux/arm64 \
  -f apps/backend/Dockerfile --target runtime \
  -t paulscode/umbrel-bitcoin-blake2b:<tag> --push .
```

The `paulscode/knots-blake2b` tag in the Dockerfile has to exist for the
architectures being built, so publish that image first.

## Verifying a build

```bash
docker run -d --rm --name uitest --user 1000:1000 -v /tmp/uidata:/data \
  -e RPC_USER=umbrel -e RPC_PASS=testpass -e APPS_SUBNET=10.99.0.0/16 \
  -e P2P_PORT=18444 -e P2P_WHITEBIND_PORT=18445 -e RPC_PORT=18443 \
  -e TOR_HOST=10.99.0.72 -e I2P_HOST=10.99.0.73 -e I2P_SAM_PORT=7656 \
  -e BITCOIND_IP=<the container's own IP> -p 13000:3000 \
  paulscode/umbrel-bitcoin-blake2b:<tag>
curl -s localhost:13000/api/bitcoind/version   # expect Bitcoin Knots v29.4.1.knots20260508
curl -s localhost:13000/api/widget/sync
```

**`BITCOIND_IP` must be the container's real address, not 127.0.0.1.** The conf
generator writes `rpcbind=$BITCOIND_IP` and `rpcbind=127.0.0.1`; with both set to
loopback bitcoind tries to bind the same endpoint twice and exits with "Address
already in use". `I2P_HOST` must also be set, or `-i2psam=undefined:undefined`
aborts startup. Both of those are set by the app's compose file and are only traps
when running the image by hand.

Then confirm it is really the fork:

```bash
docker exec uitest /opt/bitcoind/current/bitcoin-cli \
  -rpcconnect=<ip> -rpcport=18443 -rpcuser=umbrel -rpcpassword=testpass \
  getdeploymentinfo | grep -A2 blake2b     # expect "height": 961640
```

## The RPC cookie still exists

The app writes a salted `rpcauth=` line and sets neither `rpcpassword` nor
`rpcuser`, so bitcoind still generates its `.cookie`. That matters: apps that
authenticate to this node by reading the cookie out of a read-only mount keep
working unchanged across this switch. Verified on a running container.
