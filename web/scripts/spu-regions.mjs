import { createHash } from 'node:crypto';

// Regions are disjoint pairs initially. This caps duplication and avoids turning
// one hot guest graph into a giant Wasm function that remains in a baseline tier.
export function selectSpuRegions(profile, catalog, { maxRegions = 32, minSamples = 32 } = {}) {
  if (!Array.isArray(profile?.edges) || !Number.isSafeInteger(maxRegions) || maxRegions < 0
    || !Number.isSafeInteger(minSamples) || minSamples < 1) throw new Error('invalid SPU region selection policy');
  const validProgram = p => p && Number.isInteger(p.pc) && p.pc >= 0 && p.pc < 262144 && !(p.pc & 3)
    && Number.isSafeInteger(p.instructions) && p.instructions > 0 && Number.isSafeInteger(p.blocks) && p.blocks > 0;
  const used = new Set(), regions = [];
  for (const edge of profile.edges) {
    if (regions.length >= maxRegions) break;
    const a = catalog.get(edge.from?.symbol), b = catalog.get(edge.to?.symbol);
    if (!validProgram(a) || !validProgram(b) || a.symbol === b.symbol || a.pc === b.pc || used.has(a.symbol) || used.has(b.symbol)) continue;
    if (!Number.isSafeInteger(edge.samples) || !Number.isFinite(edge.observedSourceShare) || edge.observedSourceShare > 1
      || edge.samples < minSamples || edge.observedSourceShare < 0.9 || a.instructions + b.instructions > 512
      || a.blocks + b.blocks > 32) continue;
    const members = [a, b].sort((x, y) => x.symbol.localeCompare(y.symbol, 'en'));
    const id = createHash('sha256').update(members.map(x => x.symbol).join('\0')).digest('hex').slice(0, 16);
    regions.push({ id, symbol: `__spu-rx${id}`, aliases: `rpcs3_spu_region_aliases_${id}`, members, samples: edge.samples });
    for (const member of members) used.add(member.symbol);
  }
  return regions;
}

export function emitSpuRegion(region) {
  const { members, id } = region;
  if (members.length !== 2 || !/^[a-f0-9]+$/.test(id)) throw new Error('unsupported SPU region shape');
  for (const member of members) if (!/^__spu-0x[0-9a-f]+-[a-z0-9]+$/i.test(member.symbol)
    || !Number.isInteger(member.pc) || (member.pc & 3) || member.pc < 0 || member.pc >= 262144) throw new Error('invalid region member');
  const declarations = members.map((member, i) => `extern void program_${i}(void*, void*, uint64_t) __asm__("${member.symbol}");`).join('\n');
  const snapshots = members.map((member, i) => {
    const word = member.pc >>> 2;
    return `
  const uint32_t alias_${i} = aliases[${i}];
  uint32_t generation_${i} = *(const volatile uint32_t*)(lists + ${word});
  const uint32_t* preferred_${i} = cache + spu_chain_cache_slot(${member.pc}) * 2;
  if (alias_${i} < begin || alias_${i} >= end || !generation_${i} || preferred_${i}[0] != generation_${i}
      || preferred_${i}[1] >= *(const uint32_t*)(uintptr_t)generation_${i}
      || ((const uint32_t*)(uintptr_t)generation_${i})[1 + preferred_${i}[1]] != alias_${i}) generation_${i} = 0;`;
  }).join('\n');
  const nodes = members.map((member, i) => {
    const other = 1 - i;
    return `
node_${i}: {
    if (*(const volatile uint32_t*)state) { c->reason = SPU_CHAIN_STATE; goto done; }
    program_${i}(thread, ls, 0);
    if (*failure != before_failure) { c->reason = SPU_CHAIN_REJECTED; goto done; }
    ++completed;
    const uint32_t next_pc = *pc;
    if (next_pc == entry_pc) { c->reason = SPU_CHAIN_INTERPRET; goto done; }
    if (completed == budget) goto done;
    if (next_pc == ${members[other].pc} && generation_${other}
        && *(const volatile uint32_t*)(lists + ${members[other].pc >>> 2}) == generation_${other}) { entry_pc = next_pc; goto node_${other}; }
    uint32_t continuation;
    if (!spu_chain_cached_target_pairs(lists, cache, next_pc, &continuation)) { c->reason = SPU_CHAIN_MISS; goto done; }
    // Leaving a small region must not shorten the original chain's scheduling
    // slice. Continue locally through its normal runner, then restore the ABI.
    c->target = continuation;
    c->budget = budget - completed;
    rpcs3_spu_run_chain((uint32_t)(uintptr_t)thread, (uint32_t)(uintptr_t)ls, (uint64_t)(uintptr_t)c);
    completed += c->completed;
    c->budget = budget;
    c->target = initial_target;
    goto done;
  }`;
  }).join('\n');
  return `#include "chain.h"
${declarations}
static uint32_t aliases[2];
uint32_t ${region.aliases}(void) { return (uint32_t)(uintptr_t)aliases; }
static __attribute__((always_inline)) inline void execute_region(void* restrict thread, void* restrict ls, struct spu_chain_context* restrict c) {
  const uint32_t budget = c->budget, begin = c->table_begin, end = c->table_end, initial_target = c->target;
  uint32_t completed = 0;
  c->completed = 0;
  c->reason = SPU_CHAIN_BUDGET;
  if (!budget) return;
  if (c->target < begin || c->target >= end) { c->reason = SPU_CHAIN_OTHER_MODULE; return; }
  uint32_t* pc = (void*)(uintptr_t)c->pc;
  uint64_t* failure = (void*)(uintptr_t)c->failure;
  uint32_t* state = (void*)(uintptr_t)c->state;
  uint32_t* lists = (void*)(uintptr_t)c->lists;
  const uint32_t* cache = (void*)(uintptr_t)c->cache;
  const uint64_t before_failure = *failure;
  uint32_t entry_pc = *pc;
  ${snapshots}
  if (c->target == alias_0) goto node_0;
  if (c->target == alias_1) goto node_1;
  c->reason = SPU_CHAIN_OTHER_MODULE;
  goto done;
  ${nodes}
done:
  c->completed = completed;
}
void run_region(uint32_t thread, uint32_t ls, uint64_t context) __asm__("${region.symbol}");
void run_region(uint32_t thread, uint32_t ls, uint64_t context) {
  execute_region((void*)(uintptr_t)thread, (void*)(uintptr_t)ls, (void*)(uintptr_t)context);
}
`;
}
