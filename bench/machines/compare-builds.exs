#!/usr/bin/env elixir
# Commands on several builds' instances, interleaved round-robin so drift hits all alike:
# median and spread per build and command.
# elixir bench/machines/compare-builds.exs --build NAME=DIR ... --site DIR [--reps 9]

Mix.install([{:table_rex, "~> 4.1"}])

defmodule Interleave do
  @cmds [
    {"loop 3M", ~S[python3 -c "print(sum(i*i for i in range(3000000)))"]},
    {"import rich.table", ~S[python3 -c "import rich.table"]},
    {"true", "true"}
  ]

  def run(argv) do
    {o, _} = OptionParser.parse!(argv, strict: [build: :keep, site: :string, reps: :integer])
    builds = for {:build, s} <- o, do: s |> String.split("=", parts: 2) |> then(fn [k, v] -> {k, Path.expand(v)} end)
    site = Path.expand(o[:site])
    reps = o[:reps] || 9
    env = fn dir -> [{"SNOWGLOBE_VM", Path.join(dir, "snowglobe-vm")}] end
    sg = fn dir -> Path.join(dir, "snowglobe") end

    for {n, dir} <- builds do
      {_, 0} = System.cmd(sg.(dir), ["run", site, "--runtime", "native", "--name", "il-#{n}", "--detach"], env: env.(dir), stderr_to_stdout: true)
      for {_, c} <- @cmds, do: sh(sg.(dir), "il-#{n}", c, env.(dir))
    end

    samples =
      for _ <- 1..reps, {cn, c} <- @cmds, {n, dir} <- builds, reduce: %{} do
        acc ->
          {us, _} = :timer.tc(fn -> sh(sg.(dir), "il-#{n}", c, env.(dir)) end)
          Map.update(acc, {n, cn}, [us / 1000], &[us / 1000 | &1])
      end

    for {n, dir} <- builds, do: System.cmd(sg.(dir), ["stop", "il-#{n}"], env: env.(dir))

    rows =
      for {n, _} <- builds do
        [n | for({cn, _} <- @cmds, do: fmt(samples[{n, cn}]))]
      end

    IO.puts(TableRex.quick_render!(rows, ["build" | Enum.map(@cmds, &elem(&1, 0))]))
  end

  defp fmt(xs) do
    s = Enum.sort(xs)
    "#{round(Enum.at(s, div(length(s), 2)))} ms (#{round(hd(s))}–#{round(List.last(s))})"
  end

  defp sh(sg, name, cmd, env) do
    {out, s} = System.cmd(sg, ["sh", name, cmd], env: env, stderr_to_stdout: true)
    s == 0 || raise "#{cmd}: #{out}"
  end
end

Interleave.run(System.argv())
