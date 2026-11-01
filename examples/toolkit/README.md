# Toolkits: sandboxed jobs with no hypervisor

One image carrying command-line tools instead of a language (poppler, qpdf, tesseract, vips,
jq, sqlite, ffmpeg and python, the shape of [Exclave](https://github.com/filipecabaco/exclave)'s
toolkits), snapshotted at a shell and bundled into one executable that runs **jobs**: a
workspace in, a command run in a fresh machine, its output, exit status and `out/` back. No
Docker, no KVM, no Firecracker: the machine is armless, an arm64 emulator in userspace, and
the process sandboxes itself (Landlock and seccomp on Linux, Seatbelt on macOS).

```console
$ snowglobe build examples/toolkit --sandbox --out dist/toolkit
$ snowglobe bundle dist/toolkit -o toolkit
$ mkdir -p job && echo 'echo "$EXCLAVE_ASSIGNS" | jq .n; uname -m; date > out/when' > job/main.sh
$ ./toolkit --workspace job --cmd 'sh main.sh' --env 'EXCLAVE_ASSIGNS={"n":42}'
42
aarch64
$ ls job/out
when
```

Every job restores the machine from its snapshot (~200 ms), so nothing carries over from one
job to the next. `--env-file FILE` (a JSON object) passes secrets without putting them on a
command line, `--timeout SECS` bounds the job (exit 124), and the exit status is the command's.

To run many jobs, serve them: the snapshot is restored once and each job is a fork of it.

```console
$ ./toolkit --serve /tmp/toolkit.sock --jobs-root "$PWD" &
$ ./toolkit --server /tmp/toolkit.sock --workspace job --cmd 'sh main.sh'
```

## A workflow

[`workflow.exs`](workflow.exs) chains jobs the way Exclave chains runs: each step's files are
[`steps/<step>/`](steps), and a step's `out/` is the next step's `in/`. OCR fans out, one
sandbox per page, and an unrelated media branch runs alongside:

```
fixtures (vips, img2pdf) → rasterize (poppler) → ocr ×N (tesseract) → extract (python) → report (jq, sqlite)
media (ffmpeg, vips)
```

```console
$ elixir examples/toolkit/workflow.exs ./toolkit
...
▸ report  455 ms · exit 0 · 1 files out
    ╭────────────┬──────────┬─────────╮
    │   vendor   │ invoices │  total  │
    ╞════════════╪══════════╪═════════╡
    │ Acme Tools │        2 │ 3876.00 │
    │ Globex Ltd │        1 │ 1938.00 │
    ╰────────────┴──────────┴─────────╯

Step          time      exit  out/
fixtures     14950 ms      0     3
rasterize     1716 ms      0     3
ocr ×3        6009 ms      0     3
extract        886 ms      0     1
report         459 ms      0     1
media         4934 ms      0     2

6 sandboxed jobs in 24038 ms (two branches at once)
```

## What a job costs

Measured on an Apple M-series host, the Linux numbers in an unprivileged container (`--user
1000 --cap-drop ALL --network none`, Docker's default seccomp profile):

| Job | Wall time | Peak memory (Linux) |
|-----|----------:|--------------------:|
| restore, nothing run | ~0.2 s | 112 MB |
| a few shell lines with jq | 0.38 s | |
| jq + sqlite report | 0.45 s | 140 MB |
| tesseract, one page | 5.8 s | 386 MB |

Served (`--serve`), on Linux:

| | |
|-|-:|
| the server, restored once | 92 MB |
| a running job, of its own (the rest shared with the server) | 13 MB |
| an empty job | 0.10 s |
| the jq + sqlite report | 0.26 s |
| ten empty jobs at once | 0.27 s |

A job's memory is what its guest touches, not the machine's size (768 MB here): one-shot, a
small VPS runs dozens of light jobs at once; served, hundreds.

The CPU is emulated, and that is the trade. Glue (shell, jq, sqlite, python scripts, file
conversions) is dominated by the restore. Heavy vector and floating-point code is slower than
native: the same tesseract page takes 0.13 s natively. `ARMLESS_JIT_HELPER_STATS=1
SNOWGLOBE_TIMING=1` shows where it goes: which instructions compiled code still hands back to
armless's interpreter, by opcode. For tesseract these were its int8 dot product (`smull`,
`saddlp`, `addp`, `uzp1`) and SIMD&FP loads and stores, ~630M of 733M; armless's JIT translates
those now (the page went from 14.4 s to 5.8 s). What is left is scalar floating point (`fmul`,
`fsub`, `fcmpe`, `scvtf`, `fmadd`: ~100M), which needs float types in the JIT first.
