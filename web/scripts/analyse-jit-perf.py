"""Resolve sampled instruction addresses directly against V8 jitdump records.

Usage: python3 web/scripts/analyse-jit-perf.py PROFILE_DIRECTORY
Input: leaf-samples.txt from perf script --ns -G -F time,pid,tid,ip,period,dso,
plus jit-*.dump recorded with --perf-prof and perf record -k 1. This avoids
materializing millions of tiny ELF files via perf inject. Unresolved leaves
remain in the weighted user-cycle denominator. CODE_MOVE is rejected explicitly.
"""
import bisect, collections, json, mmap, re, struct, sys
from pathlib import Path


def analyse(root):
    root = Path(root)
    samples = []
    by_pid_ip = collections.defaultdict(lambda: collections.defaultdict(list))
    for line in (root / 'leaf-samples.txt').read_text().splitlines():
        m = re.match(r'\s*(\d+)/(\d+)\s+(\d+)\.(\d+):\s+(\d+)\s+([a-f0-9]+)\s+\((.*)\)', line)
        if not m: continue
        pid, tid, sec, frac, period, ip, dso = m.groups()
        s = dict(pid=int(pid), tid=int(tid), time=int(sec)*10**9+int(frac.ljust(9,'0')), period=int(period), ip=int(ip,16), dso=dso, symbol=None, loaded=-1)
        samples.append(s); by_pid_ip[s['pid']][s['ip']].append(s)
    if not samples:
        raise ValueError('no leaf samples parsed; expected perf script --ns -G -F time,pid,tid,ip,period,dso')
    records = collections.Counter()
    for path in root.glob('jit-*.dump'):
        with path.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
            magic, version, header_size, machine, pad, pid, stamp, flags = struct.unpack_from('<IIIIIIQQ', data)
            if magic != 0x4A695444 or version != 1 or flags or header_size < 40 or header_size > len(data):
                raise ValueError('unsupported jitdump header or timestamp clock')
            ips = sorted(by_pid_ip[pid]); offset = header_size
            while offset+16 <= len(data):
                kind, size, timestamp = struct.unpack_from('<IIQ', data, offset)
                if size < 16: raise ValueError('invalid JIT record size')
                if offset+size > len(data):
                    records['truncated_tail'] += 1
                    break
                records[str(kind)] += 1
                if kind == 1: raise ValueError('code moves need explicit handling')
                if kind == 0:
                    if size < 57: raise ValueError('short JIT code load')
                    _, tid, vma, addr, code_size, index = struct.unpack_from('<IIQQQQ', data, offset+16)
                    lo = bisect.bisect_left(ips, addr); hi = bisect.bisect_left(ips, addr+code_size)
                    if hi > lo:
                        end = data.find(b'\0', offset+56, offset+size)
                        if end < 0: raise ValueError('unterminated JIT name')
                        name = data[offset+56:end].decode('utf-8', errors='replace')
                        for ip in ips[lo:hi]:
                            for s in by_pid_ip[pid][ip]:
                                if s['loaded'] <= timestamp <= s['time']:
                                    s['loaded'] = timestamp; s['symbol'] = name
                offset += size
    cycles = collections.Counter(); counts = collections.Counter(); tids = collections.defaultdict(collections.Counter)
    for s in samples:
        name = s['symbol'] or ('unresolved: '+s['dso'])
        cycles[name] += s['period']; counts[name] += 1; tids[s['tid']][name] += s['period']
    total = sum(cycles.values())
    result = dict(samples=len(samples), totalUserCycles=total, records=dict(records), symbols=[dict(symbol=n,percent=100*c/total,cycles=c,samples=counts[n]) for n,c in cycles.most_common()], threads={str(t):dict(c.most_common(10)) for t,c in tids.items()})
    # The legacy threads map contains only ten leaves per thread. Keep complete
    # weights separately so a thread's long tail cannot disappear from attribution.
    result['threadTotals'] = {str(t): dict(cycles=sum(c.values()),
        percent=100 * sum(c.values()) / total,
        omittedCycles=sum(c.values()) - sum(v for _, v in c.most_common(10)))
        for t, c in tids.items()}
    warnings = root / "script.log"
    result["perfScriptWarnings"] = warnings.read_text() if warnings.exists() else None
    return result


if __name__ == "__main__":
    root = Path(sys.argv[1])
    result = analyse(root)
    (root / "jit-leaf-analysis.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Samples", result["samples"], "records", result["records"])
    if result["perfScriptWarnings"]:
        print("perf script diagnostics:", result["perfScriptWarnings"].strip())
    for entry in result["symbols"][:40]:
        print(f"{entry['percent']:6.2f}% {entry['samples']:6} {entry['symbol']}")
