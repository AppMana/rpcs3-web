# Wasm translation regions

The execution target is a bounded region of guest control flow: known edges become
branches in one Wasm function, register values remain in SSA/locals between those
edges, and explicit exits commit architectural state before runtime handling.
FEX's native backend patches known branches and unlinks them on invalidation
([implementation](https://github.com/FEX-Emu/FEX/blob/main/FEXCore/Source/Interface/Core/JIT/BranchOps.cpp)).
Wasm requires compiling a replacement function to change its direct edges.

## Implemented first increment

`Utilities/WasmRegion.h` is shared by the offline driver and browser LLVM emission.
It inlines defined guest callees within a budget of 32 LLVM blocks and 512 LLVM
instructions, then runs memory-aware EarlyCSE, CFG simplification, DSE and ADCE.
These are **LLVM** budgets in this first increment, including verification code;
they are not the eventual guest-region size policy. Imported helper effects and
verification remain intact. Edges that close a recursive expansion into the root
are retained. The pass marks expanded functions to avoid repeated growth on a
second lowering.

Enable offline with `build-spu-aot-bundle.mjs --chain --regions`, or on the compiler
pool with `wasmRegions: true`. The browser compiler's per-result `regionLinks`
counter confirms whether it applied the lowering. Existing bundle execution ABI
is preserved; `regionLowering: 1` records the transformation in the manifest.
Manifests now hash the input source collection as well as emitted Wasm parts.

This first increment joins existing compiler chunks. The cross-program extension
below additionally shares one region entry between original program variants.
It reuses immutable candidate publication rather than adding a second code registry.

## Verified-transition profiling

`--profile-edges` builds an additional same-instance chain entry with chain ABI 2.
The normal runner is still used for most calls. An LCG selects approximately one
chain in 1024 for recording; only consecutive successful program executions within
that chain produce edges. A verification failure never counts as a successful
destination. Chain boundaries and interpreter/runtime gaps are not represented.

The ABI 1 context prefix remains 44 bytes. ABI 2 adds a pointer to edge storage and
a persistent sampling clock, for 52 bytes total. Each statistics slot owns 4096
immutable atomic edge keys and atomic counts, plus a dropped-sample counter. Hash
insertion probes at most 16 slots. Live snapshots can undercount an in-flight
increment; keys are never recycled. Reports retain losses and snapshot frame bounds.

`RPCS3_SPU_CHAIN_EDGES=1` requests snapshots around frames 4500 and 5200 in the
headful harness; override with `RPCS3_EDGE_FROM_FRAME` / `RPCS3_EDGE_TO_FRAME`.
The diagnostic bundle and an ABI 2 core must be selected explicitly. Sampling
results require resolving table indices against the actual bundle placement and
artifact identities. Do not interpret raw table indices as guest PCs.

## Initial LBP2 evidence, 2026-09-05

Fresh native capture emitted 5127 SPU IR units (95,964,011 bytes). Both test bundles
have source hash `bbca16452e7a336f53fd3a0588fc27e3a30293f8c0ef42cb7eb9e58297cd561d`.
The candidate removes 4529 internal calls. Bundle sizes: control 11,032,610 bytes,
candidate 10,816,337 bytes. This source collection differs from the earlier
5436-program hand-edited diagnostic bundle.

Matched Chrome 4500–5200, same `spu-chain-jspi` core:

| | CPU ms/frame | FPS | CPU pressure |
| --- | ---: | ---: | ---: |
| Source control | 471.0781 | 12.6881 | 6.9953% |
| Region candidate | 444.7402 | 13.6741 | 3.7003% |

Both runs completed 5500+ frames without reported failures. Draw, clear and texture
counters match; surface operations differ by one at the measurement boundaries.
CPU improvement is 5.59% in one pair, with materially different host pressure.
This is not enough for promotion. Evidence: `spu-regions-v1-comparison.json`.

iPad candidate/control both completed 7000 frames. Exact-window FPS was 15.6833 /
15.5793, a 0.67% difference; p99 was 82.30 / 75.24 ms. Draw deltas differ by two at
boundaries. No CPU counters are available. No stable device gain is established.

The next increment uses verified program-to-program edge profiles to choose
small regions, preserving program-entry verification and publication guards.
Keep the default cores/bundles unchanged until repeated gameplay and correctness
checks justify promotion. Existing LBP2 rendering differences still prevent a
claim of native parity.


## Cross-program SPU regions (experimental ABI 3)

The diagnostic gameplay capture completed 5507 frames without reported failures.
Snapshots at frames 4513 and 5201 contain 342,709 verified transitions across 3096
edges, with 345 dropped samples. The most frequent two-way pair, 0x054bc/0x0588c,
accounts for 11,825 samples. Both directions exceed 99% of their respective
recorded outgoing transitions. These conditional shares exclude chain exits.

Build a bounded region bundle from that resolved profile and its native cache:

```sh
node web/scripts/build-spu-aot-bundle.mjs IR_DIR OUT_DIR \
  --edge-profile=RESOLVED_EDGES.json --spu-cache=spu-safe-v1-tane.dat
```

`spu-program-catalog.mjs` reproduces native SHA1/base57 program identities.
The builder rejects a mismatched source collection, restricts regions to one
module, and selects up to 32 disjoint pairs, each at most 32 guest blocks / 512
code words. Each pair is LLVM-linked with a generated region wrapper before the
shared region lowering. The wrapper IR budget is separately 128 blocks / 4096
instructions. Original program exports remain available for dispatch fallback.
The new 5127-program LBP2 bundle is 9,780,252 bytes, including 32 region entries.

Each pair has one region runner and two original entry aliases. The module thread
initializes immutable aliases before publication; workers install their own
instance's functions without rewriting shared aliases. ABI 3 adds an immutable
per-program runner map to module ownership, retaining the 52-byte ABI 2 execution
context. Legacy ABI 1/2 registration remains supported.

At entry, the region snapshots preferred candidates. Its direct edges guard the
next PC and candidate-list publication, then execute the original verification.
Local-store verification reads remain volatile across newly created backedges.
Explicit exits preserve budget, scheduling, interpretation and partial progress
on verification failure. No imported cross-instance tail calls are introduced.

`dispatchMarkerAbi: 1` separately permits removing browser dispatch/patchpoint
calls whose bindings are empty, and replacing direct dispatcher-address calls
with zero. The loader requires an explicit matching core capability. Escape,
channel, syscall, scheduling and other effectful helpers remain calls. Offline
`--direct-exits` can isolate this transformation from region formation.

Validation: 20 focused LLVM/Wasm tests, including 100,000 transitions from either
entry, code mutation, failed verification, changed publication, budget/state
exits, helper effects, and shared alias ownership. Three headful Chrome checks
passed with the new core (browser LLVM regions, PPU dispatch oracle, JSPI real
flips/capture). Gameplay and device measurements are still pending; no promotion
or native-parity claim is justified by code-size reduction.

A remaining compiler limitation: inlining plus EarlyCSE/DSE does not by itself
promise loop-carried guest registers in Wasm locals. The generated wrapper reads
state/PC/failure through context pointers; LLVM may conservatively alias these
with thread register fields. Before claiming register residency, inspect optimized
region IR and generated loads/stores. A next experiment should expose verified
thread-field relationships and evaluate bounded loop scalar promotion, retaining
spills around effectful helpers and every explicit exit. This is not implemented
or measured yet.

## Cross-program gameplay results and continuation correction

All comparisons use frame window 4500–5200 and the same
`spu-linked-regions-jspi` core. First v1 Chrome candidate: 390.6077 CPU ms/frame,
15.1287 FPS, pressure 2.077%. Wrapper-only control: 432.4395 CPU ms/frame,
14.0331 FPS, pressure 2.853%. That is a 9.67% CPU / 7.81% FPS improvement in
one pair, with one boundary draw difference and otherwise matching counters.
Do not treat it as established or sufficient for promotion.

The helper-removal-only Chrome control reached 465.7313 CPU ms/frame / 12.7643
FPS, but CPU pressure rose to 10.208%. That isolation comparison is confounded.
On iPad, v1 first stopped at frame 4682; a timestamp-matched Jetsam report names
the GPU process and `highwater`. The repeat completed 7000 frames at 12.6662 FPS
in the window, versus 14.1061 for the helper-only control. This is a regression
signal; no device promotion is justified.

The v1 design returned to outer dispatch when leaving a selected pair, even when
the next program was already cached in the same instance. Counters showed 6.23
blocks per chain entry versus 7.61 for the helper-only control. The v2 generator
continues through the same-instance generic chain runner for the remaining
budget, then restores the input budget and target. Misses, state checks, foreign
module bounds and failed verification preserve their original exit semantics.
The generic runner never reenters a region, so continuation does not create
recursive host stack growth. Region-entry block diagnostics include this generic
continuation and must not be labeled exclusively direct-edge executions.

The v2 bundle is 9,791,691 bytes. Its Chrome run completed 5514 frames without
reported failures and restored 7.46 blocks per chain entry. Window results were
432.1286 CPU ms/frame, 13.9248 FPS, pressure 5.086%; the pressure difference again
prevents a clean comparison with v1. The iPad v2 run is still pending here.
Twenty-two focused tests cover this revision, including continuation outside a
pair and all downstream exits.

## PPU/SPU table ownership correction

A prebuilt PPU manifest avoided main-thread instantiation but also skipped table
reservation. The subsequent SPU loader therefore selected overlapping indices.
A worker changing roles could overwrite an already populated layout while its
ready flag remained set. Prebuilt PPU loading now reserves its table span with
null entries before registering blocks, without instantiating the PPU module.
A combined-loader test uses the real conformance Wasm bundles and pre.js to
verify that populating either role preserves the other role's function references.
This correction requires fresh gameplay measurements after staging; table
placement and engine allocation can change even though guest code does not.

## Validated ownership revision, 2026-09-05

After staging the reservation fix and region diagnostic core:

| Engine | Completed frames | Window FPS | CPU ms/frame | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Headful Chrome | 5501 | 15.3836 | 381.0921 | 79.875 |
| Attached iPad | 7000 | 15.0472 | Not measured | 80.680 |

Chrome CPU pressure was 2.031%. Both runs reported no failures. Window draw
counts were 814360 in each, texture/surface-hit counts matched, and clears
were 4900/4901. The iPad reported PPU table span 21350+85157 and SPU span
106507+5160, confirming disjoint placement with the real title. Chrome measured
3,293,976 region calls handling 74,787,601 of 391,957,451 chained blocks; these
include generic continuation after direct region execution. All 23 focused tests
and three headful regression checks passed. Core and AOT remain named experiments;
there is no default performance promotion or claim of native parity.

The iPad v2 run before the ownership fix also completed 7000 frames at 15.7530
FPS (p99 73.600 ms), with 65 more draws and nine more surface operations than the
usual window. These are individual runs, not a stable speedup estimate.

The next execution experiment should let the module's generic driver select
regions internally, with regions returning explicit exits to that driver. Today
only outer entry selects a region; the generic continuation executes original
programs even when a later target belongs to another region. Avoid introducing
recursive region/driver calls while changing that ownership boundary. Separately,
explicit register caching needs correct helper and exit spills before claiming
that guest state stays in Wasm locals. PPU region formation and repeated matched
promotion measurements remain unfinished.
