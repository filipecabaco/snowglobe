defmodule PostgresTab.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    Supervisor.start_link([PostgresTab.Repo], strategy: :one_for_one, name: PostgresTab.Supervisor)
  end
end
