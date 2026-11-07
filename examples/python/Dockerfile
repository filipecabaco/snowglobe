# Python + Rich: the REPL with Rich installed, so results, tables and tracebacks render richly.
# numpy and pandas come from Alpine's own packages (built for musl, so nothing compiles here), and the
# venv sees them through --system-site-packages.
FROM alpine:3.24.2

RUN apk add --no-cache python3 py3-numpy py3-pandas && \
    python3 -m venv --system-site-packages /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir rich==15.0.0

COPY startup.py /root/startup.py
ENV LANG=C.UTF-8 PATH=/opt/venv/bin:$PATH PYTHONSTARTUP=/root/startup.py
WORKDIR /root
CMD ["python3"]

# One of the agent page's machines (/agent/ on the demo site): agents run commands in it and copy
# files to and from the others, by its form or by WebMCP tools (shared with chatgpt.com too). The
# numpy and pandas exercise puts their files in the warm pack: without it, an agent's first import
# fetched them one by one, about four minutes from the live site
LABEL snowglobe.title="Python + Rich in the browser" \
      snowglobe.ready=">>> " \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="Run Python: scripts, numpy and pandas for data work." \
      snowglobe.agent-sample="python3 -c 'import numpy, pandas; print(numpy.__version__, pandas.__version__)'" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["print(\"[bold magenta]hello[/] from [green]Rich[/]\")", "t = Table(\"language\", \"year\"); t.add_row(\"Python\", \"1991\"); t", "Syntax(\"def fib(n):\\n    return n\", \"python\")", "inspect(str.split)", "{\"nested\": {\"data\": [1, 2, 3]}}", "Tree(\"root\").add(\"leaf\")", "import numpy, pandas; d = pandas.DataFrame({\"x\": numpy.arange(3)}); d.to_csv(\"/tmp/x.csv\", index=False); d.describe()", "1 / 0"]'
