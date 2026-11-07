# Python + Rich: the REPL with Rich installed, so results, tables and tracebacks render richly.
# numpy and pandas come from Alpine's own packages (built for musl, so nothing compiles here), and the
# venv sees them through --system-site-packages.
FROM alpine:3.24.2

RUN apk add --no-cache python3 py3-numpy py3-pandas && \
    python3 -m venv --system-site-packages /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir rich==15.0.0

# pip.conf: wheels only (no compilers here). The page has no network, so pip install needs the
# agent page's python machine (examples/python-agent)
COPY pip.conf /opt/venv/pip.conf
COPY startup.py /root/startup.py
ENV LANG=C.UTF-8 PATH=/opt/venv/bin:$PATH PYTHONSTARTUP=/root/startup.py
WORKDIR /root
CMD ["python3"]

LABEL snowglobe.title="Python + Rich in the browser" \
      snowglobe.ready=">>> " \
      snowglobe.exercise='["print(\"[bold magenta]hello[/] from [green]Rich[/]\")", "t = Table(\"language\", \"year\"); t.add_row(\"Python\", \"1991\"); t", "Syntax(\"def fib(n):\\n    return n\", \"python\")", "inspect(str.split)", "{\"nested\": {\"data\": [1, 2, 3]}}", "Tree(\"root\").add(\"leaf\")", "import numpy, pandas; d = pandas.DataFrame({\"x\": numpy.arange(3)}); d.to_csv(\"/tmp/x.csv\", index=False); d.describe()", "1 / 0"]'
