# Java CRUD API over SQLite: the JDK's HTTP server and the SQLite JDBC driver, on OpenJDK 21. The
# snapshot holds the server running and warm; a job drives it with crud-bench (ApacheBench).
FROM alpine:3.24.2 AS build
RUN apk add --no-cache openjdk21-jdk
COPY CrudServer.java /src/
RUN javac -d /app /src/CrudServer.java

FROM alpine:3.24.2
RUN apk add --no-cache openjdk21-jre-headless apache2-utils
ADD --checksum=sha256:f8dce420a6016278497f4f0560f65602b9db858de141b541cf91a4644ebe4639 \
    https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.54.1.0/sqlite-jdbc-3.54.1.0.jar /opt/lib/sqlite-jdbc.jar
COPY --from=build /app /app
COPY start.sh /app/start.sh
COPY crud-bench /usr/local/bin/crud-bench

ENV LANG=C.UTF-8 PATH=/usr/lib/jvm/default-jvm/bin:$PATH
WORKDIR /root
CMD ["/app/start.sh"]

LABEL snowglobe.title="Java CRUD API (SQLite)" \
      snowglobe.ready="crud API on http://127.0.0.1:8080/items" \
      snowglobe.memory="768" snowglobe.cpus="2" \
      snowglobe.exercise='["crud-bench 200"]'
