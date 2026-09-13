## Two-group bind split hardware-verified; environment GPU note — 2026-09-11

The direct backend's two-group bind split (shared draw-buffer layout bindings 32/33/34/35
in group 1, per-program texture/sampler layout in group 0) is implemented and, on headed
Chrome over the HTTPS ingress, renders the tetris fixture byte-identically with the cache on
and off (transfer readback hash `2236050885`), with correct direct stats, no translation
failures and no timing drops. The bitmap fallback core reports no direct stats/policies and is
a presentation smoke path only. The old pixel pin `3241800133` matched the prior regenerated
fixture; the pin is re-bootstrapped and applies under `RPCS3_TEST_STRICT_PIXELS=1`.
Environment blocker recorded this round: no hardware Vulkan device is reachable here
(NVML Unknown Error; Vulkan enumerates only llvmpipe; NVIDIA Vulkan ICD not installed), so no
hardware FPS claim may be made from this session. See `draw-bind-cache.md` and
`performance.md`. Hardware gameplay pair and iPad validation remain the open hardware-gated
steps; split stays opt-in by default.

## Bind-group cache experiment implemented — 2026-09-05

ALL new builds/tests/gameplay TERMINAL. Opt-inRPCS3_BIND_GROUP_CACHE=1 forwards
through all layers; actual GPUready policy checked and gameplayhitsrequired.
Core `bind-cache-20260905-jspi`,run `bind-cache-20260905`,5504frames,failures[].
Window4500–5200:248239hits/809364draws(30.67%),561125creates,binding7.171ms,
draw30.535,encode3.070,submit4.469,present1.392;13.968FPS,CPU436.549ms/frame.
Not matched to prior diagnostic: scene work differs,2newprograms/1upload inwindow,
pressure3.690%; no net speedup claim. Visiblecanvasinspected,existingfaultsremain.
ThreeheadfulHTTPS testsPASS including equal tetris hash3241800133 in cached and
uncachedmodes; one-draw-per-frame fixturecorrectlyhas0hits. SixVitestmetrics tests,
TypeScript,diffcheckPASS. Build2PASSafter fixing accidentalblit edit. No default
promotion. [Implementation/evidence/next seams](draw-bind-cache.md). Next split
texture/sampler group from dynamicbuffer group to improve low combinedkeyreuse;
exactstoragebounds must remain. Targeted ringgrowth/size tests and samebuild
control stillneeded. iPad absent in latestdiscovery; goalactive,notblocked.

## Per-draw profiling complete — 2026-09-05

ALL new runs/builds/tests TERMINAL. Core `draw-phases-20260905-jspi`, gameplay
`draw-phases-20260905` completed5543 frames,failures[]. Detailed wall scopes:
draw31.148ms/frame,vertex2.847,uniform/index1.925,bind construction8.388,
encoding2.837; remainingdrawsetup15.151ms. Window4500–5200,total70.801ms/frame.
PresentationMessageChannel1.524ms corroborates earlier candidate. MetricsJSON in
run directory; [details and next implementation invariants](frame-phases.md).
Next concrete optimization is opt-in per-frame bind cache + dynamic offsets;
NOT implemented yet. Measuredbindcost11.85%wall vsuniform2.72%. Three phase tests,
two real headful HTTPS direct tests with positive phase values,TypeScript and
diffcheckPASS. No default promotion. iPad still absent; goal active, nativeparity
and renderingcorrectness incomplete. No subagents. Existing dirtywork preserved.

## RSX phase profiling and presentation experiment — 2026-09-05

ALL new host builds/tests/gameplay TERMINAL; device control timed out after
losing discovery (preserved complete4500–5200 window). No subagents. New core
`presentation-yield-20260905-jspi` includes phase profiler and opt-in
`RPCS3_PRESENTATION_YIELD=message`, forwarded and asserted end to end. Same-build
Chrome pair completed5507/5506 frames,failures[]. Presentation4.960→1.538ms/frame;
FPS12.822→13.877,CPU469.034→436.977ms/frame, exact renderer deltas. Host pressure
5.277→3.095% confounds total gain; one pair, no promotion/native parity claim.
Both visible canvases inspected; existing severe material/color faults remain.
iPadbaseline presentation21.8ms/frame; candidate untested because device absent.
See [phase evidence and experiment](frame-phases.md), comparisonJSON at
`test-results/performance/presentation-yield-comparison.json`. Two headful HTTPS
direct-session tests,three phase tests,TypeScriptPASS; isolatedbuildPASS.
Next: replicate scheduling effect, iPadcandidate when attached, per-draw CPU
profiling and visual correctness. Repeated bindgroup creation and ~12KBuniform
uploads per draw are source leads, not measured bottleneck attribution yet.

## Runtime inline reads integrated and measured — 2026-09-05

Gameplay/build processes TERMINAL. New runtime inline-read option passes through full API and binds the guest-page-table GOT import in hot PPU loader. Compiler policy/URL now reported and enforced; compiler JS/Wasm hashed. Four headful HTTPS correctness tests passed, TypeScript passed. Final seven LLVM/inline headful HTTPS tests PASS (`ppu-inline-runtime-final-tests.log`). All runs, builds and tests terminal.

Chrome matchedpair `ppu-inline-runtime-{control,candidate}-2`:473.924vs468.244CPUms/flip (-1.20%),12.769vs12.957FPS,pressure6.28vs5.74%;differentPPUcompilecounts230vs255. Renderer counters exactmatch,failures[]. NOT a stablegain. Firstcontrol-1 intentionallyinterruptedwhenAPIoptiondropdiscovered;excludeit.

iPad `ipad-ppu-inline-chain-{control,candidate}-1`:both7000framesok,14.9593vs14.9325FPS=effectivelytied. ExistingprebuiltinlinePPUbundle+newSPUchains,PPUJITdisabled. No new promotion. EndChromeimagesinspected:existingseverematerialfaultsremain;asynchronousposes/panelcolordiffer,notpixelproof.

See [implementation, validation, measurements and next decision](ppu-inline-runtime.md). Nextpriorityframe-criticaltimingvsaggregateCPU plusguestregister/dispatch andrenderingcorrectness. Nativeparitynotachieved. Goalremainsactive;donotmarkcomplete.

## Compilation and CPU audit — 2026-09-05 20:49 PDT

ALL RUNS TERMINAL. Fresh unprofiled `performance/compilation-audit-20260905` completed 5501 frames, failures[]. Frame4500–5200 still compiled 244PPU/17SPU, 3773ms summed LLVM elapsed over52.868s wall. Final counts alone had hidden this: play-runtime now retains per-frame compilation counters (source and dist staged).

Fresh CDP capture `performance/compilation-profile-20260905` completed5219frames, failures[],76targets profiled. Compiler workers451/23335attributed samples=1.93%, secondcompilerentirelyidle; this excludes unknown/native/backgroundcompilerCPU. BusiestPPUworker's32/64-bitread/writehelpers~26%attributedsamples. SPUchainrunner5.7%pooledattributed, DMA3.5%, listDMA2.5%, statechecks2.5%; substantialunknownCDPsamples retained. See [audit and exact limitations](compilation-audit.md).

Added compilation-metrics/analyse-compilation and analyse-compiler-profile scripts. New3Node tests plus existing6Vitest testsPASS; diffcheckPASS. No new core optimization/default promoted. PPU memory access is now concreteprofile-backedpriority: AOTinline-readexperimentexists but runtimepool flag and hot-side-module GOT.mem page-table binding are missing. Implement together before enabling; preserve storeversion/reservationsemantics. No builds/profilers active. Goal status unchanged.

## WebKit ARM64 follow-up — 2026-09-05

Inspected pinned public WebKit ARM64 BBQ and B3 source; implemented opt-in unary byte-swizzle lowering and a reusable correctness/timing probe. Seven focused tests pass. Static coverage: 57,724 rewrites in 3,671/5,127 SPU programs. Attached iPad warmed probe is effectively tied (10.88 vs 10.86 ms); first-call 26.80 vs 14.18 ms is unreplicated and includes tiering. Headful Chrome warm timing also ties. No gameplay candidate/default promoted. See [full experiment and reproduction](webkit-arm64-codegen.md). Next architectural target remains guest-register residency across linked blocks, not an assumed steady-state SIMD win.

# PPU performance and Safari handoff — 2026-09-04

The user requested compaction and preparation to work on PPU improvements. Continue the original
optimization task, with PPU architecture now the priority. The user explicitly permits revisiting
Wasm JIT architecture, says dispatch consumes too many resources, and correctly points out that
Safari 27 beta supports tail calls but may crash on them. This is emulator compatibility work.

## Latest validated state — 2026-09-05 16:38 PDT

ALL RUNS/BUILDS/TESTS TERMINAL. No active host benchmark, profiler, device run or
subagent. Earlier ACTIVE entries below are historical. Goal previously PAUSED;
no goal status change or completion claimed. No commits/default core promotion.

Implemented cross-program SPUregionv2 with local generic continuation and shared
Cell-owned ABI; main-worker alias initialization; ABI3 immutable span maps;
empty dispatch-marker lowering gated by dispatchMarkerAbi1; verified edge capture
and source-hash region planning; common offline/runtime LLVM region pass.

Fixed PPUprebuilt ownership bug: prebuiltregistration now grows main table with
nullentries, so SPUallocationcan'toverlapPPUspan. Combined actual-loader/actual-Wasm/
pre.js test verifies role changes preservebothsets ofreferences. STAGED
web/dist/rpcs3-ppu-aot-table.mjs and runtime-smoke-worker.mjs (betterErrorEventdetails).
Device progress/memory snapshots nowpublish viaatomicrename; source syntaxchecked.

Final correctness validation: 23focusedtests PASS (spu-linked-regions-ownership-tests.log);
3headfulChrome checks PASS (spu-linked-regions-ownership-headful-tests.log).
Latest corebuild2PASS after movingC-onlypointerhelper outof sharedABIheader.
Core21800565bytesstageddist/core/spu-linked-regions-diagnostic-jspi.
AOTv2 9791691bytes5127programs32pairsstageddist/local-aot/lbp2-spu-linked-regions-v2.

Owned-placement Chrome exec1447 COMPLETED5501,failures[], exact4500–5200:
381.0921CPUms/frame,15.3836FPS,p9979.875,pressure2.031%,0drops.
chain60623407calls391957451blocks;region3293976calls74787601blocks
(INCLUDESgenericcontinuation). report/windowunderperformance/spu-linked-regions-owned-run.
Owned-placement iPad exec50759 COMPLETED7000,oktrue:
15.0472FPS,p9980.68,0drops. PPUspan21350+85157,SPUspan106507+5160.
report/windowunderperformance/ipad-spu-linked-regions-owned.
Both814360draws/window,883400texturehits730800surfacehits23800surfaceops;
clears4900Chrome/4901iPad.

Previousv2beforeownership Chrome432.1286CPUms13.9248FPSpressure5.086%,
7.46blocks/chain(restoredfromv1 6.23). iPadv2exec89184completed7000,
15.7530FPS,p9973.6;smallrendererwindowdifference(+65draws,+9surfaceops).
DoNOTclaimcausalstablegainfromunmatchedpressure/placement/corevariants.
Firstv1samecorepair9.67%CPUgainexistsbutONEPAIRONLY; helper-onlyisolation
Chromecontrolpressure10.208%confounded. v1iPad10.2%regressionledtocontinuationfix.
OneearlyiPadv1GPUhighwaterkill verified by Jetsam; privatefullcrashdirectorycontains
unrelateddeviceinformation, onlysanitizedgpu-termination.jsonisreportmaterial.

NEXT USEFUL WORK:
1. Module-owned execution driver selectsregions insidegenericchain. Currentcore
   onlyselectsregionatouterentry, genericcontinuationcallsoriginalprograms. A
   nonrecursive driver can consumeexplicitregionexits and continueitsbudget.
   ExistingloaderregionMapcanfeedanimmutablemodule-localmappointer initialized
   bymainworker; avoidregion->generic->region recursion. Notimplemented.
2. Explicitguestregistercaching: hottestregion94loads112storesbefore/afterLLVM O2.
   NeedverifiedSPUthreadlayout andhelper/exitspillpolicy; inliningaloneisnotSSA
   registerresidency. Notimplemented. PreserveLSverification/concurrentDMA.
3. Native272.929CPUmsstilllowerthanbrowser381.09andrenderingstillnotvisually
   equivalent. Needmatchingrenderingand3alternatingmatchedpairsbeforepromotion.
4. PPUphase/returnprediction notyetimplemented. CommonregionLLVMpassrecognizesPPU
   butSPU-specificcrossprogramplannerisbuiltfirstperuserselection.
5. ImproveAOTcoverage: ChromeJITstill~1700SPUprogramsfromthis5127nativeIRfixture,
   iPadstaticfallbackheavier. Preserveexactsourceprofileswhencomparing.

## Current continuation status — 2026-09-05 16:23 PDT

ACTIVE host measure exec31676: spu-linked-regions-v2-run,5500frames, old fixed
spu-linked-regions-jspi core / lbp2-spu-linked-regions-v2 AOT / PPUreturn-single.
ACTIVE device exec89184: ipad-spu-linked-regions-v2,7000frames. NO host builds,
tests or profilers until exec31676 completes. All builds/tests before these terminal.

v1 region results: firstsamecore pair390.6077CPUms15.1287FPS vswrappercontrol
432.4395CPUms14.0331FPS (-9.67%CPU,+7.81%FPS),pressure2.077/2.853%,one-draw
boundarydelta,othercountersmatch. ONE PAIR ONLY. helper-onlycontrol465.7313CPUms,
12.7643FPS butpressure10.208%: ISOLATIONCOMPARISONCONFOUNDED,do notclaim16%.
Artifacts spu-linked-regions-comparison.json and spu-linked-regions-vs-direct-exits.json.

iPadv1 firstfailed4682: verifiedJetsamGPUprocesshighwater kill(timestampmatches),
not provenWasmcrash. Sanitized gpu-termination.json besidev1report; fullprivate
ipad-linked-regions-crashes includes unrelated data; don'tpublishwhole.
Repeatcompleted7000:12.6662FPS,p9592.92,p99105.88. helper-onlycontrol7000:
14.1061FPS,p9580.88,p9987.72. v1fusion10.2%slowerinthispair,notpromotable.
Artifact ipad-spu-linked-regions-vs-direct-exits.json.

Found/fixedregionexitproblem: v1returnedtoouterdispatcherwhenleavingpairalthough
nextprogramwasalreadycachedlocally. Counters6.23blocks/chain vshelpercontrol7.61,
~22%moreouterentriesperblock. v2continuesvia SAME-INSTANCE genericchainrunner
forremainingbudget,thenrestorescallerbudgetandtarget. Preservespartialverification,
state,interpretation,foreignspanexits. 22LLVM/Wasmtests passed including100000block
A->C->A continuation and all downstreamexits. v2bundle9791691bytes32pairs5127programs.
Staged dist/local-aot/lbp2-spu-linked-regions-v2, currentrunsabove.

Shared execution ABI now rpcs3/Emu/Cell/SPUWasmChain.h. web/host/spu/chain.h
includesitandcontainsonlyside-runnercached-targetutility. Coreincludeofweb/hostremoved.
InitialsharedhelperCstylecastsfailedcore-Werror;fixedbymovingC-onlypointerhelper
backtoside-runnerheader. Latestcorebuild2PASS (spu-linked-regions-continuation-core-build2.log).
Core21800565bytes includesregionCalls/regionBlocks diagnostics, stagedearlieras
spu-linked-regions-diagnostic-jspi. regionBlocks will INCLUDEgenericcontinuation
oncev2usesit;don'tcallthemexclusivelydirectblocks. Timingrunsstilluseold21800244core.
RuntimeworkerErrorEventdetailimprovementissource-only,notyetstaged;syntaxchecked.
Builderprofileprovenance/hardening andABI2/3resolver supporttested;latestv2manifest
includesprofilehash. No default corepromotion/commits. Nativeparityabsent.

NEW ISSUE TO VERIFY/FIX AFTER CURRENT HOST RUN: PPUprebuilt loader skips
instantiationandDOESNOTreserveitsmainfunctiontablespanbeforeSPUloaderreadstable.length.
Device report showbothPPUandSPUtableBase21350 (PPU85157slots,SPU5160slots).
pre.js populatesBOTH into same per-worker wasmExports table. Reusingaworkeracross
PPU/SPU roles can overwritealiaseswhileitsreadyflagremainsset. Fixshouldreserve
PPUspanwithnulltable.grow evenwhenmanifestblocksavoidinstantiation;addmeaningful
combinedPPU/SPUownershiptest. Thisisnotfixedyet. Preservecurrentmeasurementartifacts.

Furthercompilerfinding: hottestregionhas94loads112storesafterinlining;fullLLVM O2
still94/112. Inliningremovedguestcallsbutdoesnotestablishloop-carriedregisterlocals.
Explicitguestregistercachingwithhelper/exitspillseamsisthepromisingnextSPUphase.
PPUarchitecturefollow-throughand3matchedpairsbeforepromotionremainoutstanding.

## Cross-program SPU implementation — 2026-09-05 15:56 PDT

Implement-the-plan continuation: SPU-first was explicitly selected before compaction.
No commits or default core promotion. Latest work is experimental ABI 3 direct SPU regions.

ACTIVE runs (do not overlap host builds/tests/profilers):
- Chrome exec53334, performance/spu-linked-regions-v1-run(.log,/report.json),5500frames,
  core spu-linked-regions-jspi / AOT lbp2-spu-linked-regions-v1 / PPUreturn-single.
- iPad exec36629, performance/ipad-spu-linked-regions-v1(.log,/progress.json),7000frames.
- Both booted and running. Results not yet established.

Completed: ABI2 edge capture5507frames,failures[], snapshots4513–5201,
342709verifiedinternaltransitions3096edges345drops. Resolved identities at
performance/spu-region-edges.json. Top pair0x054bc/0x0588c,11825samples,
eachdirection>99%conditionalonobservedinternaledges.

New code: spu-program-catalog.mjs hashes native cache; spu-regions.mjs selects disjoint
pairs and emits direct CFG wrappers. Builder --edge-profile=JSON --spu-cache=FILE
links each pair's original IR with its wrapper before shared LLVM region lowering.
32pairs capped32guestblocks/512words; wrapperLLVMbudget128blocks/4096instructions.
WasmRegion makes original LS verification reads volatile across new loop backedges.
Explicit state/budget/verification/publication exits preserve partial progress.
WasmCallPolicy removes empty SPU dispatch/patchpoint calls with --direct-exits;
manifest dispatchMarkerAbi1 requires matching core capability. Actual helpers remain.
ABI3 adds immutable per-original-program region runner map to existing span ownership.
Main worker initializes region aliases; all other workers only populate local functions.

Build terminal: spu-linked-regions-core-build.log (core21800244bytes),
spu-linked-regions-build.log (5127programs9780252bytes32regions,
4569functions4610linkedCalls591budgetExits14714directExits).
Staged dist/core/spu-linked-regions-jspi and dist/local-aot/lbp2-spu-linked-regions-v1.
20 focused LLVM/Wasm tests passed, including actual pre.js multiple-instance alias
ownership. 3headfulChrome oracle/browserLLVM/JSPI tests passed with newcore.

Source metadata validation/provenance edits in builder/selector AFTER artifact build
are not yet re-tested or rebuilt (do after active hostrun). No runtimecodechanges
since staged build. wasm-regions.md has current architecture and prior measurements.

Next: finish current runs; same-core alternating control with
lbp2-spu-regions-v1 to isolate newchanges; also build --regions --direct-exits
control to isolate direct fusion vs marker elimination. Add region-specific diagnostic
call/block counts if needed before reprofile. No native parity claim: old browser
402.73CPUms vs native272.93, rendering still materially different. Need three
alternating matched pairs before any default promotion. PPU follow-through remains.

## SPU chaining gameplay results — 2026-09-05 14:18 PDT

Goal ACTIVE/INCOMPLETE. This turn PROGRESS. Integration built/tested and gameplay
candidate/control completed, but no default deployment and native parity remains absent.

Chrome exact4500–5200, SAME core spu-chain-jspi and same SPU imported-tail policy:
- Candidate spu-chain-2 exec29189 completed5500+,failures[]:
  14.830230FPS,402.732994CPUms/frame,pressure2.33546%,p9579.5803,p9990.5,
  max293.545ms. Chain51855565calls/402568154blocks =7.7633blocks/call.
  Attempts480800110,rejected18439943,interpreted30558,sync0,samePc509479.
  (samePc includes a multi-block cycle's budget exit; it is no longer equivalent to
  interpreter handoff. Code uses explicit chain exit reason.)
- Control spu-chain-control exec51707 completed5500+,failures[]:
  14.554718FPS,414.911183CPUms/frame,pressure2.45686%,p9578.6902,p9987.4851,
  max311.230ms. chain counters0; attempts473393027,rejected16077753,
  interpreted24819,sync1,samePc0.
- One pair: CPU -2.935%, FPS +1.893%. Renderer deltas EXACTLY match:814361draws,
  4900clears,883400texturehits,730800surfacehits,23800surfaceops,0unsupported/
  translation failures/timingdrops. Native reference272.929CPUms still much lower.
- Both browser screenshot captures inspected: same broad existing lighting/compositing
  faults. Not pixel-equivalence proof, and frame-end screenshots are not4500exact.
- Resultartifact performance/spu-chain-comparison.json. Profiling needed: substantially
  fewer outer returns but only~12.18CPUms/frame saved; much work may remain inside runner.

Device:
- ipad-spu-chain exec62702 completed7000 successfully. Window15.406882FPS,
  p9571.83984,p9978.28003,max91.65942,0drops,814361draws,4901clears,23800surfaceops.
- ipad-spu-chain-control exec7704 completed7000 successfully. Window14.097385FPS,
  p9578.43994,p9984.02002,max97.81958,0drops,814361draws,4900clears,23799surfaceops.
- One pair +9.29%FPS, but historical iPad control variability is large. Minor boundary
  differences in clear/surface counters noted; CPU unmeasured. Do not claim stable9%.
- Comparisonartifact performance/ipad-spu-chain-comparison.json.

Corrected diagnostic bundle is NOW valid: dist/local-aot/lbp2-spu-chain/spu-00.wasm
10854951bytes;5436programexports match baseline ORDER, dylink identical36868bytes/
4alignment/tableSize0. Adds one shared-table import and runner export. Baseline no
SPUtable import. Old compact-import output replaced. Defaultbundle untouched.
Runtime noassert21797415bytecore isolateddist/core/spu-chain-jspi is used by both.

Harness now records actual SHA256 of explicitly selected AOT manifests AND each part,
checks manifest-declared checksums before boot. Both completedcontrol/candidate contain
these hashes, so filenames cannot silently stand in for artifact identity.

ACTIVE:
1. profile-spu-chain exec1016, runnerPID95302 (revalidate), samecandidatecore/bundles,
   5200frames,perf99Hzcycles:u/dwarf4096/m2048/k1,FROMS4400/TO5000;--perf-prof only,
   dumpsunderperformance/profile-spu-chain. Lastobserved4837,recordingwindow reached.
   No host builds/tests/otherdesktopbenchmark alongside. Afterfinish export perf leaves,
   checklossdiagnostics, filter4600–4800, analysejit/native against matchingChrome/libc.
2. ipad-spu-chain-repeat exec92953 juststarted, samecandidate,target7000. Fresh control
   immediately preceded it to test whether candidate advantage persists on warm device.
   Need finalwindow/cleancompletion, not just oldfirstpair.

Potential runner optimization to assess AFTER profile: generatedC rereads immutable
context fields across blockcalls and writes completed count perblock. Hoisting immutable
pointers/bounds/budget into locals and publishing result only on return may reduce
extra memory traffic. Not implemented. Do not build while Chromeprofile running.

## SPU chain runtime integration in progress — 2026-09-05 14:01 PDT

Goal remains ACTIVE/INCOMPLETE; this turn PROGRESS. No default core deployment.
- Source integration now implemented: core register-chain-span export, immutable
  module spans (max64), worker-local extra runner alias, opt-in bundle `--chain`,
  manifest chainAbi1 gate. Existing bundles retain old behavior.
- SPU outer dispatcher uses runner for registered spans/cache enabled. Heap context
  owned outside setjmp; cache view has wasm32 layout assertions. Budget64 bounded
  by remaining65536 slice count. Partial completion succeeds at original candidate;
  subsequent failure dispatches CURRENT pc. Only explicit INTERPRET exit interprets.
  Initial STATE exit retries scheduling without counting a dispatch.
- Per-thread diagnostic chainCalls/chainBlocks added to dispatchProfile. Chain
  attempts/rejections and total completed dispatch accounting updated.
- Core builds completed: spu-chain-core-build.log (exec46392),
  spu-chain-counters-build.log (exec74553). New core21797415bytes staged isolated
  dist/core/spu-chain-jspi; defaultdist/core/jspi unchanged. Public/core/jspi latest.
- Headful tests exec57000: GPU capture + PPU dispatch oracle both passed (log
  spu-chain-core-tests.log). Cache6tests and actualWasm chain6tests also pass.
- LBP2 SPU IR source location not recovered (manifest says spu-ir-merged, missing
  from obvious local dirs). Diagnostic bundle appends compiled chain function to
  existing corrected spu-notail.wat and adds shared table import, preserving original
  program bodies/import-tail lowering and dylink. Source builder can link companion
  normally when input IR is available.
- First assembly --all-features emitted unsupported COMPACT IMPORTS! Initial
  spu-chain-1 run exec97235 terminated failed at0frames, no performance evidence.
  Do not enable browser experimental compact imports. Reassemble with exact baseline
  flags: --enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext
  --enable-simd --enable-tail-call --enable-reference-types --enable-multivalue
  --enable-nontrapping-float-to-int --enable-bulk-memory-opt --enable-call-indirect-overlong.
- Active at14:01: assembly exec9072/PID4050272 produces /tmp/rpcs3-spu-chain-game.wasm
  from test-results/performance/spu-chain-bundle.wat. Must append original baseline
  dylink custom section and update isolateddist/local-aot/lbp2-spu-chain manifest
  bytes/hash BEFORE validation/relaunch. Currently that isolated file is INVALID first
  compact-import encoding. The default bundle is intact.
- No game/benchmark/build/test active other than assembly. Original large assembly
  exec98842 terminal; failedfirstChrome exec97235 terminal andclosed.
- Important timing control: candidate uses corrected SPU NOTAIL bundle. Earlier
  Chrome persistent-release default used ordinary SPU bundle. Need samecore plus
  oldnotail control, not blindly compare those earlier numbers.

## Same-instance SPU chain runner prototype — 2026-09-05

This turn PROGRESS; goal remains incomplete. No default core/bundle deployment.
New `web/host/spu/chain.c` + `chain.h` implement a bounded same-instance loop to
link alongside compiled SPU programs. Not yet connected to the runtime dispatcher.
It calls original program entries (including verification), reads the persistent
4096-slot folded cache as a preference, validates immutable list generation/count,
and refuses targets outside the owning module's program-alias range. It makes no
host-function imports. The runner itself uses ordinary calls and a loop, with no
cross-instance tail calls or recursion.

The explicit result separates completed blocks from the final exit: budget,
verification rejection, same-entry interpreter handoff, scheduling state, missing
preference/new publication, or other-module target. Thus A executing then B rejecting
is completed=1/rejected, not a failed A candidate. A cycle returning to A's initial PC
at budget end is not an interpreter handoff. This distinction MUST be honored when
integrating the existing candidate_cache.find callback and outer pc-before check.

Validation:
- `node --test web/tests/spu-chain.test.mjs`: six tests passed, compiling the real
  C runner and fixture blocks to one shared-memory Wasm module using LLVM22.
- Tests cover 100000-block cycles, zero budget, first/downstream rejection, local
  store mutation by A invalidating B, same-entry handoff, initial/new scheduling
  state, missing/new publication, and callable but out-of-module target.
- Headful hardware-configured Chrome at https://rpcs3.appmana.com/runtime.html:
  100000-block cycle and four stop/rejection cases passed, crossOriginIsolated=true.
  Evidence `test-results/performance/spu-chain-headful.json`. Browser closed cleanly.
- Standalone runner 1091 bytes; combined test fixture 1306 bytes. These are conformance
  checks, NOT gameplay performance measurements or evidence of native parity.

Next integration (not implemented): opt-in build-spu-aot-bundle companion IR; reserve
and populate an extra runner table alias per part on every worker; register immutable
module bounds/runner index with runtime; expose cache layout through a checked ABI
(shared entry definition/static assertions, rather than unchecked casts); create
worker-private context outside setjmp lifetime hazards. Use runner only for registered
bundled targets and cache-enabled execution. Root candidate succeeds if completed>0;
a later rejection must return to outer dispatch at the CURRENT pc without retrying the
old entry. Interpret only explicit INTERPRET exits. Count completed blocks in dispatch
statistics, and preserve slice accounting/budget so chains do not extend it 64-fold.
State exits before any completed block require outer scheduling, not candidate fallback.
Cold preferences/new publication return to normal selection; runtime LLVM targets stay
outside module bounds. Existing isolated core and bundles remain available as controls.
After integration, build isolated core+bundle, correctness tests, headful LBP2 4500–5200
CPU/frame comparison and then device verification. iPad chain prototype not yet tested.

## Frame-matched profiler results — 2026-09-05 (completed analysis)

Native window profile completed: 6074 flips, failures [], recording actual frames
4401–5004, 23551 samples. No reported lost samples. Exact offline comparison is
4600–4800 (earlier 4500–4900 suggestion exceeded Chrome recording boundaries).
Native filtered 6337 samples; Chrome filtered 10049. Chrome clock uncertainty 687.5us.
`perf-frame-window.py` implements checked half-open frame timestamp filtering; 3 tests passed.

Chrome `profile-ppu-combined/categories-4600-4800.json`:
- SPU outer dispatch 7.474%; thread-state checks 1.961%.
- Baseline Wasm plus frame setup 7.555%; frame setup alone 2.481% (included above).
  Baseline function time contains useful work; it is not all removable overhead.
- VM write helpers 2.755%; copies/clears 7.172%; Dawn 3.233%; V8/builtins 11.191%;
  Blink 2.199%. Categories overlap and MUST NOT be summed.
- This Chrome profile predates persistent cache, using PPU slices plus inline reads.
  Do not present it as a profile of the latest release candidate.

Native `native-window-profile/resolved-4600-4800.json` resolves exact build ID
2796a97c3b0b61d30f79cf741defa701043085ce. GNU readelf exits 1 on an unfamiliar FDO
note despite printing the correct ID. Analyzer now supports READELF override; use
/usr/lib/llvm-22/bin/llvm-readelf. Build-ID checks remain strict; 5 analyzer tests pass.
Native samples include 5.607% mwaitx in SPU MFC waits, 3.101% vk::wait_for_event,
4.517% libc memcpy, 2.633% mov_rdata, 2.344% DMA, 1.960% list transfer. Native also
has real polling/wait costs. 49.872% is JIT-map DSO; map has 578926 entries and zero
address interval overlaps, but complete classification remains to be persisted.
8.965% native vDSO remains unresolved; do not yet label it clock overhead. A temporary
vDSO with matching build ID exists, but perf export changes its temporary pathname.

Fresh iPad old-cache control completed 7000 frames: 4500–5200 14.370317FPS,
p95 77.19946ms, p99 83.27979ms, zero timing drops; exact renderer counters match.
Persistent candidate 15.950097FPS is ~11.0% higher in this pair; earlier controls
varied 14.17–15.94FPS, so this does not establish a stable 11% improvement.
All native/iPad/Chrome runs and analysis processes described here are terminal.
Default dist cores remain unchanged. Goal incomplete. Next architectural experiment:
bounded same-instance SPU block chaining, retaining entry verification and correct
partial-chain completion behavior; avoid Safari imported cross-instance tail calls.

## Uninstrumented persistent cache and native profiling coordination — 2026-09-05 13:31 PDT

Goal ACTIVE/INCOMPLETE. This turn PROGRESS. No agents/commits/default core deployment.

Persistent diagnostic completed:
- spu-persistent-cache exec94998 completed5205flips,failures[]. Exact4500–5200:
  attempts484831740,rejected15902520,cacheCold8,cacheGenerationMisses2728669,
  cachePreferredHits462904932,cachePreferredRejections3295611,tableSyncs0,
  interpreted26951,samePcReturns0. Successfuldispatches468928082,hotfast0,
  runtimeLLVM59812594. Cold misses collapsed from folded8.28million to8;
  rejected attempts~66.3%below original probe47.23million. No verification bypass.
- Diagnostic timing13.254235FPS452.246879CPUms,pressure5.81382%,draws1163.372857,
  0drops; don't compare timing blindly with differently loaded diagnostic runs.

Uninstrumented candidate:
- C++ g_spu_web_cache_profile_enabled=false is now the single constexpr switch for cache
  instrumentation. Template4096/false/foldedtrue. Keep heap-owned preferences across
  slices/longjmp. Extra cache loads/stores compile out; JSON omits those fields when
  disabled. Existing dispatchProfile attempts/rejections remain as in old benchmarks.
- Built spu-persistent-release-build.log exec91340; isolateddist/core/spu-persistent-release-jspi.
  AssertionsOFF matching runtime-noassert-jspi control. Headful GPU and real PPU AOT
  dispatch oracle2tests passedspu-persistent-release-tests.log exec76821.
- Chrome spu-persistent-release-1 exec11887 completed5501flips,4inputs,failures[].
  4500–5200:14.729386FPS409.325380CPUms/frame,p9579.36475,p9986.75537,max309.40479,
  pressure2.25892%,0drops,1163.372857draws/frame. Renderer deltas match noassert control.
  Earlier runtime-noassert-1:14.442091FPS416.735106CPUms,pressure2.35656%.
  ~1.78%CPU reduction in one pair. Still~50%moreCPU than native272.928984; not parity.
- iPad ipad-spu-persistent-release exec1037 completed7000/720p/capture. Window:
  15.950097FPS,p9568.06030,p9973.99951,max86.30005,0drops,1163.372857draws/frame,
  renderer deltas match. CPUunmeasured. Earlier old-cache noassert varied15.93778 then
  14.17037; current result alone is NOT a proven iPad win. Fresh control active below.

Native profiling harness:
- Utilities/FrameTiming.h position() reads current flip underexistingmutex.
- Native --benchmark-progress PATH emits frame+monotonicUs every500ms withQTimer,
  requires --benchmark-report. Enabled only for profiling coordination here.
- run-native-performance RPCS3_PERF_FROM_FRAME / TO_FRAME optionally delimit perf recording.
  Progress startsat0 beforechildspawn to avoidstale reuse. PartialJSONwrite races retried.
  Records actualobserved start/stopframes/times inreport.perfWindow. Uses99Hzcycles:u,
  dwarf4096,-k1,-m2048. SetFROM4400/TO5000 then offlinefilterexact4500–4900 usingfinal
  native flip timestamps. Missingstartframe/perferrors become explicitreportfailures;
  newfinal exitcode guardfailures added afteractiverunner started (currentrunnerhasolder
  exitcodeguard but stillrecords failures). Normal launchesnoextra progressfile.
- Native buildnative-window-profile-build.log exec32275 passed (22actions); runner syntax
  andgitdiffcheck passed. Liveprogressfile confirmedadvancingto2311; PERF WINDOW NOT YET
  reached at13:30. Full coordination start/stop runtime validation remainspending.
- Nativejit_announce perfmap publication alreadyexists viaRPCS3_PERF_MAP=1. Need inspect
  symbolcoverage and matchedCPUcategories afterprofiling. Avoidassumingmappingcomplete.

Architecture finding:
SPU diagnostic-notail bundle is ONE Wasm module containing5436programs (~10.85MB).
Most successful dispatches use bundledprograms (~409million/700frames in latest probe),
notruntimeLLVM (~60million). Same-instance chaining could avoidgenericouterreturns;
compiler nativepatchpoint/dispatcher imports currentlyjustreturn through host stubs.
Need preserve entryverification, candidatepublicationpriority, budgetedescape, module
bounds, and correct handling when a downstream verification fails after prior blocks ran.
Do not implement naive recursion through importedtailcalls onSafari.

ACTIVE ONLY:
1. Native windowprofile exec78233, runnerPID3444471/nativePID3444762,
   outputnative-window-profile/log, XDGnative-window-profile-fixture,DISPLAY:98,
   duration350000ms,PERF_MAP1,PERF1,FROM4400/TO5000,normalinputtrace.
   Progressnative-window-profile/native-progress.json. Lastobserved2311frames/1:32elapsed.
   No builds/tests/desktopChrome alongside nativeprofiling.
2. iPad fresh old-cache control exec52517, outputipad-spu-persistent-control/log,
   core runtime-noassert-jspi,oldPPUreturn-single/SPUnotail,target7000/720p/capture,
   PPUJIT0/SPUstatic/return1/900stimeout. Lastobservedbootframe0 at13:30.

Next: completeboth, validate nativeperf boundaries/loss diagnostics/buildIDs; derive native
andChrome sampledCPU breakdowns over4500–4900 (native frames not just walltime). Compare
freshiPad control. Further desktoppair may be needed to establish1.8%cache effect. Latest
public/core/jspi is uninstrumentedpersistentcore; defaultdist/core/jspi remainsunchanged.
Rendering shadows/glow/compositing and compressedRSXcaptureload still unresolved.

## Folded cache result and persistent cache — 2026-09-05 13:13 PDT

Goal ACTIVE/INCOMPLETE. This turn PROGRESS. No agents/commits/default core deployment.

- Folded-cache diagnostic exec64695 completed5201+flips (inspect report for final exact),
  completedtrue,failures[]. Window4500–5200 dispatch deltas:
  attempts568104039,rejected18401408,cacheCold8280586,cacheGenerationMisses2253247,
  cachePreferredHits536663106,cachePreferredRejections2505692,tableSyncs0,
  interpreted25462,samePcReturns0. Failed verifications fell61.0% from probe47234943;
  generation misses fell96.7% from68250671. More cold entries due clearing larger cache.
- New execution-tier evidence: successful outer dispatches549706845, runtime fast-tier0,
  runtime LLVM60204410 in window. The remaining majority uses bundled SPU programs.
  This confirms optimizing runtime compilation counts alone misses the dominant path.
- Timing is NOT a demonstrated win: folded12.118177FPS496.305410CPUms/frame,
  pressure14.30567%, vs instrumented256-slot probe14.805681FPS404.101052CPUms,
  pressure2.10236%. Both1163.372857draws/frame,0drops. Host load changed substantially.
  ps at13:12 showed several qemu-system-x86 processes with PIDs3033xxx alongside Unity;
  these are unrelated workloads and were NOT touched. Do not blame code or claim speedup
  from this unmatched-pressure pair. Pure counts still demonstrate reduced failed searches.
- NEW persistent candidate: cache allocated once with std::make_unique in cpu_task BEFORE
  setjmp loop, passed by reference into each web interpreter slice. Heap-owned preferences
  survive both normal slice returns and longjmp; unchanged unique_ptr outside checkpoint
  avoids modified automatic-object indeterminacy. Native portable path signature unchanged.
  Only observations reset per slice; counters publish as before. No SPU object/AOT ABI change.
  Still4096slots+foldedaddress+instrumentationON for diagnostic comparison.
- Built spu-persistent-cache-build.log exec1100 passed; staged isolated
  dist/core/spu-persistent-cache-jspi. Headful direct JSPI GPU test passed
  spu-persistent-cache-gpu-tests.log exec36141. Six cache unit tests alreadypassed;
  gitdiffcheck and play-runtime syntaxcheck clean. Default dist/core/jspi untouched.
- iPad runtime-noassert-2 completed, see next section:14.170367FPS, worse than control.
  No proven iPad assertions benefit. Available USB GasGauge/AppleSmartBattery queries
  work but did not expose current temperature/thermal-pressure values; do not attribute
  variability to thermal throttling without evidence. No device run active.

ACTIVE ONLY:
Chrome persistent-cache diagnostic exec94998, outputspu-persistent-cache/log,
core spu-persistent-cache-jspi,oldPPUreturn-single,normalinputtrace,target5200,
freshprofile ~/.cache/rpcs3-web-spu-persistent-cache. No native/build/test/device active.
Latest public/core/jspi is persistent instrumented build; C++ source matches that build.

Next: finish persistent diagnostic; compare exact4500–5200 cold/mismatch/rejection/tier
counts. If beneficial, build uninstrumented persistent variant (template Instrument=false,
ensure no meaningless cache-metric interpretation) and run matched fresh Chrome control
and iPad tests before adopting. External host pressure may require repeating paired runs;
never terminate unrelated VM processes. Longer-term seam: native SPU chains blocks while
web dispatcher/patchpoint imports return through generic outer loop. Explore safe
same-instance chaining after removing avoidable cache overhead. Preserve LS verification
and Safari's cross-instance tail-call constraints. Renderer fidelity still unresolved.

## SPU cache rejection diagnosis and folded-cache experiment — 2026-09-05 13:07 PDT

This turn PROGRESS. Goal active/incomplete. No agents/commits/default core deployment.

Completed assertions controls:
- Chrome noassert-control-1 exec34522:5514flips,4inputs,failures[]. 4500–5200:
  14.340016FPS422.841667CPUms/frame,p9583.13989,p99109.64014,max312.46484,
  1163.372857draws/frame,0timingdrops,pressure2.61529%. Renderer counter deltas match
  runtime-noassert-1 exactly. Candidate416.735106 is1.44417% less CPU, small one-pair
  result. Keep assertions toggle opt-in; default CMake remainsON.
- iPad ipad-noassert-control exec89321 completed7000/720p/capture. 4500–5200:
  14.525992FPS,p9575.18018,p9982.11938,max116.66016,1163.372857draws,0drops.
  Candidate ipad-runtime-noassert15.937779FPS (~9.72%higher), but repeat pending.
- Second iPad candidate ipad-runtime-noassert-2 exec71706 COMPLETED7000/720p/capture.
  4500–5200:14.170367FPS,p9579.26001,p9987.32007,max103.70020,0drops,
  1163.372857draws/frame; renderer deltas match control exactly. Does NOT reproduce
  first candidate15.93778; below control14.52599. No established iPad assertions win.
  Default assertions remainON, experiment remainsopt-in. Device variability needs
  stronger control/thermal or OS CPU instrumentation before small wins are adopted.

New SPU evidence and code:
- Existing runtime-noassert-1 dispatchProfile delta4500–5200:
  attempts508795354,rejected46176465,tableSyncs1,interpreted20328,samePcReturns0.
- Added opt-in template instrumentation to SPUWebDispatch.h verified_dispatch_cache:
  cold entries, generation mismatch, preferred hit, preferred rejection. No verification
  bypass. Loop publishes counters alongside existing diagnostics every1024iterations and
  slice return. Unpublished escape tails remain possible as before.
- Diagnostic core dist/core/spu-cache-probe-jspi built with256slots/instrumentation,
  runtime assertionsOFF; includes indexed replay and async boot fixes.
  Build/gpu tests passed,5native cache tests passed including diagnostic accounting.
- spu-cache-probe exec72952 completed5202flips,failures[]. Exact4500–5200 delta in
  dispatch-window.json: attempts508197641,rejected47234943,cacheCold1752872,
  cacheGenerationMisses68250671,cachePreferredHits389611692,
  cachePreferredRejections1347463,tableSyncs0,interpreted26877,samePcReturns0.
  Renderer draws814361. Most rejected attempts follow lost preferences, not failure of
  the preferred entry. Main next hypothesis: too-small/direct-low-address cache causes
  repeated full-list scans. Don't label all SPU loop CPU removable overhead.
- NEW CANDIDATE: verified_dispatch_cache<4096,true,true>. Third template parameter
  FoldAddress hashes word=pc>>2 with word^(word>>8), then masks. 4096entries ~32KB
  per execution slice instead of2KB. Still calls candidate verification on every hit;
  publication and mutable LS correctness unchanged. Instrumentation remains ON in
  source temporarily for diagnosis (do not silently deploy as final production change).
- Folded candidate built spu-folded-cache-build.log; isolateddist/core/spu-folded-cache-jspi.
  Six native cache tests passed (spu-cache-tests.log), includes folded aligned-block
  separation + mutation. Headful direct JSPI test passedspu-folded-cache-gpu-tests.log.
- play-runtime.mjs now retains existing worker counts spuDispatches,spuHotDispatches,
  spuLlvmDispatches in benchmarkFrames; no new per-block accounting. Staged to dist
  AFTER first probe finished, BEFORE folded run. Helps distinguish compilation from
  which tier actually executes. Browser current folded run has those fields.

RSX replay progress:
- Indexed raw .rrc replay works! Earlier 10frame/90sec timeout was too short, not proof
  of failed boot. One-frame run rsx-replay-indexed-browser completed2.2sec but ZERO draws
  (initial blank flip), so not sufficient. TWO-frame run rsx-replay-indexed-two completed
  16.277sec,1162draws,7clears,109programs,123pipelines,0translationFailures/unsupported,
  1621textureUploads1445invalidations,clean shutdown. No PPU/SPU guest instructions.
  Actual rendered frame report.frame.png inspected: severe compositing/lighting errors,
  unlike native replay. Still not a clean throughput benchmark: snapshot restore/uploads
  dominate, native repeats ~4s and browser ~14s. Compressed .gz loading still fails
  serialization.hpp:178; raw decompression workaround used.
- Improved runner's serialized error partials are in source/staged runtime JS. Successful
  replay path validated; failure partial persistence still needs explicit failed run proof.
- Indexed replay code now compiled and runtime exercised in both native and Wasm.
  No default production core replaced. Native capture and index binaries differ; prior
  native-reference-refresh remains measured baseline with its own recorded hash.

ACTIVE at final update:
1. Chrome folded-cache diagnostic exec64695, outputspu-folded-cache/log,
   core spu-folded-cache-jspi,oldPPUreturn-single,target5200,normalinputtrace,
   freshprofile ~/.cache/rpcs3-web-spu-folded-cache. Compare dispatch-window4500–5200
   with probe baseline above BEFORE claiming benefit. Run without extra host workloads.
2. iPad repeat TERMINAL; no device run active.
No native/build/test active. Latest public/core/jspi is folded instrumented candidate.

Next: finish folded Chrome diagnostic. If it cuts rejected attempts, build an uninstrumented
candidate and validate real Chrome CPU/frame + iPad FPS against matching controls.
Preserve larger architectural question: SPU returns through generic outer dispatch
hundreds of millions of times; imported dispatcher/patchpoint stubs simply return,
where native can chain blocks. Safe same-instance chaining is a possible next seam,
with local-store verification and Safari imported-tail-call constraints preserved.
Native parity and rendering fidelity remain unachieved.

## Profiler attribution, deterministic capture, assertions experiment — 2026-09-05 12:51 PDT

Goal remains active and incomplete. This turn made progress: resolved the latest native
profile leaves, fixed incomplete per-thread accounting, acquired a real native RSX capture,
and completed the Chrome assertions-disabled candidate. No commits or default core deployment.

- Latest `profile-ppu-combined/native-resolved.json` now resolves matching Chrome/libc build IDs.
  Native leaf categories: libc copy/clear 6.48246%, Dawn 3.32762%, V8/builtins 11.51219%,
  allocator 1.33064%, Blink 2.38017%. Do not add these to overlapping JIT categories.
- `analyse-jit-perf.py` now emits `threadTotals` including the long tail omitted by its legacy
  top-ten `threads` map. Regression tests: 4 passed. `analyse-native-perf.py` now emits thread
  totals and top leaves too; 5 tests passed. Both latest reports regenerated.
  Complete sampled-cycle shares: main PPU tid1529877 19.8467%, RSX tid1529938 14.1269%,
  six SPU workers together ~46.3%, apparent GPU thread1529522 8.1931%.
  Most Chrome property lookup, memory-buffer access, and binding conversion is on RSX.
- Discovered runtime ASSERTIONS=1 includes per-WebGPU-handle dictionary membership checks.
  Added opt-in `RPCS3_WEB_RUNTIME_ASSERTIONS=0` build option (default remains 1/ON).
  `-lexports.js` publicly disables Wasm name minification independently of assertions;
  trying internal MINIFY_WASM_EXPORT_NAMES directly was rejected by emcc and replaced.
  201 required runtime exports and env.memory preserved; real headful direct JSPI capture
  and PPU AOT dispatch oracle both passed (`runtime-noassert-tests.log`).
- Isolated `dist/core/runtime-noassert-jspi` contains fixed combined bind groups, constant
  cache, PPU slices, diagnostics, first replay extension; async capture boot still OLD there.
  Chrome `runtime-noassert-1` exec45402 completed 5511 flips, 4 inputs, failures[].
  4500–5200: 14.442091 FPS, 416.735106 CPU ms/frame, 1163.372857 draws/frame,
  p95 81.710205ms, p99 94.659912ms, max381.854492ms, timingDrops0, pressure2.35656%.
  ~2.16% lower CPU than earlier PPU slices425.919, but needs fresh fixed-bindings control.
  Native gap remains ~52.7% vs272.928984 CPUms. No proven assertions-only speedup yet.

Capture/replay:
- Failed Alt+C timer code REMOVED from run-native-performance.mjs. New
  RPCS3_CAPTURE_RSX_FRAME -> --benchmark-capture-frame configures FrameTiming before boot.
  note_flip returns a one-shot request at configured guest flip; RSX sets existing capture flag.
  Standalone check passed disabled/default/exact one-shot/drain behavior; native build passed.
  Harness creates captures directory and requires actual successful log/file/hash for success.
- `native-frame-capture` exec58702 completed: 4501 flips, failures[]. Requested at4500;
  captured BCUS98372_20260905123931_capture.rrc.gz, 31,882,142 bytes,
  SHA256 80dd59b1fd86c6349f720fd06ec3c466c23efb53c94b078929476fe233155bb3.
  Fixture XDG native-frame-capture-fixture, native log RPCS3.log. This is a diagnostic,
  NOT a performance baseline (paused and overlapped builds). Native process exited.
- Capture staged at dist/fixtures/local-rsx/lbp2-frame4500.rrc.gz; raw decompression .rrc
  is111,746,701bytes. worker suffix preservation staged to dist.
- First browser replay called async BootGame despite synchronous boot extension. Fixed
  rpcs3_web_boot_begin to call shared rpcs3_web_boot. Built noassert core isolated at
  dist/core/rsx-replay-async-jspi. Compressed browser replay still fails serialization.hpp:178.
  Raw browser replay avoids immediate failure but timed out after90sec; no successful replay.
  All those Chrome diagnostic sessions are TERMINAL (30805,85492,95929,33448).
- Improved runtime-fatal handling: preserve worker logs, forward fatal log lines, include
  recent events in worker errors. run-hardware-acceptance catches errors INSIDE page.evaluate
  to retain partial evidence otherwise lost crossing Playwright's boundary. JS staged to dist;
  these latest failure-preservation changes still need a runtime diagnostic verification.
- Native runner recognizes .rrc/.rrc.gz/.rrc.zst and supplies --rsx-capture.
  `native-rsx-replay` exec53526 completed5flips/20s, failures[]. Visually renders the scene,
  but missing Media Molecule text vs captured live frame; replay not yet a faithful oracle.
  Each replay ~4seconds; source did repeated linear searches of all captured state maps.
- Added immutable reverse indexes by state ID to rsx_replay_thread (memory/data/display/tile),
  preserving first match behavior. Native index build PASSED exec27436, log
  rsx-replay-index-native-build.log. WASM INDEX BUILD NOT STARTED.
  Must validate native replay speed/image and browser replay; do not claim speedup yet.
- Visual correction: captured native gameplay has plank background and neon-green sign too.
  Earlier blanket wrong-material claims were too broad. Chrome demonstrably lacks native
  shadows/glow and has lighting/color differences. Native screenshot at6711 is another scene;
  prefer exact captured4500 reference (native-frame-capture/frame.png) for this region.

iPad `ipad-runtime-noassert` completed7000 frames, 720p, old PPU return-single and SPU
notail bundles, capture enabled. Window4500–5200:15.937779FPS,p9567.93994,p9972.72046,
max90.23975,timingDrops0. CPU unmeasured. Draw counter delta814625 (1163.75/frame),
slightly differs from earlier814360; do not assert exact counter equivalence. Earlier
constant-cache15.7132FPS, split15.5327FPS; small differences still need fresh control.

Native indexed replay exec75919 completed5flips/20s, failures[]. Consecutive intervals
3581.9,4170.9,3570.8,3228.4ms vs unindexed4101.3,3781.9,4059.9,4034.5ms. Still far too
slow for a renderer benchmark; no strong performance claim from four intervals.
Screenshot visually same scene but pixel equality check FALSE; investigate significance
before using as a strict correctness oracle. WASM index build still pending.

ACTIVE at final update:
- Chrome `noassert-control-1` exec34522, fixed-bindings-jspi (assertions ON), old PPU bundle,
  target5500, fresh profile ~/.cache/rpcs3-web-noassert-control-1, normal input trace.
- iPad `ipad-noassert-control`, fixed-bindings-jspi, old PPU/SPU notail bundles,
  target7000/720p/capture, 900s timeout. Poll log and actual process before any restart.
No builds/tests/profilers alongside the Chrome control.

Next: finish both assertions-ON controls and compare4500–5200 before adopting noassert.
Then build/test browser indexed replay and preserve failure partials with the improved runner. No builds/tests/profilers alongside any desktop performance benchmark.
Default dist/core/jspi and default game bundles remain untouched. Latest public/core/jspi
is noassert async-boot build, not the pending indexed replay source.

## Fresh native gap and RSX replay preparation — 2026-09-05 12:24 PDT

This turn PROGRESS: freshnativecompleteandmeasured,simplifiedbindpathbuilt/tested,
existingRSXcapturereplayseamexposedinbrowser,newnativecapturediagnosticrunning.
Goalactive/incomplete. Noagents/commits/defaultcoredeployment.

- native-reference-refresh exec13850 TERMINALsuccess6711flips,failures[].
 4500–5200=13.068981FPS272.928984CPUms/flip,p9581.27383,p9987.35720,max96.03008,
 0timingdrops,hostpressure2.02533%,fullwindowcoverage. Native drawcountunmeasured.
 Screenshotinspected: correctmaterials/lighting, comparablegameplayscene.
 Browserrecent420–449CPUms/flip (~54–64%moreCPU) despite similar13–15FPS andincorrect
 materials. Do notclaimparityfromFPS; currentnativeconfirmsCPUgapandfidelitygap.
- fixed-bindings source(singlecombined36-entryfixedarray,splitcacheREMOVED) built
 fixed-bindings-build.log exec35886terminal; stageddist/core/fixed-bindings-jspi.
 FullruntimeheadfulHTTPSdirectJSPIcapturetestpassedfixed-bindings-gpu-tests.log
 exec34333terminal. No fullgameperfclaimforfixedarrayyet. JSdrawBufferGroupoptional
 backwardcompatiblesupportandartifact-specifictestsremain. Defaultdist/core/jspiunmodified.

NEWcapture/replay workflow (notyetvalidatedendtoend):
- Nativealreadyhas Alt+C RSXcapture, writesconfigdir/captures/*.rrc.gz, pausesemulation.
 Emulator::BootRsxCapture alreadycompiledforweb (System.cpp854–974), loadscompressed
 snapshot andstartsrsx_replay_thread, bypassingPPU/SPUgameexecution.
- run-native-performance.mjs optionalRPCS3_CAPTURE_RSX_AT_MS setsdelay. Atdeadline find
 OWNpidwindowwithFPS:title, verifyPID,focus/sendalt+c,recordrequesttime/window/title.
 Suchruniscorrectnessdiagnostic,NOTperformancebaseline (capturepausesplayback).
- webhost rpcs3_web_boot recognizesonly .rrc/.rrc.gz/.rrc.zst suffixes, dispatches
 Emu.BootRsxCapture; successmapsno_errors,falsemapsinvalid_file_or_folder. Otherbootpaths
 unchanged. ThisreusesexistingnativeRSXcaptureformatandserializer,notnewpacketformat.
- Buildrsx-replay-runtime-build.logpassed exec39551terminal; stagedisolateddist/core/rsx-replay-jspi.
 Newcapturepath NOTYETRUNTIMEtested. public/core/jspi nowrsxreplaybuild.

ACTIVE ONLY:
Nativecapture exec53266 PID2422174 confirmedlive. Runnerlognative-rsx-capture.log,
 outputnative-rsx-capture/native.log. DISPLAY:98, clonedXDG_CONFIG_HOME
 /home/administrator/Documents/rpcs3-web/test-results/performance/native-rsx-capture-fixture,
 capturefolder.../rpcs3/captures created;350000msduration,requestat290000ms,inputtrace.
 SameVulkan720p/PPULLVM/SPULLVM config. Capturedelayishosttime,notexactguestflip;
 reportrecordsrequestandfinalcapturewillidentifyactualscene. Noothergamebenchmarksactive.
 WASMbuildranalongsideTHISDIAGNOSTIC,soabsolutelynotcontrolledtimingdata.
NoChrome/iPadcurrentlyactive. :98Xvfb3232459sharedalreadyrunning,donotterminate.

Next: pollnativecaptureexec53266 (neverrestartontimeout); inspectreport.rsxCaptureRequest,
 compressedcapturefileandpausedscreenshot. Ifshortcutfails,debugOWNwindowdelivery.
 Thenloadsamecapturethroughnative--rsx-captureandnewwebhostpath; addtargetedheadful
 runtimeharnesstest. Needverifyrsx_replay_threadworkswithwebsparseVM/workerstartup,
 noAOTneededforgraphicsreplay. ThiscanisolateGPUcostandshadererrorswithidenticalcommands.
 Existinggamefidelity/nativeCPUgap/deviceproductionSPUtailpolicyremainunfinished.

## Split binding results and native refresh — 2026-09-05 12:16 PDT

This turn PROGRESS: bothsplitbenchmarkscomplete; rejectedcomplexcachepathbasedonevidence;
source revertedtosinglebindgroup withfixedarray; newnativecomparisonrunning. Goalactive.

COMPLETED:
- split-bindings-1 exec49694 success5513flips,4inputs,noerrors.
 4500–5200:13.735885FPS442.284418CPUms/flip,p9586.08496,p99101.25488,max335.84985;
 1163.372857draws,0drops,pressure3.88972%. Deltas814361draws649861texturegroupHits,
 164500creates (~79.80%hits). Constantcachebaseline448.655CPUms13.239FPSwithpressure7.138%.
 Only1.42%lessCPUthanthatbaseline; no convincingwinversus earlier slices425.919CPUms.
- ipad-split-bindings exec71796 success7000flips,720p,captureon:
 15.532746FPS,p9573.50024,p9978.87988,max112.28003;1163.371429draws,0drops,
 649860hits164500creates. Earlierconstantcache15.713197FPS. DeviceCPUunmeasured.
- Decision: split/cachecomplexity notjustifiedbyoneweakChromecomparisonandsloweriPad.
 REMOVEDsplittexturecache/layouts/stats/secondSetBindGroupfromC++source. Isolated
 dist/core/split-bindings-jspi retainedforreproduction. JSoptional drawBufferGroup support
 andGPUtestcoverremainbackwardcompatible. Optionalruntimecacheassertion remainsforartifact.
- Source NOWonecombinedbindgroupusingfixedstd::array<WGPUBindGroupEntry,36>+entry_count,
 eliminatingtemporarygrowingvector whilekeepingoneSetBindGroup. C++newfixedarray/reversion
 NOTYETBUILT/TESTED: nativebenchmarkactive; buildandtestAFTERitfinishes. No defaultdistchange.
 public/core/jspi stilllastsplitbuild untilnextbuild; don'tmistakesourceforstagedartifact.

Harness:
- measureWindow nowreports explicit cumulative renderer directCounterDeltas overmatched
 window. Knowncounterwhitelist excludesbitmasks; absent/resetcounts omitted. Sixmetrics
 tests pass split-bindings-metrics-tests.log (afterChromeendedbeforeNativebegan).
- nativeharness nowrecords executableSHA256 and /proc/pressure/cpu + loadavg onnative
 monotonicclock, compatiblewithanalyserwindowconversion. Syntaxcheckpassed; active
 nativerunhasmatchingprocess+pressuresamplesandnoharnessfailures.

ACTIVE ONLY:
- Native exec13850, PID2207243 confirmedlive, native-reference-refresh.log (runner),
 native-reference-refresh/native.log. DISPLAY:98,XDG_CONFIG_HOME absolute
 test-results/performance/native-reference-refresh-fixture (copyofnative-fixture),
 400000ms,Vulkan720p,PPU/SPULLVM,AudioNull,inputtrace. Executablehash
 943e989845d4ea3464f2bd675da58a23dfc9333de22a974bc2b11c638d8dccea.
- :98Xvfb PID3232459 wasactuallylive whenrechecked(rootwindowemptybeforelaunch).
 Priorhandoffclaim:98deadwasstale; doNOTkillthisserverorassumeownership.
 NoChrome/iPadbenchmarkactive. Don'trunhostbuild/tests/profilersalongsideNative.
 Nextfinishnative,compute4500–5200andinspectcapture; comparecurrentbrowserCPUgapwith
 pressurecaveats. Thenbuild/testsinglebindgroupfixedarrayandcontinueprofile-guidedwork.
 Fullnativeparity/materialcorrectness/deviceproductionSPUtailpolicyremainincomplete.

## Split texture/draw binding experiment — 2026-09-05 12:07 PDT

This turn PROGRESS: LBP2routingdiagnostic complete; WebGPUresourcebindingseam implemented,
built,pixel/runtimevalidated; controlledbenchmarksstarted. Goalactive/incomplete.

- fragment-output-routing exec94508 TERMINALsuccess5502flips,4inputs,noerrors,
 1,857,108draws,170programs. remappedColorPrograms0,UNslots0throughoutobservedrun.
 Screenshotinspected: sameincorrectcyan/pink/woodmaterials. Correctnessfix validandtested
 butnotobservedLBP2cause. Remains retained fornonidentityattachmentcases.

NEWarchitecture:
- Directtranslatedshader usesgroup0fortextures/samplers,group1fordrawbuffers32–35.
 translateRsxProgramoptional drawBufferGroup (0default,1direct) flowsintoassembly.
 Existingpacket/oldcorecallers remain group0/backwardcompatible.
- gpu_program hastexture-onlybind_group_layout anddraw_bind_group_layout; pipelinelayout
 holdsboth. Texturegroup cachesmostrecentview/samplerarray PERPROGRAM (onegroup/program,
 boundedbyexistingprogramcache). Buffer offsets/sizes no longerinvalidate texturegroup.
- get_texture_bind_group builds32entryfixedarray onlyonmiss; matchincrements
 textureBindGroupHits; missincrements textureBindGroupCreates. Identityincludesallreferenced
 slots withnullsampler/viewfallback. No buffers/uniforms intexturekey.
- Perdrawbufferbindgroup usesfixed4entryarray (replacesgrowingvector), samebuffers/ranges;
 drawsetsbothgroup0(texturecache)andgroup1(drawbuffer). ExtraSetBindGroupcostmustbemeasured.
- clear_texture_bind_groups beforeanyretiredview/texturehandlesreleased atsubmit prevents
 recycledhandlealias andretainingretiredtextures. Alsoonexit; newdrawlayoutsreleasedonexit.
 Currentcacheholdsonegroupperprogram; no largeglobalLRU orbuffer-keycache.
- Files WebGPUDirectGSRender.cpp/.h, hostmainstats, publicrenderer.mjs.
 Buildsplit-bindings-build.logpassed(exec36105terminal); isolateddist/core/split-bindings-jspi
 staged, dist/rpcs3-webgpu-renderer.mjs updatedbackwardcompatibly. Defaultdistcoreunchanged.
 public/core/jspi isnewexperiment. IncludesPPUslices,constantcache,routingfix,diagnostics;
 gamebenchmarks useOLDPPUreturn-single (noinline reads).
- HeadfulHTTPSGPUtests passed2(split-bindings-gpu-tests.log,exec20621terminal): sparseRSX
 colorpixeltests nowrunbothdrawBufferGroup0and1/full&half, plusfullruntimeJSPIcapture with
 RPCS3_TEST_TEXTURE_BIND_CACHE=1 assertspositiveactualtexturegroupcreatesANDhits.
 Typecheckpassed(split-bindings-typecheck.log,exec97520terminal); gitdiffcheckclean.
 Fullgamebenefitnotyetclaimed. Oldall-in-onebindgroupcachewasrejectedearlier; thissplit
 removesvaryingvertexrange/offsetsfromtexturecacheidentity, materiallydifferentexperiment.

ACTIVE NOW:
1. Chrome exec49694 split-bindings-1.log,core split-bindings-jspi,oldPPUreturn-single,
 defaultSPU/JITtiers,5500flips,inputtrace,UNPROFILED,freshclone
 ~/.cache/rpcs3-web-split-bindings-1. Measure4500–5200withdraws/pressure/counters.
2. iPad exec71796 ipad-split-bindings.log,samecore/PPU,SPUlbp2-spu-notail,SPUstatic,
 PPUJIT0,return1,7000flips,720p,captureon,inputtrace,900stimeout.
No desktopbuild/tests/profilers alongsideChromebenchmark. Deviceindependent.
Nextfinishboth,inspectcapturesandcachehitratio; compareconstantcachebaseline
 Chrome448.655CPUms13.239FPS (pressure7.138%) / iPad15.71320FPS, andfreshcontrolsifuseful.
NeednativeCPUparity,correctmaterials,productionSPUtailpolicy,andrepeatableperformance.

## Sparse color-output routing fix — 2026-09-05 12:01 PDT

This turn PROGRESS: constantcachebenchmarks completed; concrete MRT routingbug fixed and
GPU-pixeltested; LBP2correctnessrun started. Goalactive/incomplete, noagents/commits.

Constantcache results (bothTERMINALsuccess,oldPPUreturn-single):
- fragment-constant-cache-1 exec66539:5508flips,4inputs,noerrors;4500–5200=13.23900FPS,
 448.65514CPUms/flip,p95110.57471,p99135.23486,max298.21509;1163.372857draws,0drops.
 Pressure7.13805% versusoldPPUslices2.94379%. NOChromeperformancewinproven.
- ipad-fragment-constant-cache exec86474:7000flips,captureon,720p;15.71320FPS,
 p9569.42017,p9972.23999,max79.48022;1163.372857draws,0drops,CPUunmeasured.
 Versusslices15.34205FPS~2.42%gain,onepaironly. Retainconstantcacheassimplification/
 smallpossibledevicebenefit; notaconfirmedChromeoptimization.

NEWcorrectnessfix:
- bound_targets compactedaway color-write-disabledattachments. Shaderexportselection,
 writeMaskandblendstate thenusedCOMPACTindices, erroneouslyturning survivingoutput1
 intor0/colormask0. NativeRSXThread.cpp1380 mapslogicaloutputordinals intophysicalRTindices.
- targets.color_output_map packsoriginalshaderoutputordinalperretainedattachment (2bits).
 program_key alsohasmap; perprogramshadercache separatesmappings. Pipeline write masks
 andblend-enable useoriginalordinal. SinglephysicaltargetB retainslogicaloutput0.
- EM_JS translator takescolor_output_map and passescolorOutputIndices array; JS translator
 optionalinputflowsintoassembly/fragmentSignature. Exportschooser32[0,2,3,4] orr16[0,4,6,8]
 basedonORIGINALoutputs,includingloneoutput1. Defaultindices preserveoldcallers/packetpath.
 Alpha-teststillusescolor0 asnative. Validation rejectsoutofrange/mismatchedarrays.
- Newdiagnostic remappedColorPrograms countsvalidprogramswithnonidentityoutputmapping.
 UsedtoestablishactualLBP2use beforeclaimingthisexplainsmaterialerrors.
- Buildfragment-output-routing-build.logpassed exec58519terminal. Isolated
 dist/core/fragment-output-routing-jspi staged; includesconstantcache+PPUslices+UNdiagnostic.
 dist/rpcs3-webgpu-renderer.mjs updatedwithbackward-compatibleoptionalinput.
 Defaultdist/core/jspi andgamebundles remainunchanged.
- ThreeVitestunitroutingtests pass (fragment-output-routing-tests.log): sparse/loneoutput,
 half/fullprecision,invalidindices. HeadfulHTTPSGPUtest createsrealRSX MOVinlineconstant
 programswithdistinctRGBAexports, rendersretained[1] and[0,2,3] attachments,andassertsactual
 pixelsforfull/halfprecision. ThisanddirectJSPIruntimecapturepassed2tests
 (fragment-output-routing-gpu-tests.log,exec43327terminal). Typecheckpassedexec40320
 fragment-output-routing-typecheck.log. Gitdiffcheckclean.
- Filesadded web/tests/fragment-output-routing.test.mjs and
 web/tests/e2e/fragment-output-routing.spec.ts; GPUconfigincludeslatter.

ACTIVE NOW:
Chrome exec94508 fragment-output-routing.log,5500flips,corefragment-output-routing-jspi,
 OLDPPUreturn-single,defaultSPU/JITtiers,inputtrace,freshclone
 ~/.cache/rpcs3-web-fragment-output-routing. Diagnosticgameplaycapture; read
 backend.remappedColorPrograms andinspectframe.png againstknownwrongmaterials.
 NoiPadrunactive. Do notclaimLBP2fixbeforecapture/actualuse. ExistingUNmask0leadruledout.
FullgoalstillneedsnativeCPUparity,correctmaterials,iPadproductiontailpolicyandrobustdefaults.

## Fragment constant metadata optimization — 2026-09-05 11:52 PDT

This turn PROGRESS: rendering lead tested and ruled out forobservedscene; newdraw-path
optimization implemented,built,fixturetested,benchmarksstarted. Goalactive/incomplete.

- texture-coordinate-diagnostic exec40274 TERMINALsuccess4511flips,691812draws,
 163programs,backend.unnormalizedTextureSlots=0 throughoutobservedrun,0translationfailures.
 LBP2didNOTexerciseUNcoordinates inthisscene. Do notpatchsampling claimingthiscauses
 currentmaterialerrors. Native/translatorsemanticgap existsbutisnotobservedcause.
- Found perdrawrescan of fragmentmicrocode forconstantoffsets,temporaryoffset/value
 vectorallocations,andcopytouniformring. Programhash alreadyencodesinstructionlayout
 whileignoringinlinevalues. Movedconstantoffsets intogpu_program atget_program creation;
 clampoffsetvector to256preservesexistinguniformcapacity/truncation; perdrawusescached
 offsetsandwritesfreshvalueswithnativewrite_fragment_constants_to_buffer directlyinto
 floatspan ofuniformring. Nativebyteswap/sanitizefalse semanticsunchanged. Removes
 constant_count field,perdrawscan,temporaryvectorsandmemcpy. No shadersemanticchanges.
- Files WebGPUDirectGSRender.cpp/.h onlyforoptimization. PriorUNdiagnostic retained.
 Buildfragment-constant-cache-build.log passed. Isolateddist/core/fragment-constant-cache-jspi
 containsPPUslices+inlinecapability+newconstantcache+UNdiagnostic. Defaultdist/core/jspi
 unchanged. public/core/jspi nownewexperimentalcore. Bothgamesbelow useOLDPPUreturn-single
 toexcludeunproveninline-readcost.
- HeadfulHTTPSdirectJSPIrender/capturefixturepassed (fragment-constant-cache-oracle.log,
 exec69236terminal). Buildexec16103terminal. Gitdiffcheckclean. Thisfixturedoesnotprove
 fullLBP2fidelity/performance; gamecomparisonstillneeded.

ACTIVE NOW:
1. Chrome exec66539 fragment-constant-cache-1.log,corefragment-constant-cache-jspi,
 PPUlbp2-return-single,defaultSPU/JITtiers,5500flips,inputtrace,frozenclone
 ~/.cache/rpcs3-web-fragment-constant-cache-1. UNPROFILED. Compare4500–5200andmatched
 drawcounts againstslices-only425.919CPUms/14.27668FPS,ideallyfreshsamebaselinecontrol.
2. iPad exec86474 ipad-fragment-constant-cache.log,samecore+PPU,SPUlbp2-spu-notail,
 SPUstatic,PPUJIT0,PPUreturn1,7000flips,1280x720,captureon,inputtrace,900stimeout.
 Compareipad-ppu-slices15.34205FPS cautiouslyandfreshcontrolasneeded.
No builds/tests/profilers alongsideChrome benchmark. Polltheseexacthandles.
Nextfinishboth,inspectcaptures,measurewindows; donotclaimspeedupbeforeevidence.
Renderingmaterialerrors,remainingnativeCPUgap,andproductionSPUtailpolicyareunfinished.

## Combined Chrome decision and texture diagnostic — 2026-09-05 11:47 PDT

This turn PROGRESS: unprofiledcombinedbenchmark finished; inline policy remains experimental;
texture coordinate diagnostic added and built. Goal active/incomplete.

ppu-combined-1 exec3466 TERMINALsuccess5512flips,4inputs,noerrors.
- Requested4500–5200 hasfirstobservation4501:14.94155FPS,420.90668CPUms,
 1162.36338draws/flip vscontrol1163.37196. Boundarydrawcounters/workload differ; notexactmatch.
- Shared4600–5200 has EXACTmatchingdrawrate1163.3766667 inallthree:
 combined14.88453FPS420.99845CPUms; slices14.29526FPS424.55098CPUms;
 control13.19461FPS451.04918CPUms. Only0.837%lessCPUversusslices,4.12%moreFPS,
 fromonepairwithdifferenthostpressure. Reportoriginalwindowanomaly,don'thideit.
- Inline readbundle adds~9MB(total41.0MBvs32MB). CombinediPad14.86529FPSslowerthan
 slices15.34205. DO NOTenableinlinebydefault based ontheseweakwholegamegains.
 Slicing retained; defaultdistcorestillunchanged. Nativeparityunproved.

Newdiagnostic (render semantics unchanged):
- WebGPUDirectGSRender::stats unnormalized_texture_slots bitmask; end records only
 shader-referenced ANDenabledfragmenttextures havingCELL_GCM_TEXTURE_UN.
- host rpcs3_web_direct_stats JSON exposes unnormalizedTextureSlots. Intendedtoconfirm
 actualLBP2use beforepatchingmissingcoordinatehandling. Native scales UNcoordinates;
 directWGSLtranslatorreceivesnoformatflaganddoesnotnormalize. Thisisnotyetproven
 causeoftheexistingmaterialerrors.
- Built texture-coordinate-diagnostic-build.log; isolateddist/core/texture-coordinate-diagnostic-jspi.
 IncludesPPUslicesandinlinecapability; useOLDPPUbundle forcorrectnessdiagnostic.
- HeadfuldirectJSPIoracle exec13799 TERMINALpassed (texture-coordinate-diagnostic-oracle.log).
 ACTIVE Chrome LBP2 diagnostic exec40274,4500flips,oldPPUreturn-single,
 coretexture-coordinate-diagnostic-jspi,inputtrace,freshclone ~/.cache/rpcs3-web-texture-coordinate-diagnostic.
 Logtexture-coordinate-diagnostic.log. Readbackend.unnormalizedTextureSlots to establishuse.
 Thisisacorrectnessdiagnostic,notcontrolledperformanceevidence. iPadidle.

## Inline-read attribution result — 2026-09-05 11:41 PDT

This turn PROGRESS: combinedprofile/device complete, fastresolver promoted andtested,
newunprofiledcombinedChromebenchmark started. Goal remainsactive/incomplete.

COMPLETED:
- Chrome profile-ppu-combined exec43558 success5014flips, no gameplay errors.
 Analysis exec72067 success. NEWofficialtool web/scripts/analyse-jit-perf.py replaces
 reliance on performance/symbolise-jit-leaves.py (old artifact retained). Inputs andoutputs
 unchanged; explicitheader/emptyinputchecks; CODE_MOVE rejects; warningscarried inJSON.
 ThreePythonregressiontests pass (jit-perf-tests.log), coverprocess/address/time reuse,
 futurecode,unresolveddenominator,truncatedtail,unsupportedmove,emptyinput. Tests and
 resolver ran ONLYafter desktopprofile ended. No defaultdeployment.
- Combinedprofile34869samples550585908904weightedcycles,7,190,782CODE_LOADrecords.
 script.log EMPTY: no lostperfchunks reported with2048pagerings. Four truncatedjitdump
 tails remainrecorded (distinct from perf ring loss). No assertion that tails contain
 no relevant missingcode; unresolvedsamples stayindenominator.
- Samecore+oldPPUbundle profile-ppu-slices VMreadhelper4.7234%(656samples), combined
 inline-readbundle0.0154%(2samples). Helpercallcost is nearlyeliminated as a separateleaf;
 requiredload/pageaccessinstructions nowliveinguestblocks. DO NOTclaim4.7%CPU saved from
 attribution alone. Oldprofile lost2chunks; newone none. Fullbenchmarkstillneeded.
- Writes2.5858%, SPUloop7.48%, exec_task_sliceTurboFan1.5545%, RSXon_taskLiftoff1.19%,
 Liftoff+framesetup7.4998% (baselineframesetup2.38%). Libc6.82%,Chromeunresolved16.11%.
- iPad ipad-ppu-combined exec64550 success7000flips,720p,captureenabled.
 Window4500–5200=14.86529FPS,p9573.42017,p9977.20020,max107.19995ms;
 1163.372857draws/flip,0drops,CPUunmeasured. Lowerthan slicingalone15.34205 (~3.1%);
 higherthan fresholdcontrol13.82509. Onecombinedrun doesnotshowadditivebenefit.
 Screenshotinspected: samewrongcyan/pink/woodmaterials/yellowpanel, nativefidelitystillabsent.
 Inline readsremainoptin pendingclearwholegamebenefit.

ACTIVE NOW:
- Chrome exec3466, ppu-combined-1.log; UNPROFILED5500flips,
 coreppu-slices-jspi+PPUlbp2-inline-reads,defaultSPU/JITtiers,inputtrace,
 freshclone ~/.cache/rpcs3-web-ppu-combined-1. Compare4500–5200 against
 ppu-slices-1(425.919CPUms,14.27668FPS) and control449.686CPUms/13.29758FPS,
 withhostpressurecoverage; bothcore+bundle differfromcontrolbut onlybundlefromslices.
 No iPad run active. No builds/tests/profilers alongside Chrome benchmark.

Next: completeunprofiledcombinedChrome; chooseinlinepolicyfromCPU+FPS+codesize evidence.
 Currentinlinebundle41.0MBvs32MBbaseline; iPadcombinednotbetterthan slicesalone.
 Missingnativeparity/renderingcorrectnessandproductionSPUtailpolicy stillfullgoalitems.
 Newprofilingtool documented in performance.md; useit forfuturecaptures.

## Fresh controls complete; combined PPU experiment — 2026-09-05 11:35 PDT

This turn is PROGRESS: completed fresh controls, computed authoritative gameplay windows,
and started combined optimization measurement/profile. Goal active/incomplete.

Freshcontrols TERMINAL success (4500–5200 window):
- Chrome ppu-slices-control-1 exec2405:5501flips,4inputs,noerrors;13.29758FPS,
 449.68612 OS CPUms/flip,p95110.28491ms,p99128.90503,max165.15015;
 1163.372857draws/flip,0timingdrops. Hostpressure6.82614%,fullwindowcoverage.
 Compare ppu-slices-1:14.27668FPS,425.91941CPUms,p9580.92065,pressure2.94379%.
 Candidate5.285%lessCPU,7.363%moreFPS. Pressure differs, so FPSnotpurecodeeffect.
 Both oldcorecontrols support lowercandidateCPU (earlier458.58198); still1candidate.
- iPad ipad-ppu-slices-control exec83701:7000flips,720p,captureon,oktrue;
 13.82509FPS,p9581.97998,p99104.42041,max131.33960;1163.372857draws,0drops.
 Comparecandidate15.34205FPS,p9571.54004,identicaldraws (~10.973%moreFPS).
 Oldcontrol13.35993FPS. CPUunmeasured; thermalconditionsnotmeasured.
- Retain slicing experiment in source pending furthercombined/profilevalidation.
 No defaultdistcore/gamebundledeployment or nativeparityclaim.

ACTIVE NOW:
1. Chrome PROFILE exec43558, profile-ppu-combined.log; coreppu-slices-jspi,
 PPUlocal-aot/lbp2-inline-reads/manifest.json,defaultSPU/JITtiers,5000flips,
 perf4500–4900,--perf-prof --perf-prof-path=absoluteoutput,2048pagesrecordring,
 inputtrace,frozenclone ~/.cache/rpcs3-web-profile-ppu-combined. This differsfrom
 profile-ppu-slices byinline-readbundle; compareVMreadhelpercost andremainingbaseline
 share, preserve lostrecordwarnings ifany. ProfileFPSnotbenchmarkresult.
2. iPad combined exec64550, ipad-ppu-combined.log; coreppu-slices-jspi PLUS
 PPUlbp2-inline-reads,SPUlbp2-spu-notail,SPUstatic,PPUJIT0,PPUreturn1,
 7000flips,1280x720,captureon,inputtrace,900stimeout. Verifiedlive1143flips/noerrors.
No desktop builds/tests/profilers alongside activeChromeprofile. Poll exacthandles.

Next: finishcombinedruns, inspectcapture and700flipwindow. Resolveprofilewith
 DEBUGINFOD_URLS='' perf script --ns -G -F time,pid,tid,ip,period,dso then
 performance/symbolise-jit-leaves.py. Checkscript.logforloss beforeusingpercentages.
 NeedunprofiledcombinedChrome benchmark afterprofile, plus eventualfreshnative reference
 andcorrectmaterials. Do notassumeindividualgainsadd. Tail-policyproductionSPUbundle
 andrenderingcorrectness remainunfinished, asdoes fullnativeparity.

## PPU tier result — 2026-09-05 11:30 PDT

This turn is PROGRESS: profile completed, resolved JIT samples establish optimized PPU
execution, and fresh unprofiled Chrome control started. Goal active/incomplete.

profile-ppu-slices exec91615 TERMINAL success5007flips, no reported gameplay errors.
Fast analysis exec73660 TERMINAL success. Files jit-leaf-analysis.json/.txt and
leaf-samples.txt/script.log under test-results/performance/profile-ppu-slices.
33806 samples,523276408029 weighted usercycles,7,125,670CODE_LOADrecords.
- exec_task_slice TurboFan1.739% (288samples), fast_call has0leafsamples.
- SPU executionloop TurboFan7.54%, RSXon_task Liftoff1.546%, frame setup2.079%.
- VMreads4.7234%, VMwrites2.3962%. Baselinefunctions+framesetup6.9616% combined.
- Chromeunresolved15.46%,libc6.11%,driver2.60%. Native resolution not yet run on this
 capture; previous exact Chrome/libc symbols can be reused ONLYafter buildIDcheck.
- IMPORTANT: perf script reports lost2chunks out of54170processed events. Retainwarning
 and don't present percentages as lossless. Tier observation is still direct evidence.
- run-performance perf record now reserves2048pages perring (-m2048) to reducemapping/
 DWARFsampleburst overflow. Syntaxcheckpassed. Not yet validatedbynewprofile.
- This profile uses oldPPUreturn-single. Previous profile-slices usedoldercore/defaultPPU;
 shares are not a controlledspeedup comparison. Needfreshcontrolbench below and ifneeded
 a matchedoldcoreprofile, withnewlargerbuffer. Inline-readcandidate stillneedsits ownprofile.

ACTIVE NOW:
1. Chrome UNPROFILED control exec2405, ppu-slices-control-1.log, coreppu-inline-reads-jspi
 (noPPUslices) withOLDPPUreturn-single, defaultSPU/JITtiers,5500flips,inputtrace, freshclone
 ~/.cache/rpcs3-web-ppu-slices-control-1. Nootherdesktopbuilds/tests/profilers while running.
2. iPad control exec83701, ipad-ppu-slices-control.log, samecore/PPU,SPUnotail,SPUstatic,
 PPUJIT0,return1,7000flips,720p,captureon. Lastobserved4329flips/noerrors.
Poll exacthandles; no restart on observationtimeoutexpiry.

Next: finishcontrols and measure4500–5200 against slicingcandidate. Ifgainnotrepeatable,
 reportthat rather thanattribute optimizedtieralone towholegamewin. RSX on_task retains
 another long-lived loop (RSXThread.cpp1124–1165); boundedFIFOhelper is possible but only
 ~1.55%leaf share. Guestmemoryhelpers remain larger~7.12%. Correctness gap unchanged.

## Slicing benchmark results and active profiling — 2026-09-05 11:25 PDT

Previous turn PROGRESS; this turn completed both new benchmarks and improved contention
analysis. Goal remains incomplete. No commits/agents/default dist deployment.

Completed, authoritative 4500–5200 window, unchanged old PPU return-single bundle:
- ppu-slices-1 Chrome exec7711 TERMINAL successful5507flips,4inputs,no reported errors.
 14.27668FPS,425.91941 OS CPUms/flip,p9580.92065ms,p9989.54492,max312.33521,
 1163.372857draws/flip,0timingdrops. Versus prior ppu-inline-control-2:7.12%lessCPU,
 9.97%moreFPS, provisional onepair against unusuallyslowcontrol. Screenshot inspected:
 existing cyan/pink/material errors persist. Not native visual parity.
- ipad-ppu-slices exec52563 TERMINAL successful7000flips,captureenabled,720p.
 15.34205FPS,p9571.54004,p9992.88013,max209.18018,1163.372857draws/flip,0timingdrops.
 Device CPUunmeasured. Prior control13.35993FPS; requiresrepeat (earlierdirectstaging
 oldcore had15.54856FPS, so currentcandidate is not automatically a device win).

Harness:
- performance-metrics.mjs hostPressureBetween uses cumulative `some total` microseconds
 from /proc/pressure/cpu, weighted overlap, explicit coveredMs. Null for missing/reset
 counters, zero for realmeasuredzero. measureWindow includes hostCpuPressure.
- Chrome measuredwindow hostpressure2.94379%, full49031.00mscoverage. Host-wide metric
 does not attribute stalls to emulator. ExistingCPUprocess metric unchanged.
- All5performance-metrics unit tests passed ppu-slices-metrics-test.log (run after desktop
 benchmark ended and BEFORE profiler started). Syntax/diffchecks pass.
- Definition verified against https://docs.kernel.org/accounting/psi.html and linked in
 performance.md. Latestdevicemetricswindow.json includes unmeasuredhostpressure.

ACTIVE NOW (supersedes run handles below):
1. Chrome profiler exec91615, profile-ppu-slices.log, coreppu-slices-jspi, oldPPUreturn-single,
 5000flips, perf4500–4900, --perf-prof --perf-prof-path=absoluteoutputdir; frozenclone
 ~/.cache/rpcs3-web-profile-ppu-slices. Verified running1215flips/noerrors. Do not run
 desktop builds/tests/profilers concurrently. Next analyze JIT symbols for exec_task_slice
 tier and residualLiftoff; earlierprofile-slices usedoldercore/defaultPPUbundle, so a
 matched oldcoreprofile may also be needed. No performanceclaim from profiled FPS.
2. iPad freshcontrol exec83701, ipad-ppu-slices-control.log,
 coreppu-inline-reads-jspi but OLDPPUreturn-single, SPUlbp2-spu-notail,SPUstatic,PPUJIT0,
 return1,7000flips,1280x720,captureenabled,inputtrace,900stimeout.

Correctness lead confirmed in source, still NOT demonstrated in LBP2: native
 Common/texture_cache.h3077 scales coords for CELL_GCM_TEXTURE_UN; RSXThread.cpp2294
 adds nearestfilter subpixelbias. Directtranslator receives dimensions/swizzles but
 not this flag/scale. Investigate actualdrawstate before blaming materialerrors.

## PPU execution slicing — 2026-09-05 11:19 PDT

Previous goal turn was PROGRESS: completed pending controls, computed matched-window
metrics, and recorded evidence. This turn adds a new isolated runtime experiment.
Goal remains active/incomplete. No agents or commits, default dist core unchanged.

Changes:
- PPUThread.cpp/h: web-only exec_task_slice returns true after 65536 interpreter/AOT
 dispatcher entries, false on stop. exec_task calls it through a volatile member-function
 pointer to preserve the compiler boundary after Binaryen. Native exec_task unchanged.
- The existing loop, state checks, callbacks and guest-register handling remain in the
 callee. Return occurs only between dispatched operations. Local diagnostics flush on
 return; JIT placement and instance-span caches are refreshed on the next slice.
- Hypothesis: move the hot dispatcher out of the long-lived baseline fast_call frame
 (profile-slices showed fast_call Liftoff at1.63% plus baseline frame setup1.895%).
 Do not claim optimized tier or performance improvement until measured.
- Built successfully: ppu-slices-build.log. Isolated dist/core/ppu-slices-jspi staged.
 Source enables slices for web; public/core/jspi has experimental build. dist/core/jspi
 remains untouched. Core includes previous inline-read capability, but game runs below
 use OLD PPU return-single bundle to isolate slicing.
- Passed actual-runtime PPU inline dispatch oracle (verdict76ec98ba0e352b1c), and direct
 JSPI rendering/capture fixture: ppu-slices-oracle.log / ppu-slices-render-oracle.log.
 These conformance passes do not independently establish that a slice boundary was crossed.
- run-performance now additionally records /proc/pressure/cpu and /proc/loadavg once per
 sample as hostSamples, with read errors retained. Existing hostCpuSamples already recorded
 aggregate /proc/stat. Syntax and diff whitespace checks pass. Matched-window aggregate
 host busy: prior inline candidate48.18%, control47.35%; average load does not explain
 control slowdown, pressure/thermal conditions remain unmeasured in those old runs.

ACTIVE (poll these exact handles; do not restart on observation timeout):
1. Chrome exec7711, test-results/performance/ppu-slices-1.log. 5500flips, coreppu-slices-jspi,
 PPUlocal-aot/lbp2-return-single/manifest.json, defaultSPU/JITtiers, inputtrace, freshprofile
 ~/.cache/rpcs3-web-ppu-slices-1. No profiling. Verified starting120flips, noerrors.
2. iPad exec52563, test-results/performance/ipad-ppu-slices.log. 7000flips,1280x720,captureon,
 core./core/ppu-slices-jspi/rpcs3-web.mjs, PPUlbp2-return-single,SPUlbp2-spu-notail,
 SPUstatic,PPUJIT0,PPUreturn1,inputtrace,WIP_TIMEOUT_MS900000.
No builds/tests/profilers alongside desktop benchmark. Device is independent hardware.

Next: finish both runs; measure4500–5200 and compare against ppu-inline-control-2 and
 ipad-ppu-inline-control, accounting for unusual control slowdown. Then a fresh control
 and sampled profile are needed. Profiling should verify exec_task_slice is TurboFan and
 baseline fast_call leaf cost declines; avoid claiming all dispatcher loop time removable.
For profile use --perf-prof --perf-prof-path=absoluteoutput, RPCS3_PERF=1, profilefrom4500,
 profileto4900; record separately from benchmark. Existing fast jit resolver can analyze
 timestampedjitdump without slow perf inject. Goal includes remaining native CPU gap,
 render fidelity, device production tail policy and repeatable results, all still incomplete.

## Completed inline-read controls — 2026-09-05 (supersedes active-run notes below)

Both candidates and both successful controls are now terminal. No benchmark is active.
Measured gameplay window is flips 4500–5200, with zero timing drops:

| Platform/run | FPS | OS CPU ms/flip | p95 frame ms |
| --- | ---: | ---: | ---: |
| Chrome ppu-inline-reads-1 | 14.14395 | 441.03718 | 85.35 |
| Chrome ppu-inline-control-2 | 12.98201 | 458.58198 | 110.73 |
| iPad ipad-ppu-inline-reads | 15.90635 | unmeasured | 67.84 |
| iPad ipad-ppu-inline-control | 13.35993 | unmeasured | 92.64 |

Same runtime core ppu-inline-reads-jspi in each pair; candidate PPU bundle lbp2-inline-reads,
control lbp2-return-single. Main guest address sets match exactly (85157 blocks).
Chrome candidate/control draw rates 1163.37143/1163.37286 per flip; device
1163.34/1163.37286. All successful runs completed their frame budgets without reported
render translation errors. Existing material errors still prevent native visual parity.

These are provisional single pairs: Chrome candidate used 3.83% less measured CPU per
flip and delivered 8.95% more FPS; iPad delivered 19.06% more FPS. Controls were unusually
slow compared with earlier controls. Host process inspection after completion showed
other Unity/QEMU/Python workloads; it does not establish their load during the window.
Device thermal conditions were not measured. Repeat alternating runs before adopting
or claiming these whole-game gains. Inline reads remain opt-in; defaults unchanged.

Chrome control-1 failed before gameplay with a Wasm response-body network abort and
is retained as a failed report; control-2 is the successful fresh-profile retry.
run-performance.mjs now records playUrl/requestedPlayback before navigation and a bounded
100-entry requestfailed history, improving configuration and download-failure provenance.
Both additions were syntax checked. Candidate runs predate these report additions.

Profiler interpretation: use profile-slices weighted user-cycle attribution (34635 samples),
not percentages of only resolved stacks. Memory helpers ~7.18%, copy/clear leaves ~6.18%,
SPU bounded execution loop 7.88%, remaining Liftoff functions ~5.84% and its frame setup
1.895%; loop includes useful emulation work, so its whole cost is not removable dispatch.
Native-resolved and JIT reports overlap on embedded V8 builtins; do not sum both tables.
Next: repeat controls, profile the inline-read change, and investigate batching at the
Wasm/WebGPU boundary. No evidence yet of one dispatch function consuming most CPU.

## PPU direct-read prototype — 2026-09-05 11:00 PDT

This turn is PROGRESS. Goal remains incomplete. No agents/commits/default-bundle deployment.

ACTIVE NOW (confirmed running, do not restart on observation timeouts):
1. Chrome exec45709, ppu-inline-reads-1.log,5500flips,frozenprofileclone
   ~/.cache/rpcs3-web-ppu-inline-reads-1. Coreppu-inline-reads-jspi,
   RPCS3_PPU_AOT=local-aot/lbp2-inline-reads/manifest.json; defaultSPUAOT/JITtiers;
   frame-indexedgameplayinput. No profiling. Latestobserved1683flips/noerrors.
2. iPad exec64368, ipad-ppu-inline-reads.log,7000flips,1280x720,captureenabled,
   coreppu-inline-reads-jspi, PPUlbp2-inline-reads, SPUlbp2-spu-notail, SPUstatic,
   noPPUJIT,returnpolicy,900stimeout. Latestobserved2440flips/noerrors.
Do not run desktop builds/tests/profilers alongside Chrome measurement. Device is independent.

Next immediate work: finishboth, compute4500–5200, inspectcaptures/errors. Fresh Chromecontrol
MUST use SAMEcoreppu-inline-reads-jspi and RPCS3_PPU_AOT=local-aot/lbp2-return-single/manifest.json
withfreshfrozenprofileclone. Prior defaultdesktopPPUAOTrunsare NOT the direct counterpart of
this portable-single-module run. Device control can use prior direct-stagingiPad as initial
comparison but repeat on same core with oldPPUbundle ifcandidate looks useful.

Completed direct-stagingdecision:
- Fresh ipad-direct-staging-control completed7000flips/720p:4500–5200=14.13182FPS,p9577.36ms,
 1163.372857draws/flip,no timingdrops. Experimental directstaging15.54856FPS,p9569.48ms,samedraws.
 Earlieroldcontrol14.22625FPS. This gives~10%winversusfreshcontrol(onecandidate,two controls).
 RETAIN directstaging insource fordevicebenefit/furthervalidation. Chrome pair stillno usefulwin
 (~431.07 versus430.22CPUms/frame,13.97vs14.26FPS). DeviceCPUunmeasured. Materialerrorsremain.

New PPU architecture experiment (opt-in, NOT default):
- PPUTranslator::prepare reads RPCS3_PPU_WASM_INLINE_READS=1 onlyinWasmAOTmode.
 ReadMemory emits inlinepage-tablelookup + unalignedload for mappedwithinpage8/16/32/64/128bits.
 Page-crossing/unmapped branches useexistinghelpers. Stores/write-versiontrackingunchanged.
- Explicit externaldata symbol __rpcs3_guest_pages lowers to GOT.mem mutablei32global.
 No change to PPUdispatchcontext/ABI arguments. Runtime exportsrpcs3_web_vm_page_table_address.
 AOTloader rejectscorewithoutcapability; workerpre.js bindsnewGOTglobal toits runtime'stable.
- Browsercompiler exposesrpcs3_ppu_llvm_inline_reads, compilerworker initppuInlineReads flag.
 Genericruntimecompilerpools do NOT forward/enablethisyet. Offlineenvironmentgenerationworks.
- build-ppu-aot-bundle.mjs's metadata-onlyinstantiation suppliesdummy0GOTglobal; it neverexecutes
 guestloads. Realruntimeworkergetstablepointerfromcompiledcore.
- Builds passed: ppu-inline-read-compiler-build.log, ppu-inline-read-runtime-build.log,
 ppu-inline-read-native-build.log. Isolateddistcore/ppu-inline-compiler and ppu-inline-reads-jspi.
 Updated dist/rpcs3-spu-llvm-worker.mjs and rpcs3-ppu-aot-table.mjs remainbackwardcompatible.
 Default dist/core/jspi and defaultgamebundlesunchanged. public/core/jspi nownewruntime.

Validation:
- ppu-inline-memory.spec.ts has3headfulHTTPStests, allpassed (ppu-inline-memory-test.log):
  incompatible-runtimecapabilityrejection; native-generateddispatchfixture throughrealworkers
  returnsverdict76ec98ba0e352b1c withpositiveAOTdispatches;23 generatedloadexecutioncases with
  knownbytes,unaligned, pageedge,noncontiguouscrosspage,unmapped,helpercallcounts. Includes128bitLVX.
- TypeScript checkpassed (ppu-inline-typecheck.log). Fixed earlierppy-local-chaining Uint8Array
 typecompatibility withowned-arraycopy; no semanticchange. gitdiffcheckclean.
- Fixture build envINLINE_READS=1+RETURN_DISPATCH=1 usednative build andbin/test/web_dispatch_conformance.self.
 IR test-results/performance/ppu-inline-fixture/fixture.wasm.ll; bundlelocal-aot/dispatch-inline-reads
 stagedpublic/dist. This testsfullactualAOTloader/workerpath, notonlyfakeimports.

LBP2 artifacts:
- Fresh nativeIRdump132samefilenamesasprior,1.98GB underperformance/ir-inline-reads-raw.
 UsedisolatedcopiedXDGhome native-inline-reads-fixture, Nullrendererconfig and--headless.
 Nativeprocess839500 wasterminatedONLYafterall132filesverifiedunchangedfor147seconds;
 --benchmark-duration didnotexitthisIRgenerationmode. Process is gone. Notaperformancerun.
- Filteredwithppu-existing-profile.bin:124parts,93193/556301blocks; mainEBOOT85157blocks.
 Outputperformance/ir-inline-reads. Bundlebuildcompleted31.7s,7parts/6PRX,total41,024,744bytes;
 EBOOT38,243,022bytes vsoldreturn-single29,903,768. localTableOnlytrue,0guestimports,111tables.
 Newbundle public/dist/local-aot/lbp2-inline-reads. Increasedcodesize/compiletime/memorymustbe
 weighedagainsthelper-call savings; no whole-gameinline-readspeedupclaimedyet.

Remaining fullgoal: measure/adopt/rejectPPUprototype, nativeCPUgap, iPadrobustdefaults, material/
lightingcorrectness, productionSPUportableLLVMtailpolicytests/bundle(previousunfinishedwork).

## Copy caller recovery and direct staging — 2026-09-05 10:37 PDT

Previous turn is PROGRESS: recovered missing caller attribution, implemented a measured
renderer experiment, completed Chrome A/B and a full iPad capture. Goal remains incomplete.

ACTIVE: iPad control exec63494 (`ipad-direct-staging-control.log`),7000flips,1280x720,
900s timeout, prior coregpu-streams-jspi, PPUlbp2-return-single, SPUlbp2-spu-notail,
SPUstatic, noPPUJIT, inputtrace, finalcaptureenabled. Initial launch confirmedlive.
Do not restart on observation timeout. No desktop benchmark/build/profiler is active.

Copy attribution:
- Standard perf unwinding lost most useful stacks, but raw STACK_USER retained them.
  Diagnostic performance/recover-copy-callers.py validates all34635 raw samples against
  perfscript(pid,tid,time,ip,period). Both audited libc functions have no stack changes,
  pushes/pops/calls, so the first stack word is the return address. All1068 targeted
  copy/clear samples recovered; JIT lookup uses returnaddress-1 and sampletimestamp.
- profile-slices/copy-return-addresses.json and copy-callers/{jit-leaf-analysis,native-resolved}
  preserve attribution. These caller reports use copy-only denominator6.1767% of totalCPU.
  Converted shares of TOTALCPU: SPUDMA1.177%, SPUlist0.750%, rendererend0.818%, RSXimage0.388%,
  vertexpreparation0.321%, DawnWriteBufferXL1.008%, UploadData0.688%, MapAtCreation0.653%.
  Do not mistake immediate caller attribution for all removable work or inclusive cost.
  Raw diagnostic is specific to this libc build and perfattrmask; revalidate before reuse.
  Docs/performance.md records method, denominators, limits.

Experimental implementation retained IN SOURCE pending iPad confirmation:
- WebGPUDirectGSRender::end prepares persistent/transient vertex streams and bothuniforms
  directly in ring.staging spans. Reserves entire draw/ring before taking pointers;
  preservesuniformzeroing. Removed four m_draw_* scratch vectors and their ring_write copies.
- Isolatedartifact dist/core/direct-staging-jspi. Release build direct-staging-release-build.log
  succeeded. Profiling build also succeeded but NOT used in performance comparison.
  public/core/jspi and public/core/profile-jspi now contain experimental code; default
  dist/core/jspi NOT replaced. Prior dist/core/gpu-streams-jspi remainscontrol.
- Headful HTTPS direct-session JSPI capture/oracle passes (direct-staging-oracle.log).
- Chrome direct-staging-1:5525flips,4inputs,noerrors;4500–5200=13.96603FPS431.07309CPUms/flip,
 1163.37143draws/flip,p9585.27ms. Fresh control direct-staging-control-1:5513flips,4inputs,
 noerrors;14.26399FPS430.22058CPUms/flip,1163.372857draws/flip,p9580.01ms. NO useful Chrome win.
  Older378CPUms baseline is not current-session comparable; both freshruns~430CPUms.
- iPad directstaging completed7000flips,720p,captureenabled,noMemoryprofiler. Screenshot
  inspected: same existing repeatedwood/flatcolor/material errors, NOTnativevisualparity.
  Matched4500–5200=15.54856FPS,p9569.48ms,1163.372857draws/flip; prior ipad-gpu-streams-capture
  window freshlycomputed14.22625FPS,p9577.74ms,samedraws. 9.3%apparentwin needsfreshcontrol
  nowrunning. DeviceCPU NOT measured (metrics correctlynull). Both window.json persisted.
- Decision: do not call this a proven desktop speedup; keepisolated untildevicecontrol
  determinesretention. If no repeatablebenefit, revert ONLYdirectstaging edits, preserving
  prior streamcombinedallocation and explicitGPUdestroy fixes. Artifacts remainreproducible.

Remaining: finishiPadcontrol, choose stagingpolicy, then largerPPUmemory-helper/dispatch
architecture and visualcorrectness diagnosis. ProductionSPUportableLLVMpolicy tests/bundle
remainunfinished; compilerbuiltlastturn but newpolicy notenabledindevicepath. No commits,
no agents, no goalcompletioncall. gitdiffcheckclean.

## Native-symbol profiler checkpoint — 2026-09-05 10:18 PDT

Concrete progress; goal still incomplete. No new emulator benchmark or speedup this turn.
- Added web/scripts/analyse-native-perf.py and five Python tests. Resolves native perf
  leaves via matching debug ELF and validates BOTH original binary and debug build IDs.
  DSO offsets are FILE offsets: Chrome PT_LOAD executable virtual address is file+0x1000.
  A first diagnostic lookup without this adjustment was wrong and has been overwritten;
  do not reuse its spurious DateTime/JavaScriptFrame::Print attribution. Corrected output
  independently matches V8 WasmLiftoffFrameSetup at1.895%.
- Downloaded official Chrome152.0.7977.64 symbols to
  test-results/performance/chrome-debug-152/debug-info/chrome.debug (1.46GB), matching
  build44208a02a780317973cecb6d5c01fd8e52f97314. Archive382MB retained.
  libc6-dbg2.39-0ubuntu8.8 extracted under performance/native-symbols; matching libc
  build328820b908de8ea1ef79afa8995e302e819163d7. No system package installation.
- profile-slices/native-offset-leaves.txt, buildids.txt, native-resolved.json/.txt contain
  corrected native results. 34635samples,527468647655weighted usercycles (same JITdenominator).
  memcpy/memmove5.2967%, memset0.87998%; actual copies confirmed, callers not yet proven.
  Native categories: V8+embeddedbuiltins10.286%, Dawn3.441%, allocator1.310%, Blink1.029%,
  libc6.369%, other2.533%. V8 native report overlaps JIT report: DO NOT add percentages.
  V8 propertylookup and memory.buffer getters are visible; performance.now0.512%.
  Dawn percentage excludes libc copy costs, driver work and other browser-side costs.
- native-offset-stacks.txt exports existing stacks but most high-weight samples have no
  recovered stack. Do not normalize just nonempty stacks: that discards most CPU cycles.
  Caller attribution needs robust stack join/coverage and possibly better recording.
- Fixed measureWindow: missing/no-overlap CPU samples now give null, not bogus0ms/frame.
  Real measured zero remains0. Three Vitest tests pass, five native profiler tests pass,
  gitdiffcheckclean. Performance docs include symbol workflow and limitations.
- Download/addr2line jobs all complete. Killed own stuck network-enabled perf buildid-list;
  DEBUGINFOD_URLS='' resolves buildids immediately. Ubuntu debuginfod timed out, apt-get
  download (not install) got matching libc debug package successfully.
- Production SPU portable policy is still untested/unstaged as before. Next work remains
  caller-aware copy/dispatch optimization, runtime boundary reduction, material correctness,
  portable-policy validation/bundles and clean matched Chrome/iPad/native benchmarks.

## Latest verified profiler checkpoint — 2026-09-05

The previously listed Chrome profile and iPad capture runs both completed. No benchmark
is active at this checkpoint. SPU portable-policy compiler and native builds reached
successful linking (logs spu-portable-compiler-build.log and spu-portable-native-build.log).
Policy changes have not yet been validated or staged as the production device compiler.

The 34,635-sample profile in test-results/performance/profile-slices shows:
- SPU bounded execution loop is now TurboFan: 7.88% of sampled user cycles, versus
  old cpu_task Liftoff 15.86%. These are separate profile shares, not an absolute speedup.
- Independent controlled slicing on/off benchmark: 377.93 versus 418.01 OS CPU ms/flip
  (9.6% reduction), 15.62 versus 14.84 FPS (5.3% improvement); one pair only.
- VM access helpers total 7.18%; all Liftoff guest-host functions total 5.84%;
  WasmLiftoffFrameSetup alone 1.90%; check_state 1.83%; PPU fast_call Liftoff 1.63%;
  RSX on_task Liftoff 1.53%. Generated SPU code totals 22.53% across many symbols.
- 27.425% unresolved: Chrome 15.58%, libc 6.37%, NVIDIA 2.63%, unknown 2.15%,
  plus smaller mappings. Resolve these before attributing them to dispatch or copies.
- Percentages are sampled user CPU cycles, not wall time or pure removable overhead.
  Large driver/Dawn work may also be hidden in unresolved browser symbols.

CRITICAL correctness finding: ipad-gpu-streams-capture completed 7000 flips and saved
frame.png. Compared visually to native-reference-clean-2/frame.png, geometry/camera
match closely but materials/lighting do not: repeating wood textures, flat colors,
missing native foliage/cardboard detail. Chrome profile-slices/frame.png has the same
issue. The earlier phrase "full-quality" means only resolution/no skipped draws and
must not be used as a fidelity claim. Native visual parity is NOT achieved. Investigate
existing native/WebGPU frame capture comparison before speculative shader changes.

Next: resolve native browser/library samples; measure VM helper call/translation cost;
apply bounded execution seams to remaining baseline loops if justified; complete
production LLVM SPU portable-import-call tests and bundle; diagnose material mismatch.

## Resume here — 2026-09-05 09:43 PDT

The goal remains active. Major new evidence: the iPad completed a full-quality long run.

Verified outcomes:
- `ipad-gpu-retirement` succeeded:12000flips,671880ms (11.2min),1280x720,
  zero timing drops, skipped draws, translation failures, unsupported operations.
  Matched4500–5200:13.48952FPS,1163.372857draws/flip,p9584.74ms.
  This run included WebKit memory profiling and disabled final screenshot capture.
  It contains intro/movie, heavy gameplay, and later transition; do not call it11min
  exclusively in the heavy scene. Evidence report.json/window.json/memory.json.
- Explicit destroy of retired GPU resources is retained. It follows queue submission,
  allowing browser resource reclamation independently of GC. This core also hasSPUslices.
- Bind-group caching experiment did NOT produce a useful win: `bind-groups-1` completed
 5503flips,4inputs,noerrors;4500–5200=15.41561FPS,382.75220CPUms/flip versus prior
 SPUslices15.62124FPS377.93068CPUms. Only~32%groupsreused. REMOVED cache/dynamicoffsets/
 counters fromcurrent source. Isolated dist/core/bind-groups-jspi remains for reproduction.
 Do not accidentally restage that experimental core as the current implementation.
- Fixed existing vertex stream ring growth bug: reserve persistent+transient ranges
 together, then write both into the same buffer. Previously growth between allocations
 could make persistent_offset point into a retired buffer while bindings used the new one.
- Final current core built successfully (`gpu-stream-reservation-build.log`), staged at
 dist/core/gpu-streams-jspi. Headful HTTPS direct-session capture test passed
 (`gpu-streams-oracle.log`). Cache-only optional assertions removed from test; coreURL
 override and ordinary real-pixel/flip/shutdown checks retained. gitdiffcheckclean.
- Latest source includes SPU slicing, explicitGPUretirement, sharedstreamreservation;
 no bind-group cache. Native compile/SPU call-policy production work still pending.

ACTIVE NOW:
1. iPad exec56508: `ipad-gpu-streams-capture.log`,7000frames,900soutertimeout,
   coregpu-streams-jspi,singlePPU,diagnosticSPUnotail,SPUstatic,noPPUJIT,1280x720.
   Screenshot capture ENABLED; no WebKit memory profiling. Checkfinalframe.png visually
   aftercompletion and compute4500–5200 timings. This repeats stability on finalcurrentcode.
2. Headful Chrome exec4997: `profile-slices.log`, coregpu-streams-jspi,5000frames,
   Linuxperf4500–4900, V8--perf-prof (NO perf-prof-unwinding-info to reduce dump volume).
   Frozenfixtureclone ~/.cache/rpcs3-web-profile-slices. No otherdesktoptests/builds/GPU
   workloads whileit runs. Goal:verifySPUloopnowrunsoptimizedratherthanLiftoff.
   Aftercompletion exportflatleafsamples with:
   DEBUGINFOD_URLS='' perf script -i test-results/performance/profile-slices/browser.perf
     --ns -G -F time,pid,tid,ip,period,dso > .../leaf-samples.txt
   python3 test-results/performance/symbolise-jit-leaves.py .../profile-slices
   Fastresolver was independentlyvalidated againststandardperf lastturn. Avoidstandard
   inject/report iteration:7.22Mcode-loadrecords madeit take~45min. Oldjobsallcompleted.

Remaining: native CPU efficiency (~257CPUms vsbrowser~378), stronger repeated scene-matched
comparisons, finalimagecheck, productionSPUtailpolicy+freshbundle (currentlydiagnosticWAT
lowering), robustdefaultdevicepath selection, and furtherPPU/RSXarchitectureimprovements.
No subagents, commits, or goal completion call. OwnedXvfb:98 isstillrunning;syslogstopped.

## Current checkpoint — 2026-09-05 09:34 PDT

The previous goal turn made concrete progress. Goal remains incomplete. No agents or commits.

Completed this turn:
- Standard perf report finally completed. `profile-os-jit-clock/symbol-report.txt`
  independently matches the fast resolver: SPU cpu_task Liftoff15.86%, VMread32 2.51%,
  WasmLiftoffFrameSetup1.95%, RSX on_task Liftoff1.74%, PPU fast_call Liftoff1.63%.
  Both old perf processes are gone. Standard injection/report took tens of minutes due
  to7.22million CODE_LOAD records; prefer the sampled-address resolver for iteration.
- Added WebKit Memory domain capture with RPCS3_MEMORY_PROFILE=1. Transport forwards
  notifications via onNotification; device runner saves memory.json externally.
  WebKit timestamps are0 without timeline agent; the host `at` timestamps align snapshots.
 54unit tests/16files pass (`device-memory-harness-tests.log`).
- `ipad-memory-profile` (old ppu-local-jspi, singlePPU, diagnosticSPUnotail, noPPUJIT,
  SPUstatic,720p) failed at5483 with explicit `GPUDevice.createBindGroup: Unable to
  make bind group`, preserved in report.result.diagnostics. No processkill inferred
  for this run. WebKit category page~2.0–2.3GB; JavaScript~30MB; JIT~130MB. Categories
  are broad and do not prove allocator responsibility or total device/driver footprint.
- Inspected PPU exports: singleEBOOT has223exports,0guestfunctionexports. Most85kblocks
  are table-only ALREADY; don't propose stripping85kguestexports as a new optimization.
- Implemented explicit destruction of retired WebGPU textures and buffers AFTER queue
  submission in WebGPUDirectGSRender::submit. Prior release only removed C/JS handles,
  leaving GPU reclamation to GC. Spec permits destroy after submitted use:
  https://gpuweb.github.io/gpuweb/#texture-destruction
- Built and staged isolated `dist/core/gpu-retirement-jspi`; direct headful HTTPS capture
  test passed (`gpu-retirement-oracle.log`). This core also includes prior SPU slicing.
- Implemented reusable draw bind groups with dynamic offsets for bindings32–35. Cache
  key is fixed u64array: layout,uniform/streambuffers,storageranges,textureviews/samplers.
  Bounded1024entries, cleared before retired resources are released (avoid recycledhandle
  aliasing), and onexit. Cachedgroups own handles; perdrawRelease removed. Layout uses
  dynamic offsets; setBindGroup passes offsets in binding order32,33,34,35.
  New helpers get_draw_bind_group/clear_bind_groups separate binding setup from end().
  Counters bindGroupsCreated/bindGroupHits emitted by host directStats.
- Build passed `bind-groups-build.log`, isolated `dist/core/bind-groups-jspi` staged.
  Headful HTTPS direct-session test passed, verifies actual pixels and bindGroupHits>0,
  createdgroups<draws (`bind-groups-oracle.log`). Test accepts TEST_CORE_URL and optional
  TEST_BIND_GROUP_CACHE=1, select --grep JSPI for JSPI-only stagedcores.

ACTIVE:
1. Chrome `bind-groups-1`, exec10460,5500frames, frozenprofileclone
   ~/.cache/rpcs3-web-bind-groups-1, no specialV8flags, fullinputreplay,HTTPS.
   Log test-results/performance/bind-groups-1.log. Measure4500–5200; compare SPUslices-on
   previous15.62FPS377.9CPUms, but ideally run gpu-retirement core as clean cache control.
   No desktop builds/tests/profilers while benchmark runs.
2. iPad `ipad-gpu-retirement`, exec42752,12000frames,900soutertimeout, noendcapture,
   memoryprofile enabled, singlePPU+SPUnotail, SPUstatic/noPPUJIT,1280x720.
   It passed previous failure region (>5600flips); not yet a stability verdict.
   Let it finish or fail before starting new device run. Next try bind-groups core.

Potential correctness follow-up discovered while reading rings (not changed): persistent
and transient vertex buffers allocate separately in one ring. A growth between those two
allocations can leave persistent_offset referring to the previous buffer while the binding
uses the current buffer. Reserve both ranges together before writing to avoid that case.
Do not attribute existing visual differences to cache without checking this edge.

Explicit SPU imported-tail policy in LLVM compiler is still not implemented; the iPad still
uses the diagnostic WAT-lowered AOT bundle. Native parity and stable10min iPad remain unproved.

## Resume checkpoint — 2026-09-05 09:15 PDT

No game, browser benchmark, or device runner remains active. All desktop builds/tests passed.
Owned Xvfb:98 still running. Syslog PID3623667 stopped withSIGINT afterdevicefailure.

Latest authoritative outcomes:
- iPad no-capture12000frame soak FAILED near5305flips, beforeanyfinalcapture. Recovered
 4500–5200:14.47611FPS,1163.372857draws/flip,700exactintervals,0timingdrops inwindow.
 Whole recoveredrun has15missingflips. heap1.050GB,live60,pool69 atfailure.
- Secondmatching terminationPID7388 at09:11:30 is launchd(1,7,9), sameasPID7271at08:58.
 VerifiedApple XNU headers: OS_REASON_JETSAM=1; JETSAM_REASON_MEMORY_PERPROCESSLIMIT=7.
 Thustheseareper-processmemory-limitkills, distinctfromearlierptrauth28/261. Screenshot
 completion is excluded as the cause ofthese2runs. ReduceprocessfootprintwhilekeepingSPUAOT.
 Sources: https://github.com/apple/darwin-xnu/blob/main/bsd/sys/reason.h
 https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/kern_memorystatus.h
- Device progress recovery initiallyusedtimeOrigin1mstolerance; currentsoakshowed42msclock
 shiftwithinonepage. FIXED: explicitrunIdinnewpageprogress, useidentityandobservedphaseboundary;
 legacyrecordsstopatfirstnonrunningphase. Testnowcovers42msclockshift,overlap,gaps,reload.
 All53unit tests pass afterfix. `ipad-spu-notail-soak/recovered{,-window}.json` corrected;
 rawreport.partial isolderincompleterecovery,donotuseitoverrecovered.json.
- CompactfinalDOMsummarysourceNOWstagedtodist/runtime-acceptance.mjs aftersoakended.
 Itdoesnotfixearlierkillcause(byitself)butremovesunnecessarylargeendallocation.
- Standard perf inject COMPLETEDSUCCESSFULLY exec74423 after~37minutes;PID3480933gone.
 `profile-os-jit-clock/browser-jit.perf` nowcomplete. `perf report --stdio --no-children
 --call-graph none --sort symbol --percent-limit0.5` ACTIVE exec2199 tosymbol-report.txt;
 checkforcompletionandcomparewithfast customjit-leaf-analysis15.86%SPULiftofffinding.
- Nextdesktopwork: OS-profileboundedSPUcoretoverifyliftoff->optimizedentry; repeatpair,
 thenPPU/RSXboundedloopsormemoryhelpersguidedbyprofile. Forced--no-liftoffstillfaster
 (17.62FPS356.7CPUms)thanSPU-onlyslices(15.62FPS377.9CPUms),native~257CPUms/flip.
- Nextdevicework: memorybreakdownandcode/instance/cachefootprint. LazyAOTworkerloading
 alreadyexists;utilityworkersdonotinstantiatePPU/SPUbundles. ManyPPUthreadsallinstantiate
85kfunctions. SPUcall-policyproductionimplementationandfreshbundleareNOTyetdone;
currentlyusingdiagnosticWAT-loweredSPUAOTbundle. Needstable10minfullqualitysoakandcapture.
Goal remainsactive;nativeparity/stableiPadnotachieved.

## Measurements and live work — 2026-09-05 09:07 PDT

- Same binary SPU slices pair completed5507/5509flips,4inputs,failures[]:
  on4503–5200:15.62124FPS,377.93068CPUms/flip;
  off4500–5200:14.83559FPS,418.00662CPUms/flip; both~1163.372draws/flip.
  One pair:5.30%FPS gain,9.59%lessCPU. Repeat/profile to verify optimized slice entry.
- iPad single PPU + SPU notail AOT ran to5487flips, then Safari reloaded.
  Recovered exact4500–5200:15.36659FPS,1163.372857draws/flip,p9571.82ms,0timingdrops.
  Shared shorter4400–4490 comparison: previousSPUasmjit/noAOT3.64340FPS vs
  restoredSPUAOT15.44152FPS, both1163.34draws/flip. This is AOT execution restored
  with safe imported calls; don't attribute4.2x gain to tail-call lowering alone.
- Termination at08:58:03 forWebContentPID7271 is launchd(1,7,9), NOT ptrauth.
  Copied device diagnostics (--keep) to private test-results/performance/ipad-crashes.
  Matching CPU report08:55:37 has Action taken:none (not cause of laterkill), footprint
  710.70MB->3163.59MB over117s. Wasmheap1.050GB atfailure. No matchingjetsamreportyet;
  memorygrowth is a lead, not established root cause. Don't publish unrelated device reports.
- New `web/scripts/device-progress.mjs` recovers overlapping external snapshots,
  deduplicates exactflipids, reportsgaps, excludesreloadedtimeOrigin. Safari timeOrigin
  jitters0.14ms, so use1ms tolerance. Added2unit tests; full53tests/16filespass.
  Device runner embeds recovery as `result.partial` on lost result and now supports
  RPCS3_CAPTURE_RGBA=0 for isolating capture from playback stability.
  Recoveredfiles savedunderipad-single-spu-notail, comparisonfilesunderbothdevice runs.
- ACTIVE iPad soak exec20014, `ipad-spu-notail-soak.log`,12000frames,900soutertimeout,
  sameppu-local-jspi/singlePPU/notailSPUAOT, noPPUJIT, SPUstatic,1280x720,noendcapture.
  Syslogexec8088 PID3623667 stillcapturingterminationlines (samefilename).
- Standard perf inject PID3480933 resumed after desktop pair. It is slow (~7.22Mloads),
  outputstillincomplete. Do not run it concurrently withdesktopbenchmarks.
- runtime-acceptance.mjs now displays a compact final DOM summary instead of duplicating full
  frames/events/base64 into a text node. This source change is NOT staged in dist yet; active
  soak uses previous code, isolating capture disabling from the summary change.
- New helperfileandtests uncommitted; fullruntime coreonlyatdist/core/spu-slices-jspi.
  ExistinglazyAOTinstallationalreadyinstantiatesonlyonPPU/SPUworkers(pre.js~387), so do
  not propose lazyperworkerloadingasnewfix. ManyPPUthreads stillinstantiate85kfunctionbundle.

## SPU tiering implementation — 2026-09-05 08:55 PDT

- `no-liftoff-1` COMPLETED5507flips,4inputs,failures[]. Matched4500–5200:
  17.61787FPS,356.68596OSCPUms/flip,1163.37143draws/flip,p9565.58ms.
  Prior `ppu-batch-on-1`14.91563FPS409.80573CPUms/flip =>18.1%FPS gain,13.0%lessCPU.
  This forces optimized V8 via --no-liftoff; it is diagnostic, not a deployable browser fix.
- Implemented bounded SPU loop in `SPUThread.cpp`: after65536iterations returnfalse
  at a branch boundary; flush counters on slice exit. Existing outer setjmp loop re-enters.
  Volatile function pointer preserves the call boundary through Binaryen (LLVM noinline alone
  is insufficient). Native portable interpreter remains unbounded. Candidate preference cache
  currently resets each slice; it remains verified and may need persistence if measurable.
- Added preboot control `rpcs3_web_spu_execution_slices_enable`, routed through worker,
  runtime acceptance, play query and benchmark `RPCS3_SPU_EXECUTION_SLICES=0/1`.
  Defaults enabled; older cores ignore missing export. New core only staged in isolated
  `dist/core/spu-slices-jspi`; baseline core paths retained.
- Build PASSED `spu-slices-build.log`; disassembly `spu-slices-core.wat` confirms separate
  `spu_web_interpreter_loop` function. Headful HTTPS SPU LLVM/native-verdict oracle PASSED
  `spu-slices-oracle.log`. Test now accepts TEST_CORE_URL and TEST_SUSPENDING env switches.
  Initial test forgot suspending:true and hit Promise DataCloneError; corrected test config.
  Temporary spu-check.config.ts removed.
- Normal Chrome benchmark `spu-slices-on-1` ACTIVE exec11358; frozen profile clone,
 5500frames, noV8flags. Need measure4500–5200, then samebinary slices-off control.
  Standard perf inject PID3480933 remains SIGSTOP-paused during benchmarks; ~halfway through
  7.22million code loads; do not inspect incomplete browser-jit.perf as valid report.
- iPad `ipad-single-spu-notail` ACTIVE exec39787: coreppu-local-jspi,PPUsinglebundle,
  noPPUJIT,SPUstatic with correctedlbp2-spu-notailbundle,5500frames,1280x720,600soutertimeout.
  Syslog capture exec8088 (`idevicesyslog -m termination`) to ipad-spu-notail-termination.log.
  It passed startup; evaluate speed/stability and inspect termination logs on failure.

## Concrete hotspot — 2026-09-05 08:44 PDT

The corrected OS profile completed (`profile-os-jit-clock`, 34218 samples). Flat symbol
resolution using V8 CODE_LOAD records + sample PID/IP/monotonic timestamp found:
- 15.86% sampled user cycles: `spu_thread::cpu_task()-5075-liftoff`.
- 21.94% total in Liftoff-compiled functions; 1.95% in WasmLiftoffFrameSetup builtin.
- PPU fast_call 1.63% Liftoff, RSX on_task 1.74% Liftoff.
- vm_read32 2.51%, vm_write64 1.36%, vm_read64 1.20%, vm_write32 0.90%.
- 24.78% unresolved native/browser/library cycles remain. These are USER CYCLE percentages,
  not wall time or total CPU. `JS:` in jitdump labels also prefixes Wasm functions.
- Evidence: `jit-leaf-analysis.{json,txt}`, `leaf-samples.txt`, diagnostic resolver
  `test-results/performance/symbolise-jit-leaves.py`. Resolver rejects code moves (none),
  records4 truncated final dump records, and matches latest preceding code load timestamp.
  7.22 million CODE_LOAD records explains why standard perf inject is so expensive.
- V8 official architecture docs explicitly say there is no Wasm on-stack replacement;
  an invocation started with Liftoff completes with Liftoff even after optimization is ready:
  https://chromium.googlesource.com/v8/v8/+/main/docs/wasm/architecture.md
  Hypothesis: never-returning emulator execution loops remain baseline-compiled. Test this
  before refactoring loops into bounded calls. DevTools sampling can alter tiering, which
  explains why CDP attribution did not expose the same baseline hotspot reliably.
- Current controlled diagnostic `no-liftoff-1` ACTIVE (exec70300), headful HTTPS, core
  ppu-batch-jspi, --no-liftoff,5500frames, frozen fixture cloned to
  ~/.cache/rpcs3-web-no-liftoff. No perf/CDP profiling, compare4500–5200 with prior batch-on.
  Startup may take longer because compilation is optimized from the start.
- Standard perf inject PID3480933 is SIGSTOP-paused to avoid benchmark interference;
  resume with SIGCONT AFTER no-liftoff benchmark. Exec74423. Output browser-jit.perf
  is incomplete until it exits. Do not treat partial output as validated profile.
- Corrected profile window4503–4907:13.9754FPS,458.767OSCPUms/flip (instrumented),
  1163.366draws/flip; 700774SPUattempts/flip,58414rejected,27interpreted,3table syncs total.
- All game/device runs other than no-liftoff-1 have ended. Owned Xvfb:98 remains.

## Profiling update — 2026-09-05 (supersedes older next steps)

- Both local-chaining bundles built and staged: `lbp2-return-local` (12 EBOOT parts,
  18 total modules, 32,120,560 bytes) and `lbp2-return-single` (one EBOOT part,
  7 total modules, 32,162,222 bytes). Single EBOOT has 85,157 profiled blocks.
- Extracted shared `wasm-dylink.mjs`; offline builder table sizing now uses dylink metadata
  instead of assuming 65,536 slots. 51 unit tests pass (`single-bundle-tests.log`).
- Focused headful generated-code test `ppu-local-chaining.spec.ts` passes: in-range
  dispatch calls target; out-of-range and null-context cases return. Oracle matrix also passed.
- Native clean LLVM/Vulkan baseline `native-reference-clean-2`: 4500–5200,
  13.78045 FPS, 257.381 OS CPU ms/flip, no timing drops; 6980 total flips, failures empty.
  DISPLAY=:98 owned Xvfb; :97 had died. Native draw counts unavailable, so exact scene parity
  still needs stronger verification. End screenshot confirms real gameplay.
- iPad 12-part local chaining (`ipad-local-asmjit`) failed around 4087 flips with a pthread
  error, ~600 million dispatches, 1.379 GB Wasm heap. Root cause not established.
- iPad single EBOOT (`ipad-single-asmjit`) reached 4493 flips with 255,201,577 dispatcher
  entries versus prior return-only >1.15 billion near4527. Still ~3.5 FPS in heavy scene;
  Safari lost session around450s, no persisted final result. NOT a stable speedup.
- Runtime harness now retains most recent4000 events; timeout/error carries structured
  partial timings and diagnostics. Device progress uses progress flipCounter when no recent
  frame event. Staged runtime and loaders in dist.
- Added optional Linux perf recording to `run-performance.mjs` (RPCS3_PERF=1), bounded
  by RPCS3_PROFILE_FROM_FRAME/TO_FRAME, all Chrome PIDs, cycles:u at99Hz, DWARF4096.
  V8 flags supplied explicitly through RPCS3_V8_FLAGS. Use `-k 1` for JIT clock matching!
- First OS capture `profile-os-jit`: 34041 samples, zero lost; frames4510–4904,
  13.59FPS, 470.73 OS CPUms/flip (profiling overhead; not shipping metric). GPU process
  46.88CPUms/flip. JIT inject failed because initial recorder omitted `-k 1`; corrected.
  Repeat `profile-os-jit-clock` started. Run `DEBUGINFOD_URLS='' perf inject -j ...` after
  completion, then report with no-children/call-graph none for self costs. Empty DEBUGINFOD_URLS
  avoids long network symbol lookup stalls. First run generated11GB of V8 JIT dump data.
- Earlier CDP sample `cpu_thread::operator()` 15.1% is only of attributed work samples;
  565438 samples unknown. Do not equate it to15% of all CPU or pure dispatcher overhead.
- No native/browser parity or stable iPad playback achieved. SPU no-import-tail diagnostic
  is staged but still untested. No subagents or commits.

## Resume update — 2026-09-05, latest user compaction

User reiterated: optimize until browsers match native; freely revisit web emulation architecture.
Then requested compaction and said trusted access is met. This is authorized emulator development.
No agents spawned or goal-tool goal created.

Completed since previous checkpoint:
- Regenerated public/fixtures/web_dispatch_conformance-return.wasm with latest native compiler.
  ppu-local-fixture-build.log passed. Matching manifest has localTableOnly:true,6640blocks.
- Staged fixture, current cores at dist/core/ppu-local and ppu-local-jspi, compiler at dist/core,
  and updated rpcs3-ppu-aot-table.mjs. Prior ppu-batch baselines preserved.
- Restaged corrected local-aot/lbp2-spu-notail to dist: NOW valid diagnostic version,
  replacing unsupported compact-import encoding. Still not device-tested.
- Headful Chrome HTTPS oracle matrix PASSED all4cases (tail/portable x batched/unbatched).
  Evidence test-results/performance/ppu-local-oracle.log. Temporary test config removed.
- Fresh native LBP2 IR dump completed132files in test-results/performance/ir-return-local.
  Evidence ir-return-local.log and ir-return-local-flips.json. No game/build/benchmark active.

Immediate next commands from repo root:
```
node web/scripts/filter-ppu-ir-by-profile.mjs test-results/performance/ir-return-local test-results/performance/ir-return-local-profiled test-results/performance/ppu-existing-profile.bin
node web/scripts/build-ppu-aot-bundle.mjs test-results/performance/ir-return-local-profiled web/public/local-aot/lbp2-return-local --eboot-parts=12 --jobs=6
```
Inspect parts: imported return_call must remain absent; guarded return_call_indirect now expected.
Check localTableOnly metadata. Stage bundle, then iPad with core/ppu-local-jspi, new PPU bundle,
SPUasmjit/noSPUAOT/noPPUJIT. Compare return-only evidence (9-minute timeout at4527flips,
more than1.15billiondispatches). Then test corrected SPUnotail diagnostic with SPUstatic.

Still add focused execution coverage proving local indirect chaining is taken and cross-instance
fallback remains safe. Current oracle enables chaining and passes, but does not count that branch.
Native/browser parity remains unachieved and is the ongoing objective.

## Latest compaction checkpoint — resume here (2026-09-04 19:39 PDT)

User asked `/compact let's resume again`. No build, Chrome benchmark, native game, or device runner
is active. All latest builds completed. Work is uncommitted. Earlier sections below retain history;
this section supersedes their incomplete-work/build-state statements.

### Latest PPU implementation: same-instance indirect tail calls (BUILT, NOT YET EXECUTION-TESTED)

The portable PPU mode initially returned at EVERY indirect branch. On the iPad that is expensive:
over a billion outer PPU dispatches in nine minutes. We now let it tail-call a target only if that
function-table slot belongs to the SAME Wasm instance. Cross-instance branches still store CIA
and return; imported helpers still carry LLVM `NoTail`.

Files:
- NEW `rpcs3/Emu/Cell/PPUWasmDispatch.h`: optional fourth block argument is a pointer to
  `ppu_wasm_dispatch_context { uint32_t table_begin, table_end; }`, 8bytes. Native retains its
  memory-base ABI. Wasm PPU memory accesses already use VM helpers; `m_base` was previously null.
- `PPUThread.cpp`: immutable pre-boot vector of instance spans, registered by new exported
  `rpcs3_web_ppu_register_instance_span(begin,end)` in `web/host/rpcs3_web_main.cpp`.
  Each exec loop owns a stack context and caches the span for the current table index; roots outside
  all spans get zero bounds. Passes `&web_context` as fourth argument to compiled blocks.
- `PPUTranslator::WasmCallThroughTable`: portable mode resolves the target slot, checks optional
  context non-null and `begin <= index < end`, then uses existing musttail indirect call only for
  that range. Older cores pass null and safely fall back. Imported helpers remain ordinary calls.
- `web/public/rpcs3-ppu-aot-table.mjs`: registers spans before guest execution ONLY when descriptor
  has `localTableOnly: true`. Missing metadata disables chaining safely.
- NEW `web/scripts/wasm-table-ownership.mjs`: conservative element-section parser proves all
  active entries reference defined (not imported) functions. Unknown encodings return false.
  `build-ppu-aot-bundle.mjs` and `build-partial-ppu-bundle.mjs` now write `localTableOnly`.
  Unit tests cover local/imported entries and unsupported/truncated elements.

Builds ALL PASSED:
- `ppu-local-native-build.log` -> `build-rpcs3-native-stock/bin/rpcs3`
- `ppu-local-jspi-build.log` -> `web/public/core/jspi/rpcs3-web.{mjs,wasm}`
- `ppu-local-base-build.log` -> `web/public/core/rpcs3-web.{mjs,wasm}` and compiler mjs/wasm
- `ppu-local-harness-tests.log`:51 tests,15files passed. `git diff --check` clean.

**Next required actions:**
1. Regenerate portable PPU oracle and LBP2 IR/bundle with latest native compiler. Old
   `ir-return-notail`/bundle has no local-chain check or metadata, so simply restaging old artifacts
   does not exercise this optimization. Suggested new names `ir-return-local`, `lbp2-return-local`.
2. Inspect output: imported `return_call` must remain absent; indirect tail calls now EXPECTED,
   guarded by module bounds. Verify `localTableOnly` true for intended PPU parts.
3. Stage new runtime/loader/compiler files and new cores at isolated HTTPS paths, e.g.
   `core/ppu-local`, `core/ppu-local-jspi`, without replacing established baseline paths.
4. Run headful HTTPS oracle matrix in `ppu-aot-table.spec.ts`: both branch modes and both
   diagnostic settings (4tests). `RPCS3_TEST_CORE_URL=./core/ppu-local/rpcs3-web.mjs` selects core.
   The test currently uses `fixtures/web_dispatch_conformance-return.manifest.json`, so regenerate
   that artifact with new code. Add focused coverage ensuring local chaining actually executes,
   and cross-instance fallback remains safe; mere verdict pass may use fallback if metadata absent.
5. Retry iPad with portable PPU local bundle, new JSPI core, no PPU JIT, SPU asmjit/no SPU AOT first.
   Compare outer dispatch counts and exact matched scene against the prior return-only mode.
6. Generalize imported-tail-call policy to SPU LLVM only after the diagnostic test below confirms it.
   No automatic platform selection has been enabled yet.

### PPU diagnostic batching: validated, first small desktop improvement

`ppu_web_execution_counters` in PPUThread batches shared last-PC and compiled dispatch counters
once per256 outer entries; flushes pending counters on exit/unwind. Opcode VM lookup moved below
compiled dispatch, so compiled blocks no longer pay that lookup. `ppuBatchedDiagnostics=false`
keeps per-entry shared last-PC/compiled counts for SAME-BINARY control; opcode lookup deferral
remains in both modes. Runtime/acceptance/play/device plumbing and KEEPALIVE setter implemented.

Previously staged versions (before local-chain change):
- HTTPS `core/ppu-batch` (base), `core/ppu-batch-jspi` (JSPI)
- These remain the verified batching build; public/core now contains newer local-chain build.
- `ppu-batch-oracle.log`:4headfulHTTPS oracle tests passed (native verdict76ec98ba0e352b1c).

First controlled pair, frozen profile+same binary+all4inputs+exact1163.372857draws/flip,
window4500–5200, shared Vulkan flags, no profiler:
- `ppu-batch-off-1`:14.75350FPS,414.86784OSCPUms/flip,p95=78.95996ms;5512flips,failures[].
- `ppu-batch-on-1`:14.91563FPS,409.80573OSCPUms/flip,p95=76.875ms;5510flips,failures[].
About+1.10%FPS/-1.22%CPU/flip. One pair is not reliable proof of gain; repeat in reverse order.
Profiles cloned from `~/.cache/rpcs3-web-benchmark-fixture` to
`~/.cache/rpcs3-web-ppu-batch-{off,on}-1` with `cp -a --reflink=always`.
Controls:RPCS3_CORE=ppu-batch-jspi,RPCS3_PPU_BATCHED_DIAGNOSTICS=0/1.

### iPad results this resumed session

All at1280x720, no fidelity reductions. Evidence under `test-results/performance/`:
- `ipad-aot-return-notail`:240flips,visible warning screen,43,342,101compiledPPUdispatches,
  286draws,mean36.036ms/flip. PPU return-only bundle + static SPU. First successful PPU AOT LBP2.
- `ipad-aot-return-extended`:staticSPU,noPPUJIT;9-minute runtime timeout at1679flips,
  381,811,050PPUdispatches,10090draws. No reload. Slow, NOT gameplay success.
- `ipad-return-spu-llvm`:PPUreturn-only + SPUAOT + LLVMworker1; ptrauth crash near112flips.
  `ipad-return-spu-syslog.txt` confirms domainptrauth28/code261, launchd(28,261,9).
- `ipad-return-spu-asmjit`:PPUreturn-only + batchingcore + SPUasmjit/noSPUAOT/noPPUJIT:
  SUCCESS1200flips,4751draws,mean41.50865ms/flip,p50=34.74048,p95=73.33936.
  `frame.png` visually shows opening movie. No reload.
- `ipad-return-asmjit-extended`:same options,5500target+replayedcontrols. Reached4527flips,
  >1.15billioncompiledPPUdispatches,1,174,197draws by9-minute runtime timeout.
  Progress paused around2797 while loading, then resumed. Heavy scene~1–3FPS, NOT playable speed.
  Did not reload. Runtime timeout terminates worker. Progress.json preserves samples but final
  report is failure with truncated event text, no final screenshot. Need better timeout capture.

Device command pattern:
```
WIP_TIMEOUT_MS=600000 RPCS3_CORE_URL=./core/ppu-local-jspi/rpcs3-web.mjs \
RPCS3_PPU_AOT_BUNDLE=local-aot/lbp2-return-local/manifest.json \
RPCS3_PPU_JIT=0 RPCS3_NO_SPU_AOT=1 RPCS3_SPU_DECODER=asmjit \
RPCS3_PPU_RETURN_DISPATCH=1 RPCS3_INPUT_TRACE=test-results/performance/gameplay-input.json \
node web/scripts/run-game-device.mjs https://rpcs3.appmana.com OUTPUT OPFS_ISO 5500 1280 720
```
Runner now supports RPCS3_CORE_URL, RPCS3_PPU_BATCHED_DIAGNOSTICS, RPCS3_SPU_AOT_BUNDLE;
uses shared title bundle defaults (explicit null still disables), elapsed-time deadline,
retains failure report if no result, and shows frame/draw/dispatch progress. Caveat progress logs
currently show frame0 when the last40events contain only runtime-progress despite live flipCounter;
fix this fallback. Source changes mostly staged except newest loader/core and subsequent runner-only
changes, which are local Node and need no staging.

### SPU imported-tail-call diagnostic (artifact ready; NOT DEVICE-TESTED)

Disassembly of old `local-aot/lbp2-spu/spu-00.wasm` found13,994 imported tail-call sites:
patchpoints plus `spu_dispatch`/`spu_escape`. No indirect tail calls.
`test-results/performance/lower-spu-import-tails.py` rewrites those WAT expressions as
`return(call ...)`, preserving local direct tail calls and original dylink custom section.
This is a DIAGNOSTIC transformation, not a production compiler fix.
- SourceWAT `spu-bundle.wat`105MB; changed `spu-notail.wat`.
- Corrected output `web/public/local-aot/lbp2-spu-notail/spu-00.wasm`,10,854,578bytes,
  manifest diagnosticOnly:true, source diagnostic-import-tail-lowering.
- Latest Node validation PASSED: original imports/exports exactly equal, dylink.0 one section.
- **dist/local-aot/lbp2-spu-notail still contains the FIRST INVALID version! RESTAGE corrected
  public directory before testing.** Initial `wasm-as --all-features` enabled compact-imports,
  unsupported by Node/browser. Reassembled using ONLY original feature flags and now valid.
- `spu-notail-lowering.log` records final count/size. `spu-notail-encoding.log` is failed attempt
  to disable compact imports with wasm-opt; ignore that output.
- To isolate SPUAOT, select RPCS3_SPU_DECODER=static and this SPU bundle, PPUnotail + noPPUJIT.
  Do not simultaneously enable SPULLVM until its compiler also disables imported tail calls.
- `SPULLVMRecompiler.cpp` wasm emit/dump path near3966 is shared native/browser seam for a
  production NoTail policy. Utilities/JITWeb.cpp::emit_wasm is shared backend but native IR dumping
  bypasses it. No SPU compiler policy source change has been made yet.

### Profiling and harness corrections

- `run-performance.mjs`:RPCS3_V8_FLAGS adds recorded --js-flags. `profile-no-v8-inline` completed
  5507flips/all4inputs/failures[] with --no-wasm-inlining. CPU_thread still~15%ofKNOWNsamples,
  huge unknown `(program)` remains; no confident attribution.4500–5200=12.8207FPS,
  532.326CPUms/flip but3.158sprofilerattachmentstall =>NOTshippingperformance.
- Fixed `analyse-cpuprofile.mjs`: bounded profiles must only divide by profiled flips, not the
  longer matching scene. Old `cpu-analysis.json` is TEXT with stale166.2ms/flip over1307frames.
  Corrected `cpu-analysis.txt`:304.3estimatedsampled-workms/flip over683frames; still incomplete
  sampling, not OSCPU. Main profile~51.9s,207.8sampled-workseconds,565438unknownsamples.
- Future runner records stoppedAt BEFORE profiler stop/write (startedAt already AFTER attachment).
  Consider adding a regression test for profile-window frame normalization.
- NEW `linux-thread-sampler.mjs`, optionalRPCS3_THREAD_CPU=1:reads /proc/PID/task/TID/stat,
  records CPU + lifetime; `getconf CLK_TCK` recorded. `measureWindow` reports threadCpuMs and
  excludes reusedTIDs/birth/death tails.3tests for spaces/parentheses/truncation/TIDreuse.
  Needs a real run with OS trace/JIT correlation to identify actual guest thread responsibilities.
- Tail-call probe source now tracked at `web/fixtures/wasm-tail-call/probe.wat`; generated public
  binary stays ignored. Probe script documents assembly/staging.
- Latest total unit suite51pass/15files. New local-chain code only build/unit validated so far.

Oracle regeneration command (repo root):
```
RPCS3_NATIVE="$PWD/build-rpcs3-native-stock/bin/rpcs3" \
RPCS3_PPU_WASM_RETURN_DISPATCH=1 \
RPCS3_PPU_AOT_ELF="$PWD/web/public/fixtures/web_dispatch_conformance.self" \
RPCS3_PPU_AOT_OUTPUT="$PWD/web/public/fixtures/web_dispatch_conformance-return.wasm" \
node web/scripts/build-ppu-aot-fixture.mjs
node web/scripts/build-partial-ppu-bundle.mjs \
  web/public/fixtures/web_dispatch_conformance-return.wasm \
  web/public/fixtures/web_dispatch_conformance-return.manifest.json 1
```
For headful HTTPS oracle test, create temporary web/ppu-check.config.ts importing GPUconfig,
override testMatch:['ppu-aot-table.spec.ts'], baseURL HTTPS, webServer undefined. Run with
DISPLAY=:0 RPCS3_TEST_CORE_URL=./core/ppu-local/rpcs3-web.mjs npx playwright test --config ...
and remove the temporary config. Avoid repeating mistaken web/ prefixes when workdir alreadyweb.

Original task remains incomplete: repeated performance pairs, robust native comparison, meaningful
PPU cost attribution, stable fast iPad gameplay, production SPU compatibility policy, ten-minute soak.

## Authorization and working environment

- Repo `/home/administrator/Documents/rpcs3-web`, branch `web/main`, HEAD `1be9956a0`.
  All work is uncommitted. Do not discard it or accidentally commit the large evidence/ISO artifacts.
- No subagents unless explicitly requested. No skill applies. No goal-tool goal was created.
- Use **https://rpcs3.appmana.com**, serving `web/dist` via port 4180. Cluster instructions were read
  in `~/Documents/appmana/docs/cluster.md`; ingress remains unchanged.
- User approved actual gameplay input plus the historical unattended scene; keep iPad rendering
  fidelity (1280×720, no effects/resolution reductions).
- Read original long handoff `web/2026-09-04-155041-this-session-is-being-continued-from-a-previous-c.txt`
  and `web/docs` if more historical context is needed. `performance.md` has measurement contracts.
- Host: Ryzen 5950X, 16 physical cores/32 logical threads, two RTX A5000, Chrome 152.0.7977.64,
  driver 610.57.04. DISPLAY=:0 is the real desktop. Avoid builds/other desktop GPU work during runs.
- Native Release: `build-rpcs3-native-stock/bin/rpcs3`, portable SPU OFF.
  `build-rpcs3-native` is a portable-interpreter differential oracle, not a native speed reference.
- Emsdk `~/.cache/emsdk-6.0.8`; LLVM wasm `~/llvm-wasm/build-wasm`.
- ISO `/home/administrator/Downloads/LittleBigPlanet 2 - Special Edition (USA) (En,Fr,Es,Pt).iso`.
  Browser path `/opfs/games/` plus that filename; firmware and ISO already in both devices' OPFS.
- iPad: Benjamin’s iPad, iOS 27 beta 24A5430a. Inspector discovery `http://127.0.0.1:9221/json`,
  pages `http://127.0.0.1:9222/json`, usual page197. Safari UA reports Macintosh + Version/27.0.
- An owned Xvfb server on :97 remains available for native capture. No native game, Chrome benchmark,
  build, or iPad run remains active at handoff. Do not stop unrelated Unity/appmana workloads.

## Crucial PPU finding: reproducible Safari cross-instance tail-call crash

A **112-byte standalone Wasm module** reproduces the problem independently of RPCS3:

- `web/fixtures/wasm-tail-call/probe.wat` and generated `.wasm` (fixtures may be gitignored).
- `web/scripts/probe-tail-calls-device.mjs` runs it on the attached iPad through the shared inspector.
- Signature: four i32 and three i64 parameters, void result, like guest blocks. A shared function
  table alternates between two instances of the same module with `return_call_indirect`.
- Two instances, depth 20,000 × 100 calls: Safari reloads. **No thrown exception is required.**
- Same test with both table slots pointing into ONE instance: **passes 2,000,000 tail calls in
  11.42 ms**. Zero-depth/two-instance control also passes.
- Device logs confirm `domain:ptrauth(28) code:261`, launchd termination `(28,261,9)` at the probe.
  This is stronger evidence than merely observing a lost page. Do not call it a memory-limit kill.

Evidence:
`test-results/performance/ipad-tail-calls-normal.json`, `ipad-tail-calls-zero.json`,
`ipad-tail-calls-one-instance.json`, `ipad-tail-probe-syslog.txt`.
The normal report has before/after page time origins and a timeout caused by the reload.

Commands (start from an inspectable RPCS3 HTTPS page):

```sh
RPCS3_PROBE_THROW=0 node web/scripts/probe-tail-calls-device.mjs /tmp/two-instances.json
RPCS3_PROBE_THROW=0 RPCS3_PROBE_INSTANCES=1 node web/scripts/probe-tail-calls-device.mjs /tmp/one-instance.json
RPCS3_PROBE_THROW=0 RPCS3_PROBE_DEPTH=0 node web/scripts/probe-tail-calls-device.mjs /tmp/zero-depth.json
```

The probe currently operates on the page, not a separate worker. It writes failure evidence rather
than claiming a timeout alone proves a crash. Rebuild fixture using emsdk's `upstream/bin/wasm-as`
with `--enable-tail-call`. Node also executes the fixture correctly.

## PPU workaround implemented so far — NOT YET COMPLETE

Changed:
- `PPUTranslator.h/.cpp`: `ppu_wasm_branch_mode { tail_call, return_to_dispatcher }` constructor
  option. Default preserves Chrome behavior. `WasmCallThroughTable` in return mode stores target
  CIA and returns, exactly like its existing unregistered-target path. Direct calls within the
  translated module still use musttail. This also permits returning cross-part constant branches.
- `PPUThread.cpp`: native IR generation selects return mode with
  `RPCS3_PPU_WASM_RETURN_DISPATCH=1` (presence currently enables it).
- `web/host/rpcs3_ppu_llvm_main.cpp`: exported `rpcs3_ppu_llvm_return_dispatch(int)` sets the same
  translation option for the browser compiler.
- Plumbing `ppuReturnDispatch` through `rpcs3-spu-llvm.mjs`, its compiler worker,
  `runtime-smoke-worker.mjs`, `runtime-acceptance.mjs`, and play query `ppuReturnDispatch=1`.
- Device runner env `RPCS3_PPU_RETURN_DISPATCH=1` enables it.

**Critical next fix:** portable bundles STILL contain `return_call $__check` and other imported
helper tail calls. Those also cross Wasm instances. This explains why merely removing indirect
calls did not finish the workaround. Verified by disassembling
`web/public/local-aot/lbp2-return/EBOOT-00.wasm` to
`test-results/performance/return-part.wat`: `__check` is an imported `(i32,i64)->void` function and
many return_call sites remain.

Before LLVM optimization, mark non-musttail calls to non-intrinsic helpers `TCK_NoTail` in return
mode. Preserve direct guest musttail calls within the module. `PPUTranslator::Translate` ends with
`run_transforms(*m_function); return m_function;` near line359. There are MULTIPLE identical snippets
in the file; an attempted global replacement asserted and made **NO EDIT**. Target Translate only.
Then rebuild, inspect emitted Wasm for imported tail calls, and run the iPad again. Consider whether
later lowering can introduce libc/helper tail calls, and validate rather than assume.

Current return-mode native and wasm compiler builds passed BEFORE this remaining fix. No tests yet
establish return-mode guest correctness beyond initial execution. Keep the mode opt-in until both
correctness and full device playback pass. Do not globally disable all tail calls.

## Return-mode AOT generation already done

- Raw fresh IR: `test-results/performance/ir-return` (1.1GB, 132 files, 114 EBOOT parts).
- Profiled IR: `test-results/performance/ir-return-profiled` (124 retained parts).
- Retention profile: `test-results/performance/ppu-existing-profile.bin`, extracted from the current
  `lbp2-profiled` manifest's address/index pairs. 85,157 input addresses; closure retains 93,193
  total blocks in fresh IR, so do not claim bit-identical equivalence to old 85,157-block bundles.
- New bundle `web/public/local-aot/lbp2-return` and `web/dist/local-aot/lbp2-return`:
  12 EBOOT groups + 6 PRX groups, ~28.8MB, zero guest imports.
- Logs `native-branch-mode-build.log`, `branch-mode-build.log`, `ir-return.log`,
  `filter-return.log`, `bundle-return.log` under `test-results/performance`.

Generation recipe:

```sh
# Build native after translator changes. No benchmarks concurrently.
cmake --build build-rpcs3-native-stock --target rpcs3 -j 8
# Native IR dump used these env vars and the ISO, with isolated XDG_CONFIG_HOME/native config:
RPCS3_PPU_WASM_AOT_IR=1 RPCS3_PPU_WASM_RETURN_DISPATCH=1 \
RPCS3_PPU_WASM_AOT_DIR=/absolute/output/directory
# --benchmark-duration 120000 --benchmark-report ... gave an orderly generation session stop.
node web/scripts/filter-ppu-ir-by-profile.mjs RAW_IR FILTERED_IR test-results/performance/ppu-existing-profile.bin
node web/scripts/build-ppu-aot-bundle.mjs FILTERED_IR web/public/local-aot/lbp2-return --eboot-parts=12 --jobs=6
RPCS3_WEB_JOBS=8 bash web/scripts/build-rpcs3-core.sh
```

Build script stages to public, not dist. Copy/build staging deliberately. The latest base core mjs,
LLVM compiler mjs/wasm, and runtime JS were changed/staged at different times; always hash assets.
No return-mode manifest metadata/automatic iPad bundle selection has been added yet. Defaults
still select existing bundles. Add explicit branch-policy metadata and validation when implementing
selection; the device runner still hardcodes LBP2 defaults instead of fully relying on shared options.

## Device results and harness improvements

- Full-quality Tetris, JSPI, interpreter: 60 flips, ~16.61 ms mean, 292 draws, succeeds.
- Full-quality Tetris PPU AOT (`fixtures/gs-gcm-tetris-aot.manifest.json`): 60 flips, ~16.59 ms mean,
  293 draws, succeeds. Small single-module AOT is not generally broken.
- LBP2 pure interpreter/no AOT/no LLVM: reaches 120 flips, 60 FPS in the initial BLACK/no-draw
  period. **Not playable-performance evidence.** `ipad-lbp2-interpreter`.
- Default LBP2, one compiler worker, pool32, non-JSPI, 1GiB memory ceiling: all still fail.
  Reduced memory is not a demonstrated fix and has not been made a default.
- PPU AOT only with static SPU also crashes, narrowing the initial fault to PPU compiled execution.
- Runtime PPU JIT return mode, no AOT/static SPU: advances to 104 flips, 413 compiled PPU blocks,
  ~836MB heap before reload (`ipad-jit-return`). It progressed past the old immediate failure but
  did not complete. AOT return mode still fails with confirmed ptrauth (`ipad-aot-return`,
  `ipad-return-syslog.txt`). Imported helper tail calls remain, as above.

Runner `web/scripts/run-game-device.mjs` now:
- captures progress externally every second (`progress.json`), page time origin, recent events;
- stores completed result on the live page before OPFS write;
- polls live state synchronously (old OPFS read every poll could hang);
- bounds inspector commands to10s, recognizes `Webpage Crashed`, detects lost state after10 polls;
- handles missing screenshot without `undefined.width` crash;
- records full options in new final reports;
- supports `RPCS3_JSPI=0`, `RPCS3_PPU_JIT=0`, `RPCS3_NO_PPU_AOT=1`, `RPCS3_NO_SPU_AOT=1`,
  `RPCS3_NO_AOT=1`, `RPCS3_PPU_RETURN_DISPATCH=1`, `RPCS3_MEMORY_MAX_MIB=1024`, pool/compiler counts.
Explicit no-AOT must use null, not undefined: shared runtime defaults otherwise restore it.
- Shared `webkit-connection.mjs` now rejects pending calls on unexpected socket close; tests pass.

`idevicesyslog` works. Capture only relevant process termination lines for repeat probes. A previous
full35s log is `ipad-startup-syslog.txt` (~77k lines). `idevicecrashreport --keep` copied device crash
reports to `ipad-crashes`; these contain unrelated device data and should not be published wholesale.
The ptrauth diagnostic lines alone suffice for the current finding.

## Desktop measurements and pending profiling work

SPU verified-candidate cache (`SPUWebDispatch.h`, SPUThread.cpp) is implemented and on by default.
Per executing SPU, 256 slots, ~2KB; keyed by immutable candidate-list pointer, remembers candidate
position, ALWAYS verifies mutable local store. List replacement restores optimizing-tier priority.
Same binary control query/env disables cache. Four native + wasm tests pass. Diagnostic counters
are batched local increments published every1024 iterations; unpublished tails are lower bounds.

First controlled pair, same frozen Chrome fixture/replay/binary/legacy Vulkan flags:
`cache-on-1` vs `cache-off-1`, window4500–5200, exact1163.372857draws/flip:
- ON14.840FPS,420.147 OS CPU-ms/flip,p95=76.475ms.
- OFF13.748FPS,464.954 CPU-ms/flip,p95=81.660ms.
- +7.94% FPS, -9.64% CPU/flip, **one pair only**. Reject fraction49.46%→8.40%.
Repeat pairs still pending; don't compare exploratory9.65FPS diagnostic directly to these.

Frozen profile `~/.cache/rpcs3-web-benchmark-fixture`; reflink copies are cheap. Recorded real input
`test-results/performance/gameplay-input.json`: x3866–3869, right stick5379–5482. Player movement
was visually verified earlier. Use >=5500 frames if asserting all four entries applied.

Profiling runs completed cleanly:
- `profile-window`: old named core, profile only4500–5200, target5400 (only3/4 inputs applied).
  ~13.454FPS/498.375CPUms/flip in4500–5200, but profiler attachment introduced a3.076s stall.
  **This is not shipping FPS.** Exact1163.372857draws/flip.
- `profile-seams`: profile core with Binaryen `--one-caller-inline-max-function-size=0`, target5500,
  all4 inputs applied. Raw cpuprofiles/report/analysis present.
- Large unknown `(program)` sample population retained as unknown, never treated as CPU work/idle.
- `cpu_thread::operator()` still16–20% of KNOWN samples; cannot yet call that dispatch overhead.
  In current static Wasm it is only484bytes, SPU cpu_task3597bytes, interpreter loop2130bytes.
  This invalidates my earlier confident claim that static Binaryen inlining alone explains it.
  V8's own Wasm inlining/speculative indirect-call inlining is enabled; local Chrome `--js-flags=--help`
  confirms `--no-wasm-inlining` exists. Investigate runtime inlining/profiler attribution or use OS
  perf+V8 JIT maps and per-thread CPU. Avoid repeating inadequate profiles without resolving this.
- Better attribution is still needed for PPU compiled blocks vs interpreter, DMA, VM helpers,
  synchronization, RSX submission, and driver/compositor cost.

`run-performance.mjs` supports RPCS3_PROFILE_FROM_FRAME/TO_FRAME, hashes, profile locks, exact flips,
OS process CPU1Hz, host CPU load, screenshots and orderly stop. `analyse-performance.mjs` computes
exact consecutive-frame percentiles and CPU per flip. Shared session/profiler/device modules reduce
large duplicated runners. `run-play-chrome.mjs` is now a thin compatibility wrapper.

## Native comparison and shutdown fixes

New common RSX `FrameTiming.h` and injected_pad replay seam apply to native and wasm.
Native CLI `--input-trace`, `--benchmark-report`, `--benchmark-duration`. Timed shutdown must ONLY
call `Emu.Kill()`; it is asynchronous. Calling QCoreApplication::quit immediately after Kill caused
GUI teardown segfault. The current implementation was fixed and short validation passes:
`native-stop-clean`,177flips,failures[].

`run-native-performance.mjs` records OS CPU, optional perf, JIT maps, screenshots; uses Qt xcb,
checks window ownership, saves partial reports, and owns a process group so crash-dialog helpers
cannot retain UDP3658 and poison later runs. A crash helper did retain that port; it was cleaned up.
No native process remains. Use isolated config root
`test-results/performance/native-fixture`, config `native-config.yml`.
**Quote Audio Renderer: "Null" in YAML**; unquoted Null was ignored as YAML null and actual audio
remained Cubeb. Current config is corrected; older native run used Cubeb.

`native-reference-timed` ran Vulkan on actual RTX A5000 on Xvfb:97 and captured the heavy intro.
Window4500–4740:13.787FPS,256.677 OS CPU-ms/flip,p95=75.561ms. This run ended with the OLD teardown
segfault; report was recovered and failures annotated. Only2input entries applied before stop.
Not a clean matched native baseline; do NOT claim native runs30FPS throughout (only early intro did).
Some neon logo colors are visible natively too; do not label all those colors WebGPU bugs.
Native perf has unresolved kernel20% even with copied kallsyms; investigate rather than assign it.
`Utilities/JITASM.cpp` opt-in RPCS3_PERF_MAP retains `/tmp/perf-PID.map` and runner copies it.

## Rendering, tests, and remaining task scope

Standalone canvas probe found legacy ANGLE Vulkan gave transparent ImageBitmap→2D snapshots despite
correct GPU texture bytes. Shared Vulkan flags (`Vulkan,DefaultANGLEVulkan,VulkanFromANGLE`) fix it
on actual NVIDIA. `chrome-gpu.mjs` is shared by runners/config. Explicit JSPI pre-yield capture is
implemented; no forced-alpha shader hack remains. Default/software Chrome is not a valid GPU test.
GPU config now defaults HEADFUL; `RPCS3_HEADED=0` explicitly chooses headless, where this shared
Vulkan configuration returned no adapter. Latest correct headful HTTPS direct tests:2pass.

Validation before the latest PPU branch changes:
- Vitest46pass (13files), including explicit disabled-bundle selection and inspector-close tests.
- Default e2e22pass,1skip; wasm unit118pass; native cache4pass.
- Direct headful HTTPS bitmap+JSPI2pass in `direct-current.log`.
- Native and wasm builds with the initial PPU return mode passed.
Need new meaningful PPU return-mode correctness tests (known register/control/reservation oracle),
rebuild imported-helper NoTail fix, inspect output, and rerun iPad. Existing e2e
`dispatch-conformance.spec.ts`, `spu-llvm-compiler.spec.ts`, `llvm-wasm-backend.spec.ts` offer patterns.
Do not claim all older GPU tests pass; some assume obsolete packet metrics.

Original task is incomplete: repeated controlled Chrome pairs, robust native parity, sustained
player-controlled performance, PPU architecture optimization, stable full-quality iPad playback,
and ten-minute device soak remain. Continue autonomously after compaction.
