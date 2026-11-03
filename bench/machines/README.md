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

## Results (2026-11-03)

Apple M5 Pro, a Lima VM (vz, 12 CPUs, 24 GiB, Ubuntu 24.04), the python example, 1 vCPU and
512 MB per machine, snowglobe at 3e8a8ba (armless 0.7.0):

| | Firecracker v1.17.0 | `snowglobe run --runtime native` | fork server (a fork per job) | daemon (`snowglobe up`) |
|---|---:|---:|---:|---:|
| cold boot | 2464 ms | – | – | – |
| restore → first command done | 113 ms | 295 ms | 57 ms | 89 ms |
| a command (`true`) after that | 12 ms | 64 ms | – | 60 ms |
| python loop (3M squares) | 0.085 s | 3.13 s | 2.97 s | 3.02 s |
| a request to a service at zero → its answer | – | – | – | 24 ms |
| 50 at once: all up | 8728 ms | 6052 ms | 132 ms | 841 ms |
| 50 at once: host memory used | 40 MB (~1 MB each) | 6450 MB (129 MB each) | 795 MB (15 MB each) | 887 MB (17 MB each) |
| 50 at once: PSS | 50 MB (1 MB each) | 6194 MB (123 MB each) | 900 MB (18 MB each) | 900 MB (18 MB each) |

Firecracker runs the guest on the hardware (KVM); snowglobe emulates it (armless's JIT), with no
KVM, root or Docker, on Linux and macOS alike. Where that shows: compute (~35×), and the memory of
a standalone `snowglobe run` (its restored memory is a private copy; machines forked from a
template share theirs). The daemon's 50 machines are 50 `snowglobe up` and `snowglobe sh` calls,
eight at a time; "all up" for Firecracker includes the harness starting each process and its API.
