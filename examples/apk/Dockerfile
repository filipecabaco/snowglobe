# apk: a bare Alpine shell that installs packages into the running machine. For `snowglobe run`,
# not the browser: Alpine's package mirrors don't allow CORS, so a page's fetch() can't reach
# them, while `snowglobe run` goes out from the host directly (through its proxy, if it has one).
#
#   snowglobe build examples/apk --out dist/apk
#   snowglobe run dist/apk
#
# What gets installed lives in the machine's memory and is gone when it stops.
FROM alpine:3.24.2

ENV LANG=C.UTF-8 PS1='\w # '
WORKDIR /root
CMD ["/bin/sh"]

LABEL snowglobe.title="apk: packages into a running machine" \
      snowglobe.network="fetch" \
      snowglobe.ready="~ # "
