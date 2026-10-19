import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Leases } from '../lib/leases.js';
import { createNest } from '../lib/nest.js';
import { createLifecycle } from '../lib/lifecycle.js';
import { buildServer } from '../lib/server.js';
if (!process.argv.includes('--live')) throw new Error('This opens six real desktop windows. Run with --live only on an idle test machine.');
const units = execFileSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', 'agent-desktop-*.service'], {encoding:'utf8'});
assert.equal(units.trim(), '', 'existing agent desktops must be left alone');
const nest = createNest();
const leases = new Leases();
const lifecycle = createLifecycle({ leases, nest });
const handler = createMcpHandler(() => buildServer({ leases, nest, lifecycle, host: hostname() }));
const client = new Client({name:'lifecycle-verification',version:'1'}, {versionNegotiation:{mode:'auto'}});
await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {fetch:(url,init)=>handler.fetch(new Request(url,init))}));
const call = async (name,args={}) => { const r=await client.callTool({name,arguments:args},undefined,{timeout:120000}); if(r.isError) throw new Error(JSON.stringify(r)); return r; };
const handles=[];
try {
 console.log((await call('status')).content[0].text);
 for(let i=0;i<6;i++) {
  const r=await call('claim',{owner:`Codex lifecycle verification ${i+1}`});
  handles.push(r.structuredContent.handle);
  console.log(r.content[0].text);
 }
 await call('open',{handle:handles[0],command:['foot','--title=Desktop lifecycle test','sh','-c','printf "Desktop 1: closes when released\\n"; sleep 180']});
 await call('open',{handle:handles[5],command:['foot','--title=Sixth on-demand desktop','sh','-c','printf "Desktop 6: no fixed pool of four\\n"; sleep 180']});
 await call('wait',{handle:handles[5],ms:3000});
 for(const i of [0,5]) {
  const r=await call('observe',{handle:handles[i],scale:0.5});
  writeFileSync(`/tmp/agent-desktop-${i+1}-test.png`,Buffer.from(r.content.find(c=>c.type==='image').data,'base64'));
  console.log(r.content.find(c=>c.type==='text').text);
  assert.ok(r.structuredContent.windows.length, `desktop ${i+1} has a mapped app`);
 }
 const runResult = await call('run', {handle:handles[5],command:'printf "%s %s" "$WAYLAND_DISPLAY" "$DISPLAY"'});
 assert.match(runResult.content[0].text, /wayland-agent-6 :96/);
 const before=execFileSync('systemctl',['--user','list-units','--all','--plain','--no-legend','agent-desktop-1-app-*.service'],{encoding:'utf8'});
 assert.match(before,/running/);
 await call('release',{handle:handles[0]});
 handles.shift();
 assert.equal(nest.ready(1),false);
 assert.equal(nest.ready(6),true);
 const after=execFileSync('systemctl',['--user','list-units','--all','--plain','--no-legend','agent-desktop-1-app-*.service'],{encoding:'utf8'});
 assert.doesNotMatch(after,/running/);
 console.log('PASS: released desktop and its managed app stopped; desktop 6 remains ready');
} finally {
 for(const h of handles) { try { await call('release',{handle:h}); } catch(e) {console.error(e.message);} }
 console.log((await call('status')).content[0].text);
 assert.deepEqual(leases.status(), []);
 await client.close(); await handler.close();
}
