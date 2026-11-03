#!/usr/bin/env elixir
# Firecracker-style numbers for snowglobe's runtimes: restore, exec latency, memory, density.
# elixir bench/machines/instances.exs --snowglobe PATH --sites DIR [--runtimes native,docker] [--reps 5] [--density 10]

Mix.install([{:table_rex, "~> 4.1"}])

defmodule FC do
  def run(argv) do
    {o, _} =
      OptionParser.parse!(argv,
        strict: [snowglobe: :string, sites: :string, runtimes: :string, reps: :integer, density: :integer]
      )

    sg = Path.expand(o[:snowglobe] || "./snowglobe")
    sites = Path.expand(o[:sites])
    reps = o[:reps] || 5
    runtimes = String.split(o[:runtimes] || "native,docker", ",")
    demos = sites |> File.ls!() |> Enum.filter(&File.exists?(Path.join([sites, &1, "run.json"]))) |> Enum.sort()

    rows =
      for rt <- runtimes, d <- demos do
        dir = Path.join(sites, d)
        oneshot = median(for _ <- 1..reps, do: timed(fn -> sh(sg, "echo true | #{sg} run #{dir} --runtime #{rt}") end))
        name = "fcb-#{rt}-#{d}"
        start = timed(fn -> cmd!(sg, ["run", dir, "--runtime", rt, "--name", name, "--detach"]) end)
        cmd!(sg, probe(rt, name))
        exec = median(for _ <- 1..(reps * 2), do: timed(fn -> cmd!(sg, probe(rt, name)) end))
        Process.sleep(2000)
        rss = rss(rt, name)
        cmd!(sg, ["stop", name])
        [rt, d, ms(oneshot), ms(start), ms(exec), "#{rss} MB"]
      end

    IO.puts(TableRex.quick_render!(rows, ["runtime", "demo", "one-shot run", "detached start", "sh 'true'", "idle RSS"]))

    if n = o[:density] do
      for rt <- runtimes, do: density(sg, rt, Path.join(sites, hd(demos)), n)
    end
  end

  # N instances of one site at once: what each costs, and how long starting them all took
  defp density(sg, rt, dir, n) do
    names = for i <- 1..n, do: "fcd-#{rt}-#{i}"

    t =
      timed(fn ->
        names
        |> Task.async_stream(&cmd!(sg, ["run", dir, "--runtime", rt, "--name", &1, "--detach"]),
          max_concurrency: n, timeout: 120_000)
        |> Stream.run()
      end)

    Enum.each(names, &cmd!(sg, probe(rt, &1)))
    Process.sleep(2000)
    total = names |> Enum.map(&rss(rt, &1)) |> Enum.sum()
    Enum.each(names, &cmd!(sg, ["stop", &1]))
    IO.puts("#{rt}: #{n} × #{Path.basename(dir)} started in #{ms(t)}, #{total} MB RSS in all (#{div(total, n)} MB each)")
  end

  defp probe("native", name), do: ["sh", name, "true"]
  defp probe(_, name), do: ["exec", name, "true"]

  defp rss("native", name) do
    {pids, _} = System.cmd("pgrep", ["-f", "snowglobe-vm.*instances/#{name}/"])
    pid = pids |> String.split() |> List.first()
    {kb, _} = System.cmd("ps", ["-o", "rss=", "-p", pid])
    div(String.to_integer(String.trim(kb)), 1024)
  end

  defp rss("docker", name) do
    {out, 0} = System.cmd("docker", ["exec", name, "sh", "-c", "cat /proc/$(pgrep -o snowglobe-vm)/status"])
    [_, kb] = Regex.run(~r/VmRSS:\s+(\d+)/, out)
    div(String.to_integer(kb), 1024)
  end

  defp cmd!(sg, args) do
    case System.cmd(sg, args, stderr_to_stdout: true) do
      {_, 0} -> :ok
      {out, s} -> raise "snowglobe #{Enum.join(args, " ")} exited #{s}: #{out}"
    end
  end

  defp sh(_sg, line) do
    {out, s} = System.shell(line, stderr_to_stdout: true)
    s == 0 || raise "#{line} exited #{s}: #{out}"
  end

  defp timed(f) do
    {us, _} = :timer.tc(f)
    us / 1000
  end

  defp median(xs), do: xs |> Enum.sort() |> Enum.at(div(length(xs), 2))
  defp ms(x), do: "#{round(x)} ms"
end

FC.run(System.argv())
