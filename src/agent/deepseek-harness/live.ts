import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function harnessLiveAssets(): { root: string; patch: string; bootstrap: string } {
  const root = mkdtempSync(join(tmpdir(), 'lark-dsh-live-'));
  const plugin = join(root, 'live.mjs');
  writeFileSync(plugin, `import {randomUUID} from 'node:crypto';
export default function(ctx) {
 let active, everActive=false; const pending=globalThis.__larkHarnessLive.pending;
 const ack=(id,error)=>process.stderr.write('LARK_LIVE '+JSON.stringify({id,error})+String.fromCharCode(10));
 ctx.on('agent/status', ({agent,status})=>{if(status==='running'){active=agent;everActive=true;for(const input of pending.splice(0))globalThis.__larkHarnessLive.send(input)}else if(active===agent){active=undefined;setImmediate(()=>{if(!active)globalThis.__larkHarnessLive.close?.()})}});
 globalThis.__larkHarnessLive.send=({id,text})=>{try{if(!everActive){pending.push({id,text});return}if(!active||active.status!=='running')throw Error('Native agent is not running');active.steer({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'user'}});ack(id)}catch(e){ack(id,e.message)}};
 ctx.provide('larkLiveInput',true);
}
`);
  const patch = join(root, 'live.json');
  writeFileSync(patch, JSON.stringify([
    { insert: [{ id: 'lark-live-input', name: pathToFileURL(plugin).href }] },
    { id: 'headless-runner', inject: ['headlessStartup', 'larkLiveInput'] },
  ]));
  const bootstrap = `const {createInterface}=require('node:readline');const{pathToFileURL}=require('node:url');globalThis.__larkHarnessLive={pending:[]};let started=false;const rl=createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',async line=>{try{const m=JSON.parse(line);if(!started){started=true;const e=process.argv[1];process.argv=[process.execPath,e,'--profile','headless','--patch',process.argv[2],m.prompt];const c=await import(pathToFileURL(e).href);if(typeof c.runCli==='function')await c.runCli();if(!globalThis.__larkHarnessLive.send){rl.close();process.stdin.pause()}}else if(globalThis.__larkHarnessLive.send)globalThis.__larkHarnessLive.send(m);else globalThis.__larkHarnessLive.pending.push(m)}catch(e){console.error(e);process.exitCode=1;rl.close();process.stdin.pause()}});globalThis.__larkHarnessLive.close=()=>{rl.close();process.stdin.pause()}`;
  return { root, patch, bootstrap };
}
