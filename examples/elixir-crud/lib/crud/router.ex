defmodule Crud.Router do
  @moduledoc """
  A small CRUD API over SQLite: items with a name and a quantity.

      POST   /items        {"name": "...", "qty": N}  -> 201 {"id": N}
      GET    /items                                   -> 200 [{...}, ...] (the first 100)
      GET    /items/:id                               -> 200 {...} | 404
      PUT    /items/:id    {"name": "...", "qty": N}  -> 200 {...} | 404
      DELETE /items/:id                               -> 204
  """
  use Plug.Router

  plug :match
  plug Plug.Parsers, parsers: [:json], json_decoder: JSON, pass: ["application/json"]
  plug :dispatch

  post "/items" do
    with {:ok, name, qty} <- item(conn.body_params) do
      json(conn, 201, %{id: Crud.Store.create(name, qty)})
    else
      :error -> json(conn, 400, %{error: ~s(expected {"name": "...", "qty": N})})
    end
  end

  get "/items" do
    json(conn, 200, Crud.Store.list())
  end

  get "/items/:id" do
    with {:ok, id} <- id(id), %{} = item <- Crud.Store.read(id) do
      json(conn, 200, item)
    else
      _ -> json(conn, 404, %{error: "not found"})
    end
  end

  put "/items/:id" do
    with {:ok, id} <- id(id),
         {:ok, name, qty} <- item(conn.body_params),
         %{} = item <- Crud.Store.update(id, name, qty) do
      json(conn, 200, item)
    else
      :error -> json(conn, 400, %{error: ~s(expected {"name": "...", "qty": N})})
      _ -> json(conn, 404, %{error: "not found"})
    end
  end

  delete "/items/:id" do
    with {:ok, id} <- id(id), do: Crud.Store.delete(id)
    send_resp(conn, 204, "")
  end

  match _ do
    json(conn, 404, %{error: "not found"})
  end

  defp item(%{"name" => name, "qty" => qty}) when is_binary(name) and is_integer(qty),
    do: {:ok, name, qty}

  defp item(_), do: :error

  defp id(s) do
    case Integer.parse(s) do
      {id, ""} -> {:ok, id}
      _ -> :error
    end
  end

  defp json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, JSON.encode!(body))
  end
end
