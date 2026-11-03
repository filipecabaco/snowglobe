#!/usr/bin/env elixir
# Capacity on one Linux host (a VM with KVM, e.g. Lima with nestedVirtualization): Firecracker
# microVMs restored from a snapshot vs snowglobe instances (snowglobe run --runtime native),
# snowglobe-vm's fork-per-job server, and the daemon's machines (snowglobe up) and a service at zero,
# each with the python demo's image, 1 vCPU and 512 MB.
#
#   elixir bench/machines/capacity.exs --fc DIR --sg DIR --site DIR [--wake-site DIR] [--n 50] [--reps 10]
#
# --fc holds firecracker, vmlinux and rootfs.ext4 (whose /fcinit runs each console line);
# --sg holds snowglobe and snowglobe-vm (linux/arm64); --site is the python site (--sandbox).
# --wake-site (default: --site) is the one the service at zero runs: it needs a network (built
# with --network fetch), for its port to be forwarded.

Mix.install([{:jason, "~> 1.4"}])

defmodule Mem do
  # What the host has left to give: the honest measure of what N machines cost together
  def available_mb do
    [_, kb] = Regex.run(~r/MemAvailable:\s+(\d+)/, File.read!("/proc/meminfo"))
    div(String.to_integer(kb), 1024)
  end

  def settle, do: Process.sleep(3000)

  def pss_mb(pid) do
    case File.read("/proc/#{pid}/smaps_rollup") do
      {:ok, s} ->
        [_, kb] = Regex.run(~r/Pss:\s+(\d+)/, s)
        div(String.to_integer(kb), 1024)

      _ ->
        0
    end
  end
end

defmodule Stats do
  def median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
  def ms(us), do: Float.round(us / 1000, 1)

  def timed(f) do
    {us, v} = :timer.tc(f)
    {us, v}
  end
end

defmodule FC do
  # One Firecracker process: its API socket and its serial console (stdin/stdout)
  defstruct [:port, :sock, :os_pid, buf: "", seen: ""]

  def spawn(dir, id) do
    sock = Path.join(dir, "fc-#{id}.sock")
    File.rm(sock)

    port =
      Port.open({:spawn_executable, Path.join(dir, "firecracker")}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args: ["--api-sock", sock, "--level", "Error"]
      ])

    {:os_pid, os_pid} = Port.info(port, :os_pid)
    wait_for(fn -> File.exists?(sock) end)
    %FC{port: port, sock: sock, os_pid: os_pid}
  end

  def api!(fc, method, path, body) do
    {out, 0} =
      System.cmd("curl", [
        "-s", "--unix-socket", fc.sock, "-X", method, "http://localhost" <> path,
        "-H", "Content-Type: application/json", "-d", Jason.encode!(body), "-w", "\n%{http_code}"
      ])

    [code | _] = out |> String.split("\n") |> Enum.reverse()
    code in ["200", "204"] || raise "#{method} #{path}: #{out}"
  end

  # Read the console until it has printed `marker`
  def await(fc, marker, timeout \\ 60_000) do
    if String.contains?(fc.buf, marker) do
      [seen, rest] = String.split(fc.buf, marker, parts: 2)
      %{fc | buf: rest, seen: seen}
    else
      port = fc.port

      receive do
        {^port, {:data, d}} -> await(%{fc | buf: fc.buf <> d}, marker, timeout)
        {^port, {:exit_status, s}} -> raise "firecracker exited #{s}: #{fc.buf}"
      after
        timeout -> raise "no #{marker} on the console: #{String.slice(fc.buf, -500, 500)}"
      end
    end
  end

  def type(fc, line) do
    Port.command(fc.port, line <> "\n")
    fc
  end

  # A command typed into the guest, until its exit status comes back
  def run(fc, line) do
    fc |> type(line) |> await("FCDONE_")
  end

  def kill(fc) do
    System.cmd("kill", ["-9", "#{fc.os_pid}"])
    File.rm(fc.sock)
  end

  defp wait_for(f, n \\ 2000) do
    cond do
      f.() -> :ok
      n == 0 -> raise "timed out"
      true -> Process.sleep(1); wait_for(f, n - 1)
    end
  end
end

defmodule Bench do
  @compute ~s|python3 -c "import time;t=time.time();sum(i*i for i in range(3*10**6));print('SECS', round(time.time()-t,3))"|

  def run(argv) do
    {o, _} = OptionParser.parse!(argv, strict: [fc: :string, sg: :string, site: :string, wake_site: :string, n: :integer, reps: :integer])
    n = o[:n] || 50
    reps = o[:reps] || 10
    IO.puts("host: #{System.schedulers_online()} CPUs, #{Mem.available_mb()} MB available\n")
    fc = firecracker(Path.expand(o[:fc]), n, reps)
    sg = snowglobe(Path.expand(o[:sg]), Path.expand(o[:site]), n, reps)
    fork = forked(Path.expand(o[:sg]), Path.expand(o[:site]), n)
    up = daemon(Path.expand(o[:sg]), Path.expand(o[:site]), Path.expand(o[:wake_site] || o[:site]), n, reps)
    report([fc, sg, fork, up])
  end

  defp firecracker(dir, n, reps) do
    IO.puts("== firecracker")
    snap = Path.join(dir, "snap")
    File.mkdir_p!(snap)

    # Boot once, to the init's prompt, then snapshot: what every restore starts from
    {boot_us, base} =
      Stats.timed(fn ->
        fc = FC.spawn(dir, "base")
        FC.api!(fc, "PUT", "/boot-source", %{
          kernel_image_path: Path.join(dir, "vmlinux"),
          boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/fcinit"
        })
        FC.api!(fc, "PUT", "/drives/rootfs", %{
          drive_id: "rootfs", path_on_host: Path.join(dir, "rootfs.ext4"), is_root_device: true, is_read_only: true
        })
        FC.api!(fc, "PUT", "/machine-config", %{vcpu_count: 1, mem_size_mib: 512})
        FC.api!(fc, "PUT", "/actions", %{action_type: "InstanceStart"})
        FC.await(fc, "FCREADY")
      end)

    # Warm the guest as snowglobe's build does (its exercises): python's files in the page cache
    base = FC.run(base, "python3 -c 'import rich' && true")
    FC.api!(base, "PATCH", "/vm", %{state: "Paused"})
    mem_file = Path.join(snap, "mem")
    {snap_us, _} =
      Stats.timed(fn ->
        FC.api!(base, "PUT", "/snapshot/create", %{
          snapshot_type: "Full", snapshot_path: Path.join(snap, "vmstate"), mem_file_path: mem_file
        })
      end)
    FC.kill(base)

    restore = fn id ->
      fc = FC.spawn(dir, id)
      FC.api!(fc, "PUT", "/snapshot/load", %{
        snapshot_path: Path.join(snap, "vmstate"),
        mem_backend: %{backend_type: "File", backend_path: mem_file},
        resume_vm: true
      })
      fc
    end

    # One restored machine: to the API's answer, to a first command done, then commands
    {to_first, cmd, compute} =
      Enum.map(1..reps, fn i ->
        {first_us, fc} = Stats.timed(fn -> restore.("one#{i}") |> FC.run("true") end)
        {cmd_us, fc} = Stats.timed(fn -> FC.run(fc, "true") end)
        compute = if i <= 3, do: compute(fc), else: nil
        FC.kill(fc)
        {first_us, cmd_us, compute}
      end)
      |> unzip3()

    {launch_us, mem, pss} =
      density(n, fn i -> restore.("d#{i}") |> FC.run("true") end, fn fc -> Mem.pss_mb(fc.os_pid) end, &FC.kill/1)

    %{
      name: "Firecracker #{fc_version(dir)}",
      cold_boot: Stats.ms(boot_us),
      snapshot: Stats.ms(snap_us),
      first: Stats.median(to_first) |> Stats.ms(),
      cmd: Stats.median(cmd) |> Stats.ms(),
      compute: compute |> Enum.reject(&is_nil/1) |> Stats.median(),
      n: n, launch: Stats.ms(launch_us), mem: mem, pss: pss
    }
  end

  defp compute(%FC{} = fc) do
    fc = FC.run(fc, @compute)
    [_, secs] = Regex.run(~r/SECS (\d+\.\d+)/, fc.seen)
    String.to_float(secs)
  end

  defp snowglobe(dir, site, n, reps) do
    IO.puts("== snowglobe instances")
    sg = Path.join(dir, "snowglobe")
    env = [{"SNOWGLOBE_VM", Path.join(dir, "snowglobe-vm")}]
    cmd! = fn args -> {out, 0} = System.cmd(sg, args, env: env, stderr_to_stdout: true); out end
    start = fn name -> cmd!.(["run", site, "--runtime", "native", "--name", name, "--detach"]) end
    stop = fn name -> cmd!.(["stop", name]) end

    {to_first, cmd, compute} =
      Enum.map(1..reps, fn i ->
        name = "one#{i}"
        {first_us, _} = Stats.timed(fn -> start.(name); cmd!.(["sh", name, "true"]) end)
        {cmd_us, _} = Stats.timed(fn -> cmd!.(["sh", name, "true"]) end)
        compute =
          if i <= 3 do
            [_, s] = Regex.run(~r/SECS (\S+)/, cmd!.(["sh", name, @compute]))
            String.to_float(s)
          end
        stop.(name)
        {first_us, cmd_us, compute}
      end)
      |> unzip3()

    {launch_us, mem, pss} =
      density(n, fn i -> name = "d#{i}"; start.(name); cmd!.(["sh", name, "true"]); name end,
        fn name -> pid(name) |> Mem.pss_mb() end, stop)

    %{
      name: "snowglobe run --runtime native",
      first: Stats.median(to_first) |> Stats.ms(),
      cmd: Stats.median(cmd) |> Stats.ms(),
      compute: compute |> Enum.reject(&is_nil/1) |> Stats.median(),
      n: n, launch: Stats.ms(launch_us), mem: mem, pss: pss
    }
  end

  # snowglobe-vm's fork-per-job server: one restore, each job a copy-on-write fork of it
  defp forked(dir, site, n) do
    IO.puts("== snowglobe-vm --serve (a fork per job)")
    vm = Path.join(dir, "snowglobe-vm")
    root = Path.join(System.tmp_dir!(), "sgjobs")
    File.rm_rf!(root)
    File.mkdir_p!(Path.join(root, "w"))
    sock = Path.join(root, "s.sock")
    server = Port.open({:spawn_executable, vm}, [:binary, :stderr_to_stdout,
      args: ["run", site, "--serve", sock, "--jobs-root", root, "--max-jobs", "#{n + 4}"]])
    {:os_pid, spid} = Port.info(server, :os_pid)
    Enum.find(1..2000, fn _ -> Process.sleep(5); File.exists?(sock) end)
    job = fn cmd -> System.cmd(vm, ["run", site, "--server", sock, "--workspace", Path.join(root, "w"), "--cmd", cmd], stderr_to_stdout: true) end

    first = Enum.map(1..10, fn _ -> {us, {_, 0}} = Stats.timed(fn -> job.("true") end); us end)
    [_, s] = Regex.run(~r/SECS (\S+)/, elem(job.(@compute), 0))

    # N jobs that stay up (sleep) while the host's memory is read
    before = Mem.available_mb()
    {launch_us, tasks} =
      Stats.timed(fn ->
        tasks = for _ <- 1..n, do: Task.async(fn -> job.("echo up; sleep 25") end)
        # all started: every job's child process exists
        Enum.find(1..3000, fn _ -> Process.sleep(10); children(spid) >= n end)
        tasks
      end)
    Mem.settle()
    used = before - Mem.available_mb()
    pss = children_pids(spid) |> Enum.map(&Mem.pss_mb/1) |> Enum.sum()
    Task.await_many(tasks, 60_000)
    System.cmd("kill", ["#{spid}"])

    %{
      name: "snowglobe-vm --serve (fork per job)",
      first: Stats.median(first) |> Stats.ms(),
      cmd: nil,
      compute: String.to_float(s),
      n: n, launch: Stats.ms(launch_us), mem: used, pss: pss + Mem.pss_mb(spid)
    }
  end

  # The daemon: machines forked from a template (snowglobe up), commands through its API, and a
  # service at zero woken by a request (its template a snapshot with a server listening)
  defp daemon(dir, site, wake_site, n, reps) do
    IO.puts("== snowglobe daemon (up, and a service at zero)")
    sg = Path.join(dir, "snowglobe")
    ddir = Path.join(System.tmp_dir!(), "sgd-cap-#{System.os_time(:millisecond)}")
    File.mkdir_p!(ddir)
    env = [{"SNOWGLOBE_VM", Path.join(dir, "snowglobe-vm")}, {"SNOWGLOBE_DAEMON_DIR", ddir}]
    cmd! = fn args -> {out, 0} = System.cmd(sg, args, env: env, stderr_to_stdout: true); out end
    d = Port.open({:spawn_executable, sg}, [:binary, :stderr_to_stdout, args: ["daemon"],
      env: Enum.map(env, fn {k, v} -> {~c"#{k}", ~c"#{v}"} end)])
    {:os_pid, dpid} = Port.info(d, :os_pid)
    Enum.find(1..300, fn _ -> Process.sleep(100); match?({_, 0}, System.cmd(sg, ["template", "ls"], env: env, stderr_to_stdout: true)) end)
    try do
      measure_daemon(cmd!, site, wake_site, n, reps)
    after
      # Whatever happened: nothing of this run left running
      for args <- [["service", "rm", "web"], ["template", "rm", "cap-serving"], ["snapshot", "rm", "serving"], ["template", "rm", "cap-net"], ["template", "rm", "cap"]],
        do: System.cmd(sg, args, env: env, stderr_to_stdout: true)
      System.cmd("kill", ["#{dpid}"])
    end
  end

  defp measure_daemon(cmd!, site, wake_site, n, reps) do
    cmd!.(["template", "add", site, "--name", "cap"])

    {to_first, cmd, compute} =
      Enum.map(1..reps, fn i ->
        name = "one#{i}"
        {first_us, _} = Stats.timed(fn -> cmd!.(["up", "cap", "--name", name]); cmd!.(["sh", name, "true"]) end)
        {cmd_us, _} = Stats.timed(fn -> cmd!.(["sh", name, "true"]) end)
        compute =
          if i <= 3 do
            [_, s] = Regex.run(~r/SECS (\S+)/, cmd!.(["sh", name, @compute]))
            String.to_float(s)
          end
        cmd!.(["stop", name])
        {first_us, cmd_us, compute}
      end)
      |> unzip3()

    pids = fn ->
      for line <- String.split(cmd!.(["ps"]), "\n"), [_, name, pid] <- [Regex.run(~r/^(\S+)\ttemplate cap\t.*daemon \(pid (\d+)\)/, line)], into: %{},
        do: {name, pid}
    end
    {launch_us, mem, pss} =
      density(n, fn i -> name = "d#{i}"; cmd!.(["up", "cap", "--name", name]); cmd!.(["sh", name, "true"]); name end,
        fn name -> pids.()[name] |> Mem.pss_mb() end, fn name -> cmd!.(["stop", name]) end)

    # A service at zero: its template a snapshot whose server listens (of a site with a network)
    cmd!.(["template", "add", wake_site, "--name", "cap-net"])
    cmd!.(["up", "cap-net", "--name", "base"])
    cmd!.(["sh", "base", "python3 -m http.server 8000 >/dev/null 2>&1 &"])
    # Saved once it answers: a replica of the snapshot then has it listening
    cmd!.(["sh", "base", "for i in $(seq 120); do wget -q -O /dev/null http://127.0.0.1:8000/ && exit 0; sleep 0.5; done; exit 1"])
    cmd!.(["snapshot", "save", "base", "--name", "serving"])
    cmd!.(["stop", "base"])
    cmd!.(["template", "add", "--snapshot", "serving", "--name", "cap-serving"])
    [_, port] = Regex.run(~r/127\.0\.0\.1:(\d+)→8000/, cmd!.(["service", "add", "web", "--template", "cap-serving", "-p", "0:8000", "--idle", "2s"]))
    at_zero = fn -> Enum.find(1..200, fn _ -> Process.sleep(100); cmd!.(["service", "ls"]) =~ ~r/^web\tcap-serving\t0\t/m end) end
    wakes =
      for _ <- 1..min(reps, 5) do
        at_zero.()
        {us, {_, 0}} = Stats.timed(fn -> System.cmd("curl", ["-sf", "-m", "20", "-o", "/dev/null", "http://127.0.0.1:#{port}/"]) end)
        us
      end

    %{
      name: "snowglobe daemon (up)",
      first: Stats.median(to_first) |> Stats.ms(),
      cmd: Stats.median(cmd) |> Stats.ms(),
      compute: compute |> Enum.reject(&is_nil/1) |> Stats.median(),
      wake: Stats.median(wakes) |> Stats.ms(),
      n: n, launch: Stats.ms(launch_us), mem: mem, pss: pss
    }
  end

  # N machines at once: how long starting them all took, what the host lost, their PSS
  defp density(n, start, pss_of, stop) do
    before = Mem.available_mb()
    {us, handles} = Stats.timed(fn ->
      1..n |> Task.async_stream(start, max_concurrency: 8, timeout: 120_000) |> Enum.map(fn {:ok, h} -> h end)
    end)
    Mem.settle()
    used = before - Mem.available_mb()
    pss = handles |> Enum.map(pss_of) |> Enum.sum()
    Enum.each(handles, stop)
    {us, used, pss}
  end

  defp pid(name) do
    {out, _} = System.cmd("pgrep", ["-f", "snowglobe-vm.*instances/#{name}/"])
    out |> String.split() |> List.first()
  end

  defp children(ppid), do: length(children_pids(ppid))

  defp children_pids(ppid) do
    case System.cmd("pgrep", ["-P", "#{ppid}"]) do
      {out, 0} -> String.split(out)
      _ -> []
    end
  end

  defp fc_version(dir) do
    {v, 0} = System.cmd(Path.join(dir, "firecracker"), ["--version"])
    v |> String.split("\n") |> hd() |> String.replace("Firecracker ", "")
  end

  defp unzip3(l), do: {Enum.map(l, &elem(&1, 0)), Enum.map(l, &elem(&1, 1)), Enum.map(l, &elem(&1, 2))}

  defp report(rows) do
    IO.puts("\n| | #{Enum.map_join(rows, " | ", & &1.name)} |")
    IO.puts("|---|#{Enum.map_join(rows, "|", fn _ -> "---:" end)}|")
    line = fn label, f -> IO.puts("| #{label} | #{Enum.map_join(rows, " | ", f)} |") end
    line.("cold boot", &val(&1[:cold_boot], " ms"))
    line.("restore → first command done", &val(&1.first, " ms"))
    line.("a command (`true`) after that", &val(&1.cmd, " ms"))
    line.("python loop (3M squares)", &val(&1.compute, " s"))
    line.("a request to a service at zero → its answer", &val(&1[:wake], " ms"))
    line.("#{hd(rows).n} at once: all up", &val(&1.launch, " ms"))
    line.("#{hd(rows).n} at once: host memory used", &"#{&1.mem} MB (#{div(&1.mem, &1.n)} MB each)")
    line.("#{hd(rows).n} at once: PSS", &"#{&1.pss} MB (#{div(&1.pss, &1.n)} MB each)")
  end

  defp val(nil, _), do: "–"
  defp val(v, unit), do: "#{v}#{unit}"
end

Bench.run(System.argv())
