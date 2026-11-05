defmodule Crud.Store do
  @moduledoc """
  The items table in SQLite. One connection, in this process: requests take their turn, as
  SQLite writes one at a time anyway.
  """
  use GenServer
  alias Exqlite.Sqlite3

  def start_link(path), do: GenServer.start_link(__MODULE__, path, name: __MODULE__)

  def create(name, qty), do: GenServer.call(__MODULE__, {:create, name, qty})
  def list, do: GenServer.call(__MODULE__, :list)
  def read(id), do: GenServer.call(__MODULE__, {:read, id})
  def update(id, name, qty), do: GenServer.call(__MODULE__, {:update, id, name, qty})
  def delete(id), do: GenServer.call(__MODULE__, {:delete, id})

  @impl true
  def init(path) do
    File.mkdir_p!(Path.dirname(path))
    {:ok, db} = Sqlite3.open(path)
    :ok = Sqlite3.execute(db, "PRAGMA journal_mode=WAL")
    :ok = Sqlite3.execute(db, "PRAGMA synchronous=NORMAL")

    :ok =
      Sqlite3.execute(
        db,
        "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)"
      )

    {:ok, db}
  end

  @impl true
  def handle_call({:create, name, qty}, _from, db) do
    run(db, "INSERT INTO items (name, qty) VALUES (?1, ?2)", [name, qty])
    {:ok, id} = Sqlite3.last_insert_rowid(db)
    {:reply, id, db}
  end

  def handle_call(:list, _from, db) do
    rows = run(db, "SELECT id, name, qty FROM items ORDER BY id LIMIT 100", [])
    {:reply, Enum.map(rows, &item/1), db}
  end

  def handle_call({:read, id}, _from, db) do
    case run(db, "SELECT id, name, qty FROM items WHERE id = ?1", [id]) do
      [row] -> {:reply, item(row), db}
      [] -> {:reply, nil, db}
    end
  end

  def handle_call({:update, id, name, qty}, _from, db) do
    run(db, "UPDATE items SET name = ?1, qty = ?2 WHERE id = ?3", [name, qty, id])
    {:ok, n} = Sqlite3.changes(db)
    {:reply, if(n == 0, do: nil, else: %{id: id, name: name, qty: qty}), db}
  end

  def handle_call({:delete, id}, _from, db) do
    run(db, "DELETE FROM items WHERE id = ?1", [id])
    {:reply, :ok, db}
  end

  defp run(db, sql, args) do
    {:ok, stmt} = Sqlite3.prepare(db, sql)
    :ok = Sqlite3.bind(stmt, args)
    {:ok, rows} = Sqlite3.fetch_all(db, stmt)
    :ok = Sqlite3.release(db, stmt)
    rows
  end

  defp item([id, name, qty]), do: %{id: id, name: name, qty: qty}
end
