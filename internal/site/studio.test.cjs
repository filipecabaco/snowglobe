// The studio's pieces (studio.js): the file tree, the tokenizer, the database view's parse, the prompt
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./studio.js');

test('the tree: directories first, then files, by name; skipped directories kept as leaves', () => {
  const t = S.buildTree([
    { path: 'src/main.jsx', type: 'file', size: 2 }, { path: 'package.json', type: 'file', size: 9 }, { path: 'src', type: 'dir' },
    { path: 'node_modules', type: 'dir', skipped: true }, { path: 'src/components/Card.tsx', type: 'file', size: 5 }, { path: 'src/App.jsx', type: 'file', size: 1 },
  ]);
  const names = (ns) => ns.map((n) => n.children ? [n.name, names(n.children)] : n.name);
  assert.deepEqual(names(t), [['node_modules', []], ['src', [['components', ['Card.tsx']], 'App.jsx', 'main.jsx']], 'package.json']);
  assert.equal(t[0].skipped, true);
  assert.equal(t[1].children[0].children[0].path, 'src/components/Card.tsx');
});

test('the tokenizer: JSX, TypeScript, CSS, SQL and JSON, line by line, nothing lost', () => {
  const code = 'import { useState } from "react";\n// a note\nexport default function App({ n }: { n: number }) {\n  return <Card title={`x ${n}`}>{n + 1}</Card>;\n}\n/* two\nlines */\n';
  const lines = S.tokenize(code, 'js');
  assert.equal(lines.map((l) => l.map((t) => t[1]).join('')).join('\n') + '\n', code, 'the text comes back whole');
  const cls = (line, text) => lines[line].find((t) => t[1] === text)?.[0];
  assert.equal(cls(0, 'import'), 'k');
  assert.equal(cls(0, '"react"'), 's');
  assert.equal(cls(1, '// a note'), 'c');
  assert.equal(cls(3, 'Card'), 't');
  assert.equal(cls(3, '1'), 'n');
  assert.equal(cls(5, '/* two'), 'c');
  assert.equal(cls(6, 'lines */'), 'c', 'a comment over two lines keeps its colour on both');
  assert.equal(S.tokenize('i < n;', 'js')[0].find((t) => t[1] === 'n')[0], '', 'a comparison is not a tag');
  const css = S.tokenize('.a { color: #fff; } @import "tailwindcss";', 'css')[0];
  assert.deepEqual(css.filter((t) => t[0]).map((t) => t[0] + ':' + t[1]), ['p:{', 'a:color', 'p::', 'n:#fff', 'p:;', 'p:}', 'k:@import', 's:"tailwindcss"', 'p:;']);
  const sql = S.tokenize("ALTER table notes add column done boolean -- yes\n", 'sql')[0];
  assert.deepEqual(sql.filter((t) => t[0]).map((t) => t[0] + ':' + t[1]), ['k:ALTER', 'k:table', 'k:add', 'k:column', 'c:-- yes']);
  const json = S.tokenize('{"a": 1, "b": "x"}', 'json')[0];
  assert.deepEqual(json.filter((t) => t[0]).map((t) => t[0]), ['p', 'a', 'p', 'n', 'p', 'a', 'p', 's', 'p']);
  assert.deepEqual(S.tokenize('plain', 'text'), [[['', 'plain']]]);
  assert.deepEqual(['a.tsx', 'b.css', 'c.sql', 'd.json', 'e.html', 'f.md'].map(S.langOf), ['js', 'css', 'sql', 'json', 'html', 'text']);
});

test('the lines a diff added, in the new file\'s numbers', () => {
  assert.deepEqual([...S.addedLines('@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10 +11,2 @@\n x\n+y\n')], [2, 3, 12]);
});

test('the database view: tables, row level security and columns from one tab-separated read', () => {
  const t = S.parseTables('T\tnotes\ttrue\t\nT\ttodos\tfalse\t\nC\tnotes\tid\tbigint not null\nC\tnotes\tbody\ttext not null\nC\ttodos\tdone\tboolean\n');
  assert.deepEqual(t, [{ name: 'notes', rls: true, columns: [{ name: 'id', type: 'bigint not null' }, { name: 'body', type: 'text not null' }] },
    { name: 'todos', rls: false, columns: [{ name: 'done', type: 'boolean' }] }]);
  assert.match(S.TABLES_SQL, /relrowsecurity/);
});

test('the prompt names the tab, the tools, and where the app and its schema live', () => {
  const p = S.agentPrompt('https://x.example/snowglobe/agent/');
  for (const s of ['https://x.example/snowglobe/agent/', 'open_preview', 'write_files', 'read_file', 'run_sql', 'revert_changes', '/root/app', 'row level security', 'Machines'])
    assert.ok(p.includes(s), s);
  // The project starts blank: no app of the starter's to describe
  assert.match(p, /starts blank/);
  assert.ok(!/notes/i.test(p));
  assert.match(p, /What to build: $/);
});
