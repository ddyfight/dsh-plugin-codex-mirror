import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHandler} from './index.mjs';
import {HandoffStore} from './handoff.mjs';
const root=await mkdtemp(path.join(tmpdir(),'dsh-handoff-http-'));
const store=new HandoffStore({root});const handle=createHandler(store,store,Promise.resolve(),async()=>'<html></html>');
const input={codexSession:{id:'codex-fixture',title:'测试源会话',cwd:'D:\\fixture'},dshSession:{id:'dsh-fixture',title:'DSH任务',cwd:'D:\\fixture'},progress:'已完成验证。下一步检查导出功能。'};
async function request(method='POST',body=JSON.stringify(input),headers={}){
 const req=Readable.from([body]);Object.assign(req,{method,url:'/api/codex-mirror/handoff?codexSessionId=codex-fixture&dshSessionId=dsh-fixture',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:49629','content-type':'application/json',...headers}});
 let status,payload;const res={writeHead:s=>status=s,end:data=>payload=JSON.parse(data)};await handle(req,res);return{status,payload};
}
let result=await request();assert.equal(result.status,200);assert.equal(result.payload.mode,'handoff-file');assert.equal(result.payload.codexOriginalModified,false);assert.ok((await readFile(result.payload.path,'utf8')).includes(input.progress));assert.ok(result.payload.codexPrompt);
assert.equal((await request()).payload.unchanged,true);assert.equal((await request('GET')).status,200);
assert.equal((await request('POST','{bad')).status,400);assert.equal((await request('DELETE')).status,405);
assert.equal((await request('POST',JSON.stringify(input),{'content-type':'text/plain'})).status,415);
assert.equal((await request('POST',JSON.stringify(input),{origin:'https://evil.example'})).status,403);
assert.equal((await request('POST',JSON.stringify({...input,progress:''}))).status,400);
assert.equal((await request('POST',JSON.stringify({...input,codexSession:{...input.codexSession,id:'../escape'}}))).status,400);
assert.equal((await request('POST','x'.repeat(200001))).status,413);
console.log('PASS: unified handoff route, fixture save/read/dedup, unchanged Codex originals marker, JSON bounds, invalid paths and origin rejection.');
