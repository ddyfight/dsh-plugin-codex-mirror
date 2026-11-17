/* Prebuilt DSH ModuleLoader factory; all task submission stays under user control. */
window.__ModuleLoader__.load({
  id:'dsh-plugin-codex-mirror',
  factory:(require)=>{
    'use strict';
    const React=require('react');
    const currentOf=ctx=>Object.values(ctx.sessions.list.getSnapshot().byId).find(s=>(s.retainedBy?.mainView??0)>0);
    const textOf=content=>Array.isArray(content)?content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n').trim():'';
    async function readCurrentProgress(ctx){
      const row=currentOf(ctx);if(!row)throw Error('没有选中的 DSH 会话，请先打开要交接的 DSH 会话，再返回镜像');
      const binding=ctx.sessions.binding(row.id);if(!binding)throw Error('DSH 会话尚未就绪');
      const check=()=>{if(ctx.sessions.binding(row.id)!==binding||currentOf(ctx)?.id!==row.id)throw Error('DSH 会话已切换，请重新准备进展')};
      await binding.session.open();check();
      const state=binding.session.getSnapshot();if(state.openState!=='open')throw Error(state.openError?.message||'会话历史读取失败');
      let events=[],assistant;
      for(let page=0;page<4;page++){
        check();const history=binding.eventSource.getSnapshot();events=history.entries.filter(x=>x.type!=='transient').map(x=>x.event);
        assistant=[...events].reverse().find(e=>e.type==='assistant/message'&&e.surfaceOp==='append'&&e.data.interrupted!==true&&textOf(e.data.message?.content));
        if(assistant||!history.hasMore)break;
        const first=history.entries[0]?.event.seq;await binding.session.loadOlder();check();if(binding.eventSource.getSnapshot().entries[0]?.event.seq===first)break;
      }
      if(!assistant)throw Error('最近已加载历史中没有可交接的 DSH 助手正文');
      check();
      const user=[...events].reverse().find(e=>e.seq<assistant.seq&&e.type==='user/message'&&e.surfaceOp==='append'&&e.data.source?.kind==='user');
      const cwdEvent=[...events].reverse().find(e=>e.type==='working-directory/change');
      const live=ctx.sessions.list.getSnapshot().byId[row.id]||row;
      const original=[user?'用户要求：\n'+textOf(user.data.content):'', 'DSH 最近已落盘回复：\n'+textOf(assistant.data.message.content)].filter(Boolean).join('\n\n');
      const progress=original.length>50000?original.slice(0,49880)+'\n\n[自动预览已截断，请检查并编辑；完整记录保留在 DSH 原会话中]':original;
      return {dshSession:{id:row.id,title:live.title||live.displayTitle||row.id,cwd:cwdEvent?.data.cwd||live.cwd||''},progress,running:binding.session.getSnapshot().running,truncated:original.length>50000,assistantSeq:assistant.seq,assistantTime:assistant.time};
    }
    async function createQuotedSession(ctx,prompt){
      const current=currentOf(ctx);
      const workspaceList=ctx.workspaces.list.getSnapshot();
      if(workspaceList.phase!=='ready'||!workspaceList.items.length)throw Error('工作区尚未准备好，请先在 DSH 中选择一个工作区');
      const items=workspaceList.items;
      let workspace=items.find(item=>item.sessionIds.includes(current?.id));
      if(!workspace){
        const sessions=ctx.sessions.list.getSnapshot().byId;
        workspace=[...items].sort((a,b)=>Math.max(0,...b.sessionIds.map(id=>Date.parse(sessions[id]?.updatedAt)||0))-Math.max(0,...a.sessionIds.map(id=>Date.parse(sessions[id]?.updatedAt)||0)))[0];
      }
      const sessionId=await ctx.sessions.create({workspaceId:workspace.workspaceId});
      const reference=ctx.sessions.retain(sessionId,{source:'codexMirrorQuote'});
      try{
        await reference.ready;
        const result=ctx.conversation.input.requestDraftInitialization(reference.binding,{prompt,whenDraftExists:'append'});
        if(result!=='applied')throw Error('新会话草稿暂不可写，请稍后重试');
        ctx.uiWorkspace.openSession(sessionId);
        return sessionId;
      }finally{reference.release()}
    }
    function apply(ctx){
      let quoteInFlight=false;
      const iframe=React.createRef();
      function MirrorPanel(){return React.createElement('iframe',{ref:iframe,src:new URL('api/codex-mirror/view',document.baseURI).href,title:'Codex 实时镜像',style:{display:'block',width:'100%',height:'100%',minHeight:0,border:0,background:'transparent'}})}
      function Icon(){return React.createElement('svg',{viewBox:'0 0 24 24',width:20,height:20,fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},React.createElement('path',{d:'M5 4h14v14h-8l-5 3v-3H5ZM9 9l-2 2 2 2m6-4 2 2-2 2'}))}
      const remember=(dshId,codexId)=>{if(typeof codexId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(codexId))return;try{const links=JSON.parse(localStorage.getItem('codex-mirror:links')||'{}');links[dshId]=codexId;localStorage.setItem('codex-mirror:links',JSON.stringify(links))}catch{}};
      const linked=dshId=>{try{return JSON.parse(localStorage.getItem('codex-mirror:links')||'{}')[dshId]}catch{return undefined}};
      const onMessage=async(event)=>{
        const frame=iframe.current;
        if(!frame||event.origin!==location.origin||event.source!==frame.contentWindow)return;
        const data=event.data;if(data?.source!=='codex-mirror'||typeof data.requestId!=='string')return;
        const reply=(type,payload)=>event.source.postMessage({source:'codex-mirror-host',type,requestId:data.requestId,...payload},event.origin);
        if(data.type==='progress-request'){
          try{const progress=await readCurrentProgress(ctx);reply('progress-result',{ok:true,...progress,linkedCodexSessionId:linked(progress.dshSession.id)})}
          catch(error){reply('progress-result',{ok:false,message:error.message||String(error)})}return;
        }
        if(data.type!=='quote')return;
        const quoteReply=(ok,message)=>reply('quote-result',{ok,message});
        const prompt=typeof data.prompt==='string'?data.prompt.trim():'';
        if(!prompt||prompt.length>40000){quoteReply(false,'引用内容为空或过长');return}
        if(quoteInFlight){quoteReply(false,'正在打开引用会话，请稍候');return}
        quoteInFlight=true;
        try{
          const current=currentOf(ctx),binding=data.destination==='new'?undefined:current&&ctx.sessions.binding(current.id);
          if(data.destination==='new'||!binding){
            const sessionId=await createQuotedSession(ctx,prompt);remember(sessionId,data.codexSessionId);quoteReply(true,'已新建 DSH 会话并填入引用，请补充任务要求后发送');
          }else{
            const result=ctx.conversation.input.requestDraftInitialization(binding,{prompt,whenDraftExists:'append'});
            if(result!=='applied'){quoteReply(false,'当前输入正在提交或暂不可写，请稍后再次引用');return}
            remember(current.id,data.codexSessionId);quoteReply(true,'已追加到当前 DSH 草稿，请补充任务要求后发送');ctx.uiWorkspace.openSession(current.id);
          }
        }catch(error){console.error('[codex-mirror] quote failed',error);quoteReply(false,'引用失败：'+(error.message||String(error)))}
        finally{quoteInFlight=false}
      };
      ctx.effect(()=>{window.addEventListener('message',onMessage);return()=>window.removeEventListener('message',onMessage)},'codex-mirror: quote/progress bridge');
      ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'codex-mirror'},MirrorPanel));
      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'codex-mirror',order:20,label:'Codex 实时镜像'},Icon));
    }
    return {apply,inject:['slots','uiWorkspace','sessions','conversation','workspaces'],readCurrentProgress,createQuotedSession};
  }
});
