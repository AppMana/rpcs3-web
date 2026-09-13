#!/usr/bin/env python3
"""Select perf leaf samples using recorded guest-flip boundaries on the perf clock."""
import argparse
import json
import re
from pathlib import Path


def boundaries(report, first, last):
    if first >= last:
        raise ValueError('frame window must increase')
    native = 'flips' in report
    if (report['flips'].get('dropped', 0) if native else report.get('timingDrops', 0)):
        raise ValueError('flip timing drops prevent an exact frame-window comparison')
    frames = report['flips']['frames'] if native else report['flipTimings']
    selected = {}
    for frame in frames:
        number = frame['emuFlipId']
        if number in (first, last):
            if number in selected:
                raise ValueError('duplicate frame boundary')
            selected[number] = frame
    if len(selected) != 2:
        raise ValueError('requested frame boundaries are missing')
    if native:
        times = [selected[n]['monotonicUs'] / 1e6 for n in (first, last)]
        uncertainty = 0
    else:
        clock = report['clock']
        times = [(selected[n]['hostTimeMs'] * 1000 + clock['offsetUs']) / 1e6
                 for n in (first, last)]
        uncertainty = clock['uncertaintyUs']
    if times[0] >= times[1]:
        raise ValueError('frame clocks must increase')
    recording = report.get('perfWindow', {})
    if recording.get('startedAtFrame', first) > first or recording.get('stoppedAtFrame', last) < last:
        raise ValueError('perf recording does not cover the requested frame window')
    return dict(fromFrame=first, toFrame=last, startSeconds=times[0], endSeconds=times[1],
                clockUncertaintyUs=uncertainty)


def select_samples(text, window):
    parsed = []
    for line in text.splitlines():
        if not line.strip():
            continue
        match = re.match(r'\s*\d+/\d+\s+(\d+\.\d+):', line)
        if not match:
            raise ValueError('expected perf leaf output with time,pid,tid fields')
        parsed.append((float(match[1]), line))
    start, end = window['startSeconds'], window['endSeconds']
    if not parsed or min(t for t, _ in parsed) > start or max(t for t, _ in parsed) < end:
        raise ValueError('perf samples do not bracket the requested window')
    lines = [line for time, line in parsed if start <= time < end]
    if not lines:
        raise ValueError('no samples in requested window')
    return '\n'.join(lines) + '\n', len(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('samples', type=Path)
    parser.add_argument('first', type=int)
    parser.add_argument('last', type=int)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in (args.report.resolve(), args.samples.resolve()):
        raise ValueError('output must not overwrite the source evidence')
    window = boundaries(json.loads(args.report.read_text()), args.first, args.last)
    text, count = select_samples(args.samples.read_text(), window)
    args.output.write_text(text)
    metadata = dict(window, samples=count, sourceReport=str(args.report), sourceSamples=str(args.samples))
    args.output.with_suffix('.window.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata))


if __name__ == '__main__':
    main()
