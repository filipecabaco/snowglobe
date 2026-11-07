# DuckDB: the DuckDB CLI for analytical SQL over CSV, Parquet and JSON files, with a few small
# sample files in /root/data. DuckDB's own musl build of the CLI (it needs libstdc++), pinned by checksum: Alpine has no
# duckdb package. No network: data comes in as files.
FROM alpine:3.24.2

ARG DUCKDB_VERSION=2.0.0
ARG DUCKDB_SHA256=59aee3049c335917307f5df1b3722af1335fef99199dc89e8064d1b2838620c7
ADD --checksum=sha256:${DUCKDB_SHA256} \
    https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb-cli-linux-arm64-musl.tar.gz /tmp/duckdb.tar.gz
RUN apk add --no-cache libstdc++ && \
    tar -xzf /tmp/duckdb.tar.gz -C /usr/local/bin duckdb && rm /tmp/duckdb.tar.gz && \
    printf '%s\n' \
      '' \
      '  DuckDB: SQL over CSV, Parquet and JSON files, in this tab. Try:' \
      '' \
      "    select type, count(*), sum(moons) from 'data/planets.csv' group by type;" \
      "    select region, sum(units * price) as revenue from 'data/sales.csv' group by region order by revenue desc;" \
      "    select user, avg(ms) from 'data/events.json' group by user;" \
      "    copy (select * from 'data/sales.csv') to 'sales.parquet'; select count(*) from 'sales.parquet';" \
      '' \
      '  In a shell: duckdb -c "select 6 * 7"' \
      '' > /etc/motd-duckdb

COPY data /root/data
# -dark-mode: the CLI would otherwise wait 5 seconds for a terminal that answers its colour query
ENV LANG=C.UTF-8
WORKDIR /root
CMD ["/bin/sh", "-c", "cat /etc/motd-duckdb; exec duckdb -dark-mode"]

# One of the agent page's machines (/agent/ on the demo site): agents run commands in it and copy
# files to and from the others, by its form or by WebMCP tools (shared with chatgpt.com too). Its
# commands run in the machine's root shell, from /root, not at the DuckDB prompt:
# duckdb -c "select ... from 'data/sales.csv'" or duckdb file.db < query.sql
LABEL snowglobe.title="DuckDB in the browser" \
      snowglobe.memory="512" \
      snowglobe.ready="D " \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="DuckDB for analytics: SQL over CSV, Parquet and JSON files." \
      snowglobe.agent-sample="duckdb -c 'select 6 * 7'" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["select type, count(*), sum(moons) from '"'"'data/planets.csv'"'"' group by type;", "select region, sum(units * price) as revenue from '"'"'data/sales.csv'"'"' group by region order by revenue desc;", "select user, avg(ms) from '"'"'data/events.json'"'"' group by user;", "copy (select * from '"'"'data/sales.csv'"'"') to '"'"'sales.parquet'"'"'; select count(*) from '"'"'sales.parquet'"'"';"]'
