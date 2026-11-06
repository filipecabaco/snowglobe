defmodule Crud.MixProject do
  use Mix.Project

  def project do
    [
      app: :crud,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [crud: [include_executables_for: [:unix]]]
    ]
  end

  def application do
    [extra_applications: [:logger], mod: {Crud.Application, []}]
  end

  defp deps do
    [
      {:bandit, "~> 1.8"},
      {:plug, "~> 1.18"},
      {:exqlite, "~> 0.33"}
    ]
  end
end
