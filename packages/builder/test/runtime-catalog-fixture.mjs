// UI regressions mock VM operations; their catalog must not depend on locally
// built guest images. These URLs describe fixtures and must never boot a VM.
export const runtimeCatalog = {
 armless:{js:'/fixtures/armless.js',wasm:'/fixtures/armless.wasm',wasm_smp:'/fixtures/armless-smp.wasm'},
 xterm:'/fixtures/xterm/',
 runtimes:['web','supabase'].map(name=>({
  name,title:name,base:`/fixtures/${name}/`,build_id:`fixture-${name}`,
  memory_mb:640,cpus:1,network:'fetch'
 }))
};
