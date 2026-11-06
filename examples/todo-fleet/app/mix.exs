defmodule Todo.MixProject do
  use Mix.Project

  def project do
    [
      app: :todo,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [todo: [include_executables_for: [:unix]]]
    ]
  end

  def application do
    [extra_applications: [:logger], mod: {Todo.Application, []}]
  end

  defp deps do
    [
      {:francis, "~> 0.4"},
      {:ecto_sql, "~> 3.14"},
      {:postgrex, "~> 0.22"}
    ]
  end
end
