(async()=>{
  const job=__JOB__, deadline=__DEADLINE__;
  let conversation=null, cursor=null, pages=0;
  const messages=new Map();
  const hasContent=m=>(m.content?.parts||[]).some(p=>typeof p==='string'&&p.trim()||typeof p?.text==='string'&&p.text.trim())||Boolean(m.content?.text?.trim())||Boolean(m.content?.thoughts?.length)||Boolean(m.metadata?.model_dil_v2)||Boolean(m.metadata?.genui_components?.length);
  const merge=m=>{const previous=messages.get(m.id);if(!previous||!hasContent(previous)&&hasContent(m))messages.set(m.id,m)};
  const done=()=>JSON.stringify({kind:'conversation',id:job.id,complete:!cursor,cursor:cursor||'',pages,
    conversation:{...conversation,messages:[...messages.values()],
      page_info:{has_previous_page:!!cursor,has_next_page:false}}});
  try {
    if(location.origin!=='app://-')throw Error('Unexpected page');
    const {Request}=await import(__MODULE__);
    const get=(path,query)=>{
      const remaining=deadline-Date.now();
      if(remaining<1000)throw Error('Budget exhausted');
      return Request.safeGet(path,{parameters:{path:{conversation_id:job.id},query},additionalHeaders:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(Math.min(15000,remaining))});
    };
    conversation=await get('/conversations/{conversation_id}',{num_turns:10,include_has_versions:true});
    if((conversation.conversation_id||conversation.id)!==job.id||!Array.isArray(conversation.messages)||!conversation.page_info)throw Error('Invalid conversation');
    for(const message of conversation.messages)merge(message);
    // Keep the current node from the newest page even while older pages are added.
    conversation.current_node=conversation.current_node||conversation.page_info.end_cursor||conversation.messages.at(-1)?.id;
    cursor=job.cursor||(conversation.page_info.has_previous_page?conversation.page_info.start_cursor:null);
    if(conversation.page_info.has_previous_page&&!cursor)throw Error('Missing cursor');
    pages=1;
    const seen=new Set();
    while(cursor&&pages<12&&deadline-Date.now()>2000){
      if(seen.has(cursor))throw Error('Cursor did not advance');
      seen.add(cursor);
      const page=await get('/conversations/{conversation_id}/messages',{before:cursor,num_turns:10,include_has_versions:true});
      if(!Array.isArray(page.messages)||!page.page_info||page.conversation_id&&page.conversation_id!==job.id)throw Error('Invalid page');
      for(const message of page.messages)merge(message);
      const next=page.page_info.has_previous_page?page.page_info.start_cursor:null;
      if(page.page_info.has_previous_page&&!next)throw Error('Missing cursor');
      cursor=next;pages++;
    }
    return done();
  }catch(error){
    // Partial progress is useful, but an unchanged/invalid cursor must not become
    // a completed checkpoint. No server error body or credentials leave the page.
    if(pages&&cursor)return done();
    return JSON.stringify({kind:'error',id:job.id,status:error.responseStatus||error.status||0});
  }
})()
