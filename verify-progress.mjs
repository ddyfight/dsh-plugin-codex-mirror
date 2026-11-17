import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
let plugin;vm.runInNewContext(await readFile(new URL('./client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:bundle=>plugin=bundle.factory(()=>({}))}}});
const entry=(type,seq,data,more={})=>({type:'event',event:{type,seq,time:1000+seq,surfaceOp:'append',data,...more}});
const text=value=>[{type:'text',text:value}];
let row={id:'dsh-source',title:'当前任务',cwd:'D:\\project',retainedBy:{mainView:1}};
let openState='open',changes=false;
const entries=[
 entry('user/message',1,{content:text('实际任务'),source:{kind:'user'}}),
 entry('user/message',2,{content:text('系统注入不应导出'),source:{kind:'system'}}),
 entry('assistant/message',3,{message:{content:[{type:'reasoning',text:'隐藏推理'},...text('已完成验证')]}}),
 {type:'transient',event:{type:'assistant/message',seq:4,surfaceOp:'append',data:{message:{content:text('实时未持久回复')}}}},
 entry('assistant/message',5,{interrupted:true,message:{content:text('中断片段')}}),
 entry('assistant/message',6,{message:{content:[{type:'tool-call',text:'工具过程'}]}}),
 entry('user/message',7,{content:text('后来新问题不应错配'),source:{kind:'user'}})
];
const binding={session:{open:async()=>{if(changes)row={...row,id:'other'}},getSnapshot:()=>({openState,running:true}),loadOlder:async()=>{}},eventSource:{getSnapshot:()=>({entries,hasMore:false})}};
const ctx={sessions:{list:{getSnapshot:()=>({byId:row?{[row.id]:row}:{}})},binding:()=>binding}};
const result=await plugin.readCurrentProgress(ctx);
assert.equal(result.dshSession.id,'dsh-source');assert.equal(result.assistantSeq,3);assert.equal(result.running,true);
assert.ok(result.progress.includes('实际任务')&&result.progress.includes('已完成验证'));
for(const excluded of ['系统注入','隐藏推理','实时未持久','中断片段','工具过程','后来新问题'])assert.ok(!result.progress.includes(excluded));
openState='failed';await assert.rejects(()=>plugin.readCurrentProgress(ctx),/历史读取失败/);
openState='open';changes=true;await assert.rejects(()=>plugin.readCurrentProgress(ctx),/会话已切换/);
row=null;await assert.rejects(()=>plugin.readCurrentProgress(ctx),/没有选中的/);
console.log('PASS: DSH progress reads durable text only, matches preceding real user, excludes tools/reasoning/interrupted/transient, checks open failure and session navigation.');
