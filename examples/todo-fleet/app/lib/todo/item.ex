defmodule Todo.Item do
  @moduledoc "A todo: a title, done or not."
  use Ecto.Schema
  import Ecto.Changeset

  @derive {Jason.Encoder, only: [:id, :title, :done]}
  schema "todos" do
    field :title, :string
    field :done, :boolean, default: false
    timestamps()
  end

  def changeset(item, attrs) do
    item
    |> cast(attrs, [:title, :done])
    |> validate_required([:title])
    |> validate_length(:title, min: 1, max: 200)
  end
end
