#!/usr/bin/env elixir
# snowglobe's site (snowglobe.build). Each page is a route rendered from its own template under
# site/templates; the files the pages load are site/static, and the demos are the built sites in
# dist/ (`mise run build`, or CI's assemble job: each demo, the agent page's scripts and
# runtimes.json, the blob store when it isn't on refs/snowglobe/blobs).
#
#   /                  the runs                       templates/index.html.eex
#   /agent/            the agent page                 templates/agent.html.eex
#   /fleet/            the fleet page                 templates/fleet.html.eex
#   /apphost/          App Host                       templates/apphost.html.eex
#   /docs/             the docs' first page           templates/docs/index.html.eex
#   /docs/<slug>/      a docs page                    templates/docs/<slug>.html.eex
#                      (both inside the docs' frame:  templates/docs.html.eex)
#   /card/<dir>/       a demo's X player card         templates/card.html.eex, from cards.json
#   anything else      site/static, then dist/ (a directory's index.html), or 404
#                                                     templates/404.html.eex
#
# A page's address ends in a slash, as the static site's did, so the relative links in the pages
# and in the scripts dist/ has (sw.js's scope, runtimes.json, a demo's ../) resolve as they did:
# /docs/building and /docs/building/index.html are sent on to /docs/building/.
#
# Every page is rendered once, as the server starts, and kept with its gzipped copy and an ETag:
# a request is a lookup, so one shared CPU and 256 MB serve the site. Pages are looked at again
# each visit (no-cache: an ETag makes that a 304), so a page never runs a script of the deploy
# before. Files go as GitHub Pages sent them and bench/server.mjs stands in for: ETag and
# Last-Modified, Cache-Control: max-age=600, a .gz beside a file (the Dockerfile makes those) to
# a client that takes gzip. There are no isolation headers: a page on several CPUs makes itself
# cross-origin isolated with its own service worker, as it must on any static host.
#
#   elixir site/server.exs [dist]       serves on $PORT (default 8080); dist/ is $DIST_DIR or ../dist
#   elixir site/server.exs --no-start   defines the server and returns (site/test/server_test.exs)

Mix.install([{:francis, "~> 0.4.0"}])

defmodule Site.Templates do
  @dir Path.expand("templates", __DIR__)

  @pages [
    index: "index.html.eex",
    agent: "agent.html.eex",
    fleet: "fleet.html.eex",
    apphost: "apphost.html.eex",
    docs: "docs.html.eex",
    card: "card.html.eex",
    not_found: "404.html.eex",
    header: "_header.html.eex",
    footer: "_footer.html.eex"
  ]

  # A docs page's own part: templates/docs/<slug>.html.eex
  @docs for f <- Path.wildcard(Path.join([@dir, "docs", "*.html.eex"])), do: Path.basename(f, ".html.eex")

  # Each template compiled into a clause of render/2 (most use none of their assigns)
  for {key, file} <- Enum.map(@pages, fn {name, f} -> {name, f} end) ++ Enum.map(@docs, &{{:doc, &1}, "docs/#{&1}.html.eex"}) do
    path = Path.join(@dir, file)
    @external_resource path
    quoted = EEx.compile_file(path)

    defp render(unquote(Macro.escape(key)), var!(assigns)) do
      _ = var!(assigns)
      unquote(quoted)
    end
  end

  for {name, _} <- @pages do
    def unquote(name)(assigns), do: render(unquote(name), assigns)
  end

  def docs, do: @docs
  def doc(slug, assigns) when slug in @docs, do: render({:doc, slug}, assigns)
end

defmodule Site do
  # Where the site is: canonical addresses, share cards and the install command need absolute URLs
  @site "https://filipecabaco.github.io/snowglobe"

  # The docs, in the order of their contents: {slug, title in the contents, page title, description}
  @docs [
    {"index", "Getting started", "Docs",
     "How to use snowglobe: package a Docker image into a static site that runs it in the browser, run it headlessly or as one executable, and drive it from agents and programs."},
    {"building", "Building a site", "Building a site",
     "Build a site from a Dockerfile: labels and flags, when the snapshot is taken, exercises and the warm pack, CPUs and memory, building without Docker, pooling and installable sites."},
    {"networking", "Networking", "Networking",
     "Give a snowglobe guest a network: HTTP, HTTPS and WebSockets through the browser, tunnels for other TCP, credentials, egress outside a browser, and links between machines."},
    {"running", "Running outside a browser", "Running outside a browser",
     "Run a snowglobe site outside a browser: sessions and instances, sites from a URL, forwarded ports, one executable, and instances that share their memory."},
    {"agents", "For agents and programs", "For agents and programs",
     "Drive snowglobe machines from agents and programs: sh and cp, forks, MCP, limits and logs, and the agent page with WebMCP tools, the preview and the app studio."},
    {"orchestration", "Orchestration and fleets", "Orchestration and fleets",
     "Run many snowglobe machines: the daemon, templates, snapshots, services that scale to zero and heal themselves, fleets from one file, links, fleet instances and network modes, snowglobe ui and the API."},
    {"isolation", "Isolation", "Isolation",
     "What keeps a snowglobe guest in: the emulator, the browser, native and Docker sandboxes, and how shared memory stays private."},
    {"saving", "Saving your work", "Saving your work",
     "Where a snowglobe run in the browser saves your work: browser storage, backup files and folders."},
    {"how-it-works", "How it works", "How it works",
     "How snowglobe builds a site: the boot layer, the filesystem, the snapshot, machines and the warm pack, and what to do when a build goes wrong."},
    {"reference", "CLI reference", "CLI reference",
     "The snowglobe CLI reference: every command, build flag and label, run flag and environment variable."}
  ]

  # The header's links: every page's, and the runs page's own (its sections, and App Host)
  @links [{"/#runs", "Runs"}, {"/agent/", "Agents"}, {"/fleet/", "Fleets"}, {"/docs/", "Docs"}]
  @index_links [
    {"#runs", "Runs"},
    {"#make-your-own", "Make your own"},
    {"/fleet/", "Fleets"},
    {"/agent/", "Agents"},
    {"/apphost/", "App Host"},
    {"/docs/", "Docs"}
  ]

  use Francis,
    bandit_opts: [
      port: String.to_integer(System.get_env("PORT", "8080")),
      ip: :any,
      # (One small machine: a few acceptors are plenty)
      thousand_island_options: [num_acceptors: 4]
    ],
    # Files are served after the routes (unmatched, below), not before them
    static: false,
    # (Each request's line, below the logger's level: a demo makes a lot of them)
    log_level: :debug

  alias Site.Templates

  get("/healthz", fn _ -> "ok" end)

  get("/", fn conn -> page(conn, "/") end)
  get("/agent", fn conn -> page(conn, "/agent/") end)
  get("/fleet", fn conn -> page(conn, "/fleet/") end)
  get("/apphost", fn conn -> page(conn, "/apphost/") end)
  get("/docs", fn conn -> page(conn, "/docs/") end)
  get("/docs/:slug", fn conn -> page(conn, "/docs/#{conn.params["slug"]}/") end)
  get("/card/:dir", fn conn -> page(conn, "/card/#{conn.params["dir"]}/") end)

  unmatched(fn conn -> files(conn) end)

  def docs_pages, do: @docs
  def links, do: @links
  def index_links, do: @index_links
  def site, do: @site

  def doc_path("index"), do: "/docs/"
  def doc_path(slug), do: "/docs/#{slug}/"

  def h(text) do
    text
    |> to_string()
    |> String.replace("&", "&amp;")
    |> String.replace("<", "&lt;")
    |> String.replace(">", "&gt;")
    |> String.replace("\"", "&quot;")
  end

  # ---- pages ----------------------------------------------------------------

  @doc "Every page by its address, rendered: {html, gzipped, etag}. Read once, as the server starts."
  def pages, do: :persistent_term.get({__MODULE__, :pages})

  def render_pages do
    site = [site: @site]
    docs = for {slug, nav, title, desc} <- @docs, do: %{slug: slug, nav: nav, title: title, desc: desc}
    missing = Enum.map(docs, & &1.slug) -- Templates.docs()
    missing == [] || raise "no template for docs #{inspect(missing)} (templates/docs/<slug>.html.eex)"

    doc_pages =
      docs
      |> Enum.with_index()
      |> Enum.map(fn {page, i} ->
        {doc_path(page.slug),
         Templates.docs(site ++ [
           page: page,
           pages: docs,
           body: Templates.doc(page.slug, site),
           prev: if(i > 0, do: Enum.at(docs, i - 1)),
           next: Enum.at(docs, i + 1)
         ])}
      end)

    %{"cards" => cards} = Path.expand("cards.json", __DIR__) |> File.read!() |> JSON.decode!()
    card_pages = for card <- cards, do: {"/card/#{card["dir"]}/", Templates.card(site ++ [card: card])}

    ([
       {"/", Templates.index(site)},
       {"/agent/", Templates.agent(site)},
       {"/fleet/", Templates.fleet(site)},
       {"/apphost/", Templates.apphost(site)},
       {:not_found, Templates.not_found(site)}
     ] ++ doc_pages ++ card_pages)
    |> Map.new(fn {path, html} ->
      html = IO.iodata_to_binary(html)
      {path, {html, :zlib.gzip(html), ~s("#{html |> :erlang.phash2(4_294_967_296) |> Integer.to_string(16)}")}}
    end)
    |> then(&:persistent_term.put({__MODULE__, :pages}, &1))
  end

  # A page's own address ends in a slash; without it it is sent there. An address a route takes
  # that isn't a page (/docs/docs.css) is a file's
  defp page(conn, path) do
    cond do
      not Map.has_key?(pages(), path) -> files(conn)
      conn.request_path != path -> moved(conn, path)
      true -> send_page(conn, pages()[path], 200)
    end
  end

  defp not_found(conn), do: send_page(conn, pages()[:not_found], 404)

  defp send_page(conn, {html, gz, etag}, status) do
    conn =
      conn
      |> Plug.Conn.put_resp_content_type("text/html")
      |> Plug.Conn.put_resp_header("cache-control", "no-cache")
      |> Plug.Conn.put_resp_header("vary", "accept-encoding")
      |> Plug.Conn.put_resp_header("x-content-type-options", "nosniff")

    conn = if status == 200, do: Plug.Conn.put_resp_header(conn, "etag", etag), else: conn

    cond do
      status == 200 and etag in Plug.Conn.get_req_header(conn, "if-none-match") ->
        Plug.Conn.send_resp(conn, 304, "")

      gzip?(conn) ->
        conn |> Plug.Conn.put_resp_header("content-encoding", "gzip") |> Plug.Conn.send_resp(status, gz)

      true ->
        Plug.Conn.send_resp(conn, status, html)
    end
    |> Plug.Conn.halt()
  end

  defp gzip?(conn) do
    conn |> Plug.Conn.get_req_header("accept-encoding") |> Enum.any?(&String.contains?(&1, "gzip"))
  end

  defp moved(conn, path) do
    to = if conn.query_string == "", do: path, else: path <> "?" <> conn.query_string

    conn
    |> Plug.Conn.put_resp_header("location", to)
    |> Plug.Conn.send_resp(301, "")
    |> Plug.Conn.halt()
  end

  # ---- files ----------------------------------------------------------------

  def static_dir, do: Path.expand("static", __DIR__)
  def dist_dir, do: :persistent_term.get({__MODULE__, :dist})
  def dist_dir(path), do: :persistent_term.put({__MODULE__, :dist}, Path.expand(path))

  # site/static, then dist/ as a static host serves it: a path ending in / is its index.html, a
  # directory without the / is sent to it (/python -> /python/)
  defp files(%Plug.Conn{method: m} = conn) when m in ["GET", "HEAD"] do
    # A page's address as the static site had it: /docs/building/index.html
    page = String.replace_suffix(conn.request_path, "index.html", "")

    if page != conn.request_path and Map.has_key?(pages(), page) do
      moved(conn, page)
    else
      conn = Enum.reduce_while([static_dir(), dist_dir()], conn, &serve_from/2)
      if conn.halted, do: conn, else: not_found(conn)
    end
  end

  defp files(conn), do: not_found(conn)

  defp serve_from(dir, conn) do
    path = conn.path_info

    cond do
      ".." in path or Enum.any?(path, &String.contains?(&1, ["\\", "\0"])) ->
        {:halt, conn}

      conn.request_path != "/" and String.ends_with?(conn.request_path, "/") ->
        if File.regular?(Path.join([dir | path] ++ ["index.html"])),
          do: {:halt, static(%{conn | path_info: path ++ ["index.html"]}, dir)},
          else: {:cont, conn}

      path != [] and File.dir?(Path.join([dir | path])) ->
        {:halt, moved(conn, conn.request_path <> "/")}

      true ->
        conn = static(conn, dir)
        if conn.halted, do: {:halt, conn}, else: {:cont, conn}
    end
  end

  defp static(conn, dir) do
    opts =
      with nil <- :persistent_term.get({__MODULE__, :static, dir}, nil) do
        opts = Plug.Static.init(at: "/", from: dir, gzip: true, cache_control_for_etags: "max-age=600", headers: %{"x-content-type-options" => "nosniff"})
        :persistent_term.put({__MODULE__, :static, dir}, opts)
        opts
      end

    Plug.Static.call(conn, opts)
  end
end

Logger.configure(level: :info)

{flags, args} = Enum.split_with(System.argv(), &String.starts_with?(&1, "--"))
Site.dist_dir(List.first(args) || System.get_env("DIST_DIR") || Path.expand("../dist", __DIR__))
# Every page rendered now, so a template that doesn't render fails here and not on a visit
Site.render_pages()

if "--no-start" not in flags do
  File.dir?(Site.dist_dir()) || IO.puts(:stderr, "site: #{Site.dist_dir()} isn't there: the pages without the demos")
  {:ok, _} = Supervisor.start_link([Site], strategy: :one_for_one)
  IO.puts("site: #{map_size(Site.pages())} pages, demos from #{Site.dist_dir()}, on port #{System.get_env("PORT", "8080")}")
  Process.sleep(:infinity)
end
