#!/usr/bin/env elixir
# Jobs on a fork server, with the parent's JIT prewarm and without (ARMLESS_JIT_PREWARM=off):
# wall time per workload (median), and what the parent said when it was ready.
# elixir bench/machines/fork-jit.exs --vm PATH --site DIR [--reps 5]

Mix.install([{:table_rex, "~> 4.1"}])

defmodule ForkJit do
  @workloads [
    {"true", "true"},
    {"python3 -c 1", "python3 -c 1"},
    {"rich table", ~S[python3 -c "from rich.console import Console; from rich.table import Table; t=Table('a','b'); t.add_row('1','2'); Console().print(t)"]},
    {"loop 300k", ~S[python3 -c "print(sum(i*i for i in range(300000)))"]}
  ]

  def run(argv) do
    {o, _} = OptionParser.parse!(argv, strict: [vm: :string, site: :string, reps: :integer])
    vm = Path.expand(o[:vm])
    site = Path.expand(o[:site])
    reps = o[:reps] || 5

    results =
      for mode <- ["prewarm", "off"] do
        dir = Path.join(System.tmp_dir!(), "fj-#{mode}-#{System.unique_integer([:positive])}")
        File.mkdir_p!(Path.join(dir, "jobs/ws"))
        env = if mode == "off", do: [{"ARMLESS_JIT_PREWARM", "off"}], else: []
        log = Path.join(dir, "log")
        # A relative socket path: sun_path is short
        port =
          Port.open({:spawn_executable, "/bin/sh"}, [
            :binary,
            args: ["-c", ~s[cd "#{dir}" && exec "#{vm}" run "#{site}" --serve s.sock --jobs-root jobs 2>"#{log}"]],
            env: Enum.map(env, fn {k, v} -> {~c"#{k}", ~c"#{v}"} end)
          ])

        ready = wait_ready(log, 600)
        times =
          for {name, cmd} <- @workloads do
            ms = for _ <- 1..reps, do: job(vm, dir, cmd)
            {name, median(ms)}
          end

        {par, _} = :timer.tc(fn ->
          1..10 |> Task.async_stream(fn _ -> job(vm, dir, elem(Enum.at(@workloads, 2), 1)) end, max_concurrency: 10, timeout: 120_000) |> Stream.run()
        end)

        {:os_pid, pid} = Port.info(port, :os_pid)
        System.cmd("kill", ["#{pid}"])
        File.rm_rf!(dir)
        {mode, ready, times, par / 1000}
      end

    names = Enum.map(@workloads, &elem(&1, 0))
    rows =
      for {mode, _, times, par} <- results do
        [mode | Enum.map(times, fn {_, ms} -> "#{round(ms)} ms" end)] ++ ["#{round(par)} ms"]
      end

    IO.puts(TableRex.quick_render!(rows, ["parent" | names] ++ ["10 rich at once"]))
    for {mode, ready, _, _} <- results, do: IO.puts("#{mode}: #{ready}")
  end

  defp wait_ready(log, 0), do: raise("not ready: #{File.read!(log)}")

  defp wait_ready(log, n) do
    case File.read(log) do
      {:ok, s} ->
        if s =~ "serving jobs", do: String.trim(s), else: (Process.sleep(100); wait_ready(log, n - 1))

      _ ->
        Process.sleep(100)
        wait_ready(log, n - 1)
    end
  end

  defp job(vm, dir, cmd) do
    {us, {out, s}} =
      :timer.tc(fn -> System.cmd(vm, ["run", "--server", "s.sock", "--workspace", "jobs/ws", "--cmd", cmd], cd: dir, stderr_to_stdout: true) end)

    s == 0 || raise "#{cmd}: exit #{s}: #{out}"
    us / 1000
  end

  defp median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
end

ForkJit.run(System.argv())
