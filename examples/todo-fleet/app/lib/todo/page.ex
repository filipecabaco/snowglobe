defmodule Todo.Page do
  @moduledoc """
  The page: static markup, and a script that renders the todos with textContent, so a title is
  never markup.
  """

  @html """
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Todos</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
      form { display: flex; gap: .5rem; margin-bottom: 1rem; }
      input[type=text] { flex: 1; padding: .4rem .6rem; }
      ul { list-style: none; padding: 0; }
      li { display: flex; align-items: center; gap: .6rem; padding: .3rem 0; }
      li.done span { text-decoration: line-through; color: #888; }
      li button { margin-left: auto; }
      p.error { color: #b00020; }
    </style>
  </head>
  <body>
    <h1>Todos</h1>
    <form id="add">
      <input type="text" name="title" placeholder="Something to do" maxlength="200" required>
      <button>Add</button>
    </form>
    <p class="error" id="error" hidden></p>
    <ul id="list"></ul>
    <script>
      const list = document.getElementById("list");
      const error = document.getElementById("error");
      async function call(method, path, body) {
        const r = await fetch(path, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        error.hidden = r.ok;
        if (!r.ok) error.textContent = "The app answered " + r.status;
        return r.status === 204 ? null : r.json();
      }
      async function load() {
        const todos = await call("GET", "/todos");
        list.replaceChildren(...todos.map((t) => {
          const li = document.createElement("li");
          li.className = t.done ? "done" : "";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = t.done;
          box.onchange = () => call("PATCH", "/todos/" + t.id, { done: box.checked }).then(load);
          const title = document.createElement("span");
          title.textContent = t.title;
          const remove = document.createElement("button");
          remove.textContent = "Delete";
          remove.onclick = () => call("DELETE", "/todos/" + t.id).then(load);
          li.append(box, title, remove);
          return li;
        }));
      }
      document.getElementById("add").onsubmit = async (e) => {
        e.preventDefault();
        const input = e.target.title;
        await call("POST", "/todos", { title: input.value });
        input.value = "";
        load();
      };
      load();
    </script>
  </body>
  </html>
  """

  def html, do: @html
end
