#!/usr/bin/env elixir
# What a toolkit job costs (examples/toolkit/README.md, "What a job costs"), for one build of
# snowglobe at a time, so builds can be compared: one-shot jobs in an unprivileged container,
# jobs served from one restore (--serve), and the daemon's template jobs, with and without the
# job limits, plus a build-as-snapshot (machine up -> build job -> snapshot -> template -> run).
#
#   elixir bench/machines/toolkit-jobs.exs --variant new --bundle toolkit.bin --sg DIR \
#     --site-net SITE --cache DIR --fixtures DIR [--py-site SITE] [--reps 7] \
#     [--sections oneshot,native,served,daemon,limits,limits_each,burst500,build] [--out results.json]
#     [--warm]
#
# --bundle: `snowglobe bundle` of examples/toolkit built --sandbox; --site-net: the same built
# --sandbox --network fetch (what a daemon template for exclave is); --sg: the snowglobe CLI of
# that build; --cache: the build's own cache (XDG_CACHE_HOME), so builds share nothing;
# --fixtures: invoices.json and page.png (one 150 dpi page of the workflow's invoices).
# One-shot runs: docker run --rm --user 1000 --cap-drop ALL --network none (default seccomp),
# timed and measured inside by busybox `time -v` (wall, max RSS); one warm-up run first (the
# cache volume, with the JIT profiles, persists across runs, as on a runner node).
# --warm: the operator's warm-up before serving (the report, with its invoices written by the
# command itself, run 3 times on the site): `template add --warm` for the daemon's templates, and
# for --serve the same 3 one-shot runs of the bundle into the server's cache first. Without it the
# servers start from the build's profile only. Give each a fresh --cache to compare.

Mix.install([{:req, "~> 0.5"}])

defmodule Stats do
  def median([]), do: nil
  def median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
  def summary(xs), do: %{median: median(xs), min: Enum.min(xs, fn -> nil end), max: Enum.max(xs, fn -> nil end), n: length(xs), raw: xs}
  def ms(f) do
    t = System.monotonic_time(:microsecond)
    v = f.()
    {Float.round((System.monotonic_time(:microsecond) - t) / 1000, 1), v}
  end
end

defmodule Proc do
  def rollup(pid) do
    case File.read("/proc/#{pid}/smaps_rollup") do
      {:ok, s} ->
        get = fn k -> case Regex.run(~r/^#{k}:\s+(\d+)/m, s) do [_, v] -> String.to_integer(v); _ -> 0 end end
        %{rss: get.("Rss"), pss: get.("Pss"), uss: get.("Private_Clean") + get.("Private_Dirty")}
      _ -> nil
    end
  end

  def children(pid) do
    Path.wildcard("/proc/#{pid}/task/*/children")
    |> Enum.flat_map(fn f -> case File.read(f) do {:ok, s} -> String.split(s); _ -> [] end end)
    |> Enum.map(&String.to_integer/1)
  end

  def tree(pid), do: [pid | Enum.flat_map(children(pid), &tree/1)]
  def mb(kb), do: Float.round(kb / 1024, 1)
end

defmodule Bench do
  @alpine "alpine:3.24.2"

  def workloads(fx) do
    report = File.read!(Path.join(fx, "report.sh"))
    %{
      "empty" => {"true", %{}, []},
      "jq_lines" => {~s(sh main.sh), %{"main.sh" => ~s(echo "$EXCLAVE_ASSIGNS" | jq .n; uname -m; date > out/when\n)}, [~s(EXCLAVE_ASSIGNS={"n":42})]},
      "report" => {"sh main.sh", %{"main.sh" => report, "in/invoices.json" => File.read!(Path.join(fx, "invoices.json"))}, []},
      "tesseract" => {"tesseract in/page.png out/page --psm 6 2>/dev/null; wc -w out/page.txt", %{"in/page.png" => File.read!(Path.join(fx, "page.png"))}, []}
    }
  end

  # The warm-up command: the report workload with its input written by the command, since a
  # warm-up runs in an empty workspace
  def warm_cmd(fx) do
    "mkdir -p in out\ncat > in/invoices.json <<'JSON'\n" <> File.read!(Path.join(fx, "invoices.json")) <> "\nJSON\n" <>
      File.read!(Path.join(fx, "report.sh"))
  end

  def workspace(root, files) do
    dir = Path.join(root, "ws-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "out"))
    for {p, b} <- files, do: (File.mkdir_p!(Path.dirname(Path.join(dir, p))); File.write!(Path.join(dir, p), b))
    System.cmd("chmod", ["-R", "a+rwX", dir])
    dir
  end

  defp time_v(out) do
    [_, m, s] = Regex.run(~r/Elapsed \(wall clock\) time.*?:\s+(\d+)m\s+([\d.]+)s/, out)
    [_, kb] = Regex.run(~r/Maximum resident set size \(kbytes\):\s+(\d+)/, out)
    {Float.round((String.to_integer(m) * 60 + String.to_float(s)) * 1000, 0), Proc.mb(String.to_integer(kb))}
  end

  defp docker(o, image, job, argv) do
    args = ["run", "--rm", "--user", "1000:1000", "--cap-drop", "ALL", "--network", "none",
            "-e", "SNOWGLOBE_CACHE=/cache", "-e", "HOME=/tmp", "-e", "OMP_THREAD_LIMIT=1",
            "-v", "#{o.cache}/oneshot:/cache", "-v", "#{o.bundle}:/toolkit:ro", "-v", "#{job}:/job", "-w", "/job",
            image, "/usr/bin/time", "-v" | argv]
    {out, _} = System.cmd("docker", args, stderr_to_stdout: true)
    {out, time_v(out)}
  end

  def oneshot(o, w) do
    File.mkdir_p!("#{o.cache}/oneshot")
    System.cmd("chmod", ["a+rwx", "#{o.cache}/oneshot"])
    for name <- ~w(empty jq_lines report tesseract), into: %{} do
      {cmd, files, env} = w[name]
      reps = if name == "tesseract", do: max(5, div(o.reps, 2) + 2), else: o.reps
      runs =
        for i <- 0..reps do
          job = workspace(o.tmp, files)
          {out, r} = docker(o, @alpine, job, ["/toolkit", "--workspace", "/job", "--cmd", cmd | Enum.flat_map(env, &["--env", &1])])
          if i == 0, do: IO.puts("  [oneshot #{name} warm-up] " <> String.slice(out, 0, 160) |> String.replace("\n", " | "))
          File.rm_rf!(job)
          r
        end
        |> tl()
      IO.puts("  oneshot #{name}: #{inspect(Enum.map(runs, &elem(&1, 0)))} ms, peak #{inspect(Enum.map(runs, &elem(&1, 1)))} MB")
      {name, %{wall_ms: Stats.summary(Enum.map(runs, &elem(&1, 0))), peak_rss_mb: Stats.summary(Enum.map(runs, &elem(&1, 1)))}}
    end
  end

  def native(o, w) do
    {_, files, _} = w["tesseract"]
    runs =
      for _ <- 0..o.reps do
        job = workspace(o.tmp, files)
        {_out, r} = docker(o, "bench-native-tess", job, ["tesseract", "in/page.png", "out/page", "--psm", "6"])
        File.rm_rf!(job)
        r
      end
      |> tl()
    IO.puts("  native tesseract: #{inspect(runs)}")
    %{"tesseract_native" => %{wall_ms: Stats.summary(Enum.map(runs, &elem(&1, 0))), peak_rss_mb: Stats.summary(Enum.map(runs, &elem(&1, 1)))}}
  end

  # ## Served: one restore, a fork per job
  def served(o, w) do
    root = Path.join(o.tmp, "served")
    File.rm_rf!(root)
    File.mkdir_p!(root)
    sock = Path.join(o.tmp, "served.sock")
    File.rm(sock)
    env = [{~c"SNOWGLOBE_CACHE", String.to_charlist("#{o.cache}/served")}]
    if o.warm do
      for i <- 1..3 do
        ws = workspace(root, %{})
        {out, st} = System.cmd(o.bundle, ["--workspace", ws, "--cmd", o.warm], env: [{"SNOWGLOBE_CACHE", "#{o.cache}/served"}], stderr_to_stdout: true)
        if st != 0, do: raise("served warm-up #{i}: exit #{st}: #{out}")
        File.rm_rf!(ws)
      end
    end
    port = Port.open({:spawn_executable, o.bundle}, [:binary, :exit_status, :stderr_to_stdout, env: env, args: ["--serve", sock, "--jobs-root", root]])
    {:os_pid, spid} = Port.info(port, :os_pid)
    wait_for(fn -> File.exists?(sock) end, 30_000)
    Process.sleep(2000)
    server = Proc.rollup(spid)
    job = fn {cmd, files, env} ->
      ws = workspace(root, files)
      {ms, {out, st}} = Stats.ms(fn -> System.cmd(o.bundle, ["--server", sock, "--workspace", ws, "--cmd", cmd | Enum.flat_map(env, &["--env", &1])], stderr_to_stdout: true) end)
      File.rm_rf!(ws)
      if st != 0, do: IO.puts("  served job exit #{st}: #{String.slice(out, 0, 200)}")
      ms
    end
    for _ <- 1..3, do: job.(w["report"])
    empty = for _ <- 1..o.reps, do: job.(w["empty"])
    report = for _ <- 1..o.reps, do: job.(w["report"])
    own =
      for _ <- 1..o.reps do
        t = Task.async(fn -> job.({"jq -n '[range(100000)]|length' >/dev/null; sleep 2", %{}, []}) end)
        Process.sleep(1500)
        kids = Proc.children(spid) |> Enum.flat_map(&Proc.tree/1) |> Enum.map(&Proc.rollup/1) |> Enum.reject(&is_nil/1)
        Task.await(t, 60_000)
        Enum.max_by(kids, & &1.uss, fn -> %{uss: 0, pss: 0, rss: 0} end)
      end
    burst = fn n -> for _ <- 1..o.reps do
        {ms, _} = Stats.ms(fn -> 1..n |> Task.async_stream(fn _ -> job.(w["empty"]) end, max_concurrency: n, timeout: 300_000) |> Enum.to_list() end)
        ms
      end end
    c10 = burst.(10)
    c50 = burst.(50)
    Port.close(port)
    System.cmd("kill", [to_string(spid)])
    res = %{
      server_rss_mb: Proc.mb(server.rss), server_pss_mb: Proc.mb(server.pss),
      job_own_uss_mb: Stats.summary(Enum.map(own, &Proc.mb(&1.uss))), job_pss_mb: Stats.summary(Enum.map(own, &Proc.mb(&1.pss))),
      empty_ms: Stats.summary(empty), report_ms: Stats.summary(report), ten_at_once_ms: Stats.summary(c10), fifty_at_once_ms: Stats.summary(c50)
    }
    IO.puts("  served: #{inspect(Map.new(res, fn {k, v} -> {k, if(is_map(v), do: v.median, else: v)} end))}")
    res
  end

  # ## The daemon's template jobs
  def daemon_start(o) do
    env = [{"XDG_CACHE_HOME", o.cache}]
    System.cmd(Path.join(o.sg, "snowglobe"), ["daemon", "stop"], env: env, stderr_to_stdout: true)
    # Older builds' --detach opens the log before making its directory
    File.mkdir_p!(Path.join([o.cache, "snowglobe", "daemon"]))
    {out, 0} = System.cmd(Path.join(o.sg, "snowglobe"), ["daemon", "--memory", "16G", "--detach"], env: env, stderr_to_stdout: true)
    IO.puts("  " <> String.trim(out))
    sock = Path.join([o.cache, "snowglobe", "daemon", "daemon.sock"])
    wait_for(fn -> File.exists?(sock) end, 30_000)
    for {name, site} <- [{"bench-tk", o.site_net}] ++ if(o.py_site, do: [{"bench-py", o.py_site}], else: []) do
      System.cmd(Path.join(o.sg, "snowglobe"), ["template", "rm", name], env: env, stderr_to_stdout: true)
      warm = if o.warm, do: ["--warm", o.warm, "--warm-runs", "3"], else: []
      {out, st} = System.cmd(Path.join(o.sg, "snowglobe"), ["template", "add", site, "--name", name] ++ warm, env: env, stderr_to_stdout: true)
      if st != 0, do: raise("template add #{name}: #{out}")
      IO.puts("  " <> String.trim(out))
    end
    Process.sleep(2000)
    sock
  end

  def daemon_stop(o), do: System.cmd(Path.join(o.sg, "snowglobe"), ["daemon", "stop"], env: [{"XDG_CACHE_HOME", o.cache}], stderr_to_stdout: true)

  def req(sock, method, path, body \\ nil) do
    opts = [method: method, url: "http://sg" <> path, unix_socket: sock, retry: false, receive_timeout: 600_000]
    opts = if body, do: Keyword.put(opts, :json, body), else: opts
    Req.request!(opts)
  end

  def body({cmd, files, env}, extra \\ %{}) do
    env = Map.new(env, fn kv -> [k, v] = String.split(kv, "=", parts: 2); {k, v} end)
    Map.merge(%{cmd: cmd, files: Map.new(files, fn {p, b} -> {p, Base.encode64(b)} end), env: env, timeout: 300}, extra)
  end

  def tjob(sock, b, name \\ "bench-tk") do
    {ms, r} = Stats.ms(fn -> req(sock, :post, "/v1/templates/#{name}/jobs", b) end)
    if r.status != 200 or r.body["status"] != 0, do: IO.puts("  job: #{r.status} #{inspect(r.body, limit: 8, printable_limit: 300)}")
    ms
  end

  def daemon_pids(o) do
    exe = Path.join(o.sg, "snowglobe")
    d = Path.wildcard("/proc/[0-9]*") |> Enum.find(fn p ->
      match?({:ok, ^exe}, File.read_link(p <> "/exe")) and (File.read!(p <> "/cmdline") |> String.contains?("daemon"))
    end)
    pid = d |> Path.basename() |> String.to_integer()
    {pid, Proc.tree(pid) -- [pid]}
  end

  def pss_now(o) do
    {d, kids} = daemon_pids(o)
    dk = (Proc.rollup(d) || %{pss: 0}).pss
    kk = kids |> Enum.map(&Proc.rollup/1) |> Enum.reject(&is_nil/1) |> Enum.map(& &1.pss) |> Enum.sum()
    %{daemon_pss_mb: Proc.mb(dk), servers_and_jobs_pss_mb: Proc.mb(kk), total_pss_mb: Proc.mb(dk + kk), processes: length(kids) + 1}
  end

  def daemon(o, w, sock, extra, label) do
    run = fn wl -> tjob(sock, body(w[wl], extra)) end
    for _ <- 1..3, do: run.("report")
    idle = pss_now(o)
    empty = for _ <- 1..o.reps, do: run.("empty")
    report = for _ <- 1..o.reps, do: run.("report")
    burst = fn n ->
      for _ <- 1..o.reps do
        sampler = Task.async(fn -> sample(o, 0) end)
        {ms, per} = Stats.ms(fn -> 1..n |> Task.async_stream(fn _ -> run.("empty") end, max_concurrency: n, timeout: 600_000) |> Enum.map(fn {:ok, v} -> v end) end)
        send(sampler.pid, :stop)
        {ms, Stats.median(per), Task.await(sampler)}
      end
    end
    c10 = burst.(10)
    c50 = burst.(50)
    res = %{
      idle_pss: idle, empty_ms: Stats.summary(empty), report_ms: Stats.summary(report),
      c10_wall_ms: Stats.summary(Enum.map(c10, &elem(&1, 0))), c10_job_median_ms: Stats.summary(Enum.map(c10, &elem(&1, 1))),
      c50_wall_ms: Stats.summary(Enum.map(c50, &elem(&1, 0))), c50_job_median_ms: Stats.summary(Enum.map(c50, &elem(&1, 1))),
      c50_peak_total_pss_mb: Stats.summary(Enum.map(c50, &elem(&1, 2)))
    }
    IO.puts("  daemon#{label}: #{inspect(Map.new(res, fn {k, v} -> {k, if(is_map(v) and Map.has_key?(v, :median), do: v.median, else: v)} end))}")
    res
  end

  defp sample(o, peak) do
    receive do
      :stop -> peak
    after
      100 -> sample(o, max(peak, pss_now(o).total_pss_mb))
    end
  end

  # machine up -> build job (a real pip fetch) -> snapshot -> template -> first run
  def build(o, sock) do
    reqs = %{"requirements.txt" => "six==1.16.0\n", "main.py" => "import six\nprint('six', six.__version__)\n"}
    runs =
      for i <- 1..o.reps do
        m = "bb-#{i}-#{System.unique_integer([:positive])}"
        s = "bs-" <> String.slice(m, 3..-1//1)
        {up, r} = Stats.ms(fn -> req(sock, :post, "/v1/machines", %{template: "bench-py", name: m, egress: "https", ttl: "900s"}) end)
        200 = r.status
        {bj, r} = Stats.ms(fn -> req(sock, :post, "/v1/machines/#{m}/jobs", body({"uv pip install --target=vendor -r requirements.txt && { python3 -m compileall -q vendor || true; }", reqs, []}, %{workdir: "/workspace", egress: "https"})) end)
        if r.body["status"] != 0, do: IO.puts("  build job: #{inspect(r.body, limit: 8, printable_limit: 400)}")
        {sn, r} = Stats.ms(fn -> req(sock, :post, "/v1/machines/#{m}/snapshots", %{name: s}) end)
        bytes = r.body["size_bytes"] || r.body["bytes"]
        {tp, r} = Stats.ms(fn -> req(sock, :post, "/v1/templates", %{name: s, snapshot: s}) end)
        200 = r.status
        req(sock, :delete, "/v1/machines/#{m}")
        run = %{cmd: "PYTHONPATH=vendor python3 main.py", workdir: "/workspace", timeout: 60}
        first = tjob(sock, run, s)
        second = tjob(sock, run, s)
        req(sock, :delete, "/v1/templates/#{s}")
        req(sock, :delete, "/v1/snapshots/#{s}")
        %{up_ms: up, build_job_ms: bj, snapshot_ms: sn, template_ms: tp, total_ms: Float.round(up + bj + sn + tp, 1), first_run_ms: first, second_run_ms: second, snapshot_mb: Float.round((bytes || 0) / 1_048_576, 1)}
      end
    res = for k <- Map.keys(hd(runs)), into: %{}, do: {k, Stats.summary(Enum.map(runs, & &1[k]))}
    IO.puts("  build-as-snapshot: #{inspect(Map.new(res, fn {k, v} -> {k, v.median} end))}")
    res
  end

  @limits %{memory_limit_mb: 512, cpus_limit: 1, pids_limit: 1024, disk_limit_mb: 5120, max_rss_mb: 768, output_limit: 8_388_608, copy_limit_mb: 5120, egress: "none"}

  # Each guest limit alone, then all three, then exclave's whole set, against none: an empty job
  # one at a time, and bursts of 10 and 50 (wall, and the median job within the burst)
  @each [
    {"none", %{}},
    {"memory", %{memory_limit_mb: 512}},
    {"cpus", %{cpus_limit: 1}},
    {"pids", %{pids_limit: 1024}},
    {"guest_all", %{memory_limit_mb: 512, cpus_limit: 1, pids_limit: 1024}}
  ]
  def limits_each(o, w, sock) do
    sets = @each ++ [{"exclave_all", @limits}]
    for {name, extra} <- sets, into: %{} do
      run = fn -> tjob(sock, body(w["empty"], extra)) end
      for _ <- 1..3, do: run.()
      one = for _ <- 1..o.reps, do: run.()
      burst = fn n ->
        for _ <- 1..o.reps do
          {ms, per} = Stats.ms(fn -> 1..n |> Task.async_stream(fn _ -> run.() end, max_concurrency: n, timeout: 600_000) |> Enum.map(fn {:ok, v} -> v end) end)
          {ms, Stats.median(per)}
        end
      end
      c10 = burst.(10)
      c50 = burst.(50)
      res = %{
        one_ms: Stats.summary(one),
        c10_wall_ms: Stats.summary(Enum.map(c10, &elem(&1, 0))), c10_job_median_ms: Stats.summary(Enum.map(c10, &elem(&1, 1))),
        c50_wall_ms: Stats.summary(Enum.map(c50, &elem(&1, 0))), c50_job_median_ms: Stats.summary(Enum.map(c50, &elem(&1, 1)))
      }
      IO.puts("  limits #{name}: one #{res.one_ms.median} c10 #{res.c10_wall_ms.median}/#{res.c10_job_median_ms.median} c50 #{res.c50_wall_ms.median}/#{res.c50_job_median_ms.median}")
      {name, res}
    end
  end

  # 500 jobs with exclave's limits, 50 at once: the daemon's PSS before, at its peak, and idle
  # 5 s and 60 s after (Go keeps freed heap a while before it hands it back)
  def burst500(o, w, sock) do
    for _ <- 1..3, do: tjob(sock, body(w["empty"], @limits))
    before = pss_now(o)
    sampler = Task.async(fn -> sample(o, 0) end)
    {ms, _} = Stats.ms(fn -> 1..500 |> Task.async_stream(fn _ -> tjob(sock, body(w["empty"], @limits)) end, max_concurrency: 50, timeout: 600_000) |> Enum.to_list() end)
    send(sampler.pid, :stop)
    peak = Task.await(sampler)
    Process.sleep(5000)
    after5 = pss_now(o)
    Process.sleep(55_000)
    after60 = pss_now(o)
    res = %{wall_ms: ms, before: before, peak_total_pss_mb: peak, after_5s: after5, after_60s: after60}
    IO.puts("  burst500: #{ms} ms; daemon PSS #{before.daemon_pss_mb} -> 5s after #{after5.daemon_pss_mb} -> 60s after #{after60.daemon_pss_mb} MB; total peak #{peak}")
    res
  end

  def wait_for(f, left) when left <= 0, do: f.() || raise("timed out waiting")
  def wait_for(f, left), do: f.() || (Process.sleep(100); wait_for(f, left - 100))

  def main(argv) do
    {opts, _} = OptionParser.parse!(argv, strict: [variant: :string, bundle: :string, sg: :string, site_net: :string, py_site: :string, cache: :string, fixtures: :string, reps: :integer, sections: :string, out: :string, warm: :boolean])
    o = %{
      variant: opts[:variant], bundle: opts[:bundle], sg: opts[:sg], site_net: opts[:site_net], py_site: opts[:py_site],
      cache: opts[:cache], reps: opts[:reps] || 7, tmp: "/tmp/sgbench-#{opts[:variant]}",
      warm: if(opts[:warm], do: warm_cmd(opts[:fixtures]))
    }
    File.mkdir_p!(o.tmp)
    sections = String.split(opts[:sections] || "oneshot,served,daemon", ",")
    w = workloads(opts[:fixtures])
    IO.puts("== #{o.variant}: #{Enum.join(sections, ",")}, #{o.reps} reps")
    res = %{variant: o.variant, at: DateTime.utc_now() |> DateTime.to_iso8601(), reps: o.reps}
    res = if "oneshot" in sections, do: Map.put(res, :oneshot, oneshot(o, w)), else: res
    res = if "native" in sections, do: Map.put(res, :native, native(o, w)), else: res
    res = if "served" in sections, do: Map.put(res, :served, served(o, w)), else: res
    res =
      if Enum.any?(~w(daemon limits limits_each burst500 build), &(&1 in sections)) do
        sock = daemon_start(o)
        res = if "daemon" in sections, do: Map.put(res, :daemon, daemon(o, w, sock, %{}, "")), else: res
        res = if "limits" in sections, do: Map.put(res, :daemon_limits, daemon(o, w, sock, @limits, " (limits)")), else: res
        res = if "limits_each" in sections, do: Map.put(res, :limits_each, limits_each(o, w, sock)), else: res
        res = if "burst500" in sections, do: Map.put(res, :burst500, burst500(o, w, sock)), else: res
        res = if "build" in sections, do: Map.put(res, :build, build(o, sock)), else: res
        daemon_stop(o)
        res
      else
        res
      end
    if opts[:out], do: File.write!(opts[:out], JSON.encode!(res))
  end
end

Bench.main(System.argv())
