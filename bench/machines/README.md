# Machine benchmarks

Scripts that measure snowglobe as a machine runtime (restore, commands, compute, memory, density,
the daemon's machines and services) rather than in a browser (that is `bench/run.mjs`). Each is an
Elixir script (`Mix.install` fetches what it needs, once) and prints a table.

| Script | What it measures |
|---|---|
| `capacity.exs` | Firecracker vs `snowglobe run`, the fork server and the daemon (`up`, a service at zero) on one Linux host with KVM: restore to a first command, the next command, a Python loop, N machines at once and the memory they take |
| `instances.exs` | Per site: a one-shot run, a detached start, `sh 'true'`, idle memory, and N instances at once, natively and in Docker |
| `compare-builds.exs` | The same commands on several builds' instances, interleaved round-robin so drift hits all alike: median and spread |
| `fork-jit.exs` | Jobs on a fork server with the JIT profile compiled before forking, and without |
| `fork-check.exs` | Many jobs at once on a fork server, each computing something of its own: every answer must be right |

## Running the Firecracker comparison

`capacity.exs` needs Linux with KVM, Firecracker and a guest for it. On a Mac, a Lima VM with
nested virtualization does (`vmType: vz`, `nestedVirtualization: true`; `sudo chmod 666 /dev/kvm`
after each boot, as the kvm group doesn't reach the Lima shell). In it:

- `--fc DIR`: `firecracker` (from its release), `vmlinux` (Firecracker's CI kernel) and
  `rootfs.ext4` made from the python example's image, with an `/fcinit` that mounts `/proc`,
  `/sys`, `/dev` and `/tmp`, prints `FCREADY`, then runs each console line and prints
  `FCDONE_<status>`.
- `--sg DIR`: linux/arm64 `snowglobe` and `snowglobe-vm`.
- `--site DIR`: the python example built with `--sandbox`; `--wake-site DIR` the same built with
  `--network fetch` too (a service's ports need a network).

```sh
elixir bench/machines/capacity.exs --fc ~/fc --sg ~/sg --site ~/python --wake-site ~/python-net --n 50 --reps 10
```

## Results (2026-11-04)

Apple M5 Pro, a Lima VM (vz, 12 CPUs, 24 GiB, Ubuntu 24.04), the python example, 1 vCPU and
512 MB per machine, snowglobe at 26f221e (armless 0.8.0):

| | Firecracker v1.17.0 | `snowglobe run --runtime native` | fork server (a fork per job) | daemon (`snowglobe up`) |
|---|---:|---:|---:|---:|
| cold boot | 2347 ms | – | – | – |
| restore → first command done | 115 ms | 195 ms | 65 ms | 87 ms |
| a command (`true`) after that | 11 ms | 66 ms | – | 58 ms |
| python loop (3M squares) | 0.081 s | 3.13 s | 3.01 s | 2.99 s |
| a request to a service at zero → its answer | – | – | – | 25 ms |
| 50 at once: all up | 11886 ms | 5598 ms | 157 ms | 846 ms |
| 50 at once: host memory used | 34 MB (~1 MB each) | 2387 MB (47 MB each) | 761 MB (15 MB each) | 852 MB (17 MB each) |
| 50 at once: PSS | 50 MB (1 MB each) | 2318 MB (46 MB each) | 850 MB (17 MB each) | 860 MB (17 MB each) |

Firecracker runs the guest on the hardware (KVM); snowglobe emulates it (armless's JIT), with no
KVM, root or Docker, on Linux and macOS alike. Where that shows: compute (~35×), and the memory a
machine takes besides its guest's own pages: snowglobe-vm's heap, most of what a standalone `snowglobe
run` is left with now that the snapshot's memory is shared (below). The daemon's 50 machines are 50
`snowglobe up` and `snowglobe sh` calls, eight at a time; "all up" for Firecracker includes the
harness starting each process and its API.

On 2026-11-03, at armless 0.7.0 (before the snapshot's memory was shared), a standalone run took
129 MB of host memory each (123 MB PSS) and 295 ms from restore to its first command; the fork
server and the daemon were within a few percent of the numbers above.

### Shared snapshot memory (armless 0.8.0)

Since armless 0.8.0, a standalone run maps its site's snapshot memory from an image in the cache
(made by the first run, read-only and private to the user), copy-on-write, instead of decompressing
the snapshot into memory of its own. Ten `snowglobe run --runtime native` instances of the python
demo, after one command each:

| | before | after |
|---|---:|---:|
| Linux (Lima, 512 MB guests): PSS each | 111 MB | 46 MB |
| macOS: physical footprint each | 175 MB | 96 MB |
| restore (`SNOWGLOBE_TIMING`, macOS) | 60–74 ms | 4–6 ms |
| image on disk, once per snapshot | – | 71 MB (Linux) |

Of what is left on macOS, the guest's own pages are ~14 MB; the rest is snowglobe-vm's heap.
`SNOWGLOBE_RAM_IMAGE=off` restores the old way.
