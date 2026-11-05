defmodule Todo.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [Todo.Repo, Todo.Web]
    Supervisor.start_link(children, strategy: :one_for_one, name: Todo.Supervisor)
  end
end
