const assert=require('assert');
process.env.REDIS_KV_REST_API_URL='http://r';process.env.REDIS_KV_REST_API_TOKEN='t';
const kv=new Map();
global.fetch=async(u)=>{const p=decodeURIComponent(u.replace('http://r',''));const a=p.split('/').filter(Boolean);const c=a[0];let r=null;
 if(c==='get')r=kv.get(a[1])??null; else if(c==='set'){kv.set(a[1],a[2]);r='OK';} else if(c==='del'){kv.delete(a[1]);r=1;} else if(c==='zadd'||c==='zrem')r=1; else if(c==='incr')r=1;
 return {ok:true,json:async()=>({result:r})};};
const h=require('../lib/handoff');
(async()=>{
 const base={grId:'g1',platform:'whatsapp',contact:'x',customerPhone:'+917878261315'};
 assert((await h.queueForward({...base,route:'vishvas'})).queued);
 let r=await h.queueForward({...base,route:'neel'}); assert.strictEqual(r.queued,false); assert.strictEqual(r.reason,'already_with_vishvas');
 r=await h.queueForward({...base,route:'neel',hardNeel:true}); assert(r.queued,'hard Neel case still goes');
 r=await h.queueForward({...base,route:'neel',keySuffix:'call'}); assert(r.queued,'call request still goes');
 assert.strictEqual(h.needsNeel({intent:'order_status',escalate:false}),false);
 assert.strictEqual(h.needsNeel({intent:'order_status',escalate:true}),true);
 assert.strictEqual(h.needsNeel({intent:'support_issue'}),true);
 assert.strictEqual(h.needsNeel({escalate:true,escalateReason:'price_needed_unverified_price_removed'}),false);
 console.log('one-alert: all checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
