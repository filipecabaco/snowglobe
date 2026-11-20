# site/server.exs: every page renders from its template at its address (with a slash), the old
# addresses are sent on, the docs' frame lists every docs page, a card per demo in cards.json, and
# files come from site/static and then dist/ as a static host serves them.
#
#   elixir site/test/server_test.exs

dist = Path.join(System.tmp_dir!(), "snowglobe-site-#{System.unique_integer([:positive])}")
File.mkdir_p!(Path.join([dist, "python", "system"]))
File.write!(Path.join([dist, "python", "index.html"]), "<h1>python</h1>")
File.write!(Path.join([dist, "python", "system", "warm.pack"]), "pack")
File.mkdir_p!(Path.join([dist, "agent", "python"]))
File.write!(Path.join([dist, "agent", "sessions.js"]), "// sessions")
File.write!(Path.join([dist, "agent", "python", "index.html"]), "<p>stub</p>")
File.write!(Path.join([dist, "big.js"]), "js")
File.write!(Path.join([dist, "big.js.gz"]), :zlib.gzip("js"))
System.put_env("DIST_DIR", dist)
System.argv(["--no-start"])
Code.require_file("../server.exs", __DIR__)

ExUnit.start()

defmodule SiteServerTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  @opts Site.init([])

  defp get(path, headers \\ []) do
    Enum.reduce(headers, conn(:get, path), fn {k, v}, c -> put_req_header(c, k, v) end)
    |> Site.call(@opts)
  end

  defp header(conn, name), do: conn |> get_resp_header(name) |> List.first()

  test "every page renders at its address" do
    for {path, has} <- [
          {"/", "Real programs, sandboxed"},
          {"/agent/", ~s(src="agent-page.js")},
          {"/fleet/", ~s(src="fleet-page.js")},
          {"/apphost/", "App Host"},
          {"/docs/", "Getting started"},
          {"/docs/building/", "Building a site"},
          {"/docs/reference/", "CLI reference"},
          {"/card/python/", "twitter:player"}
        ] do
      conn = get(path)
      assert conn.status == 200, path
      assert header(conn, "content-type") =~ "text/html", path
      assert conn.resp_body =~ has, path
      refute conn.resp_body =~ "<%", path
    end
  end

  test "a page's address without its slash, or as index.html, is sent to it" do
    for {from, to} <- [
          {"/agent", "/agent/"},
          {"/docs", "/docs/"},
          {"/docs/building", "/docs/building/"},
          {"/docs/building/index.html", "/docs/building/"},
          {"/fleet?x=1", "/fleet/?x=1"},
          {"/python", "/python/"}
        ] do
      conn = get(from)
      assert conn.status == 301, from
      assert header(conn, "location") == to, from
    end
  end

  test "the docs' frame lists every docs page, marks this one, and links the next" do
    body = get("/docs/building/").resp_body

    for {slug, _, _, _} <- Site.docs_pages() do
      assert body =~ ~s(href="#{Site.doc_path(slug)}"), slug
    end

    assert body =~ ~s(href="/docs/building/" aria-current="page")
    assert body =~ ~s(<a class="next" href="/docs/networking/">)
    assert body =~ ~s(<a class="prev" href="/docs/">)
  end

  test "a docs page with no template, or no card for a demo, is a 404" do
    assert get("/docs/nope/").status == 404
    assert get("/card/nope/").status == 404
  end

  test "a page is not cached, has an ETag, a 304 for it, and goes gzipped to who takes it" do
    conn = get("/docs/")
    assert header(conn, "cache-control") == "no-cache"
    etag = header(conn, "etag")
    assert get("/docs/", [{"if-none-match", etag}]).status == 304

    gz = get("/docs/", [{"accept-encoding", "gzip, br"}])
    assert header(gz, "content-encoding") == "gzip"
    assert :zlib.gunzip(gz.resp_body) == conn.resp_body
  end

  test "files: site/static, then dist/, with a directory's index.html" do
    assert get("/base.css").status == 200
    assert get("/docs/docs.css").status == 200
    assert get("/llms.txt").status == 200

    conn = get("/python/")
    assert conn.status == 200 and conn.resp_body == "<h1>python</h1>"
    assert header(conn, "cache-control") == "max-age=600"

    assert get("/python/system/warm.pack").resp_body == "pack"
    assert get("/agent/sessions.js").resp_body == "// sessions"
    assert get("/agent/python/").resp_body == "<p>stub</p>"

    gz = get("/big.js", [{"accept-encoding", "gzip"}])
    assert header(gz, "content-encoding") == "gzip"
  end

  test "what isn't there is the 404 page; no way out of the directories" do
    for path <- ["/nope", "/python/nope.js", "/../server.exs", "/static/../server.exs"] do
      conn = get(path)
      assert conn.status in [400, 404], path
    end

    assert get("/nope").resp_body =~ "Nothing is here"
  end

  test "health" do
    assert get("/healthz").resp_body == "ok"
  end
end
