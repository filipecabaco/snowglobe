# The Python machine of the agent page (/agent/): examples/python plus a network, so pip install works.
# It is its own site because the network is part of what a build boots; examples/python is the page
# for people, with no network (the same image otherwise: keep the two Dockerfiles in step).
# Python + Rich: the plain Python REPL, with Rich installed for tables, syntax, trees and pretty output.
# numpy and pandas come from Alpine's own packages (built for musl, so nothing compiles here), and the
# venv sees them through --system-site-packages.
FROM alpine:3.24.2

RUN apk add --no-cache python3 py3-numpy py3-pandas && \
    python3 -m venv --system-site-packages /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir rich==15.0.0

# pip inside the machine goes out through the page's fetch(), so only servers that allow CORS answer:
# pypi.org and files.pythonhosted.org do (for plain GETs), so `pip install <package>` works against PyPI
# as it is. Wheels only (--only-binary): there are no compilers here, and PyPI has musllinux aarch64
# wheels for most packages with native code. numpy and pandas are baked in.
COPY pip.conf /opt/venv/pip.conf
ENV LANG=C.UTF-8 PATH=/opt/venv/bin:$PATH
WORKDIR /root
CMD ["python3"]

# One of the agent page's machines (/agent/ on the demo site): agents run commands in it and copy
# files to and from the others, by its form or by WebMCP tools (shared with chatgpt.com too). The
# numpy and pandas exercise puts their files in the warm pack: without it, an agent's first import
# fetched them one by one, about four minutes from the live site. The network is on for pip install
# (through the page's own fetch()); agent-name: it is "python" on the page, not "python-agent"
LABEL snowglobe.title="Python + Rich in the browser" \
      snowglobe.network="fetch" \
      snowglobe.ready=">>> " \
      snowglobe.agent="true" \
      snowglobe.agent-name="python" \
      snowglobe.agent-purpose="Run Python: scripts, numpy and pandas for data work; pip install adds packages from PyPI." \
      snowglobe.agent-sample="python3 -c 'import numpy, pandas; print(numpy.__version__, pandas.__version__)'" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["from rich import print; print(\"[bold magenta]hello[/] from [green]Rich[/]\")", "from rich.console import Console; from rich.table import Table; t = Table(\"language\", \"year\"); t.add_row(\"Python\", \"1991\"); Console().print(t)", "from rich.syntax import Syntax; Console().print(Syntax(\"def fib(n):\\n    return n\", \"python\"))", "from rich import inspect; inspect(str.split)", "from rich.pretty import pprint; pprint({\"nested\": {\"data\": [1, 2, 3]}})", "from rich.tree import Tree; tree = Tree(\"root\"); leaf = tree.add(\"leaf\"); Console().print(tree)", "import numpy, pandas; d = pandas.DataFrame({\"x\": numpy.arange(3)}); d.to_csv(\"/tmp/x.csv\", index=False); d.describe()", "1 / 0"]'
