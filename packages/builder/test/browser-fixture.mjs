// An intercepted HTTPS document applies production isolation headers without a
// running dev server, VM images or user accounts. BUILDER_URL opts into a real site.
export async function openFixture(page){
 if(process.env.BUILDER_URL){await page.goto(process.env.BUILDER_URL);return {offline:false};}
 const attempts=[];
 await page.route('https://builder.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path!=='/'){attempts.push(path);return route.fulfill({status:200,contentType:'application/json',body:'{"canary":"private-gateway"}'});}
  return route.fulfill({status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<!doctype html><html><body>Builder security fixture</body></html>'});
 });
 await page.goto('https://builder.test/');return {offline:true,attempts};
}
