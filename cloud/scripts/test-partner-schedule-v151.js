'use strict';

// 真路由 + 真 handler + 内存云库；不连接线上、不修改真实排班。
const assert = require('assert');
const path = require('path');
const H = require('./harness');
const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib/auth'));
const bj = require(path.join(API, 'lib/bjTime'));
const { currentWeekStart, weekDates, templatesToSlots } = require(path.join(API, 'handlers/partner/_kit'));
const contract = require('../contracts/partner');
const WEEK = currentWeekStart(Date.now() + 7 * bj.DAY_MS);
const DATES = weekDates(WEEK);
const tokens = {};
[1,2,3,4,5,6,7,8,9].forEach((id) => { tokens[id] = sign({ id, username: `p${id}`, role: id === 1 ? 0 : id === 2 ? 1 : 2 }); });
let checks = 0;
const equal = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const yes = (name, cond) => { assert.ok(cond, name); checks++; };
const TPL = [
  { day:0,title:'早会',start:410,end:440,dept:'主持部',role:'主持',count:1 },
  { day:0,title:'早会',start:410,end:440,dept:'播音部',role:'播音',count:1 },
  { day:1,title:'午间',start:730,end:750,dept:'播音部',role:'播音',count:1 },
  { day:2,title:'午间',start:730,end:750,dept:'编辑部',role:'编辑',count:1 },
  { day:3,title:'午间',start:730,end:750,dept:'播音部',role:'播音',count:1 },
  { day:4,title:'下午',start:1040,end:1060,dept:'主持部',role:'主持',count:1 },
];
const SLOTS = templatesToSlots(TPL);
function seed() {
  const admin = [
    {id:1,role:0,nickname:'老师',department:'播音部',dutyRoles:['播音']},
    {id:2,role:1,nickname:'社干',department:'播音部',dutyRoles:['播音']},
    {id:3,role:2,nickname:'主持甲',department:'主持部',dutyRoles:['主持']},
    {id:4,role:2,nickname:'编辑甲',department:'编辑部',dutyRoles:['编辑']},
    {id:5,role:2,nickname:'周乙',department:'播音部',dutyRoles:['播音']},
    {id:6,role:2,nickname:'未填',department:'播音部',dutyRoles:['播音']},
    {id:7,role:2,nickname:'已过期',department:'播音部',dutyRoles:['播音']},
    {id:8,role:2,nickname:'无资格',department:'',dutyRoles:[]},
    {id:9,role:2,nickname:'停用',department:'播音部',dutyRoles:['播音'],status:0},
  ].map((a) => ({_id:`a${a.id}`,username:`p${a.id}`,status:1,...a}));
  const available = [1,2,3,4,5,7,8,9].map((id) => ({
    _id:`avail:${WEEK}:${id}`,personId:id,weekStart:WEEK,slotVersion:id===7?0:1,
    confirmedAt:new Date(),picks:SLOTS.map((s)=>({slotKey:s.slotKey,can:true})),
  }));
  return {admin,duty_slot_versions:[{_id:'slots1',version:1,state:'published',templates:TPL}],duty_availability:available};
}
function reset() { H.reset(seed()); }
const call = (method,url,body,id=1) => H.call(H.req(method,url,body||{},tokens[id]||''));
const get = (id=1) => call('GET',`/partner/schedule?week=${WEEK}`,{},id);
const people = (w) => w.days.flatMap((d)=>d.slots.flatMap((s)=>s.people));
async function mutate(method,route,body={},id=1) {
  const w=await get(id); return call(method,`/partner/schedule/${route}`,{weekStart:WEEK,revision:w.data.revision,...body},id);
}
function shape(value, expected, at='response') {
  if (typeof expected==='string') {
    if (expected==='any') return;
    if (expected.endsWith('|null') && value===null) return;
    if (expected.endsWith('[]')) { yes(at+' array',Array.isArray(value)); value.forEach((v)=>shape(v,expected.slice(0,-2),at+'[]')); return; }
    equal(at+' type', Array.isArray(value)?'array':typeof value,expected); return;
  }
  if (Array.isArray(expected)) { yes(at+' array',Array.isArray(value)); value.forEach((v)=>shape(v,expected[0],at+'[]')); return; }
  Object.keys(expected).forEach((k)=>{ yes(at+'.'+k+' exists',Object.prototype.hasOwnProperty.call(value,k)); shape(value[k],expected[k],at+'.'+k); });
}

(async()=>{
  reset();
  let r=await get(); equal('empty state',r.data.state,'empty'); equal('5 dates',r.data.days.length,5);
  equal('two concurrent department groups',r.data.days[0].slots[0].groups.length,2);
  equal('empty positions preserved',r.data.summary,{needed:6,filled:0,missing:6,fixed:0});
  equal('unauthorized read',(await call('GET','/partner/schedule',{},0)).code,40101);
  r=await call('PUT','/partner/schedule/generate',{weekStart:WEEK},1);equal('revision required',r.code,40001);
  r=await mutate('PUT','generate',{},2); equal('manager generate',r.code,0); equal('all filled',r.data.generated,6);
  yes('qualification and confirmed time enforced',people(r.data.week).every((p)=>![6,7,8,9].includes(p.personId)));
  equal('new draft not in formal assignment',(H.dump().duty_assignments||[]).length,0);
  const draft=r.data.week;
  shape(draft,contract['GET /partner/schedule'].resp);
  r=await get(3);equal('member draft people hidden',r.data.total,0); equal('member cannot manage',r.data.canManage,false);
  equal('mine hides draft',(await call('GET',`/partner/schedule/mine?week=${WEEK}`,{},3)).data.count,0);
  equal('month hides draft',(await call('GET',`/partner/schedule/month?month=${WEEK.slice(0,7)}`,{},3)).data.total,0);
  for(const [method,route,body] of [['PUT','generate',{}],['PUT','cell',{day:DATES[0],slotKey:'0-1',personIds:[3]}],['POST','publish',{}],['POST','withdraw',{}],['DELETE','draft',{}]]) {
    equal('member forbidden '+route,(await mutate(method,route,body,3)).code,40301);
  }
  const candidate=await call('GET',`/partner/schedule/candidates?week=${WEEK}&day=${DATES[0]}&slotKey=0-2`,{},2);
  equal('candidate read',candidate.code,0); yes('wrong department reason',candidate.data.list.find((x)=>x.personId===3).reasons.some((x)=>/^部门不匹配（当前：主持部，这个时段要：播音部）$/.test(x)));
  yes('unconfirmed reason',candidate.data.list.find((x)=>x.personId===6).reasons.some((x)=>/可排/.test(x)));
  yes('stale reason',candidate.data.list.find((x)=>x.personId===7).reasons.some((x)=>/过期/.test(x)));
  equal('candidate excludes disabled',candidate.data.list.some((x)=>x.personId===9),false);
  r=await mutate('PUT','cell',{day:DATES[0],slot:'早会',personIds:[3],reason:'测试调整'});equal('ambiguous title rejected',r.code,40001);
  r=await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[3],reason:'测试调整'});equal('wrong qualification hard stop',r.code,40901);
  r=await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[5]});equal('reason required',r.code,40001);
  r=await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[5],reason:'临时调换'});equal('manual change',r.code,0);
  equal('other concurrent department kept',r.data.week.days[0].slots[0].groups[0].people[0].personId,3);
  yes('manual automatically fixed',r.data.week.days[0].slots[0].groups[1].people[0].fixed);
  const oldRevision=r.data.week.revision;
  r=await mutate('PUT','generate');equal('regenerate works',r.code,0);equal('fixed survives regeneration',r.data.week.days[0].slots[0].groups[1].people[0].personId,5);
  equal('old page cannot publish',(await call('POST','/partner/schedule/publish',{weekStart:WEEK,revision:oldRevision},1)).code,40901);
  r=await call('GET',`/partner/schedule/check?week=${WEEK}`,{},2);equal('check valid',r.data.valid,true);
  shape(r.data,contract['GET /partner/schedule/check'].resp);
  r=await mutate('POST','publish',{},2);equal('manager publishes',r.code,0); equal('first version',r.data.week.version,1);
  equal('formal assignment now written',H.dump().duty_assignments.length,6);
  equal('member sees published',(await get(3)).data.total,6); equal('member fixed hidden',people((await get(3)).data).some((p)=>p.fixed),false);
  r=await call('GET',`/partner/schedule/month?month=${WEEK.slice(0,7)}`,{},3);equal('month counts formal',r.data.total,6); yes('month includes zero person',r.data.list.some((p)=>p.count===0));
  equal('force cannot overwrite published',(await mutate('PUT','generate',{force:true})).code,40901);
  equal('published cell blocked',(await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[1],reason:'测试调整'})).code,40901);
  equal('published clear blocked',(await mutate('DELETE','draft')).code,40901);
  equal('manager cannot withdraw',(await mutate('POST','withdraw',{},2)).code,40301);
  const formal=JSON.stringify(H.dump().duty_assignments);
  r=await mutate('POST','withdraw',{reason:'修订人员'});equal('super withdraw',r.code,0); equal('withdraw returns draft',r.data.week.state,'draft'); equal('withdraw keeps version',r.data.week.version,1);
  equal('withdraw preserves formal rows',JSON.stringify(H.dump().duty_assignments),formal);
  // 2026-10-31 口径：撤回只退回草稿状态，**不把任何人钉成固定** ——
  // 全员固定会让「再次生成」一个人都不动，而界面上看不出原因（陛下当天定的）
  equal('withdraw clears fixed flags',r.data.week.summary.fixed,0);
  // 撤回后「再次生成」必须真的重排：全员不固定 ⇒ 全部重挑，而不是原样留着
  r=await mutate('PUT','generate');equal('regenerate after withdraw',r.code,0);
  equal('regenerate refills every slot',r.data.week.summary.filled,6);equal('regenerate leaves nobody fixed',r.data.week.summary.fixed,0);
  equal('withdraw member hides',(await get(3)).data.total,0);equal('withdraw mine hides',(await call('GET',`/partner/schedule/mine?week=${WEEK}`,{},3)).data.count,0);
  equal('withdraw month hides',(await call('GET',`/partner/schedule/month?month=${WEEK.slice(0,7)}`,{},3)).data.total,0);
  r=await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[1],reason:'老师顶班'});equal('edit preserved draft',r.code,0);
  equal('editing draft leaves formal unchanged',JSON.stringify(H.dump().duty_assignments),formal);
  r=await mutate('POST','publish');equal('republish succeeds',r.code,0); equal('version increments',r.data.week.version,2);equal('latest member gets new person',(await get(3)).data.days[0].slots[0].groups[1].people[0].personId,1);
  r=await call('GET',`/partner/schedule/history?week=${WEEK}`,{},1);equal('history publications',r.data.versions.length,2);
  const v1=r.data.list.find((x)=>x.action==='publish'&&x.version===1); equal('old snapshot retained',v1.snapshot.assignments.find((a)=>a.slotKey==='0-2').personId,5);
  yes('history real operator',r.data.list.every((x)=>x.operatorName)); shape(r.data,contract['GET /partner/schedule/history'].resp);
  const mgrHistory=await call('GET',`/partner/schedule/history?week=${WEEK}`,{},2);yes('manager snapshots withheld',mgrHistory.data.list.every((x)=>!('snapshot'in x)));
  equal('member history denied',(await call('GET',`/partner/schedule/history?week=${WEEK}`,{},3)).code,40301);
  await mutate('POST','withdraw');
  const target=H.dump().duty_weeks.find((w)=>w._id===WEEK).draftRows.find((x)=>x.slotKey==='0-2');
  H.store.get('duty_leaves').set('approved',{_id:'approved',id:1,weekStart:WEEK,day:target.day,slot:target.slot,personId:target.personId,status:1});
  r=await mutate('POST','publish',{allowMissing:true});equal('approved leave blocks even override',r.code,40901);
  yes('publish rechecks latest leave',r.data.issues.some((x)=>/请假/.test(x.message)));
  H.store.get('duty_leaves').clear();
  r=await mutate('PUT','cell',{day:DATES[0],slotKey:'0-2',personIds:[],reason:'暂时留空'});equal('clear one department',r.code,0);
  equal('parallel department still assigned',r.data.week.days[0].slots[0].groups[0].people.length,1);
  r=await mutate('POST','publish');equal('missing cannot silently publish',r.code,40901);
  r=await mutate('POST','publish',{allowMissing:true,reason:'已确认保留缺岗'});equal('explicit missing confirmation publishes',r.code,0);
  await mutate('POST','withdraw');
  r=await mutate('DELETE','draft'); equal('clear draft',r.code,0);equal('clear all people',r.data.week.total,0);equal('clear keeps all required slots',r.data.week.summary.needed,6);
  equal('clear does not remove formal archive',H.dump().duty_assignments.length,5);
  const history=await call('GET',`/partner/schedule/history?week=${WEEK}`,{},1);equal('clear keeps history versions',history.data.versions.length,3);

  reset();
  const rev=0;
  const concurrent=await Promise.all([call('PUT','/partner/schedule/generate',{weekStart:WEEK,revision:rev}),call('PUT','/partner/schedule/generate',{weekStart:WEEK,revision:rev})]);
  equal('one concurrent writer only',concurrent.filter((x)=>x.code===0).length,1);
  equal('other concurrent writer conflicts',concurrent.filter((x)=>x.code===40901).length,1);
  equal('write lease released',(H.dump().unique_keys||[]).filter((x)=>x.scope==='duty-week').length,0);
  const weekDoc=H.store.get('duty_weeks').get(WEEK);weekDoc.state='draft';weekDoc.draftRows=[{weekStart:WEEK,day:DATES[0],slot:'早会',slotKey:'0-2',personId:3,personName:'错误资格',department:'播音部',source:'manual',fixed:true}];
  r=await mutate('PUT','generate');equal('invalid fixed blocks regeneration',r.code,40901);
  yes('fixed conflict returns reasons',r.data.issues.some((x)=>/资格|部门/.test(x.message)));
  const stale=seed();stale.duty_availability.forEach((x)=>{x.slotVersion=0;});H.reset(stale);
  r=await mutate('PUT','generate');equal('stale availability produces missing',r.data.week.total,0);equal('all missing on stale',r.data.week.summary.missing,6);
  reset();
  const valid=await call('PUT','/partner/slots/draft',{templates:TPL},1);equal('parallel department templates valid',valid.code,0);
  const duplicate=await call('PUT','/partner/slots/draft',{templates:[TPL[0],TPL[0]]},1);equal('duplicate same department rejected',duplicate.code,40001);
  const partial=await call('PUT','/partner/slots/draft',{templates:[TPL[0],{...TPL[1],start:420}]},1);equal('partial overlap rejected',partial.code,40001);
  equal('invalid month rejected',(await call('GET','/partner/schedule/month?month=2026-99',{},1)).code,40001);
  /* ── 多选岗位：兼「主持 + 播音」的人，两个部门的时段都得能上（2026-10-30「可以多选」）──
     ⚠️⚠️ person.department 只能存一个（主部门），所以判定必须是「岗位命中就放行部门检查」。
        否则多选出来的第二个岗位就是摆设 —— 配了、却还是选不上，正是当天被投诉的那件事。 */
  reset();
  let d5 = await call('PUT','/partner/people/3/duty',{dutyRoles:['主持','播音']},1);
  equal('多选岗位落库', d5.data.dutyRoles, ['主持','播音']);
  equal('主部门按顺序归播音部', d5.data.department, '播音部');
  let cA = await call('GET',`/partner/schedule/candidates?week=${WEEK}&day=${DATES[0]}&slotKey=0-2`,{},2);
  let p3a = cA.data.list.find((x)=>x.personId===3);
  equal('兼两个岗位 → 播音部时段不再报部门不匹配', p3a.reasons.some((x)=>/部门不匹配/.test(x)), false);
  equal('兼两个岗位 → 播音部时段岗位资格通过', p3a.reasons.some((x)=>/岗位资格不匹配/.test(x)), false);
  equal('兼两个岗位 → 播音部时段可选', p3a.eligible, true);
  let cB = await call('GET',`/partner/schedule/candidates?week=${WEEK}&day=${DATES[0]}&slotKey=0-1`,{},2);
  let p3b = cB.data.list.find((x)=>x.personId===3);
  equal('主部门换了，原来的主持部时段照样可选', p3b.eligible, true);
  // 反证：只留播音，主持部时段就该被拦住（说明放行靠的是岗位，不是无脑放开）
  d5 = await call('PUT','/partner/people/3/duty',{dutyRoles:['播音']},1);
  equal('只留播音 → 主部门播音部', d5.data.department, '播音部');
  cB = await call('GET',`/partner/schedule/candidates?week=${WEEK}&day=${DATES[0]}&slotKey=0-1`,{},2);
  p3b = cB.data.list.find((x)=>x.personId===3);
  equal('只留播音 → 主持部时段被拦', p3b.eligible, false);
  equal('只留播音 → 主持部时段报部门不匹配', p3b.reasons.some((x)=>/部门不匹配/.test(x)), true);

  console.log(`PASS ${checks} assertions: v151 schedule handler, permissions, revision, parallel departments, formal/draft isolation and publication history.`);
})().catch((e)=>{console.error(e);process.exitCode=1;});
