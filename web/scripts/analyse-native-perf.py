#!/usr/bin/env python3
"""Resolve native leaves without generating millions of ELF files for V8 JIT loads.

Export samples using perf script --ns -G -F time,pid,tid,ip,period,dso,dsoff.
Supply a perf buildid-list file and --elf /recorded/dso=/matching/debug/elf.
All leaves remain in the denominator, including unresolved JIT addresses.
"""
import argparse
import collections
import json
import os
import re
import subprocess
from pathlib import Path


def parse_leaves(text):
    samples = []
    pattern = re.compile(r"\s*(\d+)/(\d+)\s+(\d+\.\d+):\s+(\d+)\s+([a-f0-9]+)\s+\((.*)\)")
    for line in text.splitlines():
        if not line.strip():
            continue
        match = pattern.fullmatch(line)
        if not match:
            raise ValueError(f"Unrecognized perf leaf: {line[:160]}")
        pid, tid, timestamp, weight, ip, mapping = match.groups()
        offset_match = re.fullmatch(r"(.*)\+0x([a-f0-9]+)", mapping)
        dso, offset = (offset_match[1], int(offset_match[2], 16)) if offset_match else (mapping, None)
        samples.append(dict(pid=int(pid), tid=int(tid), time=timestamp,
                            cycles=int(weight), ip=int(ip, 16), dso=dso, offset=offset))
    return samples


def check_build_id(dso, elf, recorded):
    notes = subprocess.check_output([os.environ.get("READELF", "readelf"), "-n", str(elf)], text=True)
    match = re.search(r"Build ID: ([a-f0-9]+)", notes)
    if not match or recorded.get(dso) != match[1]:
        raise ValueError(f"Debug ELF build ID does not match recording: {dso}: {elf}")


def load_segments(binary):
    headers = subprocess.check_output([os.environ.get("READELF", "readelf"), "-lW", str(binary)], text=True)
    segments = []
    for line in headers.splitlines():
        fields = line.split()
        if fields and fields[0] == "LOAD":
            segments.append(tuple(int(fields[i], 16) for i in (1, 2, 4)))
    return segments


def virtual_address(offset, segments):
    for file_offset, address, size in segments:
        if file_offset <= offset < file_offset + size:
            return address + offset - file_offset
    raise ValueError(f"Sample offset {offset:x} is outside ELF load segments")


def resolve_offsets(elf, offsets, segments):
    offsets = sorted(set(offsets))
    if not offsets:
        return {}
    result = subprocess.run(["addr2line", "-f", "-C", "-e", str(elf)],
                            input="".join(f"{virtual_address(offset, segments):x}\n" for offset in offsets),
                            text=True, capture_output=True, check=True)
    lines = result.stdout.splitlines()
    if len(lines) != 2 * len(offsets):
        raise ValueError("Unexpected addr2line output length")
    return {offset: lines[2 * i] for i, offset in enumerate(offsets) if lines[2 * i] != "??"}


def summarize(samples, symbols):
    weights = collections.Counter()
    counts = collections.Counter()
    resolved = 0
    threads = collections.defaultdict(collections.Counter)
    for sample in samples:
        symbol = symbols.get(sample["dso"], {}).get(sample["offset"])
        if symbol:
            resolved += sample["cycles"]
        name = f'{sample["dso"]}: {symbol}' if symbol else f'unresolved: {sample["dso"]}'
        threads[str(sample["tid"])][name] += sample["cycles"]
        weights[name] += sample["cycles"]
        counts[name] += 1
    total = sum(weights.values())
    return dict(samples=len(samples), totalUserCycles=total,
                resolvedNativePercent=100 * resolved / total if total else None,
                threads={tid: dict(cycles=sum(values.values()),
                    percent=100 * sum(values.values()) / total if total else None,
                    symbols=[dict(symbol=name, cycles=weight,
                                  percent=100 * weight / total if total else None)
                             for name, weight in values.most_common(20)])
                         for tid, values in threads.items()},
                symbols=[dict(symbol=name, cycles=weight, samples=counts[name],
                              percent=100 * weight / total if total else None)
                         for name, weight in weights.most_common()])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path)
    parser.add_argument("buildids", type=Path)
    parser.add_argument("--elf", action="append", default=[], metavar="DSO=DEBUG_ELF")
    parser.add_argument("--binary", action="append", default=[], metavar="DSO=ORIGINAL_ELF")
    args = parser.parse_args()
    recorded = {}
    for line in args.buildids.read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]+)\s+(.+)", line)
        if match:
            recorded[match[2]] = match[1]
    samples = parse_leaves(args.samples.read_text())
    symbols = {}
    binaries = dict(mapping.split("=", 1) for mapping in args.binary)
    for mapping in args.elf:
        dso, elf = mapping.split("=", 1)
        check_build_id(dso, elf, recorded)
        binary = binaries.get(dso, dso)
        check_build_id(dso, binary, recorded)
        symbols[dso] = resolve_offsets(elf, [s["offset"] for s in samples
                                           if s["dso"] == dso and s["offset"] is not None],
                                       load_segments(binary))
    print(json.dumps(summarize(samples, symbols), indent=2))


if __name__ == "__main__":
    main()
