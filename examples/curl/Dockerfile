# curl + jq: ordinary command-line tools in a shell, with the network on. Their requests leave as
# the visitor's own browser requests, so any API that allows CORS answers. No server is involved.
FROM alpine:3.24.2

RUN apk add --no-cache curl jq

ENV LANG=C.UTF-8 PS1='\w $ '
WORKDIR /root
CMD ["/bin/sh"]

LABEL snowglobe.title="curl + jq in the browser" \
      snowglobe.network="fetch" \
      snowglobe.ready="~ $ " \
      snowglobe.exercise='["curl -sS https://api.github.com/zen; echo", "curl -sS https://api.github.com/repos/copy/v86 | jq \"{name: .full_name, stars: .stargazers_count, language}\"", "curl -sS \"https://api.github.com/users/copy/repos?per_page=5&sort=updated\" | jq -r \".[].name\"", "curl -sS https://httpbin.org/post -H \"content-type: application/json\" -d \"{\\\"from\\\": \\\"a sandboxed tab\\\"}\" | jq .json"]'
