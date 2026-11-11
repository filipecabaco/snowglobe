defmodule PostgresTab do
  @moduledoc """
  A PostgreSQL server inside this browser tab, reached through Ecto and Postgrex: Alpine's own
  postgres binary for 64-bit ARM Linux, running on an emulated ARM CPU next to this BEAM.
  """

  alias PostgresTab.Repo

  @doc "Runs any SQL statement and prints the result as a table."
  def sql(statement, params \\ []) do
    %{columns: columns, rows: rows, num_rows: count} = Repo.query!(statement, params)
    # Statements like INSERT or CREATE return no columns and no rows, only a count; SHOW returns a
    # row but no count
    if columns not in [nil, []] and is_list(rows), do: IO.puts(table(columns, rows))
    count = if is_list(rows) and rows != [], do: length(rows), else: count || 0
    IO.puts(IO.ANSI.faint() <> "#{count} row(s)" <> IO.ANSI.reset())
    IEx.dont_display_result()
  end

  defp table(columns, rows) do
    cells = Enum.map(rows, fn row -> Enum.map(row, &cell/1) end)

    widths =
      Enum.zip_with([columns | cells], fn col ->
        col |> Enum.map(&String.length/1) |> Enum.max()
      end)

    line = fn row ->
      row |> Enum.zip(widths) |> Enum.map_join(" │ ", fn {v, w} -> String.pad_trailing(v, w) end)
    end

    rule = Enum.map_join(widths, "─┼─", &String.duplicate("─", &1))

    Enum.join(
      [IO.ANSI.bright() <> line.(columns) <> IO.ANSI.reset(), rule | Enum.map(cells, line)],
      "\n"
    )
  end

  defp cell(nil), do: "NULL"
  defp cell(value) when is_binary(value), do: value
  defp cell(value), do: inspect(value)
end
