# The todo fleet's app: Francis (HTTP) with Ecto and Postgrex, in a Mix release on Elixir 1.20.5
# and Erlang/OTP 29.1.2. It reaches Postgres as db.internal:5432, a link the fleet makes to the db
# service (see ../snowglobe.toml).
FROM hexpm/elixir:1.20.5-erlang-29.1.2-alpine-3.24.3 AS build
RUN apk add --no-cache git build-base
ENV MIX_ENV=prod LANG=C.UTF-8
WORKDIR /src
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config config
RUN mix deps.get --only prod && mix deps.compile
COPY lib lib
RUN mix release --path /release

FROM alpine:3.24.3
RUN apk add --no-cache libstdc++ libgcc ncurses-libs zlib libcrypto3 lksctp-tools
COPY --from=build /release /app
COPY start.sh /app/start.sh

ENV LANG=C.UTF-8 HOME=/root RELEASE_DISTRIBUTION=none
WORKDIR /root
CMD ["/app/start.sh"]

LABEL snowglobe.title="Todo app (Francis + Ecto)" \
      snowglobe.ready="todo app on port 4000" \
      snowglobe.memory="512" snowglobe.cpus="2" snowglobe.build-cpus="2"
