const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {ethers}=require('ethers');
const {createScenario,runCoreJourney,runExtendedJourneys}=require('./scenario-kit.cjs');

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const refuse=code=>{throw Object.assign(new Error(code),{safeCode:code});};
// Explicit bounded wait policy, not a promise about network liveness. Three
// minutes for inclusion plus 24 seconds per additional requested confirmation.
function confirmationWaitMs(confirmations){
  if(!Number.isSafeInteger(confirmations)||confirmations<1||confirmations>64)refuse('TESTNET_CONFIRMATIONS_REFUSED');
  return 180000+(confirmations-1)*24000;
}
const integer=(name,min,max)=>{
  const v=process.env[name];if(!v||!/^\d+$/.test(v))refuse('TESTNET_EXPLICIT_BUDGET_REQUIRED');
  const n=BigInt(v);if(n<min||n>max)refuse('TESTNET_BUDGET_REFUSED');return n;
};
async function main(){
  if(process.env.WALLET_TESTNET_EXECUTE!=='TEST_ONLY_NO_REAL_VALUE')refuse('TESTNET_EXECUTION_NOT_ENABLED');
  const chainId=integer('WALLET_TESTNET_CHAIN_ID',1n,2n**64n-1n);
  if(![11155111n,560048n].includes(chainId))refuse('TESTNET_CHAIN_NOT_ALLOWED');
  const maxFee=integer('WALLET_TESTNET_MAX_FEE_PER_GAS_WEI',1n,1000000000000n);
  const totalBudget=integer('WALLET_TESTNET_TOTAL_BUDGET_WEI',1n,1000000000000000000n);
  const maxGas=integer('WALLET_TESTNET_MAX_GAS_PER_TX',21000n,15000000n);
  const confirms=Number(integer('WALLET_TESTNET_CONFIRMATIONS',1n,64n));
  const confirmationTimeoutMs=confirmationWaitMs(confirms);
  const sourceCommit=process.env.WALLET_TESTNET_SOURCE_COMMIT;
  if(!sourceCommit||!/^[0-9a-f]{40}$/.test(sourceCommit))refuse('TESTNET_SOURCE_BINDING_REQUIRED');
  const root=path.resolve(__dirname,'../..');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(git('rev-parse','HEAD')!==sourceCommit||git('status','--porcelain')!=='')refuse('TESTNET_SOURCE_NOT_FROZEN');
  const sourceTree=git('rev-parse','HEAD^{tree}');
  // This URL must point to an explicitly authorized test signer/RPC. Never log it.
  const endpoint=process.env.WALLET_TESTNET_RPC_URL;
  if(!endpoint)refuse('TESTNET_SIGNER_RPC_REQUIRED');
  const connection=new ethers.FetchRequest(endpoint);connection.timeout=30000;
  const provider=new ethers.JsonRpcProvider(connection,undefined,{batchMaxCount:1});
  let evidenceFd=null;
  try{
    if((await provider.getNetwork()).chainId!==chainId)refuse('TESTNET_CHAIN_MISMATCH');
    const raw=await provider.send('eth_accounts',[]);
    const selected=process.env.WALLET_TESTNET_PUBLIC_ACTORS?.split(',');
    if(!selected||selected.length!==5||selected.some(a=>!ethers.isAddress(a))||new Set(selected.map(a=>a.toLowerCase())).size!==5||
      !Array.isArray(raw)||selected.some(a=>!raw.some(b=>typeof b==='string'&&b.toLowerCase()===a.toLowerCase())))refuse('TESTNET_FIVE_CUSTODIED_ACTORS_REQUIRED');
    const output=process.env.WALLET_TESTNET_OUTPUT_DIRECTORY;
    if(!output||!path.isAbsolute(output))refuse('TESTNET_EXCLUSIVE_OUTPUT_REQUIRED');
    // Parent must pre-exist; final directory must not. Never overwrites an earlier run.
    const parent=path.dirname(output);const parentStat=fs.lstatSync(parent);
    if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||fs.realpathSync(parent)!==parent)refuse('TESTNET_OUTPUT_PARENT_REFUSED');
    fs.mkdirSync(output,{mode:0o700});
    evidenceFd=fs.openSync(path.join(output,'transactions.jsonl'),'wx',0o600);
    let previousHash='0'.repeat(64),count=0;
    const record=async record=>{
      const publicRecord={index:++count,previousHash,...record};const bytes=JSON.stringify(publicRecord);
      previousHash=hash(bytes);fs.writeSync(evidenceFd,JSON.stringify({...publicRecord,evidenceHash:previousHash})+'\n');fs.fsyncSync(evidenceFd);
    };
    const createJson=(name,value)=>{const fd=fs.openSync(path.join(output,name),'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
    let reserved=0n;const deployments=new Map();
    class BudgetSigner extends ethers.AbstractSigner{
      constructor(inner){super(provider);this.inner=inner;}
      getAddress(){return this.inner.getAddress();}
      connect(){refuse('TESTNET_SIGNER_REBIND_REFUSED');}
      signMessage(){refuse('TESTNET_ARBITRARY_MESSAGE_REFUSED');}
      signTransaction(){refuse('TESTNET_RAW_SIGNATURE_REFUSED');}
      async signTypedData(domain,types,value){
        if(domain.name!=='8415Wallet ResponsibilityControls'||domain.version!=='1'||BigInt(domain.chainId)!==chainId||
          domain.verifyingContract?.toLowerCase()!==deployments.get('ResponsibilityController')?.address.toLowerCase()||
          Object.keys(types).join(',')!=='ForwardConsent')refuse('TESTNET_TYPED_DOMAIN_REFUSED');
        return this.inner.signTypedData(domain,types,value);
      }
      async sendTransaction(input){
        if((await provider.getNetwork()).chainId!==chainId)refuse('TESTNET_CHAIN_MISMATCH');
        const from=await this.getAddress();const tx={...input,from,chainId};
        const value=BigInt(tx.value??0);if(value<0n||value>1000n)refuse('TESTNET_VALUE_LIMIT_REFUSED');
        const gas=(await provider.estimateGas(tx))*120n/100n;
        if(gas>maxGas)refuse('TESTNET_GAS_LIMIT_REFUSED');
        const fee=await provider.getFeeData();
        if(fee.maxFeePerGas===null||fee.maxPriorityFeePerGas===null||fee.maxFeePerGas>maxFee||fee.maxPriorityFeePerGas>maxFee)
          refuse('TESTNET_FEE_LIMIT_REFUSED');
        const reserve=gas*maxFee+value;if(reserved+reserve>totalBudget)refuse('TESTNET_TOTAL_BUDGET_EXCEEDED');
        if(await provider.getBalance(from)<reserve)refuse('TESTNET_FUNDS_INSUFFICIENT');
        reserved+=reserve;
        // No retry here: an uncertain provider failure must not send another transaction.
        return this.inner.sendTransaction({...tx,type:2,gasLimit:gas,maxFeePerGas:fee.maxFeePerGas,maxPriorityFeePerGas:fee.maxPriorityFeePerGas});
      }
    }
    const signers=await Promise.all(selected.map(async a=>new BudgetSigner(await provider.getSigner(a))));
    const files={RegisterProjectionReference:'reference/RegisterProjectionReference.sol/RegisterProjectionReference.json',
      ResponsibilityController:'controls/ResponsibilityController.sol/ResponsibilityController.json',
      NativeResponsibilityPayments:'controls/NativeResponsibilityPayments.sol/NativeResponsibilityPayments.json',
      ControlledWallet:'controls/ControlledWallet.sol/ControlledWallet.json'};
    const artifactPins=[];
    const artifact=async name=>{
      if(!Object.hasOwn(files,name))refuse('TESTNET_ARTIFACT_REFUSED');
      const file=path.join(root,'artifacts/contracts',files[name]);const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)refuse('TESTNET_ARTIFACT_IDENTITY_REFUSED');
      const bytes=fs.readFileSync(file),parsed=JSON.parse(bytes.toString('utf8'));
      if(parsed.contractName!==name||!/^0x[0-9a-f]+$/i.test(parsed.bytecode)||Object.keys(parsed.linkReferences??{}).length!==0)
        refuse('TESTNET_ARTIFACT_SCHEMA_REFUSED');
      const debug=JSON.parse(fs.readFileSync(file.replace(/\.json$/,'.dbg.json'),'utf8'));
      if(typeof debug.buildInfo!=='string')refuse('TESTNET_BUILD_INFO_REQUIRED');
      const buildPath=path.resolve(path.dirname(file),debug.buildInfo);
      const buildRoot=path.join(root,'artifacts','build-info')+path.sep;
      if(!buildPath.startsWith(buildRoot)||fs.lstatSync(buildPath).isSymbolicLink())refuse('TESTNET_BUILD_INFO_REFUSED');
      const build=JSON.parse(fs.readFileSync(buildPath,'utf8'));
      if(build.solcVersion!=='0.8.26'||build.input?.settings?.viaIR!==true||build.input?.settings?.optimizer?.enabled!==true||
        build.input.settings.optimizer.runs!==200)refuse('TESTNET_COMPILER_BINDING_REFUSED');
      for(const [source,entry] of Object.entries(build.input.sources??{})){
        if(!/^contracts\/[a-zA-Z0-9_/-]+\.sol$/.test(source)||source.includes('..')||typeof entry.content!=='string')refuse('TESTNET_BUILD_SOURCE_REFUSED');
        const committed=execFileSync('git',['show',`${sourceCommit}:${source}`],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
        if(entry.content.replace(/\r\n/g,'\n')!==committed.replace(/\r\n/g,'\n'))refuse('TESTNET_BUILD_SOURCE_DRIFT');
      }
      const output=build.output?.contracts?.[parsed.sourceName]?.[name];
      if(!output||`0x${output.evm?.bytecode?.object}`!==parsed.bytecode)refuse('TESTNET_ARTIFACT_BUILD_MISMATCH');
      if(!artifactPins.some(p=>p.name===name))artifactPins.push({name,sha256:hash(bytes),bytes:bytes.length});
      return parsed;
    };
    await record({kind:'start',scope:'TEST_ONLY_NO_REAL_VALUE',chainId:chainId.toString(),sourceCommit,sourceTree,
      confirmations:confirms,confirmationTimeoutMs,
      startedAt:new Date().toISOString(),roles:['A','B','C','D','registrar'].map((role,i)=>({role,address:selected[i]}))});
    try{
      const k=await createScenario({ethers,provider,signers,artifact,confirmations:confirms,timeout:confirmationTimeoutMs,record:async r=>{
        if(r.kind==='deployment')deployments.set(r.name,r);await record(r);
      }});
      await runCoreJourney(k,{funded:false});await runCoreJourney(k,{funded:true});
      await runExtendedJourneys(k);
      const pin=name=>{const d=deployments.get(name);return{address:d.address,runtimeCodeHash:d.runtimeCodeHash};};
      createJson('public-deployment.json',{schema:'8415-controls-testnet/1',chainId:chainId.toString(),
        controller:pin('ResponsibilityController'),token:pin('RegisterProjectionReference'),payment:pin('NativeResponsibilityPayments')});
      createJson('result.json',{schema:'8415-v3-testnet-core/1',verdict:'CORE_JOURNEYS_EXECUTED_NOT_FULL_V3_ACCEPTANCE',
        chainId:chainId.toString(),sourceCommit,sourceTree,artifactPins,eventCount:count,evidenceHeadSha256:previousHash,
        reservedMaximumWei:reserved.toString(),uiVerified:false,independentAuditPassed:false,
        remaining:'Full W-01–W-24, adversarial matrix and genuine desktop/mobile acceptance remain separate required gates; sdk-observation is not UI evidence.',
        privateMaterialPersisted:false,validatorKeys:'ephemeral-test-only-not-retained',completedAt:new Date().toISOString()});
    }catch(error){
      createJson('result.json',{schema:'8415-v3-testnet-core/1',verdict:'INCOMPLETE',stableCode:error?.safeCode??'TESTNET_EXECUTION_REFUSED',
        sourceCommit,sourceTree,eventCount:count,evidenceHeadSha256:previousHash,automaticRetry:false,privateMaterialPersisted:false});
      throw error;
    }
  }finally{if(evidenceFd!==null)fs.closeSync(evidenceFd);provider.destroy();}
}
if(require.main===module)main().catch(e=>{process.stderr.write((e?.safeCode??'TESTNET_EXECUTION_REFUSED')+'\n');process.exitCode=1;});
module.exports={main,confirmationWaitMs};
