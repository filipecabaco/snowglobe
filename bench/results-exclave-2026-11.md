# Toolkit jobs: BASELINE vs NEW (vs OLD), and exclave on a real daemon (2026-11-16)

## Builds compared

| | snowglobe | armless | tools image | guest kernel |
|---|---|---|---|---|
| OLD | local `main` aaa95da (0.11.0 + 5), worktree `snowglobe-old`, CLI built from source | v0.12.0 (tag) | `snowglobe-tools:ee708ee61284f58b`, built locally | release 0.19.0 boot archive (`SNOWGLOBE_BOOT`; kernel.Dockerfile is identical at aaa95da and 766f0b2) |
| BASELINE | origin/main 766f0b2 = tag v0.19.0 (worktree `snowglobe-base`); the **release binaries** v0.19.0 linux/arm64 (SHA256SUMS verified) | v0.20.0 (tag) | `ghcr.io/filipecabaco/snowglobe-tools:6bd920e6011213d0` (pulled) | release 0.19.0 |
| NEW | `snowglobe-wt` (766f0b2 + uncommitted limits/contract work), CLI built from source | `armless-wt` (origin/main 7631138, armless-v0.20.0+1, + uncommitted fs write budget / egress ports), via the Cargo `[patch]` | `snowglobe-tools:b18a8ef878b2309c`, built by hand (context: `internal/tools` + `armless-wt` copied to `runtime/armless-wt`, patch path rewritten to `armless-wt`; tag = `tools.Version()` of the tree) | built from the new kernel.Dockerfile (cgroup v2), `built-9f288d056de91d72` |
| NEW-oldkernel (diagnostic) | NEW | NEW | NEW | release 0.19.0 (no cgroups) |

All sites: `examples/toolkit` (alpine 3.24.2, 768 MB, 1 CPU, JIT on — the default; no ARMLESS_JIT_* set). Each
variant has its own cache (`XDG_CACHE_HOME=~/cache-<v>`), so no JIT profiles, RAM images or runtimes are shared.

## Host

Apple M5 Pro, 48 GB, macOS 26.7.3; Lima 2.2.1 VM `snowglobe-fc` (vz, aarch64, 12 vCPUs, 24 GiB),
Ubuntu 24.04.5, kernel 6.8.0-149-generic, cgroup v2, Docker 29.1.3. No cpufreq governor exposed in the
guest. Nothing else ran during the measurements (exclave's Postgres/S3 containers and daemon stopped; started
again only for the exclave e2e numbers, measured last).

## Method

`bench/machines/toolkit-jobs.exs` (new; Elixir, as the rest of `bench/machines`). Per variant:

- **One-shot**: `snowglobe bundle` of the `--sandbox` site; each run is
  `docker run --rm --user 1000:1000 --cap-drop ALL --network none` (default seccomp) `alpine:3.24.2
  /usr/bin/time -v /toolkit --workspace /job --cmd …`; wall and max RSS from busybox `time -v`
  (**10 ms resolution**). A persistent cache volume per variant (JIT profiles), one warm-up run first.
  Workloads: `true`; the README's jq lines (`echo "$EXCLAVE_ASSIGNS" | jq .n; uname -m; date > out/when`);
  `steps/report/main.sh` over a 3-invoice `invoices.json`; `tesseract page.png --psm 6` on one 150 dpi
  invoice page (rendered by the workflow's fixtures+rasterize steps). Native tesseract: same container
  flags, `alpine:3.24.2 + tesseract-ocr` (`OMP_THREAD_LIMIT=1` both).
- **Served**: the bundle's `--serve SOCK --jobs-root DIR`, natively in the VM; clients are the bundle's
  `--server` (so client start-up is in the latency). Server RSS/PSS 2 s after restore; a job's own memory =
  USS (Private_Clean+Private_Dirty) of the forked child while it runs; 10/50 = wall for that many clients at once.
- **Daemon**: `snowglobe daemon --memory 16G`, `template add` of the `--sandbox --network fetch` site;
  `POST /v1/templates/bench-tk/jobs` over the Unix socket (Req). c10/c50 = wall of N at once, plus the median
  job latency within the burst. PSS = daemon + its process tree, idle, and the peak sampled every 100 ms during c50.
- Two passes (base→old→new, then new→old→base), 5 reps each → **n=10 per number** (OLD: one-shot/served n=5
  from pass 2 — pass 1 crashed on OLD's `daemon --detach` before writing, fixed by making the daemon dir first;
  its pass-1 one-shot/served are in the log below). Median [min–max].

Commands (in the VM):

```sh
# tools image (NEW)
mkdir -p ~/toolsctx-new/runtime && cp internal/tools/Dockerfile ~/toolsctx-new/ && \
  cp -r internal/tools/runtime/{Cargo.toml,Cargo.lock,src} ~/toolsctx-new/runtime/ && \
  cp -r ~/new/armless-wt ~/toolsctx-new/runtime/armless-wt && \
  sed -i 's#\.\./\.\./\.\./\.\./armless-wt#armless-wt#g' ~/toolsctx-new/runtime/Cargo.toml && \
  docker build -t snowglobe-tools:b18a8ef878b2309c ~/toolsctx-new
# sites, per variant v in base|old|new (OLD with SNOWGLOBE_BOOT=~/rel/snowglobe-boot_0.19.0_arm64.tar.gz)
XDG_CACHE_HOME=~/cache-$v $BIN/snowglobe build examples/toolkit --sandbox --out ~/sites/$v-toolkit
XDG_CACHE_HOME=~/cache-$v $BIN/snowglobe build examples/toolkit --sandbox --network fetch --out ~/sites/$v-toolkit-net
XDG_CACHE_HOME=~/cache-$v $BIN/snowglobe bundle ~/sites/$v-toolkit -o ~/sites/$v-toolkit.bin
# measurements
elixir bench/machines/toolkit-jobs.exs --variant $v --bundle ~/sites/$v-toolkit.bin --sg ~/bin-$v \
  --site-net ~/sites/$v-toolkit-net --cache ~/cache-$v --fixtures ~/fixtures --reps 5 \
  --sections oneshot,native,served,daemon[,limits,build --py-site ~/sites/new-python] --out results/$v-passN.json
```

## Results

### One-shot (container), wall / peak RSS

| Job | README (0.3-era, n=3) | OLD (pass 2) | BASELINE | NEW | NEW-oldkernel (n=5) |
|---|---:|---:|---:|---:|---:|
| restore, `true` | 0.30 s / 118 MB | 90 ms / 46 MB | 60 [50–250] ms / 42 MB† | 90 [80–90] ms / 45 MB | 50 ms / 32 MB |
| jq lines | 0.42 s / 122 MB | 170 ms / 51 MB | 130 [130–140] / 46† | 160 [160–170] / 48 | 130 / 39 |
| jq + sqlite report | 0.47 s / 131 MB | 210 ms / 64 MB | 170 [160–190] / 52† | 200 [190–210] / 54 | 140 / 45 |
| tesseract, one page | 5.2 s / 345 MB | 4.16 s / 222 MB | 4.22 [4.03–4.30] s / 164 MB | 4.32 [4.24–4.41] s / 166 MB | 3.58 s / 163 MB |
| native tesseract | 0.13 s | 0.18 s / 82 MB | 0.18 / 82 | 0.18 / 82 | – |

† BASELINE's peak rose from 31→42 MB (empty) between pass 1 and pass 2 as its JIT profile cache grew; pass-2
values shown (all variants' pass 2 are steady-state). Emulated/native tesseract ≈ 23–24× (README: 40×).

### Served (`--serve`)

| | README | OLD | BASELINE | NEW | NEW-oldkernel |
|---|---:|---:|---:|---:|---:|
| server RSS after restore | 92 MB | 18.1 MB | 17.1–17.5 | 18.3–18.4 | 17.2 |
| a running job, of its own (USS) | 13 MB | 29.6 | 24.8 [24.6–24.9] | 25.2 [25.2–25.2] | 24.4 |
| empty job | 0.10 s | 66 ms | 41 [40–45] | 70 [62–73] | 43 |
| jq + sqlite report | 0.26 s | 184 | 149 [133–156] | 248 [232–260] | 182 |
| ten empty jobs at once | 0.27 s | 115 | 92 [68–256] | 107 [100–281] | 88 |
| fifty at once (24 run, the rest queue: `--max-jobs` = 2×CPUs) | – | 440 | 415 [302–457] | 416 [362–427] | 391 |

### Daemon template jobs (`POST /v1/templates/{name}/jobs`)

| | OLD (n=10) | BASELINE | NEW | NEW + limits |
|---|---:|---:|---:|---:|
| empty job | 59 [57–72] | 61 [51–66] | 62 [58–65] | 111 [104–118] |
| jq + sqlite | 162 [159–222] | 172 [141–179] | 174 [169–184] | 242 [227–255] |
| 10 at once: wall / job median | 81 / 77 | 85 / 80 | 82 / 76 | 212 / 169 |
| 50 at once: wall / job median | 343 / 246 | 320 / 223 | 309 / 211 | 819 / 565 |
| PSS idle: daemon + template servers | 16 + 41 = 57 MB | 18 + 34 = 52 | 17 + 48 = 65 | 39–106 + 48 (daemon grows after the limits bursts) |
| PSS peak during 50 at once | 250 [120–352] | 226 [126–285] | 187 [115–249] | 265 [141–314] |

(The idle row has two template servers for NEW: bench-tk and bench-py.)

**Limits, one at a time** (NEW, empty job, median of 11 [min–max], ms): none 54.2 [52.6–58.7];
`memory_limit_mb` 77.7 [73.5–85.7]; `cpus_limit` 79.1 [73.7–85.4]; `pids_limit` 77.2 [73.6–82.7];
`disk_limit_mb` 52.8; `max_rss_mb` 54.5; `output_limit` 52.4; `copy_limit_mb` 53.3; `egress:none` 52.2.

### Build as snapshot (NEW, python+uv site, `uv pip install six==1.16.0` from PyPI), n=10

machine up 2.4 ms [2.0–3.3]; build job 3459 [3349–3707] ms (network fetch included); snapshot 114 [109–197] ms;
template from snapshot 758 [405–965] ms; total 4334 [3869–4754] ms; first run forked from it 345 [320–403] ms,
second 352 [313–403]; snapshot 16.6 MB.

### exclave end to end (NEW daemon, jq project `jq` + `uname`, n=21, interleaved)

raw daemon job, no limits 113.9 [111.7–138.2] ms; raw with the exact limit fields exclave sends 160.9
[153.5–196.0]; `Exclave.Scripting.execute/5` 162.0 [152.1–237.0]. exclave's own overhead ≈ 1 ms; the
limits ≈ 47 ms.

## Notes

- **NEW's cgroup kernel is the whole one-shot/served regression.** `SNOWGLOBE_TIMING=1` on `true`: BASELINE
  job 34 ms, JIT 89–107 modules/132–152 KB; NEW 52–57 ms, 58–65 modules/256–284 KB code for the same ~97M
  instructions; NEW runtime on the old kernel: 33–34 ms, 95–102 modules/144–161 KB — and its whole table
  matches or beats BASELINE. `CONFIG_MEMCG`/`CGROUP_SCHED`/`FAIR_GROUP_SCHED`/`CFS_BANDWIDTH` put more kernel
  code on every fork/exec/page-fault path; the guest pays it emulated. Candidates: `cgroup.memory=nokmem`,
  dropping `FAIR_GROUP_SCHED`+`CFS_BANDWIDTH` (cpus_limit), or a second kernel only for sites that need limits.
- **The guest limits cost ~23 ms each** (memory/cpu/pids), ~55 ms together, and 2.6× on 50-at-once: the job
  launcher (`internal/tools/runtime/src/job.rs:285-296`) forks `grep` twice per controller and adds a
  `sh -c` hop to join the cgroup. Builtins (`read` the controller files, one `+memory +cpu +pids` write) and
  joining in the launcher's own shell would remove most of it. Host-side limits are free.
- The daemon's own PSS grows after limit-heavy bursts (39→106 MB idle after pass 2), not seen without limits.
- Daemon jobs NEW ≈ BASELINE ≈ OLD within noise; OLD→BASELINE improved one-shot (−30 ms, −10 MB),
  served (−25 ms) and tesseract memory (222→164 MB).
- Served 50-at-once: the server runs 24 at once (`--max-jobs` default 2×CPUs), so it's partly queued.

## Raw numbers

### base-pass1
native.tesseract_native.wall_ms: 170.0 180.0 170.0 170.0 170.0
native.tesseract_native.peak_rss_mb: 81.6 81.4 81.5 81.8 81.8
oneshot.empty.wall_ms: 50.0 50.0 50.0 60.0 250.0
oneshot.empty.peak_rss_mb: 31.4 31.5 31.4 32.1 32.9
oneshot.jq_lines.wall_ms: 130.0 130.0 130.0 130.0 130.0
oneshot.jq_lines.peak_rss_mb: 38.5 38.2 37.9 38.4 38.6
oneshot.report.wall_ms: 160.0 170.0 160.0 170.0 170.0
oneshot.report.peak_rss_mb: 46.6 46.9 45.9 44.6 44.9
oneshot.tesseract.wall_ms: 4240.0 4030.0 4030.0 4260.0 4190.0
oneshot.tesseract.peak_rss_mb: 163.5 164.5 163.2 163.2 164.1
served.job_own_uss_mb: 24.6 24.7 24.7 24.7 24.7
served.job_pss_mb: 31.4 31.5 31.6 31.5 31.6
served.empty_ms: 41.9 40.7 41.4 41.8 41.2
served.report_ms: 148.8 154.3 155.5 145.7 148.5
served.ten_at_once_ms: 99.9 256.1 96.0 92.1 106.1
served.fifty_at_once_ms: 450.7 457.3 414.7 433.6 428.3
daemon.empty_ms: 62.7 63.0 61.4 66.4 62.2
daemon.report_ms: 171.8 174.7 179.4 174.1 174.0
daemon.c10_wall_ms: 90.4 85.4 92.2 86.0 90.7
daemon.c10_job_median_ms: 85.3 79.7 84.8 82.3 80.7
daemon.c50_wall_ms: 325.7 336.4 320.4 341.4 335.3
daemon.c50_job_median_ms: 230.1 247.9 222.8 246.5 226.2
daemon.c50_peak_total_pss_mb: 150.4 125.7 226.9 272.3 285.3
served.server_rss_mb=17.1, served.server_pss_mb=16.8, daemon.idle_pss.processes=4, daemon.idle_pss.daemon_pss_mb=18.6, daemon.idle_pss.servers_and_jobs_pss_mb=33.9, daemon.idle_pss.total_pss_mb=52.4
### base-pass2
native.tesseract_native.wall_ms: 190.0 180.0 180.0 180.0 180.0
native.tesseract_native.peak_rss_mb: 81.8 81.6 81.8 81.6 81.5
oneshot.empty.wall_ms: 60.0 60.0 60.0 70.0 60.0
oneshot.empty.peak_rss_mb: 41.8 42.3 41.8 41.9 42.1
oneshot.jq_lines.wall_ms: 140.0 140.0 130.0 130.0 140.0
oneshot.jq_lines.peak_rss_mb: 45.8 45.9 45.8 46.3 45.8
oneshot.report.wall_ms: 170.0 170.0 170.0 190.0 170.0
oneshot.report.peak_rss_mb: 52.3 52.7 52.5 52.4 52.6
oneshot.tesseract.wall_ms: 4210.0 4220.0 4220.0 4.3E+3 4.3E+3
oneshot.tesseract.peak_rss_mb: 163.2 163.2 164.3 164.5 164.2
served.job_own_uss_mb: 24.8 24.9 24.9 24.9 24.9
served.job_pss_mb: 31.7 31.8 31.7 31.8 31.7
served.empty_ms: 42.0 45.1 39.8 40.6 40.0
served.report_ms: 149.6 147.1 150.3 133.2 140.1
served.ten_at_once_ms: 72.6 74.7 70.4 72.1 68.0
served.fifty_at_once_ms: 302.0 303.3 332.5 330.7 311.1
daemon.empty_ms: 52.7 52.3 51.3 52.9 51.8
daemon.report_ms: 140.6 148.3 144.1 143.6 145.0
daemon.c10_wall_ms: 73.7 68.5 68.5 68.9 66.7
daemon.c10_job_median_ms: 69.3 65.1 65.6 66.6 65.1
daemon.c50_wall_ms: 251.4 248.2 237.7 257.3 252.1
daemon.c50_job_median_ms: 168.7 171.1 168.5 179.5 171.5
daemon.c50_peak_total_pss_mb: 125.8 226.4 143.0 243.4 176.4
served.server_rss_mb=17.5, served.server_pss_mb=17.1, daemon.idle_pss.processes=4, daemon.idle_pss.daemon_pss_mb=17.8, daemon.idle_pss.servers_and_jobs_pss_mb=34.0, daemon.idle_pss.total_pss_mb=51.8
### old-pass2
native.tesseract_native.wall_ms: 190.0 180.0 190.0 180.0 180.0
native.tesseract_native.peak_rss_mb: 81.5 81.6 81.5 81.3 81.8
oneshot.empty.wall_ms: 90.0 90.0 90.0 90.0 90.0
oneshot.empty.peak_rss_mb: 46.4 46.2 46.5 46.1 46.6
oneshot.jq_lines.wall_ms: 170.0 160.0 170.0 160.0 170.0
oneshot.jq_lines.peak_rss_mb: 51.4 51.4 51.3 51.5 51.5
oneshot.report.wall_ms: 200.0 210.0 210.0 210.0 210.0
oneshot.report.peak_rss_mb: 63.9 63.8 63.8 64.0 64.0
oneshot.tesseract.wall_ms: 4120.0 4180.0 4160.0 4210.0 4160.0
oneshot.tesseract.peak_rss_mb: 221.3 222.4 221.5 221.9 221.7
served.job_own_uss_mb: 29.6 29.6 29.7 29.6 29.6
served.job_pss_mb: 36.7 36.7 36.8 36.7 36.7
served.empty_ms: 69.4 65.6 66.4 65.9 67.3
served.report_ms: 189.1 184.0 182.9 187.9 181.2
served.ten_at_once_ms: 114.8 119.4 113.1 109.6 115.1
served.fifty_at_once_ms: 440.4 443.0 446.0 418.9 424.4
daemon.empty_ms: 70.3 69.2 69.8 70.3 71.7
daemon.report_ms: 197.8 200.4 190.8 190.8 221.7
daemon.c10_wall_ms: 110.3 98.0 104.2 103.8 96.8
daemon.c10_job_median_ms: 97.5 92.7 92.1 86.4 94.6
daemon.c50_wall_ms: 406.7 409.9 416.3 416.3 421.0
daemon.c50_job_median_ms: 297.0 266.4 283.4 296.9 321.8
daemon.c50_peak_total_pss_mb: 214.7 119.6 247.1 308.8 249.7
served.server_rss_mb=18.1, served.server_pss_mb=17.7, daemon.idle_pss.processes=4, daemon.idle_pss.daemon_pss_mb=17.1, daemon.idle_pss.servers_and_jobs_pss_mb=41.5, daemon.idle_pss.total_pss_mb=58.6
### old-pass1-daemon
daemon.empty_ms: 59.1 59.1 57.9 58.5 57.2
daemon.report_ms: 160.1 161.9 159.3 162.1 166.8
daemon.c10_wall_ms: 87.1 79.4 78.9 81.1 77.7
daemon.c10_job_median_ms: 76.5 74.1 77.3 75.3 75.0
daemon.c50_wall_ms: 342.6 322.9 547.5 342.5 325.3
daemon.c50_job_median_ms: 234.3 227.8 246.1 249.2 244.3
daemon.c50_peak_total_pss_mb: 212.4 138.3 261.6 310.4 351.8
daemon.idle_pss.processes=4, daemon.idle_pss.daemon_pss_mb=15.8, daemon.idle_pss.servers_and_jobs_pss_mb=41.3, daemon.idle_pss.total_pss_mb=57.1
### new-pass1
native.tesseract_native.wall_ms: 190.0 190.0 180.0 180.0 190.0
native.tesseract_native.peak_rss_mb: 81.8 81.4 81.5 81.3 81.5
build.up_ms: 2.4 2.2 2.0 2.0 3.3
build.build_job_ms: 3706.9 3636.4 3402.0 3509.4 3349.2
build.snapshot_ms: 118.2 113.6 113.0 143.3 111.2
build.template_ms: 506.1 709.6 758.2 808.9 404.9
build.total_ms: 4333.6 4461.8 4275.2 4463.6 3868.6
build.first_run_ms: 403.3 345.0 329.9 319.9 351.8
build.second_run_ms: 403.3 338.5 366.5 327.4 364.7
build.snapshot_mb: 16.6 16.6 16.6 16.6 16.6
oneshot.empty.wall_ms: 90.0 90.0 90.0 90.0 90.0
oneshot.empty.peak_rss_mb: 45.1 45.1 44.8 45.1 44.6
oneshot.jq_lines.wall_ms: 170.0 170.0 170.0 160.0 170.0
oneshot.jq_lines.peak_rss_mb: 47.4 47.5 47.4 47.4 47.6
oneshot.report.wall_ms: 200.0 200.0 200.0 210.0 200.0
oneshot.report.peak_rss_mb: 53.6 53.9 53.9 53.9 53.9
oneshot.tesseract.wall_ms: 4250.0 4330.0 4310.0 4320.0 4380.0
oneshot.tesseract.peak_rss_mb: 169.9 165.6 165.1 164.7 164.3
served.job_own_uss_mb: 25.2 25.2 25.2 25.2 25.2
served.job_pss_mb: 32.7 32.6 32.6 32.6 32.6
served.empty_ms: 73.4 71.7 70.8 69.5 72.0
served.report_ms: 247.6 252.8 255.5 258.6 260.3
served.ten_at_once_ms: 113.5 107.1 107.0 114.0 115.6
served.fifty_at_once_ms: 415.5 421.0 427.4 418.9 415.5
daemon.empty_ms: 62.4 62.7 63.5 63.4 65.2
daemon.report_ms: 178.1 177.5 183.5 174.2 172.8
daemon.c10_wall_ms: 92.0 79.8 86.0 82.4 82.2
daemon.c10_job_median_ms: 76.4 78.3 80.9 76.4 76.4
daemon.c50_wall_ms: 309.7 310.4 316.2 313.6 308.9
daemon.c50_job_median_ms: 195.1 212.3 223.2 211.1 216.0
daemon.c50_peak_total_pss_mb: 228.6 169.6 236.4 114.9 163.6
daemon_limits.empty_ms: 115.8 110.8 107.6 114.6 118.3
daemon_limits.report_ms: 241.2 242.3 240.3 245.0 247.7
daemon_limits.c10_wall_ms: 218.8 179.4 217.1 218.2 199.4
daemon_limits.c10_job_median_ms: 174.1 159.3 170.6 169.6 167.1
daemon_limits.c50_wall_ms: 820.7 806.1 829.4 818.8 828.6
daemon_limits.c50_job_median_ms: 565.1 527.8 573.6 575.5 580.4
daemon_limits.c50_peak_total_pss_mb: 314.2 213.1 210.0 150.0 200.4
served.server_rss_mb=18.3, served.server_pss_mb=17.9, daemon.idle_pss.processes=5, daemon.idle_pss.daemon_pss_mb=17.7, daemon.idle_pss.servers_and_jobs_pss_mb=47.3, daemon.idle_pss.total_pss_mb=65.0, daemon_limits.idle_pss.processes=5, daemon_limits.idle_pss.daemon_pss_mb=38.6, daemon_limits.idle_pss.servers_and_jobs_pss_mb=48.1, daemon_limits.idle_pss.total_pss_mb=86.7
### new-pass2
native.tesseract_native.wall_ms: 180.0 180.0 180.0 180.0 170.0
native.tesseract_native.peak_rss_mb: 81.4 81.6 81.8 81.8 81.6
build.up_ms: 3.1 2.2 3.0 2.4 2.3
build.build_job_ms: 3458.7 3349.4 3589.3 3360.4 3354.2
build.snapshot_ms: 110.5 114.1 196.5 108.8 109.1
build.template_ms: 807.7 862.7 965.2 404.7 509.1
build.total_ms: 4380.0 4328.4 4754.0 3876.3 3974.7
build.first_run_ms: 344.1 324.2 329.6 359.6 359.8
build.second_run_ms: 312.7 315.5 312.9 364.1 352.0
build.snapshot_mb: 16.6 16.6 16.6 16.6 16.6
oneshot.empty.wall_ms: 80.0 80.0 80.0 80.0 80.0
oneshot.empty.peak_rss_mb: 45.1 45.2 45.3 45.1 45.3
oneshot.jq_lines.wall_ms: 160.0 160.0 160.0 160.0 160.0
oneshot.jq_lines.peak_rss_mb: 47.7 47.7 47.7 47.7 47.6
oneshot.report.wall_ms: 200.0 190.0 200.0 190.0 200.0
oneshot.report.peak_rss_mb: 53.9 53.8 54.1 54.2 54.1
oneshot.tesseract.wall_ms: 4410.0 4340.0 4310.0 4280.0 4240.0
oneshot.tesseract.peak_rss_mb: 169.8 169.7 165.8 164.6 165.6
served.job_own_uss_mb: 25.2 25.2 25.2 25.2 25.2
served.job_pss_mb: 32.6 32.6 32.6 32.6 32.6
served.empty_ms: 62.3 65.9 67.4 66.5 67.4
served.report_ms: 233.2 232.0 234.0 237.1 236.9
served.ten_at_once_ms: 104.1 103.0 99.6 280.7 106.5
served.fifty_at_once_ms: 376.9 375.2 361.5 380.5 383.6
daemon.empty_ms: 61.2 61.4 60.5 57.8 59.8
daemon.report_ms: 171.8 171.1 169.0 171.4 175.2
daemon.c10_wall_ms: 87.3 78.3 79.8 81.1 79.0
daemon.c10_job_median_ms: 78.1 75.2 76.7 76.2 75.9
daemon.c50_wall_ms: 292.1 290.4 306.8 295.1 288.5
daemon.c50_job_median_ms: 192.4 194.4 212.6 202.3 199.5
daemon.c50_peak_total_pss_mb: 136.3 187.1 242.3 144.9 248.9
daemon_limits.empty_ms: 111.7 108.7 110.4 103.8 104.7
daemon_limits.report_ms: 227.4 233.3 243.6 254.7 237.3
daemon_limits.c10_wall_ms: 207.7 208.2 211.6 206.7 222.7
daemon_limits.c10_job_median_ms: 162.7 156.8 168.8 178.2 162.3
daemon_limits.c50_wall_ms: 750.2 784.1 821.5 779.0 751.3
daemon_limits.c50_job_median_ms: 507.9 508.8 584.4 561.2 508.9
daemon_limits.c50_peak_total_pss_mb: 265.1 141.2 294.1 295.9 279.9
served.server_rss_mb=18.4, served.server_pss_mb=17.9, daemon.idle_pss.processes=5, daemon.idle_pss.daemon_pss_mb=16.3, daemon.idle_pss.servers_and_jobs_pss_mb=48.1, daemon.idle_pss.total_pss_mb=64.3, daemon_limits.idle_pss.processes=5, daemon_limits.idle_pss.daemon_pss_mb=106.3, daemon_limits.idle_pss.servers_and_jobs_pss_mb=48.9, daemon_limits.idle_pss.total_pss_mb=155.2
### newk-oldkernel
oneshot.empty.wall_ms: 50.0 50.0 50.0 50.0 50.0
oneshot.empty.peak_rss_mb: 31.4 31.7 31.6 31.7 31.8
oneshot.jq_lines.wall_ms: 120.0 130.0 130.0 140.0 110.0
oneshot.jq_lines.peak_rss_mb: 38.2 38.9 39.1 38.5 39.2
oneshot.report.wall_ms: 140.0 140.0 140.0 150.0 180.0
oneshot.report.peak_rss_mb: 45.6 44.5 44.5 44.6 44.6
oneshot.tesseract.wall_ms: 3560.0 3580.0 3580.0 3660.0 4040.0
oneshot.tesseract.peak_rss_mb: 162.9 162.9 164.3 163.0 163.2
served.job_own_uss_mb: 24.4 24.3 24.4 24.4 24.3
served.job_pss_mb: 31.2 31.2 31.3 31.3 31.2
served.empty_ms: 44.0 45.4 42.8 42.7 43.1
served.report_ms: 178.3 381.3 182.0 180.6 188.0
served.ten_at_once_ms: 87.5 92.8 84.7 82.6 92.2
served.fifty_at_once_ms: 378.4 391.8 401.0 386.0 390.5
served.server_rss_mb=17.2, served.server_pss_mb=16.9

### old-pass1 (log only)
== old: oneshot,native,served,daemon, 5 reps
  oneshot empty: [80.0, 80.0, 80.0, 80.0, 80.0] ms, peak [37.4, 37.9, 37.9, 37.1, 37.9] MB
  oneshot jq_lines: [160.0, 150.0, 150.0, 150.0, 150.0] ms, peak [45.1, 44.8, 45.2, 45.0, 44.7] MB
  oneshot report: [190.0, 200.0, 200.0, 200.0, 190.0] ms, peak [55.4, 55.2, 55.3, 55.3, 55.5] MB
  oneshot tesseract: [4360.0, 3910.0, 3860.0, 4160.0, 4330.0] ms, peak [221.6, 222.1, 222.1, 222.2, 221.7] MB
  served: %{server_rss_mb: 17.8, server_pss_mb: 17.4, job_own_uss_mb: 29.6, job_pss_mb: 36.6, empty_ms: 71.2, report_ms: 196.1, ten_at_once_ms: 119.3, fifty_at_once_ms: 503.0}

### limits one at a time / exclave e2e
see the tables above (raw lists: limits loop printed median [min-max] only; exclave e2e raw arrays below)
raw_no_limits_ms: 116.2 111.9 112.1 111.8 113.6 113.9 114.4 114.6 112.4 112.4 120.6 111.7 112.1 118.2 113.9 128.9 116.7 132.2 126.5 113.6 138.2
raw_exclave_limits_ms: 156.0 161.6 156.5 154.1 156.0 160.9 165.8 156.0 153.5 161.0 164.5 156.2 157.6 157.4 169.0 176.7 165.2 158.4 166.4 170.6 196.0
exclave_execute_ms: 154.7 156.8 162.7 154.6 156.7 152.1 154.4 164.6 155.5 156.4 158.5 162.6 156.9 162.8 163.7 175.5 173.0 172.6 162.0 237.0 208.4

# After fixes (2026-11-17)

Same host, VM, method and script (`bench/machines/toolkit-jobs.exs`, now with `limits_each` and
`burst500` sections), nothing else running; two passes in opposite order (base → new → newmem, then
newmem → new → base), 5 reps each, **n=10**, median [min–max]. BASELINE is as above (release v0.19.0,
its own cache, which has kept learning JIT profiles since 2026-11-16). NEW is `snowglobe-wt` +
`armless-wt` as of this section (CLI and tools image built from the tree, `~/mktools.sh` in the VM;
kernel from the new `kernel.Dockerfile`, `built-86bee5a31d3c8f38`):

- **NEW** — `examples/toolkit --sandbox`: no memory cgroup (the default), one-shot and served.
- **NEW-mem** — the same `--memory-limits`: what exclave's toolkit templates are built with.
- Daemon rows use NEW's `--sandbox --network fetch --memory-limits` site (exclave's template).
  The daemon/limits rows were re-run once more after the daemon memory fix (`newd`, two passes).

## What the regressions were

**1. The "cgroup kernel" regression was not the kernel.** The same kernel image (byte-identical,
`52a5ce0b…`) built into six sites gave six sites that were either fast (`true` 33 ms, ~130 KB JIT) or
slow (52 ms, ~250 KB), at random, and the old no-cgroup kernel did exactly the same (k0: 1 slow, 3
fast). A per-job phase timer (`SNOWGLOBE_TIMING`: line typed → echoed → launcher asks for its nonce
→ marker) put the whole difference before the launcher starts, and a guest PC sampler showed the CPU
**idle** for it: BusyBox ash's line editor, at its prompt, asks the terminal for its cursor
(`ESC[6n`); when a line arrives with no answer it `usleep(20*1000)` before running it. A snapshot that
caught the serial shell already at its prompt made every job wait 20 ms; one that caught it a moment
earlier didn't. Fix: the serial shell's terminal has `-echo` (ash then reads lines with `fgets`, no
line editor) and no history file (`internal/boot/layer.go`, `snowglobe-shell`). After it, 8/8 sites
were fast, on either kernel.

With that noise gone, the kernel's real cost shows on fork-heavy jobs (served jq + sqlite report,
n=30 each, ms; separate builds per row):

| kernel | report | | kernel | report |
|---|---:|---|---|---:|
| no cgroups (k0), 3 builds | 165–174 | | cgroups only (+SCHED_MM_CID) | 188 |
| + pids | 160 | | + memcg | 182 |
| + CPU sched (FAIR_GROUP_SCHED) | 177 | | + CFS_BANDWIDTH | 181 |
| full (as built before), 3 builds | 189–192 | | full, `cgroup.memory=nokmem` | 192 |
| full, SCHED_MM_CID off, 3 builds | 177–184 | | cgroups only, SCHED_MM_CID off | 170 |
| full, SCHED_MM_CID off, `cgroup_disable=memory` | 174 (k0 in the same run: 167) | | | |

`CONFIG_SCHED_MM_CID` (comes with `CGROUPS`, not switchable in Kconfig) is about half of it; the
memory controller's per-page accounting the rest; pids and CPU bandwidth are within noise, so
`cpu.max` stays in the guest. `nokmem` does nothing. Hence: **one kernel**, `SCHED_MM_CID` patched off,
and the memory controller chosen per site at build time — `snowglobe build --memory-limits`
(`"memory_limits": true` on `POST /v1/builds`) boots with it, otherwise the guest boots with
`cgroup_disable=memory` and a `memory_limit_mb` job fails with an error naming the flag. No second
kernel is needed.

**2. Guest limits.** The launcher no longer starts any process for a limit (no `grep`, no `sh -c`):
the controllers are handed down and `/sys/fs/cgroup/sgjob` made once by init; the launcher writes
the limits with shell builtins, joins the cgroup only to fork the command into it and goes back,
reads `memory.events` with `read`, kills what the job left in its cgroup, and removes a cgroup of its
own (made only if `sgjob` is missing or busy). What remained (~12 ms, whatever the limit) was the
first `cgroup.procs` write after a restore waiting for an RCU grace period: `--memory-limits` sites
boot with `rcupdate.rcu_expedited=1` (−6 ms per limited job; +1.5 ms on others, so only there).
`favordynmods` was tried too: −7 ms per limited job but +4 ms / +12% at 50-at-once for every job:
not used.

**Daemon PSS** after limit bursts was not a leak and not about limits: any burst of 500 jobs left the
daemon at ~120 MB RSS (gctrace: ~53 MB live at 50 in flight, retained after). The job client held a
1 MiB read buffer per job in flight; now 64 KiB, and freed heap is returned to the system 2 s after
the last job of a burst ends. Live heap at 50 in flight: 53 → 4 MB.

## One-shot (container), wall / peak RSS

| Job | BASELINE | NEW | NEW-mem |
|---|---:|---:|---:|
| restore, `true` | 50 [50–50] ms / 43.1 MB | 50 [50–50] / 44.4 | 50 [50–50] / 44.8 |
| jq lines | 110 [110–110] / 47.0 | 110 [110–110] / 47.7 | 120 [110–120] / 47.7 |
| jq + sqlite report | 140 [140–140] / 53.2 | 140 [140–140] / 53.5 | 150 [140–150] / 53.5 |
| tesseract, one page | 3.42 [3.41–3.44] s / 165 | 3.46 [3.43–3.49] s / 164 | 3.48 [3.47–3.49] s / 165 |
| native tesseract | 0.15 s / 81 | 0.15 / 81 | – |

(BASELINE's own numbers moved since the first measurement — 60→50 ms, 4.22→3.42 s — as its
profile cache kept learning; NEW's cache started empty today plus a 3-rep warm-up.)

## Served (`--serve`)

| | BASELINE | NEW | NEW-mem | NEW, learned profile |
|---|---:|---:|---:|---:|
| server RSS after restore | 17.6 MB | 18.4 | 18.4 | 34.6 |
| a running job, of its own (USS) | 25.7 | 25.4 | 25.5 | 24.0 |
| empty job | 30.6 [30.1–32.6] ms | 38.8 [38.1–41.0] | 39.0 [37.9–39.9] | 30.0 [29.3–31.2] |
| jq + sqlite report | 117.7 [114.9–119.4] | 169.8 [167.0–173.5] | 180.4 [178.5–182.5] | 99.5 [97.9–102.2] |
| ten empty jobs at once | 57.1 [54.8–71.9] | 79.1 [74.7–84.2] | 79.0 [77.1–85.0] | 54.7 [49.7–61.6] |
| fifty at once | 253.1 [243.8–256.2] | 347.4 [341.7–356.7] | 355.2 [350.9–365.9] | 221.0 [214.9–224.5] |

NEW's served gap is the isolation fix (3a), not speed: a serving process's jobs no longer add what
they compile to the JIT profile the server prewarms from (one team's jobs must not shape, or be timed
from, another's). BASELINE's server prewarms from everything its jobs ever ran; NEW's only from the
build. "Learned profile" is NEW with the profile its single-tenant one-shot runs learned copied into
the server's cache — what an operator gets by warming a template with trusted single-tenant runs —
and it beats BASELINE everywhere.

## Daemon template jobs (`POST /v1/templates/{name}/jobs`)

| | BASELINE | NEW | NEW + exclave limits | NEW, learned profile | + exclave limits |
|---|---:|---:|---:|---:|---:|
| empty job | 51.0 [49.9–52.2] | 31.9 [31.0–33.7] | 39.5 [37.8–40.2] | 31.8 [29.9–33.3] | 37.4 [35.7–40.3] |
| jq + sqlite | 138.1 [135.5–140.0] | 125.4 [122.8–126.2] | 135.6 [133.9–141.2] | 117.5 [115.6–118.8] | 127.9 [126.6–132.5] |
| 10 at once: wall / job median | 69.0 / 62.3 | 65.5 / 54.0 | 102.9 / 65.5 | 56.9 / 48.8 | 99.9 / 57.1 |
| 50 at once: wall / job median | 233.6 / 163.6 | 290.6 / 189.4 | 415.1 / 261.2 | 252.6 / 178.1 | 337.2 / 225.7 |
| PSS idle: daemon + servers | 17.4 + 34.9 | 17.2 + 34.4 | 24.4 + 34.4 | 18.2 + 32.2 | 25.2 + 34.7 |
| PSS peak during 50 at once | 226.8 | 171.7 | 239.0 | 146.9 | 222.1 |

Before the fixes NEW + limits was 111 ms empty and 819 / 565 ms at 50 at once.

**Limits, one at a time and together** (NEW, empty job, ms; 50-at-once wall / job median):

| | 1 job | 10 at once (wall) | 50 at once |
|---|---:|---:|---:|
| none | 32.5 [31.9–33.3] | 61.7 | 284.9 / 188.9 |
| `memory_limit_mb` | 38.4 [38.0–39.9] | 79.8 | 385.7 / 251.8 |
| `cpus_limit` | 38.6 [37.6–40.0] | 75.9 | 358.5 / 247.6 |
| `pids_limit` | 38.4 [37.7–38.9] | 74.3 | 358.5 / 243.5 |
| all three | 39.4 [37.6–39.7] | 77.1 | 384.3 / 251.1 |
| exclave's whole set (+ disk, max_rss, output, copy, egress none) | 40.1 [39.5–40.9] | 112.2 | 432.0 / 262.9 |

Before: +23 ms per guest limit, +55 ms for all three, 2.6× at 50 at once. Now +6–7 ms for any or all,
and 50 at once adds ~2 ms per job over the single-job cost (sublinear), not a multiple. The ~6 ms
left is the kernel side of the first cgroup move after a restore (expedited grace period, writes to
cgroupfs, the move back), not the launcher: a `clone3(CLONE_INTO_CGROUP)` helper in the guest
would be the next step. The ≤3 ms target is not met.

**500 jobs with exclave's limits, 50 at once:** 4.2 s; daemon PSS 23–27 MB before → **18.9 MB 5 s and
60 s after** (before the fix: 87–120 → 117–124 MB, never returned).

Raw results: `~/results-final/*.json` in the VM; summarised with a throwaway `summarize.exs`.

# Operator warm-up and per-job stdio (2026-11-17, later)

Two changes since the section above:

- **`template add --warm CMD [--warm-runs N]`** (`warm`/`warm_runs` on `POST /v1/templates` and
  `POST /v1/builds`): before a template's server starts, the daemon runs CMD on the site N times
  (default 3), each a one-shot run of its own (empty workspace, `--egress none`, for no team). The
  site's JIT profile learns from those runs only; the server compiles it before forking, and its
  jobs read it and never write it. A snapshot's (one team's) template can't be warmed.
- A forked job's (and machine's) stdout and stderr point at `/dev/null` once it is confined: they
  were the template's log, inherited from the server. Not a cost; listed because it is in these
  builds.

Same host, VM, method and script (`bench/machines/toolkit-jobs.exs`, now with `--warm`); nothing
else running; two passes in opposite order (base → cold → warm, then warm → cold → base), 5 reps
each, **n=10**, median [min–max], ms. Sites rebuilt from this tree (`r3-toolkit`, and for the daemon
`r3-toolkit-net`: `--sandbox --network fetch --memory-limits`). **cold** and **warm** each start
from an empty cache every pass (what a new node has); **warm** passes `--warm` with the report
workload (its invoices written by the command, since a warm-up's workspace is empty), 3 runs, which
took 187 + 143 + 142 ms. BASELINE is release v0.19.0 with its own long-lived, still-learning cache.

## Served (`--serve`; for warm, 3 one-shot runs of the bundle into the server's cache first)

| | BASELINE | cold | warm |
|---|---:|---:|---:|
| empty job | 30.6 [30.0–31.7] | 38.9 [38.3–40.0] | 31.6 [30.5–32.1] |
| jq + sqlite report | 120.4 [116.9–130.4] | 170.2 [164.6–177.4] | **119.0** [116.1–120.4] |
| ten empty at once | 59.1 [52.1–66.7] | 79.2 [75.8–85.4] | 59.4 [54.1–65.0] |
| fifty at once | 252.2 [244.3–268.7] | 347.1 [343.5–355.1] | **250.5** [241.0–257.3] |
| a running job, of its own (USS, MB) | 25.8 | 25.3 | 24.7 |

## Daemon template jobs (`POST /v1/templates/{name}/jobs`)

| | BASELINE | cold | warm | cold + exclave limits | warm + exclave limits |
|---|---:|---:|---:|---:|---:|
| empty job | 50.9 [49.8–52.0] | 30.5 [29.6–31.7] | **30.1** [28.8–31.1] | 37.0 [36.2–38.0] | 35.7 [34.0–37.4] |
| jq + sqlite | 134.0 [132.4–135.2] | 119.0 [115.5–119.7] | **112.7** [110.5–116.4] | 131.8 [126.4–135.0] | 121.7 [119.9–124.4] |
| 10 at once: wall / job median | 67.1 / 64.0 | 52.7 / 45.1 | 47.7 / 43.7 | 98.6 / 57.2 | 95.2 / 50.2 |
| 50 at once: wall / job median | 230.5 / 156.4 | 227.7 / 160.1 | **213.8 / 148.8** | 336.4 / 221.6 | 299.8 / 189.5 |
| PSS idle, daemon + servers (MB, pass 1 / 2) | 14.8+49.7 / 14.5+49.7 | 17.2+47.0 / 17.1+46.8 | 17.4+24.9 / 17.6+23.9 | | |
| server's prewarm at start | 64 modules, 574 KB | 63 modules, 569 KB | 101 modules, 1175 KB | | |

What it shows:

- The served gap of the section above is closed by the operator's warm-up, not by letting jobs
  teach the profile: warm served matches BASELINE (report 119.0 vs 120.4, fifty at once 250.5 vs
  252.2) while its jobs still never write the profile. The cold cache's `jit/` directory doesn't
  exist after 2 × (served + daemon + limits) passes: nothing a job ran was saved.
- Daemon jobs beat BASELINE everywhere when warm (report −16%, 50 at once −7% wall), and warm-up
  takes about half a second per template.
- With exclave's limits, warm-up takes ~10 ms off the report and ~37 ms off 50 at once; the limits'
  own ~6 ms per job (the first cgroup move after a restore) is unchanged.
- Warm servers' idle PSS (servers and what they hold) measured ≈24 MB against ≈47 MB cold, in both
  passes. Not investigated; noted as measured.

Raw results: `~/results-r3/{base,cold,warm}-pass{1,2}.json` in the VM.

# On snowglobe v0.20.0 / armless v0.21.0 (2026-11-17, evening)

Upstream released armless-v0.21.0 (egress/JIT/snapshot hardening, web relay bounds, TCP flow
control) and snowglobe v0.20.0 (on it; a kernel site's guest reports the memory it frees, through a
virtio-balloon, and snapshots leave it out). This tree was moved onto both (armless-wt at
origin/main a2cb4ad + the write budget and egress ports, as 0.22.0; snowglobe-wt at 14bf1b7 + the
work above, as 0.21.0). **BASELINE is now the v0.20.0 release** (linux/arm64 binaries, SHA256SUMS
verified; its GHCR tools image and release boot archive), its cache warmed by 3 one-shot passes
first, as a long-lived node's would be. Both sides' sites have free page reporting.

Same host, VM, script and method as the section above: two passes in opposite order (base → cold →
warm, then warm → cold → base), 5 reps each, **n=10**, median [min–max], ms. Sites `r4-toolkit`
(`--sandbox`) and `r4-toolkit-net` (`--sandbox --network fetch --memory-limits`); cold and warm each
from an empty cache every pass; warm = `--warm`, the report run 3 times.

## One-shot (container), wall / peak RSS (10 ms resolution)

| | BASELINE v0.20.0 | this tree (cold cache) |
|---|---:|---:|
| `true` | 80 [70–270] / 43 MB | **50** [50–60] / 44 MB |
| jq lines | 150 [140–150] / 47 | **130** [120–130] / 47 |
| jq + sqlite report | 180 [170–190] / 52 | **160** [150–170] / 53 |
| tesseract, one page | **3.63** [3.58–4.05] s / 164 | 3.93 [3.85–4.04] s / 169 |

## Served (`--serve`)

| | BASELINE | cold | warm |
|---|---:|---:|---:|
| empty job | 55.6 [53.8–56.8] | 41.0 [39.6–48.2] | **36.0** [33.7–37.3] |
| jq + sqlite report | 147.4 [145.3–149.7] | 198.3 [177.6–229.0] | **141.6** [125.5–152.5] |
| ten at once | 112.8 [83.8–268.8] | 84.8 [80.6–88.1] | **58.7** [55.2–63.6] |
| fifty at once | 403.1 [322.6–544.6] | 375.0 [362.5–406.8] | **260.4** [252.7–268.4] |
| a running job's own USS (MB) | 25.1 | 24.9 | 24.7 |

## Daemon template jobs

| | BASELINE | cold | warm | cold + exclave limits | warm + exclave limits |
|---|---:|---:|---:|---:|---:|
| empty job | 53.7 [51.0–55.6] | 36.0 [31.7–37.7] | **30.9** [30.5–42.5] | 46.5 [38.0–49.8] | 37.4 [36.4–38.6] |
| jq + sqlite | 147.6 [142.8–153.6] | 147.4 [127.0–164.4] | **123.4** [121.7–134.2] | 166.0 [137.3–173.7] | 136.8 [131.4–147.6] |
| 10 at once: wall / job median | 78.4 / 70.4 | 60.4 / 51.6 | **49.7 / 45.5** | 102.9 / 61.7 | 97.4 / 57.0 |
| 50 at once: wall / job median | 294.3 / 195.7 | 262.6 / 180.7 | **226.1 / 162.0** | 386.3 / 236.7 | 316.1 / 206.7 |
| PSS idle, daemon + servers (MB) | 18.4 + 33.6 | 17.5 + 33.5 | 17.4 + 34.8 | 21.3 + 34.6 | 22.4 + 35.4 |

What it shows:

- Warm, this tree beats v0.20.0 on every served and daemon number (daemon report −16%, 50 at once
  −23% wall; served 50 at once −35%). Cold, served reports are still slower (198 vs 147): the
  operator warm-up is what closes that, as before.
- v0.20.0's own numbers are higher than v0.19.0's in the section above (served empty 55.6 vs 30.6,
  daemon report 147.6 vs 134.0) on the same host. Not investigated here; free page reporting is new
  in it, and both sides of this table have it.
- Idle PSS of servers is ~34 MB on both sides now (the 47 → 24 MB cold/warm gap of the section
  above is gone: freed guest memory is given back either way).
- One-shot tesseract is 8% slower than BASELINE (3.93 vs 3.63 s). The cold side's cache started empty
  each pass while BASELINE's had learned through 3 extra passes, so part of it is JIT profile
  maturity; not separated here.
- exclave's limits still cost ~6–9 ms per job (warm: 37.4 vs 30.9 empty).

Raw results: `~/results-r4/{base,cold,warm}-pass{1,2}.json` in the VM.
