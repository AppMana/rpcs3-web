import {readFileSync} from 'node:fs';
import {compilationWindow} from './compilation-metrics.mjs';
const [path, from = '4500', to = '5200'] = process.argv.slice(2);
if (!path) throw new Error('usage: analyse-compilation.mjs report.json [from-frame to-frame]');
const report = JSON.parse(readFileSync(path, 'utf8'));
console.log(JSON.stringify(compilationWindow(report, Number(from), Number(to)), null, 2));
