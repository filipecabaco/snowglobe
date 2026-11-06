# Python + Rich: the REPL with Rich installed, so results, tables and tracebacks render richly.
FROM alpine:3.24.2

RUN apk add --no-cache python3 && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir rich==15.0.0

COPY startup.py /root/startup.py
ENV LANG=C.UTF-8 PATH=/opt/venv/bin:$PATH PYTHONSTARTUP=/root/startup.py
WORKDIR /root
CMD ["python3"]

# An agent may run commands in it (WebMCP tools in a browser that has WebMCP, and for chatgpt.com)
LABEL snowglobe.title="Python + Rich in the browser" \
      snowglobe.ready=">>> " \
      snowglobe.agent="true" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["print(\"[bold magenta]hello[/] from [green]Rich[/]\")", "t = Table(\"language\", \"year\"); t.add_row(\"Python\", \"1991\"); t", "Syntax(\"def fib(n):\\n    return n\", \"python\")", "inspect(str.split)", "{\"nested\": {\"data\": [1, 2, 3]}}", "Tree(\"root\").add(\"leaf\")", "1 / 0"]'
