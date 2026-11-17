import http from 'node:http';
const origin='http://127.0.0.1:49629';
const graph=await new Promise((resolve,reject)=>{
 const req=http.get(origin+'/plugins/events',res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;for(const line of text.split('\n'))if(line.startsWith('data:')){try{const event=JSON.parse(line.slice(5));if(event.graph){resolve(event.graph);res.destroy();return}}catch{}}});});req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('graph timeout')));
});
const row=graph.entries.find(e=>e.id==='dsh-plugin-codex-mirror');
if(!row)throw Error('Codex mirror missing from live client graph');
const batch=graph.batches.find(b=>b.url.includes('dsh-plugin-codex-mirror'));
if(!batch)throw Error('Codex client batch missing');
const response=await fetch(new URL(batch.url,origin));const text=await response.text();
if(!response.ok||!text.includes('dsh-plugin-codex-mirror')||!text.includes('sidebar.panellist'))throw Error('Client bundle invalid');
if(!text.includes('progress-request')||!text.includes('readCurrentProgress'))throw Error('Live bundle has not updated to progress handoff feature');
if(!text.includes('createQuotedSession')||!text.includes("data.destination==='new'"))throw Error('Live bundle has not updated to new-session quote feature');
console.log(JSON.stringify({liveClientRegistered:true,clientResourceStatus:response.status,clientFactory:true,sidebarEntry:true,quoteBridge:true,progressBridge:true,newSessionQuote:true}));
