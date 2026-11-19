# Recompiler fork checkouts

`forks.lock.json` records the upstream repositories and exact commits used for
integration studies. Release builds consume the repositories directly through
`RPCS3_RECOMP_FORKS_DIR`; they are development inputs and are not vendored.

Use:

```sh
node web/scripts/sync-recomp-forks.mjs
node web/scripts/sync-recomp-forks.mjs --check
```

Set `RPCS3_RECOMP_FORKS_DIR` or pass `--root=PATH` to keep the checkouts outside
the source tree.
