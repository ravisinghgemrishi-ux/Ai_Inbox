const assert=require('assert');
process.env.ENABLE_TEAM_MONITOR='true';
let gemini=0;
global.fetch=async(u)=>{ if(String(u).includes('generativelanguage'))gemini++; return {ok:true,json:async()=>({result:null}),text:async()=>''}; };
const tm=require('../lib/teamMonitor');
assert.strictEqual(typeof tm.handleTeamMessage,'function');
process.env.GEMINI_API_KEY='x';
// default: AI review off -> source gate present
const src=require('fs').readFileSync(require.resolve('../lib/teamMonitor'),'utf8');
assert(/TEAM_MONITOR_AI_REVIEW \|\| 'off'/.test(src),'default must be off');
assert(/else if \(!aiReviewOn\(\)\)/.test(src),'review gated');
assert(/if \(aiReviewOn\(\) && customerMsg/.test(src),'product lookup gated');
console.log('free-monitor: checks passed');
