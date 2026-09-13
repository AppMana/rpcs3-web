import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const mask = Array.from({ length: 16 }, (_, i) => `i32 ${15 - i}`).join(', ');
const ones = Array.from({ length: 16 }, () => 'i8 1').join(', ');
const source = `target triple = "wasm32-unknown-unknown"
define void @bench(ptr %data, i32 %count) {
entry:
 %initial = load <16 x i8>, ptr %data, align 1
 %empty = icmp eq i32 %count, 0
 br i1 %empty, label %done, label %loop
loop:
 %i = phi i32 [0, %entry], [%nexti, %loop]
 %v = phi <16 x i8> [%initial, %entry], [%next, %loop]
 %r = shufflevector <16 x i8> %v, <16 x i8> poison, <16 x i32> <${mask}>
 %next = add <16 x i8> %r, <${ones}>
 %nexti = add i32 %i, 1
 %more = icmp ult i32 %nexti, %count
 br i1 %more, label %loop, label %done
done:
 %result = phi <16 x i8> [%initial, %entry], [%next, %loop]
 store <16 x i8> %result, ptr %data, align 1
 ret void
}
`;
writeFileSync(join(output, 'probe.ll'), source);
for (const name of ['control', 'candidate']) {
 const report = execFileSync(process.execPath, ['web/scripts/compile-ppu-ir-to-wasm.mjs', join(output, 'probe.ll'), join(output, `${name}.wasm`), '--pic', '--export-all', ...(name === 'candidate' ? ['--unary-swizzles'] : [])], { encoding: 'utf8' });
 writeFileSync(join(output, `${name}.json`), report);
}
