# File-level object-cache prototype

This experiment compares package tarballs, individual compressed content-addressed
files, and batches of missing files. It changes no production drvjs behavior.
All three paths run the same release-built Rust assembler.

## Results: November 16, 2026

**This prototype did not outperform tarballs.** The package-level file cache
reduced bytes for a dependency update, but increased total installation time.
These are local simulated-transport results, not cloud measurements.

The workload is Vue v3.5.22's compiler-sfc closure: 98 input archives, 97 installed
registry instances, and six importers including the synthetic root. It contains
1,351 unique stored objects including package indexes. The machine had four
cgroup-limited CPU cores and 12 GiB RAM on an Intel Xeon Platinum 8581C.

Medians of five trials; seconds from fetch start through verified Rust assembly:

| Added request delay | Scenario | Tarballs | Individual files | Batches |
| --- | --- | ---: | ---: | ---: |
| 0 ms | Cold client cache | 0.204 | 1.364 | 1.438 |
| 0 ms | Source edit | 0.118 | 0.279 | 0.279 |
| 0 ms | PostCSS update | 0.120 | 0.306 | 0.304 |
| 20 ms | Cold client cache | 0.257 | 1.919 | 1.435 |
| 20 ms | Source edit | 0.116 | 0.281 | 0.275 |
| 20 ms | PostCSS update | 0.135 | 0.319 | 0.342 |

| Transport | Cold requests | Cold payload | Update requests | Update payload |
| --- | ---: | ---: | ---: | ---: |
| Tarballs | 98 | 3,826,997 B | 1 | 47,806 B |
| Individual files | 1,351 | 4,146,752 B | 23 | 36,487 B |
| Batches | 11 | 3,850,617 B | 2 | 29,706 B |

The batch update transferred 37.9% fewer response bytes than tarballs, but still
took 2.54 times as long at 20 ms. With warm caches and no HTTP requests, the object
paths spent about 85 ms discovering/reading metadata and 55 ms hydrating indexes,
before about 130–140 ms of assembly. Tarball cache discovery was about 3 ms and
assembly about 112 ms. The double integrity check and intermediate store copies
are real prototype work, not excluded costs.

At 20 ms, median cold time through NAR serialization and zstd-3 compression was
0.450 s for tarballs, 2.129 s for files, and 1.646 s for batches. Compression added
roughly 0.2 s; final compressed NARs were about 3.46 MB in every mode. Object
granularity therefore did not eliminate final output serialization/transfer.
Initial local cache preparation took 3.03 s, including 0.51 s registry downloading,
0.63 s retained-store assembly and 1.89 s object encoding. No cloud upload was run.

All 90 installs passed tree comparison (1,937 files/symlinks, or 1,938 after the
source edit). Both object transports passed independent offline pnpm verification;
the updated fixture also passed. Five corrupted-manifest/content/archive cases
were rejected.

[Raw samples, stage timings, provenance and validation](object-store-2026-11-16.json)
include min/max values and all 18 comparison groups. Keep tarballs as the default
on this evidence. Reducing metadata scans, intermediate copies and gateway
recompression is a hypothesis for a subsequent prototype, not a measured fix.

## Protocol

`prepare` downloads the target-filtered archives from an exported drvjs plan,
verifies their locked SRI digests, and runs the existing retained-store assembler.
It publishes gzip-compressed pnpm file objects, keyed by SHA-512 of the raw bytes.
The same content with different executable permissions shares an object;
permissions and paths remain in package indexes.

`spec.json` pins the digest of each package index and the original archive SRI.
It is **trusted preparation output**, not an unauthenticated remote manifest.
Package indexes are themselves content-addressed objects. The client downloads
missing indexes, verifies them, then downloads only missing file contents.
All downloaded blobs are verified. Hydration writes a compatible pnpm store;
drvjs's existing `--unpacked-store` path verifies file contents again while
assembling the final installation.

| Mode | Transfer | Local reuse |
| --- | --- | --- |
| `tar` | Original npm gzip tarball per missing package | Compressed archives |
| `files` | One gzip object per missing index or distinct file | Raw blobs and hydrated pnpm store |
| `batch` | Up to 128 missing objects in one gzip-compressed framed response | Same as `files` |

The batch endpoint is a prototype gateway, **not an S3/GCS batch-read API**.
It reads and decompresses local objects, frames their lengths and contents, and
compresses the response. Its CPU work is included because client and server share
the benchmark machine. Remote upstream GETs, gateway deployment, and caching are
not implemented. This experiment cannot establish a cloud-storage speedup or cost.

## Measurement boundaries

- Five trials per mode/scenario/delay; mode order rotates each trial.
- Delays are zero or 20 ms added once per HTTP request. These are simulated delays,
  not measured cloud latency. HTTP uses loopback and connection reuse, without TLS
  or a bandwidth cap.
- Client concurrency is 32. The real assembler uses four workers.
- **Cold** means an empty client artifact cache, not a cold OS page cache.
- **Source edit** adds a real source file while retaining downloaded dependencies.
- **Dependency update** upgrades PostCSS from 8.5.6 to 8.5.8 after warming the old
  graph. Existing compatible dependency versions remain locked.
- Install time includes metadata/cache discovery, HTTP requests, decompression,
  integrity validation, local hydration, subprocess startup, source copying,
  package assembly, and dependency-link creation.
- NAR serialization and zstd level-3 compression are timed separately. Each sample
  also reports their sum with installation time.
- Preparation records registry downloads, retained-store generation and object
  encoding separately. This is one preparation sample, not a comparison of
  provider upload costs.
- Tree comparison and cleanup are outside timed sections. Files, executable bits,
  and symlink targets are compared, with output-root strings normalized.
- Nix evaluation, store import/registration, remote binary-cache publication and
  substitution, helper compilation, export, and application builds are **not**
  timed. The tar downloader is the same experimental HTTP client as the other
  modes, not Nix's built-in fetcher. Existing `--cache-packages` and
  `--shared-dependencies` modes are not compared.

Warm file-cache work still includes scanning package indexes and local file
existence, rehydrating indexes, and assembler-side file verification. That work
must be counted rather than treating a network cache hit as a free install.
No one-file-per-Nix-derivation graph is introduced.

## Reproduce

Requires Linux, Rust, Node 22+, `nix-store`, `zstd`, Git, and pnpm 10.34.5 for the
independent verifier. The benchmark client uses only Node built-ins.

```bash
cargo build --release --locked
export BIN="$PWD/target/release/drvjs"
export HARNESS="$PWD/benchmarks/object-store.mjs"
export WORK="$(mktemp -d)"
git clone --depth 1 --branch v3.5.22 https://github.com/vuejs/core.git "$WORK/vue"
test "$(git -C "$WORK/vue" rev-parse HEAD)" = \
  5a8aa0b2ba575e098cbb63b396e9bcb751eb3a0f
"$BIN" export -C "$WORK/vue" --filter @vue/compiler-sfc -o "$WORK/before"
cp -R "$WORK/before/project" "$WORK/updated-project"
node --input-type=module <<'JS'
import fs from 'node:fs';
const lock = `${process.env.WORK}/updated-project/pnpm-lock.yaml`;
const previous = 'sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==';
const next = 'sha512-OW/rX8O/jXnm82Ey1k44pObPtdblfiuWnrd8X7GJ7emImCOstunGbXUpp7HdBrFQX6rJzn3sPT397Wp5aCwCHg==';
const text = fs.readFileSync(lock, 'utf8')
  .replaceAll('8.5.6', '8.5.8')
  .replaceAll('specifier: ^8.5.8', 'specifier: ^8.5.6')
  .replace(previous, next);
fs.writeFileSync(lock, text);
JS
"$BIN" export -C "$WORK/updated-project" -o "$WORK/after"
node "$HARNESS" prepare --binary "$BIN" --export "$WORK/before" --out "$WORK/objects-before"
node "$HARNESS" prepare --binary "$BIN" --export "$WORK/after" --out "$WORK/objects-after"
node "$HARNESS" validate --binary "$BIN" --before "$WORK/objects-before" --out "$WORK/validation"
node "$HARNESS" benchmark --binary "$BIN" \
  --before "$WORK/objects-before" --after "$WORK/objects-after" \
  --out "$WORK/results" --runs 5 --latencies 0,20 --concurrency 32
```

The fixed-version edit above is specific to this pinned Vue fixture, not a
general lockfile updater. `prepare` authenticates the new archive against the
pinned SRI. To check the updated fixture independently too:

```bash
"$BIN" verify "$WORK/objects-after/retained"
```

`validate` compares all three installed trees, runs independent offline pnpm
verification for both object transports, and rejects altered package manifests,
altered file contents, and altered tarballs. Expected final line:

```text
PASS: equal installed trees, independent offline pnpm, and five corruption cases
```

The benchmark checks tree equivalence again on every trial/scenario. Raw samples,
stage timings, request counts, payload bytes, machine limits and medians are in
`results.json`. Only responses are included in payload bytes, not HTTP headers or
batch request bodies. Direct and batch requests both count package-index transfers.

## Scope limits

Only public registry packages are accepted. Credentials, remote object uploads,
manifest signing, eviction/garbage collection, retries and crash-safe publication
are deliberately outside this local prototype. The server binds to loopback.
The wire format is not intended as a production API.

The pinned Vue compiler subset is one workload, with no patched packages or native
postinstall execution. Results should not be generalized to a large monorepo,
cross-project cache reuse, different dependency updates, or real GCS/S3. A useful
next experiment must first reduce the measured local overhead, then test real
same-region storage including request billing and final Nix output transfers.
