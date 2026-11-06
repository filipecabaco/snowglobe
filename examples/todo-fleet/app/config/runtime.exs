import Config

# db.internal is the fleet's link to the db service (see snowglobe.toml). The site is
# snapshotted without a database around, so the pool retries every second rather than backing
# off for longer: the first requests after a restore find it.
config :todo, Todo.Repo,
  url: System.get_env("DATABASE_URL", "ecto://postgres@db.internal:5432/todo"),
  pool_size: 4,
  backoff_type: :rand,
  backoff_min: 200,
  backoff_max: 1_000,
  show_sensitive_data_on_connection_error: false
