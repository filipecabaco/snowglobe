#!/usr/bin/env elixir
# An Exclave-shaped workflow on a snowglobe toolkit bundle: every step is a job in a sandbox of
# its own, restored fresh from the snapshot (no Docker, KVM or Firecracker), and a step's out/
# is the next step's in/. Two branches run at once:
#
#   fixtures -> rasterize (poppler) -> ocr (tesseract, one sandbox per page) -> extract (python)
#     -> report (jq, sqlite)
#   media (ffmpeg, vips)
#
#   snowglobe build examples/toolkit --sandbox --out dist/toolkit
#   snowglobe bundle dist/toolkit -o toolkit
#   elixir examples/toolkit/workflow.exs ./toolkit [--keep DIR]
#
# Each step's files are examples/toolkit/steps/<step>/ (its main.sh is the command), as an
# Exclave template's are; assigns arrive as EXCLAVE_ASSIGNS.

defmodule Workflow do
  @steps Path.join(__DIR__, "steps")
  @chain ~w(fixtures rasterize ocr extract report)
  # Steps that run once per input file, all at once, their out/ merged for the next step
  @fan_out ~w(ocr)

  def run(argv) do
    {opts, args} = OptionParser.parse!(argv, strict: [keep: :string])
    bundle = Path.expand(List.first(args) || "./toolkit")
    File.exists?(bundle) || halt("no bundle at #{bundle}: snowglobe bundle dist/toolkit -o toolkit")
    keep = opts[:keep] && Path.expand(opts[:keep])
    root = keep || Path.join(System.tmp_dir!(), "snowglobe-workflow-#{System.unique_integer([:positive])}")
    File.rm_rf!(root)
    File.mkdir_p!(root)

    IO.puts(IO.ANSI.format([:bright, "Workflow on ", :normal, bundle, "\n"]))
    {micros, results} =
      :timer.tc(fn ->
        [
          Task.async(fn -> chain(bundle, root, @chain) end),
          Task.async(fn -> [step(bundle, root, "media", nil)] end)
        ]
        |> Task.await_many(:infinity)
        |> List.flatten()
      end)

    summary(results, micros)
    report = Path.join([root, "report", "out", "report.csv"])
    sheet = Path.join([root, "media", "out", "contact-sheet.png"])
    if File.exists?(report), do: IO.puts("report:        #{report}")
    if File.exists?(sheet), do: IO.puts("contact sheet: #{sheet}")
    unless keep, do: IO.puts(IO.ANSI.format([:faint, "(--keep DIR keeps every step's workspace)"]))
    if Enum.any?(results, &(&1.status != 0)), do: System.halt(1)
  end

  # Each step starts from the previous one's out/; a failed step ends the chain
  defp chain(bundle, root, steps) do
    Enum.reduce_while(steps, {[], nil}, fn name, {done, input} ->
      r = if name in @fan_out and input, do: fan_out(bundle, root, name, input), else: step(bundle, root, name, input)
      if r.status == 0, do: {:cont, {[r | done], r.out}}, else: {:halt, {[r | done], nil}}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  # One sandbox per input file, as many at once as there are cores
  defp fan_out(bundle, root, name, input) do
    files = File.ls!(input) |> Enum.sort()
    merged = Path.join([root, name, "out"])
    File.mkdir_p!(merged)

    {micros, parts} =
      :timer.tc(fn ->
        files
        |> Enum.with_index(1)
        |> Task.async_stream(
          fn {file, i} ->
            only = Path.join([root, "#{name}.in", "#{i}"])
            File.mkdir_p!(only)
            File.cp!(Path.join(input, file), Path.join(only, file))
            step(bundle, root, "#{name}", only, "#{name}-#{i}")
          end,
          max_concurrency: System.schedulers_online(),
          timeout: :infinity
        )
        |> Enum.map(fn {:ok, r} -> r end)
      end)

    for p <- parts, File.dir?(p.out), do: File.cp_r!(p.out, merged)
    status = Enum.find_value(parts, 0, &(&1.status != 0 && &1.status))
    %{name: "#{name} ×#{length(parts)}", status: status, micros: micros, out: merged, files: length(File.ls!(merged))}
  end

  defp step(bundle, root, name, input, dir \\ nil) do
    ws = Path.join(root, dir || name)
    File.mkdir_p!(ws)
    File.cp_r!(Path.join(@steps, name), ws)
    if input, do: File.cp_r!(input, Path.join(ws, "in"))
    assigns = JSON.encode!(%{step: name, workflow: "invoices"})

    {micros, {output, status}} =
      :timer.tc(fn ->
        System.cmd(bundle, ["--workspace", ws, "--cmd", "sh main.sh", "--env", "EXCLAVE_ASSIGNS=" <> assigns],
          stderr_to_stdout: true
        )
      end)

    out = Path.join(ws, "out")
    files = if File.dir?(out), do: length(File.ls!(out)), else: 0
    colour = if status == 0, do: :green, else: :red

    IO.puts(
      IO.ANSI.format([colour, "▸ #{name}", :reset, :faint, "  #{ms(micros)} · exit #{status} · #{files} files out\n", :reset])
    )

    output |> String.trim_trailing() |> String.split("\n") |> Enum.take(14) |> Enum.each(&IO.puts("    " <> &1))
    IO.puts("")
    %{name: name, status: status, micros: micros, out: out, files: files}
  end

  defp summary(results, micros) do
    IO.puts(IO.ANSI.format([:bright, "Step          time      exit  out/"]))
    for r <- results do
      IO.puts(
        String.pad_trailing(r.name, 13) <>
          String.pad_leading(ms(r.micros), 8) <> String.pad_leading("#{r.status}", 7) <> String.pad_leading("#{r.files}", 6)
      )
    end

    IO.puts(IO.ANSI.format([:bright, "\n#{length(results)} sandboxed jobs in #{ms(micros)}", :normal, " (two branches at once)\n"]))
  end

  defp ms(micros), do: "#{div(micros, 1000)} ms"

  defp halt(msg) do
    IO.puts(:stderr, msg)
    System.halt(2)
  end
end

Workflow.run(System.argv())
