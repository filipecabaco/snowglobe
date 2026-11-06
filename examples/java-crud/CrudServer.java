// A small CRUD API over SQLite: items with a name and a quantity.
//
//   POST   /items        {"name": "...", "qty": N}  -> 201 {"id": N}
//   GET    /items                                   -> 200 [{...}, ...] (the first 100)
//   GET    /items/{id}                              -> 200 {...} | 404
//   PUT    /items/{id}   {"name": "...", "qty": N}  -> 200 {...} | 404
//   DELETE /items/{id}                              -> 204
//
// The JDK's own HTTP server and the SQLite JDBC driver, nothing else: one connection, which
// the handlers take in turn (SQLite writes one at a time anyway).

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CrudServer {
    private static final Pattern NAME = Pattern.compile("\"name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
    private static final Pattern QTY = Pattern.compile("\"qty\"\\s*:\\s*(-?\\d+)");

    private final Connection db;

    CrudServer(String path) throws SQLException {
        db = DriverManager.getConnection("jdbc:sqlite:" + path);
        try (Statement s = db.createStatement()) {
            s.execute("PRAGMA journal_mode=WAL");
            s.execute("PRAGMA synchronous=NORMAL");
            s.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)");
        }
    }

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8080;
        String path = args.length > 1 ? args[1] : "/var/lib/crud/items.db";
        CrudServer app = new CrudServer(path);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 64);
        server.createContext("/items", app::handle);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("crud listening on 127.0.0.1:" + port);
    }

    private void handle(HttpExchange ex) throws IOException {
        try {
            String[] parts = ex.getRequestURI().getPath().split("/");
            Long id = parts.length > 2 ? parseId(parts[2]) : null;
            String method = ex.getRequestMethod();
            if (parts.length > 2 && id == null) {
                send(ex, 404, "{\"error\":\"not found\"}");
            } else if (id == null && method.equals("POST")) {
                create(ex);
            } else if (id == null && method.equals("GET")) {
                send(ex, 200, list());
            } else if (id != null && method.equals("GET")) {
                String item = read(id);
                send(ex, item == null ? 404 : 200, item == null ? "{\"error\":\"not found\"}" : item);
            } else if (id != null && method.equals("PUT")) {
                update(ex, id);
            } else if (id != null && method.equals("DELETE")) {
                delete(id);
                send(ex, 204, null);
            } else {
                send(ex, 405, "{\"error\":\"method not allowed\"}");
            }
        } catch (SQLException | IllegalArgumentException e) {
            send(ex, 400, "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}");
        } finally {
            ex.close();
        }
    }

    private void create(HttpExchange ex) throws IOException, SQLException {
        String[] item = parse(ex);
        long id;
        synchronized (db) {
            try (PreparedStatement p = db.prepareStatement("INSERT INTO items (name, qty) VALUES (?, ?)")) {
                p.setString(1, item[0]);
                p.setLong(2, Long.parseLong(item[1]));
                p.executeUpdate();
            }
            try (Statement s = db.createStatement(); ResultSet r = s.executeQuery("SELECT last_insert_rowid()")) {
                r.next();
                id = r.getLong(1);
            }
        }
        send(ex, 201, "{\"id\":" + id + "}");
    }

    private String list() throws SQLException {
        StringBuilder out = new StringBuilder("[");
        synchronized (db) {
            try (Statement s = db.createStatement();
                 ResultSet r = s.executeQuery("SELECT id, name, qty FROM items ORDER BY id LIMIT 100")) {
                while (r.next()) {
                    if (out.length() > 1) out.append(',');
                    out.append(json(r.getLong(1), r.getString(2), r.getLong(3)));
                }
            }
        }
        return out.append(']').toString();
    }

    private String read(long id) throws SQLException {
        synchronized (db) {
            try (PreparedStatement p = db.prepareStatement("SELECT id, name, qty FROM items WHERE id = ?")) {
                p.setLong(1, id);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? json(r.getLong(1), r.getString(2), r.getLong(3)) : null;
                }
            }
        }
    }

    private void update(HttpExchange ex, long id) throws IOException, SQLException {
        String[] item = parse(ex);
        int n;
        synchronized (db) {
            try (PreparedStatement p = db.prepareStatement("UPDATE items SET name = ?, qty = ? WHERE id = ?")) {
                p.setString(1, item[0]);
                p.setLong(2, Long.parseLong(item[1]));
                p.setLong(3, id);
                n = p.executeUpdate();
            }
        }
        if (n == 0) {
            send(ex, 404, "{\"error\":\"not found\"}");
        } else {
            send(ex, 200, json(id, item[0], Long.parseLong(item[1])));
        }
    }

    private void delete(long id) throws SQLException {
        synchronized (db) {
            try (PreparedStatement p = db.prepareStatement("DELETE FROM items WHERE id = ?")) {
                p.setLong(1, id);
                p.executeUpdate();
            }
        }
    }

    /** The name and quantity of a request's JSON body. */
    private static String[] parse(HttpExchange ex) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Matcher name = NAME.matcher(body);
        Matcher qty = QTY.matcher(body);
        if (!name.find() || !qty.find()) {
            throw new IllegalArgumentException("expected {\"name\": \"...\", \"qty\": N}");
        }
        return new String[] {name.group(1), qty.group(1)};
    }

    private static Long parseId(String s) {
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String json(long id, String name, long qty) {
        return "{\"id\":" + id + ",\"name\":" + quote(name) + ",\"qty\":" + qty + "}";
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static void send(HttpExchange ex, int status, String body) throws IOException {
        if (body == null) {
            ex.sendResponseHeaders(status, -1);
            return;
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }
}
