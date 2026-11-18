// A JavaScript prompt in Bun, with a web server in the same process: Bun.serve on port 3000 of the
// machine's network address answers JSON for any path (and "ok" at /health), and each line typed at
// "bun> " is run and its value shown. One program and no shell, so it runs with no guest kernel.
//
// What a line can be: an expression (its value is shown), a statement, or several; `await` works at
// the start of a line. A declaration at the top of a line (const x = ..., let, var) is kept for the
// lines after it, as a global. .help says so, .exit ends it, and so does the end of the input.
const PORT = 3000;
const started = Date.now();
let served = 0;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    served++;
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    return Response.json({ from: `Bun ${Bun.version}`, method: req.method, path: url.pathname, served, upMs: Date.now() - started });
  },
});

const AsyncFunction = (async () => {}).constructor;
// `const x = await f()` becomes `globalThis.x = await f()`: kept for the next lines, and its value shown
const DECLARATION = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);?\s*$/;

async function run(line) {
  const d = line.match(DECLARATION);
  const code = d ? `globalThis.${d[1]} = (${d[2]})` : line;
  if (!/\bawait\b/.test(code)) return (0, eval)(code);
  // With await: as an expression whose value is shown, else as statements
  let fn;
  try {
    fn = new AsyncFunction(`return (${code}\n)`);
  } catch {
    fn = new AsyncFunction(code);
  }
  return await fn();
}

const HELP = `JavaScript, run by Bun ${Bun.version}. Its server answers on port ${PORT}: try
  await (await fetch("http://127.0.0.1:${PORT}/hello")).json()
A declaration at the start of a line (const x = ...) is kept for the next lines. .exit ends.`;

console.log(`Bun ${Bun.version}: serving on port ${server.port}. Type JavaScript, or .help`);
process.stdout.write("bun> ");
for await (const raw of console) {
  const line = raw.trim();
  if (line === ".exit") break;
  if (line === ".help") console.log(HELP);
  else if (line) {
    try {
      console.log(Bun.inspect(await run(line), { colors: false }));
    } catch (e) {
      console.log(`Uncaught ${e?.name ?? "Error"}: ${e?.message ?? e}`);
    }
  }
  process.stdout.write("bun> ");
}
server.stop(true);
process.exit(0);
