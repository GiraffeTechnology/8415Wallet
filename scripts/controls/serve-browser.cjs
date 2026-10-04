const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');

// Development-only server: loopback, GET/HEAD and two public static trees only.
// It has no RPC forwarding, signing, secret loading, upload or write endpoint.
const root=path.resolve(__dirname,'../..');
const port=Number(process.env.WALLET_BROWSER_PORT??'8415');
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('BROWSER_PORT_REFUSED');
const web=new Set(['index.html','login-core.mjs','wallet-auth.mjs','account-auth.mjs','app.mjs','public-store.mjs','wallet.css','external-assets.mjs','external-store.mjs','ui-lock.mjs','release-profile.mjs','release-config.json','settlement-store.mjs','legacy-clearing.mjs','legacy-clearing-store.mjs']);
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  const host=req.headers.host;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||!['GET','HEAD'].includes(req.method)) {res.writeHead(403);res.end();return;}
  if(req.url==='/'){res.writeHead(302,{Location:'/web/index.html'});res.end();return;}
  let relative;
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.search||url.hash)throw new Error();
    relative=decodeURIComponent(url.pathname).slice(1);
    if(relative==='')relative='web/index.html';
    if(relative.includes('\\')||relative.split('/').some(s=>s==='..'||s==='.'||s===''))throw new Error();
    if(!(relative.startsWith('web/')&&web.has(relative.slice(4)))&&
       !(relative.startsWith('dist/browser/')&&/^[a-zA-Z0-9_/-]+\.js$/.test(relative)))throw new Error();
    const full=path.resolve(root,relative),segments=relative.split('/');let at=root;
    for(const segment of segments){at=path.join(at,segment);if(fs.lstatSync(at).isSymbolicLink())throw new Error();}
    const stat=fs.lstatSync(full);if(!stat.isFile()||stat.nlink!==1||stat.size>2000000)throw new Error();
    res.setHeader('Content-Type',mime[path.extname(full)]??'application/octet-stream');
    res.writeHead(200);res.end(req.method==='HEAD'?undefined:fs.readFileSync(full));
  }catch{res.writeHead(404);res.end();}
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`8415Wallet browser available on loopback port ${port}; development-only\n`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
