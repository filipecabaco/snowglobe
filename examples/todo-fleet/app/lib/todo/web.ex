defmodule Todo.Web do
  @moduledoc """
  The todo app over HTTP on port 4000:

      GET    /             the page
      GET    /todos        -> 200 [{"id", "title", "done"}, ...]
      POST   /todos        {"title": "..."}            -> 201 {...} | 422
      PATCH  /todos/:id    {"done": true}, {"title"}   -> 200 {...} | 404 | 422
      DELETE /todos/:id                                -> 204
  """
  use Francis, bandit_opts: [ip: {0, 0, 0, 0}, port: 4000]
  import Ecto.Query
  alias Todo.{Item, Repo}

  get("/", fn conn ->
    conn
    |> Plug.Conn.put_resp_content_type("text/html")
    |> Plug.Conn.send_resp(200, Todo.Page.html())
  end)

  get("/todos", fn _conn -> Repo.all(from i in Item, order_by: i.id) end)

  post("/todos", fn conn ->
    case Repo.insert(Item.changeset(%Item{}, conn.body_params)) do
      {:ok, item} -> json(conn, 201, item)
      {:error, changeset} -> json(conn, 422, %{errors: errors(changeset)})
    end
  end)

  patch("/todos/:id", fn conn ->
    with {id, ""} <- Integer.parse(conn.params["id"]),
         %Item{} = item <- Repo.get(Item, id),
         {:ok, item} <- Repo.update(Item.changeset(item, conn.body_params)) do
      json(conn, 200, item)
    else
      {:error, %Ecto.Changeset{} = changeset} -> json(conn, 422, %{errors: errors(changeset)})
      _ -> json(conn, 404, %{error: "not found"})
    end
  end)

  delete("/todos/:id", fn conn ->
    with {id, ""} <- Integer.parse(conn.params["id"]) do
      Repo.delete_all(from i in Item, where: i.id == ^id)
    end

    Plug.Conn.send_resp(conn, 204, "")
  end)

  unmatched(fn conn -> json(conn, 404, %{error: "not found"}) end)

  defp errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, _opts} -> message end)
  end
end
