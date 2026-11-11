# Java + Gson: jshell on OpenJDK 21 with Gson on the classpath.
FROM alpine:3.24.2

RUN apk add --no-cache openjdk21-jdk && \
    # jshell announces creating this on first run; create it now so it isn't on the snapshot
    mkdir -p /root/.java/.userPrefs

ADD --checksum=sha256:2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f \
    https://repo1.maven.org/maven2/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar /opt/lib/gson.jar

ENV LANG=C.UTF-8 PATH=/usr/lib/jvm/default-jvm/bin:$PATH
WORKDIR /root
# --execution local keeps snippets in jshell's own JVM instead of starting a second one; in that
# mode the jar must also be on the JVM's own classpath (-J) for snippets to load it
CMD ["jshell", "--execution", "local", "--class-path", "/opt/lib/gson.jar", "-J--class-path=/opt/lib/gson.jar", \
     "--startup", "DEFAULT", "-J-Xshare:auto", "-J-XX:TieredStopAtLevel=1"]

LABEL snowglobe.title="Java + Gson in the browser" \
      snowglobe.ready="jshell> " \
      snowglobe.memory="768" snowglobe.cpus="2" \
      snowglobe.exercise='["import com.google.gson.*", "record Point(int x, int y) {}", "Gson gson = new GsonBuilder().setPrettyPrinting().create()", "gson.toJson(new Point(1, 2))", "gson.fromJson(\"{\\\"x\\\": 3, \\\"y\\\": 4}\", Point.class)", "JsonParser.parseString(\"{\\\"a\\\": [1, 2, 3]}\").getAsJsonObject().get(\"a\")", "java.time.LocalDate.now().plusDays(30)"]'
