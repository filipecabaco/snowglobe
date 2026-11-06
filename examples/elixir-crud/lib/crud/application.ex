defmodule Crud.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    path = System.get_env("CRUD_DB", "/var/lib/crud/items.db")

    children = [
      {Crud.Store, path},
      {Bandit, plug: Crud.Router, ip: {127, 0, 0, 1}, port: 8080}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Crud.Supervisor)
  end
end
