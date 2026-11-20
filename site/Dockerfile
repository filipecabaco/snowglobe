# snowglobe's site as Fly serves it: server.exs (Francis) with its templates, the files in static/,
# and the demos in dist/ (the CI and site workflow moves the assembled dist/ in here). Built from
# site/: `fly deploy --remote-only` there.
FROM elixir:1.20-alpine

RUN mix local.hex --force && mix local.rebar --force
ENV MIX_INSTALL_DIR=/opt/mix-installs DIST_DIR=/app/dist PORT=8080

WORKDIR /app
COPY server.exs cards.json ./
COPY templates templates
# Its dependencies compiled now, not as a machine starts; and every page rendered once, so a
# template that doesn't render fails the build, not the machine
RUN elixir server.exs --no-start

COPY static static
COPY dist dist
# A gzipped copy beside each file that compresses, as Pages compressed them (snapshots, warm packs
# and blobs are compressed already)
RUN find static dist -type f \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \
      -o -name '*.json' -o -name '*.webmanifest' -o -name '*.wasm' -o -name '*.svg' -o -name '*.txt' \
      -o -name '*.toml' -o -name '*.md' -o -name '*.sh' \) -size +1k -exec gzip -k9 {} \;

# A VM for a machine of 256 MB and a shared CPU: one scheduler (and one dirty CPU one), no
# busy-waiting for work (a suspended machine wakes to no spinning schedulers), memory given back
# to the system as soon as a carrier empties, and room for a few thousand processes (one a
# connection), not a million
ENV ERL_FLAGS="+S 1:1 +SDcpu 1:1 +SDio 2 +sbwt none +sbwtdcpu none +sbwtdio none +MBacul 0 +MHacul 0 +P 16384 +Q 4096"

EXPOSE 8080
CMD ["elixir", "server.exs"]
