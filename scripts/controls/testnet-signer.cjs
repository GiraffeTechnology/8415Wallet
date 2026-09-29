const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const crypto=require('node:crypto');
const {ethers}=require('ethers');

// Loopback signer for public-testnet runs. The journey runner refuses raw
// signatures by design and expects an RPC that custodies its five actors; a
// public endpoint custodies nothing. This process holds the throwaway test keys
// and nothing else does: the runner still sees only an RPC, and no key, key
// file path or request token is ever written to stdout or to evidence.
//
// Test networks only, no real value, loopback only, one bounded method set.
const ALLOWED_CHAINS=[11155111n,560048n];
const FORWARD=new Set(['eth_chainId','net_version','eth_blockNumber','eth_getBalance','eth_call','eth_estimateGas',
  'eth_getCode','eth_getStorageAt','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionByHash',
  'eth_getTransactionReceipt','eth_getTransactionCount','eth_feeHistory','eth_gasPrice','eth_maxPriorityFeePerGas','eth_getLogs']);
const LOCAL=new Set(['eth_accounts','eth_sendTransaction','eth_signTypedData_v4']);
// Actual gas measured for the whole runner journey set on a local EVM at
// commit 7a4e970: 128 transactions, 35,392,861 gas. An estimate for funding,
// never a promise about a public network. Re-measure when the runner's set of
// journeys changes, or this under-funds a run and it stops halfway.
const MEASURED_GAS={A:21221446n,B:4103742n,C:3314654n,D:1497762n,registrar:5255257n};
const ROLES=['A','B','C','D','registrar'];
const HEADROOM_PERCENT=150n;

const refuse=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const integer=(name,min,max)=>{
  const v=process.env[name];if(!v||!/^\d+$/.test(v))refuse('SIGNER_EXPLICIT_BUDGET_REQUIRED');
  const n=BigInt(v);if(n<min||n>max)refuse('SIGNER_BUDGET_REFUSED');return n;
};
function settings(){
  if(process.env.WALLET_TESTNET_EXECUTE!=='TEST_ONLY_NO_REAL_VALUE')refuse('SIGNER_EXECUTION_NOT_ENABLED');
  const chainId=integer('WALLET_TESTNET_CHAIN_ID',1n,2n**64n-1n);
  if(!ALLOWED_CHAINS.includes(chainId))refuse('SIGNER_CHAIN_NOT_ALLOWED');
  const maxFee=integer('WALLET_TESTNET_MAX_FEE_PER_GAS_WEI',1n,1000000000000n);
  const maxGas=integer('WALLET_TESTNET_MAX_GAS_PER_TX',21000n,15000000n);
  const upstream=process.env.WALLET_TESTNET_UPSTREAM_RPC_URL;
  // A rehearsal drives this same path against a loopback chain, so the public
  // journey is proved end to end before any funded run. It cannot reach a public
  // network: the upstream must be loopback, and the flag has to be explicit.
  const rehearsal=process.env.WALLET_TESTNET_UPSTREAM_LOOPBACK_REHEARSAL==='LOOPBACK_REHEARSAL_NOT_PUBLIC_CHAIN';
  const loopback=/^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(upstream??'');
  if(!upstream||!(/^https:\/\//.test(upstream)||(rehearsal&&loopback)))refuse('SIGNER_UPSTREAM_HTTPS_REQUIRED');
  return {chainId,maxFee,maxGas,upstream,rehearsal:rehearsal&&loopback};
}
function keystorePath(){
  const index=process.argv.indexOf('--keystore');
  const dir=index>0?process.argv[index+1]:undefined;
  if(!dir||!path.isAbsolute(dir))refuse('SIGNER_ABSOLUTE_KEYSTORE_REQUIRED');
  return {dir,file:path.join(dir,'signers.json')};
}
function create({dir,file}){
  const parent=path.dirname(dir),stat=fs.lstatSync(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(parent)!==parent)refuse('SIGNER_KEYSTORE_PARENT_REFUSED');
  fs.mkdirSync(dir,{mode:0o700});
  const keys=Array.from({length:5},()=>ethers.Wallet.createRandom().privateKey);
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({schema:'8415-testnet-signers/1',scope:'TEST_ONLY_NO_REAL_VALUE',keys})+'\n');fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  return keys;
}
function load({file}){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)refuse('SIGNER_KEYSTORE_IDENTITY_REFUSED');
  if((stat.mode&0o077)!==0)refuse('SIGNER_KEYSTORE_PERMISSIONS_REFUSED');
  const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
  if(parsed?.schema!=='8415-testnet-signers/1'||!Array.isArray(parsed.keys)||parsed.keys.length!==5||
    parsed.keys.some(k=>typeof k!=='string'||!/^0x[0-9a-f]{64}$/.test(k)))refuse('SIGNER_KEYSTORE_SCHEMA_REFUSED');
  return parsed.keys;
}
const wallets=keys=>keys.map(k=>new ethers.Wallet(k));
/**
 * What each role is still short, given what it already holds. Role A funds the
 * others, so its own shortfall is settled by the person funding it; the rest is
 * a single transfer per role and nothing is sent to a role already funded.
 */
function shortfalls(rows,balances){
  const transfers=rows.slice(1)
    .map((row,index)=>({role:row.role,index:row.index,wei:row.weiRequired>balances[index+1]?row.weiRequired-balances[index+1]:0n}))
    .filter(t=>t.wei>0n);
  return {transfers,totalWei:transfers.reduce((t,x)=>t+x.wei,0n)};
}
function requirement(maxFee){
  const rows=ROLES.map((role,index)=>({role,index,
    weiRequired:MEASURED_GAS[role]*maxFee*HEADROOM_PERCENT/100n}));
  return {rows,totalWei:rows.reduce((t,r)=>t+r.weiRequired,0n)};
}
const report=(addresses,maxFee,balances)=>{
  const {rows,totalWei}=requirement(maxFee);
  for(const row of rows){
    const balance=balances?.[row.index];
    process.stdout.write(`${row.role.padEnd(9)} ${addresses[row.index]}  need ${ethers.formatEther(row.weiRequired)} ETH`+
      (balance===undefined?'':`  have ${ethers.formatEther(balance)} ETH  ${balance>=row.weiRequired?'ok':'UNDERFUNDED'}`)+'\n');
  }
  process.stdout.write(`total needed ${ethers.formatEther(totalWei)} ETH at ${ethers.formatUnits(maxFee,'gwei')} gwei; test value only\n`);
};
async function connect({chainId,upstream}){
  const request=new ethers.FetchRequest(upstream);request.timeout=30000;
  const provider=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1,staticNetwork:true});
  if((await provider.getNetwork()).chainId!==chainId)refuse('SIGNER_UPSTREAM_CHAIN_MISMATCH');
  return provider;
}
function typedData(json,{chainId}){
  let payload;try{payload=JSON.parse(json);}catch{refuse('SIGNER_TYPED_PAYLOAD_REFUSED');}
  const {domain,types,message,primaryType}=payload??{};
  if(primaryType!=='ForwardConsent'||domain?.name!=='8415Wallet ResponsibilityControls'||domain.version!=='1'||
    BigInt(domain.chainId)!==chainId||!ethers.isAddress(domain.verifyingContract))refuse('SIGNER_TYPED_DOMAIN_REFUSED');
  if(!types||!Array.isArray(types.ForwardConsent)||Object.keys(types).some(k=>!['EIP712Domain','ForwardConsent'].includes(k)))
    refuse('SIGNER_TYPED_TYPES_REFUSED');
  if(typeof message!=='object'||message===null)refuse('SIGNER_TYPED_MESSAGE_REFUSED');
  return {domain:{name:domain.name,version:domain.version,chainId:domain.chainId,verifyingContract:domain.verifyingContract},
    types:{ForwardConsent:types.ForwardConsent},message};
}
async function serve(config,keys){
  const provider=await connect(config);
  const signers=wallets(keys);
  const addresses=signers.map(s=>s.address.toLowerCase());
  const nonces=new Map();
  const token=crypto.randomBytes(24).toString('hex');
  const of=address=>{
    if(typeof address!=='string'||!ethers.isAddress(address))refuse('SIGNER_ADDRESS_REFUSED');
    const index=addresses.indexOf(address.toLowerCase());
    if(index<0)refuse('SIGNER_ACCOUNT_NOT_CUSTODIED');
    return signers[index];
  };
  async function send(input){
    if(typeof input!=='object'||input===null)refuse('SIGNER_TRANSACTION_REFUSED');
    const signer=of(input.from);
    const value=BigInt(input.value??0);
    // A test journey moves accounting amounts only. Nothing here carries value.
    if(value<0n||value>1000n)refuse('SIGNER_VALUE_LIMIT_REFUSED');
    const gasLimit=BigInt(input.gas??input.gasLimit??0);
    if(gasLimit<21000n||gasLimit>config.maxGas)refuse('SIGNER_GAS_LIMIT_REFUSED');
    const maxFeePerGas=BigInt(input.maxFeePerGas??0),maxPriorityFeePerGas=BigInt(input.maxPriorityFeePerGas??0);
    if(maxFeePerGas<1n||maxFeePerGas>config.maxFee||maxPriorityFeePerGas>maxFeePerGas)refuse('SIGNER_FEE_LIMIT_REFUSED');
    if(input.chainId!==undefined&&BigInt(input.chainId)!==config.chainId)refuse('SIGNER_CHAIN_MISMATCH');
    if(input.data!==undefined&&!/^0x([0-9a-fA-F]{2})*$/.test(input.data))refuse('SIGNER_CALLDATA_REFUSED');
    if(input.to!==undefined&&input.to!==null&&!ethers.isAddress(input.to))refuse('SIGNER_RECIPIENT_REFUSED');
    const pending=BigInt(await provider.getTransactionCount(signer.address,'pending'));
    const previous=nonces.get(signer.address);
    const nonce=previous===undefined?pending:(pending>previous+1n?pending:previous+1n);
    const signed=await signer.signTransaction({type:2,chainId:config.chainId,nonce:Number(nonce),to:input.to??null,
      value,data:input.data??'0x',gasLimit,maxFeePerGas,maxPriorityFeePerGas});
    // Broadcast before recording the nonce so a rejected send is retried on the
    // same nonce rather than silently skipping one.
    const hash=await provider.send('eth_sendRawTransaction',[signed]);
    nonces.set(signer.address,nonce);
    return hash;
  }
  async function handle({method,params=[]}){
    if(!Array.isArray(params))refuse('SIGNER_PARAMS_REFUSED');
    if(method==='eth_accounts')return signers.map(s=>s.address);
    if(method==='eth_sendTransaction')return send(params[0]);
    if(method==='eth_signTypedData_v4'){
      const signer=of(params[0]);const {domain,types,message}=typedData(params[1],config);
      return signer.signTypedData(domain,types,message);
    }
    if(FORWARD.has(method))return provider.send(method,params);
    refuse('SIGNER_METHOD_REFUSED');
  }
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    const host=req.headers.host;
    const port=server.address().port;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||req.method!=='POST'||req.url!==`/${token}`){res.writeHead(404);res.end();return;}
    const chunks=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>131072){req.destroy();return;}chunks.push(chunk);});
    req.on('end',async()=>{
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'SIGNER_BODY_REFUSED'});}
      if(Array.isArray(body))return reply(400,{error:'SIGNER_BATCH_REFUSED'});
      const id=body?.id??null;
      if(typeof body?.method!=='string'||!(LOCAL.has(body.method)||FORWARD.has(body.method)))
        return reply(200,{jsonrpc:'2.0',id,error:{code:-32601,message:'SIGNER_METHOD_REFUSED'}});
      try{reply(200,{jsonrpc:'2.0',id,result:await handle(body)});}
      catch(error){
        // A refusal of ours answers with its stable code and nothing else. An
        // upstream failure keeps its own code and its revert bytes, because a
        // caller asserting on a custom error has to see them; only hex data is
        // relayed, and the message is bounded, so nothing else travels back.
        if(error?.safeCode)return reply(200,{jsonrpc:'2.0',id,error:{code:-32000,message:error.safeCode}});
        const upstream=error?.info?.error??error;
        const data=[upstream?.data,error?.data].find(d=>typeof d==='string'&&/^0x([0-9a-fA-F]{2})*$/.test(d));
        // A public node answers a reverted call with EIP-1474 code 3, which is
        // what a caller classifies a revert from. A development chain may answer
        // -32603 instead, so a rehearsal normalises toward the public shape:
        // otherwise the rehearsal would exercise a code no public node sends.
        const reverted=config.rehearsal&&body.method==='eth_call'&&data!==undefined&&data!=='0x';
        reply(200,{jsonrpc:'2.0',id,error:{code:reverted?3:Number.isInteger(upstream?.code)?upstream.code:-32000,
          message:String(upstream?.message??'SIGNER_REQUEST_REFUSED').slice(0,200),...(data===undefined?{}:{data})}});
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/${token}`;
  const file=process.env.WALLET_TESTNET_SIGNER_URL_FILE;
  if(file){
    if(!path.isAbsolute(file))refuse('SIGNER_URL_FILE_REFUSED');
    const fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,url);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  process.stdout.write(`loopback signer listening on 127.0.0.1:${server.address().port}; 5 custodied test accounts`+
    (config.rehearsal?' against a LOOPBACK REHEARSAL chain, not a public network\n':'\n'));
  process.stdout.write(file?`request url written to ${file}\n`:'set WALLET_TESTNET_SIGNER_URL_FILE to capture the request url\n');
  report(signers.map(s=>s.address),config.maxFee,await Promise.all(signers.map(s=>provider.getBalance(s.address))));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();process.exit(0);});
  return server;
}
async function main(){
  const mode=process.argv[2];
  const config=settings();
  const store=keystorePath();
  if(mode==='init'){
    const addresses=wallets(create(store)).map(w=>w.address);
    process.stdout.write('five throwaway test signers created; fund these addresses from a faucet\n');
    report(addresses,config.maxFee);
    return;
  }
  if(mode==='status'){
    const signers=wallets(load(store));
    const provider=await connect(config);
    report(signers.map(s=>s.address),config.maxFee,await Promise.all(signers.map(s=>provider.getBalance(s.address))));
    return;
  }
  if(mode==='distribute'){
    const signers=wallets(load(store));
    const provider=await connect(config);
    const balances=await Promise.all(signers.map(s=>provider.getBalance(s.address)));
    const {rows}=requirement(config.maxFee);
    const {transfers,totalWei}=shortfalls(rows,balances);
    if(transfers.length===0){process.stdout.write('every role is already funded; nothing to send\n');return;}
    // A plain transfer costs 21000; keep a margin so the last one is not stranded.
    const fees=BigInt(transfers.length)*21000n*config.maxFee*2n;
    if(balances[0]<totalWei+fees)refuse('SIGNER_FUNDER_INSUFFICIENT');
    const funder=signers[0].connect(provider);
    for(const transfer of transfers){
      const sent=await funder.sendTransaction({to:signers[transfer.index].address,value:transfer.wei,
        maxFeePerGas:config.maxFee,maxPriorityFeePerGas:config.maxFee/10n,gasLimit:21000n});
      const receipt=await sent.wait(1);
      process.stdout.write(`${transfer.role.padEnd(9)} ${ethers.formatEther(transfer.wei)} ETH  ${receipt.hash}\n`);
    }
    report(signers.map(s=>s.address),config.maxFee,await Promise.all(signers.map(s=>provider.getBalance(s.address))));
    return;
  }
  if(mode==='serve'){await serve(config,load(store));return;}
  refuse('SIGNER_MODE_REFUSED');
}
if(require.main===module)main().catch(error=>{process.stderr.write(`${error?.safeCode??'SIGNER_FAILED'}\n`);process.exit(1);});
module.exports={ALLOWED_CHAINS,FORWARD,LOCAL,MEASURED_GAS,ROLES,HEADROOM_PERCENT,requirement,shortfalls,typedData,load};
