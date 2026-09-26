const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {ethers}=require('ethers');

// Genuine browser acceptance for the reference UI: a real Chromium renders the
// served page, a real person's clicks are reproduced as real clicks, and every
// read and write goes through an injected EIP-1193 provider exactly as a wallet
// extension would. The page itself keeps no network path to the chain, so this
// is the same trust boundary the product ships with.
//
// A desktop window and an emulated phone viewport are both driven. An emulated
// viewport is not a physical handset, and this journal never claims one.
const ALLOWED_CHAINS=[11155111n,560048n];
const VIEWPORTS=[{name:'desktop',viewport:{width:1440,height:900},isMobile:false,hasTouch:false,deviceScaleFactor:1},
  {name:'mobile',viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3}];
const refuse=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const flag=name=>{const i=process.argv.indexOf(`--${name}`);return i>0?process.argv[i+1]:undefined;};
const absolute=(name,value)=>{if(!value||!path.isAbsolute(value))refuse(`BROWSER_${name}_ABSOLUTE_REQUIRED`);return value;};

function chromium(){
  const explicit=process.env.WALLET_BROWSER_CHROMIUM;
  if(explicit)return explicit;
  const root=process.env.PLAYWRIGHT_BROWSERS_PATH??'/opt/pw-browsers';
  const found=fs.readdirSync(root).filter(n=>/^chromium-\d+$/.test(n)).sort()
    .map(n=>path.join(root,n,'chrome-linux','chrome')).filter(p=>fs.existsSync(p));
  if(found.length===0)refuse('BROWSER_CHROMIUM_NOT_FOUND');
  return found[found.length-1];
}
async function detachedExport(provider,controller,abi,sequenceId,chainId){
  const contract=new ethers.Contract(controller,abi,provider);
  const logs=await contract.queryFilter(contract.filters.LegDetached(sequenceId),0,'latest');
  return {schema:'8415-detached-history/1',chainId:String(chainId),controller:controller.toLowerCase(),sequenceId,
    records:logs.map(log=>({occurrence:String(log.args.occurrence),legId:log.args.legId,fromAccount:log.args.fromAccount,
      toAccount:log.args.toAccount,termsHash:log.args.termsHash,acceptanceHash:log.args.acceptanceHash,
      returnAuthority:log.args.returnAuthority,returnConditionHash:log.args.returnConditionHash,
      detachedCommitment:log.args.detachedCommitment}))};
}
async function main(){
  const rpc=fs.readFileSync(absolute('RPC_URL_FILE',flag('rpc-url-file')),'utf8').trim();
  const deploymentFile=absolute('DEPLOYMENT',flag('deployment'));
  const output=absolute('OUTPUT',flag('output'));
  const tokenId=flag('token')??'1';
  const sequenceId=flag('sequence');
  if(!/^\d+$/.test(tokenId)||!/^0x[0-9a-f]{64}$/.test(sequenceId??''))refuse('BROWSER_SUBJECT_REFUSED');
  const deployment=JSON.parse(fs.readFileSync(deploymentFile,'utf8'));
  if(deployment?.schema!=='8415-controls-testnet/1')refuse('BROWSER_DEPLOYMENT_SCHEMA_REFUSED');
  const chainId=BigInt(deployment.chainId);
  if(!ALLOWED_CHAINS.includes(chainId))refuse('BROWSER_CHAIN_NOT_ALLOWED');
  fs.mkdirSync(output,{mode:0o700});

  const provider=new ethers.JsonRpcProvider(rpc,undefined,{batchMaxCount:1,staticNetwork:true});
  if((await provider.getNetwork()).chainId!==chainId)refuse('BROWSER_CHAIN_MISMATCH');
  const abi=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../artifacts/contracts/controls/ResponsibilityController.sol/ResponsibilityController.json'),'utf8')).abi;
  const archive=await detachedExport(provider,deployment.controller.address,abi,sequenceId,chainId);
  const archiveFile=path.join(output,'detached-history.json');
  fs.writeFileSync(archiveFile,JSON.stringify(archive,null,2));

  const port=Number(process.env.WALLET_BROWSER_PORT??'8415');
  const server=spawn(process.execPath,[path.resolve(__dirname,'serve-browser.cjs')],
    {env:{...process.env,WALLET_BROWSER_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  const origin=`http://127.0.0.1:${port}`;
  await new Promise((resolve,reject)=>{
    server.stdout.once('data',resolve);server.once('error',reject);
    setTimeout(()=>reject(Object.assign(new Error('BROWSER_SERVER_TIMEOUT'),{safeCode:'BROWSER_SERVER_TIMEOUT'})),20000);
  });

  const {chromium:launcher}=require('playwright-core');
  const browser=await launcher.launch({executablePath:chromium(),args:['--no-sandbox','--disable-dev-shm-usage']});
  const journal=[],violations=[];
  try{
    for(const profile of VIEWPORTS){
      const context=await browser.newContext({viewport:profile.viewport,isMobile:profile.isMobile,
        hasTouch:profile.hasTouch,deviceScaleFactor:profile.deviceScaleFactor});
      const requests=[],consoleErrors=[],calls=[],failed=[];
      // A page request that leaves this origin would mean the page reached the
      // chain itself. Record every one so the journal can prove it did not.
      context.on('request',r=>requests.push(r.url()));
      context.on('weberror',e=>consoleErrors.push(String(e.error()?.message??'error')));
      // The development server serves two static trees and nothing else, so a
      // browser's automatic /favicon.ico probe is a 404 by design, not a defect.
      context.on('response',r=>{if(r.status()>=400&&new URL(r.url()).pathname!=='/favicon.ico')failed.push(`${r.status()} ${r.url()}`);});
      // A wallet provider rejects with the node's own error object, and a caller
      // classifies a reverted call from its EIP-1474 code. Crossing this binding
      // would flatten a thrown error to its message alone, so the outcome is
      // carried as data and rebuilt in the page with code and data intact.
      await context.exposeFunction('__wallet8415Rpc',async(method,params)=>{
        calls.push(method);
        const request=method==='eth_requestAccounts'?'eth_accounts':method;
        const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:request,params:params??[]})});
        const body=await response.json();
        if(body?.error)return {ok:false,error:{code:body.error.code,message:String(body.error.message??''),data:body.error.data}};
        return {ok:true,result:body?.result};
      });
      await context.addInitScript(()=>{
        // Minimal EIP-1193 surface, the same contract a wallet extension offers.
        globalThis.ethereum={isTestHarness:true,
          request:async({method,params})=>{
            const outcome=await globalThis.__wallet8415Rpc(method,params??[]);
            if(outcome.ok)return outcome.result;
            const error=new Error(outcome.error.message);
            error.code=outcome.error.code;error.data=outcome.error.data;
            throw error;
          },
          on(){},removeListener(){}};
      });
      const page=await context.newPage();
      // Resource failures are judged from the response events above, which know
      // the url; a console line for the same failure would double-count it.
      page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))consoleErrors.push(m.text());});
      const shot=async name=>{const file=path.join(output,`${profile.name}-${name}.png`);
        await page.screenshot({path:file,fullPage:true});return path.basename(file);};
      const result=async()=>(await page.locator('#result').textContent())??'';
      // The page disables every control while an operation runs and re-enables
      // them when it settles, so a step is complete when it is idle again AND
      // the panel changed. Waiting on the panel alone raced the previous step
      // and silently dropped the next click, which the page ignores while busy.
      const settled=before=>page.waitForFunction(previous=>!document.getElementById('connect').disabled&&
        document.getElementById('result').textContent!==previous,before,{timeout:120000});
      const step=async(name,fn)=>{
        const previous=await result();const before=Date.now();
        await fn();await settled(previous);
        const text=await result();
        const refused=/^CONTROL_[A-Z_]+$/.test(text.trim());
        journal.push({profile:profile.name,step:name,refused,resultSha256:crypto.createHash('sha256').update(text).digest('hex'),
          resultLength:text.length,ms:Date.now()-before,screenshot:await shot(name)});
        if(refused)refuse(`BROWSER_STEP_REFUSED_${name.toUpperCase().replace(/[^A-Z]/g,'_')}_${text.trim()}`);
        return text;
      };
      // A negative case the product must explain rather than refuse: a bare
      // refusal code would leave a reader unable to tell "the register says
      // nothing about this instant" from "something broke".
      const negative=async(name,fn,required)=>{
        const previous=await result();await fn();await settled(previous);
        const text=(await result()).trim();
        const bare=/^CONTROL_[A-Z_]+$/.test(text);
        journal.push({profile:profile.name,step:name,refused:bare,explained:!bare&&text.includes(required),
          resultSha256:crypto.createHash('sha256').update(text).digest('hex'),resultLength:text.length,
          screenshot:await shot(name)});
        if(bare)refuse(`BROWSER_NEGATIVE_CASE_BARE_REFUSAL_${text}`);
        if(!text.includes(required))refuse('BROWSER_NEGATIVE_CASE_UNEXPLAINED');
        return text;
      };
      await page.goto(`${origin}/web/index.html`,{waitUntil:'load'});
      await step('deployment-loaded',async()=>{
        await page.setInputFiles('#deployment',deploymentFile);
      });
      await step('connected',async()=>{
        await page.click('#connect');
      });
      const identity=await page.locator('#identity').textContent();
      if(!identity?.includes(`Chain ${chainId}`))refuse('BROWSER_IDENTITY_REFUSED');
      await page.fill('#tokenId',tokenId);
      // A covered instant for the ordinary query, and the instant before the
      // first entry as an explicit negative: the projection does not cover it,
      // and the page must say so rather than read like a failure.
      const latest=await provider.getBlock('latest');
      await page.fill('#instant',String(latest.timestamp));
      for(const read of ['asset','temporal','history','registration','acquisition','risk','posture','settlements','ownership'])
        await step(`read-${read}`,async()=>{
          await page.click(`[data-read="${read}"]`);
        });
      await negative('read-temporal-before-first-entry',async()=>{
        await page.fill('#instant','0');
        await page.click('[data-read="temporal"]');
      },'does not cover this instant');
      await page.fill('#instant',String(latest.timestamp));
      await step('linked-tab',async()=>{
        await page.click('#linked-tab');
        await page.waitForSelector('#linked:not([hidden])');
        await page.fill('#sequenceId',sequenceId);
        await page.click('[data-action="read"]');
      });
      const chainText=await result();
      // The archive read must show the chain-checked disclosure and the exact
      // commitment the contract holds, not merely change the panel.
      const verified=await step('detached-history-verified',async()=>{
        await page.setInputFiles('#detached-history-file',archiveFile);
        await page.click('[data-action="read-detached-history"]');
      });
      const commitment=archive.records.at(-1)?.detachedCommitment;
      if(!verified.includes('checked against a canonical chain commitment'))
        refuse(`BROWSER_ARCHIVE_DISCLOSURE_MISSING: ${verified.replace(/\s+/g,' ').slice(0,200)}`);
      if(commitment!==undefined&&!verified.toLowerCase().includes(commitment.toLowerCase()))refuse('BROWSER_ARCHIVE_COMMITMENT_MISSING');
      const foreign=requests.filter(u=>!u.startsWith(origin));
      journal.push({profile:profile.name,step:'boundary',refused:false,
        archiveRecords:archive.records.length,archiveCommitmentRendered:true,foreignRequests:foreign,
        pageRequestCount:requests.length,providerCalls:calls.length,consoleErrors,failedResponses:failed,
        liveLegsRendered:/legs|occurrence|boundary/i.test(chainText??''),
        uiVerified:true,physicalDevice:false,independentAuditPassed:false});
      if(foreign.length>0)violations.push({profile:profile.name,code:'BROWSER_PAGE_LEFT_ORIGIN',detail:foreign.slice(0,4)});
      if(consoleErrors.length>0)violations.push({profile:profile.name,code:'BROWSER_CONSOLE_ERROR',
        detail:consoleErrors.slice(0,4).map(t=>String(t).slice(0,200))});
      if(failed.length>0)violations.push({profile:profile.name,code:'BROWSER_RESOURCE_FAILED',detail:failed.slice(0,4)});
      await context.close();
    }
  }finally{
    await browser.close();server.kill('SIGTERM');
  }
  const summary={schema:'8415-browser-journey/1',verdict:'UI_JOURNEY_EXECUTED_NOT_FULL_V3_ACCEPTANCE',
    chainId:String(chainId),tokenId,sequenceId,controller:deployment.controller.address,
    profiles:VIEWPORTS.map(v=>({name:v.name,...v.viewport,isMobile:v.isMobile})),violations,
    steps:journal.length,chromium:chromium(),physicalDevice:false,independentAuditPassed:false,
    remaining:'A physical handset, a public-chain run and independent review remain separate gates.',
    completedAt:new Date().toISOString(),journal};
  fs.writeFileSync(path.join(output,'browser-journey.json'),
    JSON.stringify({...summary,verdict:violations.length===0?summary.verdict:'UI_JOURNEY_VIOLATIONS_RECORDED'},null,2)+'\n');
  process.stdout.write(`browser journey recorded ${journal.length} steps across ${VIEWPORTS.length} profiles\n`);
  if(violations.length>0){
    for(const v of violations)process.stdout.write(`${v.profile} ${v.code} ${JSON.stringify(v.detail)}\n`);
    refuse('BROWSER_JOURNEY_VIOLATIONS');
  }
}
if(require.main===module)main().catch(e=>{process.stderr.write(`${e?.safeCode??e?.message??'BROWSER_JOURNEY_FAILED'}\n`);process.exit(1);});
module.exports={ALLOWED_CHAINS,VIEWPORTS,chromium};
