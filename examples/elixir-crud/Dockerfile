# Elixir CRUD API over SQLite: Bandit and Plug, with Exqlite, in a Mix release, on the newest
# Elixir and Erlang/OTP. The snapshot holds the server running and warm; a job drives it with
# crud-bench (ApacheBench).
FROM hexpm/elixir:1.20.5-erlang-29.1.2-alpine-3.24.3 AS build
RUN apk add --no-cache git build-base
ENV MIX_ENV=prod LANG=C.UTF-8 EXQLITE_FORCE_BUILD=true
WORKDIR /src
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config config
RUN mix deps.get --only prod && mix deps.compile
COPY lib lib
RUN mix release --path /release

# The release carries its own Erlang runtime: the same Alpine as the build, with the libraries
# that runtime links (OpenSSL's libcrypto for :crypto)
FROM alpine:3.24.3
RUN apk add --no-cache libstdc++ libgcc ncurses-libs zlib libcrypto3 lksctp-tools apache2-utils
COPY --from=build /release /app
COPY start.sh /app/start.sh
COPY crud-bench /usr/local/bin/crud-bench

# A guest is one node: no distribution
ENV LANG=C.UTF-8 HOME=/root RELEASE_DISTRIBUTION=none
WORKDIR /root
CMD ["/app/start.sh"]

# The BEAM starts one scheduler per CPU it sees: booting on the 2 CPUs it ships with keeps its
# scheduler view true
LABEL snowglobe.title="Elixir CRUD API (SQLite)" \
      snowglobe.ready="crud API on http://127.0.0.1:8080/items" \
      snowglobe.memory="640" snowglobe.cpus="2" snowglobe.build-cpus="2" \
      snowglobe.exercise='["crud-bench 200"]'
