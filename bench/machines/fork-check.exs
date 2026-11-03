#!/usr/bin/env elixir
# Many jobs at once on a prewarmed fork server, each computing something of its own (and
# compiling code of its own): every answer must be right.
# elixir bench/machines/fork-check.exs --vm PATH --site DIR [--n 30] [--rounds 3]

defmodule ForkCheck do
  def run(argv) do
    {o, _} = OptionParser.parse!(argv, strict: [vm: :string, site: :string, n: :integer, rounds: :integer])
    vm = Path.expand(o[:vm])
    site = Path.expand(o[:site])
    n = o[:n] || 30
    dir = Path.join(System.tmp_dir!(), "fc-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "jobs/ws"))
    log = Path.join(dir, "log")
    port = Port.open({:spawn_executable, "/bin/sh"}, [:binary, args: ["-c", ~s[cd "#{dir}" && exec "#{vm}" run "#{site}" --serve s.sock --jobs-root jobs 2>"#{log}"]]])
    wait(log, 600)
    IO.puts(File.read!(log) |> String.trim())

    bad =
      for round <- 1..(o[:rounds] || 3), reduce: 0 do
        acc ->
          results =
            1..n
            |> Task.async_stream(fn i -> {i, job(vm, dir, cmd(i, round))} end, max_concurrency: n, timeout: 300_000)
            |> Enum.map(fn {:ok, r} -> r end)

          wrong = for {i, out} <- results, String.trim(out) != expected(i, round), do: {i, out}
          IO.puts("round #{round}: #{n - length(wrong)}/#{n} right")
          Enum.each(Enum.take(wrong, 3), fn {i, out} -> IO.puts("  job #{i}: #{inspect(String.slice(out, 0, 200))}") end)
          acc + length(wrong)
      end

    {:os_pid, pid} = Port.info(port, :os_pid)
    System.cmd("kill", ["#{pid}"])
    File.rm_rf!(dir)
    if bad > 0, do: System.halt(1)
  end

  # Each job different: a loop, string work and a dict, with numbers of its own
  defp cmd(i, r), do: ~s|python3 -c "n=#{i * 1000 + r}; s=sum(k*k % 97 for k in range(n)); d={str(k): k for k in range(#{i})}; print(s, len(d), '-'.join(str(k) for k in sorted(d.values())[-3:]))"|

  defp expected(i, r) do
    n = i * 1000 + r
    s = Enum.reduce(0..(n - 1)//1, 0, fn k, a -> a + rem(k * k, 97) end)
    last = Enum.take(0..(i - 1)//1 |> Enum.to_list(), -3) |> Enum.join("-")
    "#{s} #{i} #{last}"
  end

  defp wait(log, 0), do: raise("not ready: #{File.read!(log)}")

  defp wait(log, k) do
    case File.read(log) do
      {:ok, s} -> if s =~ "serving jobs", do: :ok, else: (Process.sleep(100); wait(log, k - 1))
      _ -> (Process.sleep(100); wait(log, k - 1))
    end
  end

  defp job(vm, dir, cmd) do
    {out, _} = System.cmd(vm, ["run", "--server", "s.sock", "--workspace", "jobs/ws", "--cmd", cmd], cd: dir, stderr_to_stdout: true)
    out
  end
end

ForkCheck.run(System.argv())
