# File-level object-cache prototype

This experiment compares package tarballs, individual compressed content-addressed
files, and batches of missing files. It changes no production drvjs behavior.
All five paths run the same release-built Rust assembler. The original object
paths remain as controls alongside direct-to-store versions.

## Results: November 16, 2026

**Direct-to-store improved the prototype, but still did not outperform tarballs.**
The original and revised clients were measured together, not compared across
separate runs. These are local simulated-transport results, not cloud measurements.

The workload is Vue v3.5.22's compiler-sfc closure: 98 input archives, 97 installed
registry instances, and six importers including the synthetic root. It contains
1,351 unique stored objects including package indexes. The machine had four
cgroup-limited CPU cores and 12 GiB RAM on an Intel Xeon Platinum 8581C.

Medians of five trials; seconds from fetch start through verified Rust assembly:

| Delay | Scenario | Tar | Files old | Files direct | Batch old | Batch direct |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | Cold cache | 0.209 | 1.404 | 1.093 | 1.518 | 1.135 |
| 0 ms | Source edit | 0.127 | 0.284 | 0.169 | 0.314 | 0.171 |
| 0 ms | PostCSS update | 0.139 | 0.310 | 0.179 | 0.342 | 0.199 |
| 20 ms | Cold cache | 0.269 | 2.003 | 1.651 | 1.615 | 1.165 |
| 20 ms | Source edit | 0.131 | 0.286 | 0.171 | 0.290 | 0.158 |
| 20 ms | PostCSS update | 0.157 | 0.351 | 0.239 | 0.370 | 0.247 |

At 20 ms, direct batching reduced install time by **28% cold, 45% on a source edit,
and 33% on the dependency update** versus the original batch control. It removed
1,352 / 98 / 120 intermediate file-copy operations respectively. The final
verified copies into node_modules remain.

| Transport | Cold requests | Cold payload | Update requests | Update payload |
| --- | ---: | ---: | ---: | ---: |
| Tarballs | 98 | 3,826,997 B | 1 | 47,806 B |
| Individual files | 1,351 | 4,146,752 B | 23 | 36,487 B |
| Batches | 11 | 3,850,617 B | 2 | 29,706 B |

Direct and original object modes use the same requests and payload bytes.
The batch update transfers 37.9% fewer response bytes than tarballs. With warm
caches, batch metadata/discovery plus hydration fell from about 145 ms to 25 ms.
Native assembly still took about 133 ms. The remaining cost is measured, not
hidden by calling a network cache hit free.

At 20 ms, median cold time through NAR serialization and zstd-3 compression was
0.502 s for tarballs, 1.821 s for original batches, and 1.379 s for direct batches.
That is a **24% reduction through NAR compression**, versus 28% through assembly.
The corresponding reductions were 26% for source edits and 16% for dependency
updates. Compression still added roughly 0.2 s and outputs were about 3.46 MB.
Original prepared objects were reused unchanged; initial preparation was 3.03 s.
No cloud upload or remote final-output transfer was run.

All 150 installs passed tree comparison (1,937 files/symlinks, or 1,938 after the
source edit). All four object modes passed independent offline pnpm verification.
Thirteen corruption cases were rejected, including warm-cache corruption, and
both direct modes recovered after a cached index and file were deleted.

[Current samples, stages, copy counts and provenance](object-store-direct-2026-11-16.json)
include min/max values and all 30 comparison groups.
[The original 90-sample report](object-store-2026-11-16.json) is retained separately.
Keep tarballs as the default on this workload. Gateway recompression and native
client integration remain unmeasured optimization ideas.

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
All downloaded blobs are verified. The original paths copy raw objects into a
compatible pnpm store. Direct paths write verified downloads straight to that
store, read each cached package index once, and list each relevant file shard
once instead of checking every file separately. Only missing directories and
files are created; cached indexes are not rewritten.

Both versions use drvjs's existing `--unpacked-store` path, which verifies file
contents again while assembling the final installation. The final verified copy
into node_modules is retained so output mutation cannot alter the shared cache.
Each install starts with fresh in-memory state; warm results do not depend on
retaining parsed metadata in a daemon.

| Mode | Transfer | Local reuse |
| --- | --- | --- |
| `tar` | Original npm gzip tarball per missing package | Compressed archives |
| `files` | One gzip object per missing index or distinct file | Raw blobs and hydrated pnpm store |
| `batch` | Up to 128 missing objects in one gzip-compressed framed response | Same as `files` |
| `files-direct` | Same requests and bytes as `files` | Pnpm store only, no intermediate object copy |
| `batch-direct` | Same requests and bytes as `batch` | Same as `files-direct` |

The batch endpoint is a prototype gateway, **not an S3/GCS batch-read API**.
It reads and decompresses local objects, frames their lengths and contents, and
compresses the response. Its CPU work is included because client and server share
the benchmark machine. Remote upstream GETs, gateway deployment, and caching are
not implemented. This experiment cannot establish a cloud-storage speedup or cost.

## Measurement boundaries

- Five trials per mode/scenario/delay; mode order rotates each trial. With five
  modes, each occupies every order position once.
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
- Direct modes include local store writes in `fetchSeconds`. Their separate
  `hydrateSeconds` is zero because that phase is gone, not because writes are
  excluded. `cacheCopyFiles` counts intermediate copies, not the final assembler
  copies shared by both versions.
- NAR serialization and zstd level-3 compression are timed separately. Each sample
  also reports their sum with installation time.
- Preparation records registry downloads, retained-store generation and object
  encoding separately. This is one preparation sample, not a comparison of
  provider upload costs.
- Tree comparison and cleanup are outside timed sections. Files, executable bits,
  and symlink targets are compared, with output-root strings normalized.
- Nix evaluation, store import/registration, remote binary-cache publication and
  substitution, helper compilation, export, and application builds are **not**
  timed. Node harness/server startup and prepared-spec loading are also outside
  the timer. The tar downloader is the same experimental HTTP client as the other
  modes, not Nix's built-in fetcher. Existing `--cache-packages` and
  `--shared-dependencies` modes are not compared.

Warm direct-cache work still includes reading/verifying indexes, listing shards,
and assembler-side verification. The original controls also recopy indexes.
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

`validate` compares all five installed trees and runs independent offline pnpm
verification for all four object modes. It rejects altered remote manifests,
files and tarballs, plus altered warm-cache indexes and package.json files in both
direct modes. Deleting a cached index and file also exercises missing-object
recovery. Expected final line:

```text
PASS: equal installed trees, independent offline pnpm, thirteen corruption cases, and cache-eviction recovery
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
next experiment should test real same-region storage including request billing
and final Nix output transfers before making deployment decisions.
