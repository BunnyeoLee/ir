import {firebaseConfig,ADMIN_EMAILS,SUMMARY_INTERVAL_SEC} from "./firebase-config.js";
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,onAuthStateChanged,signInAnonymously,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,doc,collection,query,limit,getDoc,getDocs,setDoc,deleteDoc,onSnapshot,runTransaction,writeBatch} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
(function(){
"use strict";

/* ───────── constants & state ───────── */
const DEFAULT_CFG={title:"모의창업 IR 데모데이",budget:1000000,unit:10000,scope:"own",showLive:true,status:"setup",cohorts:[],closedAt:0,revealedAt:0};
const STATUS={setup:{label:"준비 중",cls:""},open:{label:"펀딩 진행 중",cls:"open"},closed:{label:"펀딩 마감",cls:"closed"},revealed:{label:"결과 발표",cls:"revealed"}};
const VIEWS=["gallery","ranking","portfolio","stage","admin"];
const ADMINS=(Array.isArray(ADMIN_EMAILS)?ADMIN_EMAILS:[]).map(e=>String(e).trim().toLowerCase()).filter(Boolean);
const SUM_MS=Math.max(2,Number(SUMMARY_INTERVAL_SEC)||4)*1000;
const FB={app:null,auth:null,fs:null};
const S={
  ready:false,noDb:false,dbError:"",db:null,user:null,uid:null,isAdmin:false,canWrite:null,readOnly:false,assets:null,
  cfg:Object.assign({},DEFAULT_CFG),loaded:{cfg:false,teams:false,inv:false},
  teams:new Map(),inv:new Map(),roster:new Map(),me:null,meLoaded:false,final:null,
  view:"gallery",cohortSel:null,rankSel:null,stageSel:"all",adminTab:"run",rosterQ:"",
  bgDraft:{},email:"",authError:"",summary:null,sumAt:0,sumErr:"",prevTotals:null,pulses:new Map(),barPrev:new Map(),lastHtml:"",ceremonyShown:false
};

/* ───────── utils ───────── */
const $=(s,r=document)=>r.querySelector(s);
const esc=v=>String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const won=n=>(Number(n)||0).toLocaleString("ko-KR")+"원";
const wonShort=n=>{n=Number(n)||0;if(n>=100000000)return +(n/100000000).toFixed(2)+"억";if(n>=10000)return +(n/10000).toFixed(1)+"만";return n.toLocaleString("ko-KR")};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const hue=s=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))>>>0;return h%360};
const cohortLabel=c=>c?`${c.grade} ${c.dept}`.trim():"(삭제된 갤러리)";
const cohortById=id=>S.cfg.cohorts.find(c=>c.id===id)||null;
const safeUrl=u=>/^https?:\/\//i.test(String(u||"").trim())?String(u).trim():"";
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
class UserError extends Error{}
function errMsg(e){
  if(e instanceof UserError)return e.message;
  const c=String(e&&e.code||"").replace(/^firestore\//,"");
  if(c==="permission-denied")return "저장할 권한이 없어요. 펀딩 기간이 아니거나, 관리자 계정이 아니거나, 투자 규칙에 맞지 않는 요청이에요.";
  if(c==="resource-exhausted")return "Firebase 무료 사용량 한도에 도달했어요. 선생님께 알려 주세요.";
  if(c==="unavailable"||c==="deadline-exceeded")return "인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.";
  if(c==="aborted")return "동시에 요청이 몰렸어요. 한 번 더 눌러 주세요.";
  if(c==="failed-precondition")return "데이터베이스 설정이 끝나지 않았어요. 선생님께 알려 주세요.";
  return "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
}
function authErr(e){
  const c=e&&e.code||"";
  if(c==="auth/operation-not-allowed"||c==="auth/admin-restricted-operation")return "Firebase 콘솔의 Authentication에서 ‘익명’과 ‘Google’ 로그인을 사용 설정해 주세요.";
  if(c==="auth/unauthorized-domain")return "Firebase 콘솔 Authentication › 설정 › 승인된 도메인에 이 사이트 주소를 추가해 주세요.";
  if(c==="auth/network-request-failed")return "인터넷 연결을 확인해 주세요.";
  if(c==="auth/configuration-not-found"||c==="auth/invalid-api-key")return "firebase-config.js의 설정값을 다시 확인해 주세요.";
  return "로그인하지 못했어요. ("+c+")";
}
async function withRetry(fn){
  try{return await fn()}catch(e){
    const c=String(e&&e.code||"");
    if(/unavailable|aborted|deadline-exceeded/.test(c)){await sleep(400+Math.random()*900);return await fn()}
    throw e;
  }
}
const queues=new Map();
function enqueue(key,fn){
  const prev=queues.get(key)||Promise.resolve();
  const p=prev.then(fn,fn);
  queues.set(key,p.catch(()=>{}));
  return p;
}
function toast(msg,bad){
  const t=document.createElement("div");t.className="toast"+(bad?" bad":"");t.setAttribute("role","status");t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),bad?4200:2600);
}
function busy(text){
  const el=document.createElement("div");el.className="busy";el.innerHTML=`<div><span class="spinner"></span><span>${esc(text)}</span></div>`;
  $("#overlay-root").appendChild(el);return ()=>el.remove();
}

/* ───────── normalize ───────── */
function posInt(v,d){v=Number(v);return Number.isInteger(v)&&v>0?v:d}
function normCfg(d){
  const c=Object.assign({},DEFAULT_CFG);
  if(!d||typeof d!=="object")return c;
  if(typeof d.title==="string"&&d.title.trim())c.title=d.title.slice(0,80);
  c.budget=posInt(d.budget,c.budget);c.unit=posInt(d.unit,c.unit);
  c.scope=d.scope==="all"?"all":"own";
  c.showLive=d.showLive!==false;
  c.status=STATUS[d.status]?d.status:"setup";
  c.closedAt=Number(d.closedAt)||0;c.revealedAt=Number(d.revealedAt)||0;
  c.cohorts=Array.isArray(d.cohorts)?d.cohorts.filter(x=>x&&typeof x.id==="string").map(x=>({id:x.id,grade:String(x.grade||""),dept:String(x.dept||"")})):[];
  return c;
}
function normTeam(id,d){
  d=d||{};
  return {id,cohortId:String(d.cohortId||""),name:String(d.name||"이름 없는 팀"),item:String(d.item||""),summary:String(d.summary||""),members:String(d.members||""),
    deck:deckLines(d.deck).join("\n"),createdAt:Number(d.createdAt)||0};
}
function deckLines(v){
  return String(v||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(safeDeckUrl).filter(Boolean).slice(0,40);
}
function safeDeckUrl(u){
  u=String(u||"").trim();if(!u)return "";
  if(/^https?:\/\//i.test(u))return u;
  if(/^[a-z][a-z0-9+.-]*:/i.test(u)||u.startsWith("//")||u.includes("\\"))return "";
  return u.replace(/^\.?\//,"");
}
const IMG_RE=/\.(png|jpe?g|webp|gif)$/i;
function deckInfo(t){
  const lines=deckLines(t.deck);const u=lines[0]||"";
  if(!u)return {kind:"none",label:"자료 없음"};
  const path=u.split(/[?#]/)[0];
  if(lines.length>1&&lines.every(x=>IMG_RE.test(x.split(/[?#]/)[0])))return {kind:"imgs",list:lines,open:u,label:`이미지 ${lines.length}장`,cover:u};
  let m;
  if((m=u.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/)))return {kind:"frame",src:`https://docs.google.com/presentation/d/${m[1]}/preview`,open:u,label:"구글 슬라이드"};
  if((m=u.match(/drive\.google\.com\/file\/d\/([\w-]+)/))||(m=u.match(/drive\.google\.com\/open\?id=([\w-]+)/)))return {kind:"frame",src:`https://drive.google.com/file/d/${m[1]}/preview`,open:u,label:"구글 드라이브"};
  if(/^https:\/\/(www\.)?canva\.com\/design\//i.test(u)){const base=path.replace(/\/(edit|watch)$/,"/view");return {kind:"frame",src:base+"?embed",open:u,label:"캔바"}}
  if(/\.pdf$/i.test(path))return {kind:"pdf",src:u,open:u,label:"PDF"};
  if(IMG_RE.test(path))return {kind:"imgs",list:[u],open:u,label:"이미지",cover:u};
  return {kind:"link",open:u,label:"링크"};
}
/* ───────── integrity & aggregation ───────── */
function evalDoc(d){
  const cfg=S.cfg;const r={ok:true,reason:"",entries:[],sum:0};
  if(!d||typeof d!=="object"){r.ok=false;r.reason="형식 오류";return r}
  const alloc=d.alloc&&typeof d.alloc==="object"?d.alloc:{};
  for(const [tid,v] of Object.entries(alloc)){
    const t=S.teams.get(tid);
    if(!t)continue;                                   // team removed → entry ignored
    if(!Number.isInteger(v)||v<0||v%cfg.unit!==0){r.ok=false;r.reason="잘못된 금액";return r}
    if(v===0)continue;
    if(d.ownTeamId&&tid===d.ownTeamId){r.ok=false;r.reason="자기 팀 투자";return r}
    if(cfg.scope==="own"&&t.cohortId!==d.cohortId){r.ok=false;r.reason="다른 갤러리 투자";return r}
    r.sum+=v;r.entries.push([tid,v]);
  }
  if(r.sum>cfg.budget){r.ok=false;r.reason="한도 초과";return r}
  return r;
}
function aggregate(invMap){
  const agg=new Map();for(const t of S.teams.values())agg.set(t.id,{total:0,investors:0});
  const flagged=[];let totalFunded=0,investors=0;
  for(const [id,d] of invMap){
    const r=evalDoc(d);
    if(!r.ok){flagged.push({id,reason:r.reason});continue}
    if(r.sum>0){investors++;totalFunded+=r.sum}
    for(const [tid,v] of r.entries){const a=agg.get(tid);a.total+=v;a.investors++}
  }
  return {agg,flagged,totalFunded,investors};
}
function isFinal(){return (S.cfg.status==="closed"||S.cfg.status==="revealed")&&S.final&&S.final.teams&&typeof S.final.teams==="object"}
function standings(){
  const adminLive=S.isAdmin?aggregate(S.inv):null;
  if(isFinal()){
    const agg=new Map();
    for(const t of S.teams.values()){const f=S.final.teams[t.id];agg.set(t.id,{total:Number(f&&f.total)||0,investors:Number(f&&f.investors)||0})}
    return {agg,flagged:adminLive?adminLive.flagged:[],totalFunded:Number(S.final.totalFunded)||0,investors:Number(S.final.investors)||0,frozen:true,frozenAt:S.final.frozenAt};
  }
  if(adminLive)return Object.assign(adminLive,{frozen:false});
  const sm=S.summary;const agg=new Map();
  for(const t of S.teams.values()){const f=sm&&sm.teams&&sm.teams[t.id];agg.set(t.id,{total:Number(f&&f.total)||0,investors:Number(f&&f.investors)||0})}
  return {agg,flagged:[],totalFunded:Number(sm&&sm.totalFunded)||0,investors:Number(sm&&sm.investors)||0,frozen:false,pending:!sm};
}
function rankList(cohortId,agg){
  const list=[...S.teams.values()].filter(t=>cohortId==="all"||t.cohortId===cohortId)
    .map(t=>Object.assign({},t,agg.get(t.id)||{total:0,investors:0}));
  list.sort((a,b)=>b.total-a.total||b.investors-a.investors||a.createdAt-b.createdAt||a.name.localeCompare(b.name,"ko"));
  list.forEach((t,i)=>{t.rank=i===0?1:(t.total===list[i-1].total?list[i-1].rank:i+1)});
  return list;
}
function winnersOf(list){return list.filter(t=>t.rank===1&&t.total>0)}
function amountsVisible(){
  if(S.isAdmin)return true;
  if(S.cfg.status==="revealed")return true;
  return S.cfg.showLive;
}
function myState(){
  const raw=S.uid?S.inv.get(S.uid):null;
  const r=raw?evalDoc(raw):{ok:true,entries:[],sum:0};
  const by=new Map(r.entries);
  return {raw,ok:r.ok,reason:r.reason,sum:r.ok?r.sum:0,by,remaining:Math.max(0,S.cfg.budget-(r.ok?r.sum:0))};
}
function investBlock(t){
  const c=S.cfg;
  if(S.readOnly)return "보기 전용 권한";
  if(!S.uid)return "로그인이 필요해요";
  if(c.status==="setup")return "펀딩 시작 전";
  if(c.status!=="open")return "펀딩 마감";
  if(!S.me)return "";
  if(S.me.ownTeamId&&S.me.ownTeamId===t.id)return "우리 팀에는 투자할 수 없어요";
  if(c.scope==="own"&&t.cohortId!==S.me.cohortId)return "내 갤러리 팀에만 투자할 수 있어요";
  return "";
}

/* ───────── boot ───────── */
function configured(){
  const c=firebaseConfig||{};
  return !!(c.apiKey&&c.projectId&&!/YOUR_|여기에/.test(c.apiKey+c.projectId));
}
async function boot(){
  routeFromHash();schedule();
  if(!configured()){S.noDb=true;S.ready=true;schedule();return}
  try{FB.app=initializeApp(firebaseConfig);FB.auth=getAuth(FB.app);FB.fs=getFirestore(FB.app)}
  catch(e){S.noDb=true;S.setupError=String(e&&e.message||e);S.ready=true;schedule();return}
  S.db=makeDb(FB.fs);
  getRedirectResult(FB.auth).catch(e=>{if(e&&e.code&&e.code!=="auth/no-auth-event")toast(authErr(e),true)});
  let lastUid=null;
  onAuthStateChanged(FB.auth,async u=>{
    if(!u){
      S.uid=null;S.isAdmin=false;
      try{await signInAnonymously(FB.auth)}catch(e){S.authError=authErr(e);S.ready=true;S.lastHtml="";schedule()}
      return;
    }
    const email=u.isAnonymous?"":String(u.email||"").toLowerCase();
    S.uid=u.uid;S.email=email;S.isAdmin=!!email&&ADMINS.includes(email);S.authError="";
    if(email&&!S.isAdmin)toast(`${email}은(는) 관리자 목록에 없는 계정이에요. firebase-config.js와 firestore.rules에 추가하세요.`,true);
    if(lastUid!==u.uid){lastUid=u.uid;resubscribe()}
    S.ready=true;S.lastHtml="";schedule();
  });
}
function makeDb(fs){
  const wrap=s=>({id:s.id,exists:s.exists(),data:()=>s.data(),metadata:s.metadata});
  const docRef=path=>{const r=doc(fs,path);return {
    get:async()=>wrap(await getDoc(r)),set:d=>setDoc(r,d),delete:()=>deleteDoc(r),
    onSnapshot:(n,e)=>onSnapshot(r,s=>n(wrap(s)),e)}};
  const collRef=(path,lim)=>{const q=lim?query(collection(fs,path),limit(lim)):collection(fs,path);return {
    limit:n=>collRef(path,n),
    get:async()=>{const qs=await getDocs(q);return {docs:qs.docs.map(wrap)}},
    onSnapshot:(n,e)=>onSnapshot(q,qs=>n({docs:qs.docs.map(wrap)}),e)}};
  return {doc:docRef,collection:p=>collRef(p,0)};
}
function onErr(e){
  const c=String(e&&e.code||"");
  if(c==="permission-denied")S.dbError="데이터를 읽을 권한이 없어요. 선생님께 Firestore 보안 규칙이 게시됐는지 확인해 달라고 하세요.";
  else if(c==="failed-precondition")S.dbError="Firestore 데이터베이스가 아직 만들어지지 않았어요.";
  else if(c==="resource-exhausted")S.dbError="Firebase 무료 사용량 한도에 도달했어요.";
  else S.dbError="실시간 연결이 끊겼어요. 페이지를 새로고침해 주세요.";
  S.loaded.cfg=S.loaded.teams=S.loaded.inv=true;S.meLoaded=true;
  schedule();
}
let unsubs=[];let gated=null;
function resubscribe(){
  unsubs.forEach(f=>{try{f()}catch(e){}});unsubs=[];stopGated();
  S.loaded={cfg:false,teams:false,inv:false};S.inv=new Map();S.roster=new Map();S.me=null;S.meLoaded=false;
  S.summary=null;S.final=null;S.dbError="";S.lastHtml="";S.prevTotals=null;
  const db=S.db;
  unsubs.push(db.doc("config/main").onSnapshot(s=>{
    S.cfg=normCfg(s.exists?s.data():null);S.loaded.cfg=true;syncGated();checkCeremony();schedule();
  },onErr));
  unsubs.push(db.collection("teams").onSnapshot(q=>{
    const m=new Map();q.docs.forEach(d=>{if(d.exists)m.set(d.id,normTeam(d.id,d.data()))});
    S.teams=m;S.loaded.teams=true;queueSummary();schedule();
  },onErr));
  unsubs.push(db.doc("roster/"+S.uid).onSnapshot(s=>{S.me=s.exists?s.data():null;S.meLoaded=true;schedule()},onErr));
  if(S.isAdmin){
    unsubs.push(db.collection("investments").onSnapshot(q=>{
      const m=new Map();q.docs.forEach(d=>{if(d.exists)m.set(d.id,d.data())});
      S.inv=m;S.loaded.inv=true;queueSummary();schedule();
    },onErr));
    unsubs.push(db.collection("roster").onSnapshot(q=>{
      const m=new Map();q.docs.forEach(d=>{if(d.exists)m.set(d.id,d.data())});S.roster=m;schedule();
    },()=>{}));
  }else{
    unsubs.push(db.doc("investments/"+S.uid).onSnapshot(s=>{
      S.inv=new Map(s.exists?[[S.uid,s.data()]]:[]);S.loaded.inv=true;schedule();
    },onErr));
  }
}
/* summary & final are readable by students only while amounts are public */
function canReadResults(){return S.isAdmin||S.cfg.showLive||S.cfg.status==="revealed"}
function stopGated(){if(gated){gated.forEach(f=>{try{f()}catch(e){}});gated=null}}
function syncGated(){
  const want=canReadResults();
  if(!want){if(gated){stopGated();S.summary=null;S.final=null}return}
  if(gated)return;
  const fail=()=>{stopGated();S.summary=null;S.final=null;schedule();setTimeout(()=>{if(!gated)syncGated()},4000)};
  gated=[
    S.db.doc("public/summary").onSnapshot(s=>{S.summary=s.exists?s.data():null;S.sumAt=Date.now();queueSummary();schedule()},fail),
    S.db.doc("results/final").onSnapshot(s=>{S.final=s.exists?s.data():null;schedule()},fail)
  ];
}
/* the admin page publishes the aggregate students see (throttled) */
let sumTimer=null,lastSumAt=0;
function canon(v){if(v&&typeof v==="object"&&!Array.isArray(v))return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canon(v[k])).join(",")+"}";return JSON.stringify(v)}
function queueSummary(){
  if(!S.isAdmin||!S.loaded.inv||!S.loaded.teams||!S.loaded.cfg||sumTimer)return;
  sumTimer=setTimeout(publishSummary,Math.max(300,SUM_MS-(Date.now()-lastSumAt)));
}
async function publishSummary(){
  sumTimer=null;lastSumAt=Date.now();
  const st=aggregate(S.inv);const teams={};
  for(const [k,v] of st.agg)teams[k]={total:v.total,investors:v.investors};
  const body={teams,totalFunded:st.totalFunded,investors:st.investors};
  const cur=S.summary?{teams:S.summary.teams||{},totalFunded:S.summary.totalFunded,investors:S.summary.investors}:null;
  if(cur&&canon(cur)===canon(body)){S.sumErr="";return}
  try{await S.db.doc("public/summary").set(Object.assign(body,{updatedAt:Date.now()}));S.sumErr=""}
  catch(e){S.sumErr=errMsg(e);setTimeout(queueSummary,5000)}
  schedule();
}
async function adminLogin(){
  if(!FB.auth)return;
  const p=new GoogleAuthProvider();p.setCustomParameters({prompt:"select_account"});
  try{await signInWithPopup(FB.auth,p)}
  catch(e){
    const c=e&&e.code||"";
    if(c==="auth/popup-blocked"||c==="auth/operation-not-supported-in-this-environment"){try{await signInWithRedirect(FB.auth,p)}catch(e2){toast(authErr(e2),true)}}
    else if(c!=="auth/popup-closed-by-user"&&c!=="auth/cancelled-popup-request")toast(authErr(e),true);
  }
}
async function adminLogout(){
  if(!await confirmBox({title:"로그아웃",text:"관리자 계정에서 로그아웃할까요? 이 기기는 학생 화면으로 돌아가요.",ok:"로그아웃"}))return;
  try{await signOut(FB.auth);go("gallery")}catch(e){toast("로그아웃하지 못했어요",true)}
}
/* ───────── routing ───────── */
function routeFromHash(){
  const h=(location.hash||"").replace("#","");
  S.view=VIEWS.includes(h)?h:"gallery";
}
window.addEventListener("hashchange",()=>{routeFromHash();S.lastHtml="";schedule();window.scrollTo({top:0})});
function go(v){if(location.hash!=="#"+v)location.hash=v;else{S.view=v;S.lastHtml="";schedule()}}

/* ───────── render scheduling ───────── */
let rTimer=null,rLast=0;
function schedule(){
  if(rTimer)return;
  const wait=Math.max(0,250-(Date.now()-rLast));
  rTimer=setTimeout(()=>{rTimer=null;rLast=Date.now();requestAnimationFrame(render)},wait);
}
function render(){
  renderHeader();
  const app=$("#app");
  let html;
  if(S.authError&&!S.uid)html=viewAuthError();
  else if(!S.ready||(!S.noDb&&!(S.loaded.cfg&&S.loaded.teams&&S.loaded.inv&&S.meLoaded)))html=`<div class="loading"><div class="spinner" aria-label="불러오는 중"></div></div>`;
  else if(S.noDb)html=viewNoDb();
  else{
    if(S.view==="stage"&&!S.isAdmin&&S.cfg.status!=="revealed")S.view="ranking";
    trackPulses();
    html=(S.dbError?`<div class="wrap"><div class="notice warn"><div class="ic">!</div><div class="body"><b>${esc(S.dbError)}</b></div></div></div>`:"")+
      (S.view==="admin"&&!S.isAdmin?viewAdminLogin:({gallery:viewGallery,ranking:viewRanking,portfolio:viewPortfolio,stage:viewStage,admin:viewAdmin}[S.view]||viewGallery))()+
      `<footer class="foot wrap"><p>투자금은 수업용 가상 금액이에요 · 학생마다 자기 투자 기록만 저장되어 여러 명이 동시에 투자해도 금액이 섞이지 않아요</p><p>${S.isAdmin?`관리자 ${esc(S.email)} · <button class="linkbtn" data-act="admin-logout">로그아웃</button>`:`<a href="#admin">관리자 로그인</a>`}</p></footer>`;
  }
  if(html!==S.lastHtml){
    const ae=document.activeElement;let keep=null;
    if(ae&&ae.id&&app.contains(ae)){keep={id:ae.id};try{keep.s=ae.selectionStart;keep.e=ae.selectionEnd}catch(_){}}
    S.lastHtml=html;app.innerHTML=html;animateBars();
    if(keep){const el=document.getElementById(keep.id);if(el){el.focus({preventScroll:true});try{if(keep.s!=null)el.setSelectionRange(keep.s,keep.e)}catch(_){}}}
  }
}
function animateBars(){
  const bars=document.querySelectorAll(".bar i[data-k]");
  bars.forEach(b=>{const k=b.dataset.k;const prev=S.barPrev.get(k);b.style.width=(prev==null?0:prev)+"%"});
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    bars.forEach(b=>{b.style.width=b.dataset.w+"%";S.barPrev.set(b.dataset.k,Number(b.dataset.w))});
  }));
}
function trackPulses(){
  if(!amountsVisible())return;
  const {agg}=standings();const now=Date.now();
  if(S.prevTotals){
    for(const [tid,a] of agg){const p=S.prevTotals.get(tid);if(p!=null&&a.total>p)S.pulses.set(tid,{delta:a.total-p,until:now+2400})}
  }
  S.prevTotals=new Map([...agg].map(([k,v])=>[k,v.total]));
  for(const [k,v] of S.pulses)if(v.until<now)S.pulses.delete(k);
  if(S.pulses.size)setTimeout(()=>{S.lastHtml="";schedule()},2500);
}
/* ───────── header ───────── */
function renderHeader(){
  const st=STATUS[S.cfg.status];
  $("#status-pill").innerHTML=S.ready&&!S.noDb&&S.loaded.cfg?`<span class="pill ${st.cls}"><span class="dot"></span>${st.label}</span>`:"";
  const items=[["gallery","갤러리"],["ranking","실시간 순위"],["portfolio","내 투자"]];
  if(S.isAdmin||S.cfg.status==="revealed")items.push(["stage","발표 화면"]);
  if(S.isAdmin)items.push(["admin","관리자"]);
  const html=items.map(([k,l])=>`<a href="#${k}" ${S.view===k?'aria-current="page"':""} class="${k==="admin"?"admin-link":""}">${l}</a>`).join("");
  const nav=$("#nav");if(nav.innerHTML!==html)nav.innerHTML=html;
}

/* ───────── views ───────── */
function viewNoDb(){
  return `<div class="wrap"><div class="mast"><div class="eyebrow">IR Demo Day · 설치 안내</div><h1>Firebase 연결이 필요해요</h1>
  <p class="sub">이 앱은 학생들의 투자 기록을 Firebase(무료)에 실시간으로 저장해요.</p></div>
  <div class="panel"><ol class="steps">
    <li><span>Firebase 프로젝트를 만들고 웹 앱을 추가하세요<small>console.firebase.google.com</small></span></li>
    <li><span>Authentication에서 ‘익명’과 ‘Google’ 로그인을 사용 설정하세요<small>승인된 도메인에 GitHub Pages 주소(아이디.github.io)를 추가하세요</small></span></li>
    <li><span>Firestore 데이터베이스를 만들고 firestore.rules 내용을 규칙 탭에 붙여넣어 게시하세요<small>규칙 안의 관리자 이메일을 선생님 구글 계정으로 바꾸세요</small></span></li>
    <li><span>firebase-config.js에 설정값과 관리자 이메일을 넣고 GitHub에 올리세요<small>자세한 순서는 README.md에 있어요</small></span></li>
  </ol>${S.setupError?`<p class="err">${esc(S.setupError)}</p>`:""}</div></div>`;
}
function viewAuthError(){
  return `<div class="wrap"><div class="mast"><div class="eyebrow">IR Demo Day</div><h1>접속하지 못했어요</h1></div>
  <div class="notice warn"><div class="ic">!</div><div class="body"><b>${esc(S.authError)}</b><p>문제가 계속되면 선생님께 알려 주세요.</p></div><div class="act"><button class="btn" data-act="reload">다시 시도</button></div></div></div>`;
}
function viewAdminLogin(){
  return `<div class="wrap"><div class="mast"><div class="eyebrow">Admin</div><h1>관리자 로그인</h1><p class="sub">firebase-config.js와 firestore.rules에 등록한 선생님 구글 계정으로 로그인하세요.</p></div>
  <div class="panel" style="max-width:520px">
    ${S.email&&!S.isAdmin?`<div class="notice warn" style="margin:0 0 16px"><div class="ic">!</div><div class="body"><b>${esc(S.email)}은(는) 관리자로 등록되지 않았어요</b><p>다른 계정으로 로그인하거나 관리자 목록에 이 이메일을 추가하세요.</p></div></div>`:""}
    <button class="btn primary lg" data-act="admin-login" style="width:100%">Google 계정으로 로그인</button>
    <p class="muted" style="font-size:13px;margin:12px 0 0">학생은 로그인할 필요가 없어요. 이 기기에서 학생으로 등록한 기록이 있다면, 관리자 로그인 후에는 이 기기에서 그 학생 기록이 보이지 않아요.</p>
  </div></div>`;
}
function masthead(){
  const c=S.cfg;const st=standings();const vis=amountsVisible();
  const ms=myState();
  const teamCount=S.teams.size;
  const wallet=S.me&&!S.isAdmin?`<div class="fig wallet"><div class="k">내 잔액</div><div class="v">${wonShort(ms.remaining)}<small>원</small></div><div class="meter"><i style="width:${Math.min(100,ms.sum/c.budget*100)}%"></i></div></div>`
    :`<div class="fig"><div class="k">1인당 투자금</div><div class="v">${wonShort(c.budget)}<small>원</small></div></div>`;
  return `<section class="wrap mast">
    <div class="eyebrow"><span>IR Demo Day</span><span aria-hidden="true">·</span><span>Seed Round</span></div>
    <h1>${esc(c.title)}</h1>
    <p class="sub">1인당 가상 투자금 <b class="num">${won(c.budget)}</b> · 투자 단위 <b class="num">${won(c.unit)}</b> · ${c.scope==="own"?"내 갤러리 팀에 투자":"모든 갤러리 팀에 투자 가능"}</p>
    <div class="figures">
      <div class="fig"><div class="k">총 펀딩 금액</div><div class="v">${vis?(st.pending?"집계 중":wonShort(st.totalFunded)+"<small>원</small>"):"비공개"}</div></div>
      <div class="fig"><div class="k">참여 투자자</div><div class="v">${st.investors}<small>명</small></div></div>
      <div class="fig"><div class="k">참가 팀</div><div class="v">${teamCount}<small>팀</small></div></div>
      ${wallet}
    </div>
    ${topNotice()}
  </section>`;
}
function topNotice(){
  const c=S.cfg;
  if(S.cfg.status==="revealed"){
    const {agg}=standings();const w=winnersOf(rankList("all",agg));
    if(w.length)return `<div class="notice gold"><div class="ic">1</div><div class="body"><b>결과가 발표됐어요 · 최다 펀딩 ${esc(w.map(t=>t.name).join(", "))}</b><p>${won(w[0].total)}의 투자를 받았어요.</p></div><div class="act"><button class="btn gold" data-act="ceremony">시상 다시 보기</button></div></div>`;
  }
  if(S.isAdmin)return "";
  if(S.readOnly)return `<div class="notice warn"><div class="ic">!</div><div class="body"><b>보기 전용으로 열려 있어요</b><p>투자하려면 선생님께 이 페이지의 ‘참여(Contributor)’ 권한을 요청하세요.</p></div></div>`;
  if(!S.uid)return `<div class="notice warn"><div class="ic">!</div><div class="body"><b>접속 중이에요</b><p>잠시만 기다려 주세요.</p></div></div>`;
  if(!S.me){
    if(!c.cohorts.length)return `<div class="notice"><div class="ic">i</div><div class="body"><b>아직 갤러리가 열리지 않았어요</b><p>선생님이 갤러리와 팀을 등록하면 투자자 등록을 할 수 있어요.</p></div></div>`;
    return `<div class="notice"><div class="ic">→</div><div class="body"><b>먼저 투자자로 등록하세요</b><p>이름과 소속 갤러리를 입력하면 ${won(c.budget)}의 투자금을 받아요.</p></div><div class="act"><button class="btn accent" data-act="register">투자자 등록</button></div></div>`;
  }
  const ms=myState();
  if(!ms.ok)return `<div class="notice warn"><div class="ic">!</div><div class="body"><b>투자 기록에 문제가 있어요 (${esc(ms.reason)})</b><p>‘내 투자’에서 투자를 다시 조정하면 해결돼요.</p></div></div>`;
  if(c.status==="setup")return `<div class="notice"><div class="ic">i</div><div class="body"><b>펀딩 시작 전이에요</b><p>발표자료를 미리 살펴보세요. 선생님이 펀딩을 시작하면 투자할 수 있어요.</p></div></div>`;
  if(c.status==="closed")return `<div class="notice warn"><div class="ic">■</div><div class="body"><b>펀딩이 마감됐어요</b><p>결과 발표를 기다려 주세요.</p></div></div>`;
  return "";
}
function cohortChips(sel,act,withAll){
  const c=S.cfg;const mine=S.me&&S.me.cohortId;
  let h=withAll?`<button class="chip" data-act="${act}" data-id="all" aria-pressed="${sel==="all"}">전체</button>`:"";
  h+=c.cohorts.map(co=>{
    const n=[...S.teams.values()].filter(t=>t.cohortId===co.id).length;
    return `<button class="chip" data-act="${act}" data-id="${esc(co.id)}" aria-pressed="${sel===co.id}">${esc(cohortLabel(co))} <span class="n">${n}</span>${mine===co.id?'<span class="mine">내 갤러리</span>':""}</button>`;
  }).join("");
  return `<div class="chips" role="group" aria-label="갤러리 선택">${h}</div>`;
}
function resolveSel(sel,allowAll){
  const ids=S.cfg.cohorts.map(c=>c.id);
  if(allowAll&&sel==="all")return "all";
  if(sel&&ids.includes(sel))return sel;
  if(S.me&&ids.includes(S.me.cohortId))return S.me.cohortId;
  return allowAll?"all":(ids[0]||null);
}
function coverHtml(t,rankTag){
  const di=deckInfo(t);
  return `<button class="cover" style="--h:${hue(t.id)}" data-act="deck" data-id="${esc(t.id)}" aria-label="${esc(t.name)} 발표자료 보기">
    ${di.cover?`<img src="${esc(di.cover)}" alt="" loading="lazy" onerror="this.nextElementSibling.hidden=false;this.remove()">`:""}<div class="typo" ${di.cover?"hidden":""}><span class="slide-no">PITCH DECK · ${esc(t.name)}</span><span class="big">${esc(t.item||t.name)}</span><span class="rule"></span></div>
    ${rankTag||""}<span class="deck-tag">${esc(di.label)}</span></button>`;
}
function viewGallery(){
  const c=S.cfg;const sel=resolveSel(S.cohortSel,false);
  const vis=amountsVisible();const {agg}=standings();
  let body;
  if(!c.cohorts.length){
    body=`<div class="empty"><h3>등록된 갤러리가 없어요</h3><p>${S.isAdmin?"관리자 화면에서 학년과 학과를 정해 갤러리를 만들고 팀과 발표자료를 등록하세요.":"선생님이 갤러리를 준비하고 있어요."}</p>${S.isAdmin?`<button class="btn primary" data-go="admin">갤러리 만들기</button>`:""}</div>`;
  }else{
    const list=rankList(sel,agg);
    const max=Math.max(1,...list.map(t=>t.total));
    const order=vis?list:[...list].sort((a,b)=>a.createdAt-b.createdAt);
    const ms=myState();
    const revealed=c.status==="revealed";
    body=order.length?`<div class="grid">${order.map(t=>{
      const pulse=S.pulses.get(t.id);
      const block=investBlock(t);
      const mine=ms.by.get(t.id)||0;
      const own=S.me&&S.me.ownTeamId===t.id;
      const isWin=revealed&&t.rank===1&&t.total>0;
      const rankTag=vis&&t.total>0?`<span class="rank-tag ${isWin?"r1":""}">${t.rank}위</span>`:"";
      return `<article class="card ${pulse?"pulse":""} ${isWin?"winner":""}">
        ${coverHtml(t,rankTag)}
        <div class="card-body">
          <div class="team-name">${esc(t.name)}${own?'<span class="own-badge">우리 팀</span>':""}</div>
          <h3 class="item-title">${esc(t.item||"아이템명 미정")}</h3>
          ${t.summary?`<p class="summary">${esc(t.summary)}</p>`:""}
          ${t.members?`<div class="members">${esc(t.members)}</div>`:""}
        </div>
        <div class="raise">${vis?`
          <div class="raise-row"><span class="raise-amt">${won(t.total)}${pulse?`<span class="delta">+${wonShort(pulse.delta)}</span>`:""}</span><span class="raise-meta">투자자 ${t.investors}명</span></div>
          <div class="bar ${isWin?"gold":""}"><i data-k="g-${esc(t.id)}" data-w="${(t.total/max*100).toFixed(2)}"></i></div>`
          :`<div class="hidden-amt">● 펀딩 금액은 결과 발표 때 공개돼요</div>`}
        </div>
        ${mine?`<div class="my-stake"><span>내 투자</span><span class="num">${won(mine)}</span></div>`:""}
        <div class="card-foot">
          <button class="btn" data-act="deck" data-id="${esc(t.id)}">발표자료</button>
          ${S.isAdmin&&!S.me?"":investBtn(t,block,mine)}
          ${block&&!S.isAdmin&&S.me?`<div class="reason">${esc(block)}</div>`:""}
        </div>
      </article>`}).join("")}</div>`
      :`<div class="empty"><h3>이 갤러리에 등록된 팀이 없어요</h3><p>${S.isAdmin?"관리자 화면의 ‘갤러리·팀’에서 팀과 발표자료를 등록하세요.":"곧 팀이 등록될 거예요."}</p></div>`;
  }
  return masthead()+`<section class="wrap">
    <div class="section-head"><div><h2>발표 갤러리</h2><p>${vis?"펀딩을 많이 받은 순서로 정렬돼요. 금액은 실시간으로 바뀌어요.":"발표자료를 보고 마음에 드는 팀에 투자하세요."}</p></div>${c.cohorts.length?cohortChips(sel,"cohort",false):""}</div>
    ${body}</section>`;
}
function investBtn(t,block,mine){
  if(!S.me&&!S.isAdmin&&!block&&S.uid&&!S.readOnly)return `<button class="btn accent" data-act="register">등록 후 투자</button>`;
  if(block)return `<button class="btn accent" disabled>투자하기</button>`;
  if(!S.me)return `<button class="btn accent" data-act="register">등록 후 투자</button>`;
  return `<button class="btn accent" data-act="invest" data-id="${esc(t.id)}">${mine?"투자 조정":"투자하기"}</button>`;
}
function boardHtml(list,keyPrefix,big){
  const max=Math.max(1,...list.map(t=>t.total));const tot=list.reduce((a,t)=>a+t.total,0);
  const revealed=S.cfg.status==="revealed"||S.isAdmin;
  return `<div class="board ${big?"stage-board":""}"><div class="board-head"><span>순위</span><span>팀 · 아이템</span><span>펀딩 비율</span><span class="ta-r">펀딩 금액</span><span class="ta-r">투자자</span></div>
    ${list.map(t=>{const r1=t.rank===1&&t.total>0&&revealed;return `<div class="row ${r1?"r1":""}">
      <span class="rk">${t.total>0?t.rank:"–"}</span>
      <div class="who"><b>${esc(t.item||t.name)}</b><span>${esc(t.name)}${keyPrefix==="all"?" · "+esc(cohortLabel(cohortById(t.cohortId))):""}</span></div>
      <div class="barcell"><div class="bar ${r1?"gold":""}"><i data-k="${keyPrefix}-${esc(t.id)}" data-w="${(t.total/max*100).toFixed(2)}"></i></div></div>
      <span class="amt">${won(t.total)}</span>
      <span class="cnt">${t.investors}명 · ${tot?Math.round(t.total/tot*100):0}%</span>
    </div>`}).join("")}</div>`;
}
function viewRanking(){
  const c=S.cfg;const sel=resolveSel(S.rankSel||"all",true);
  const st=standings();
  let body;
  if(!amountsVisible()){
    body=`<div class="empty"><h3>실시간 금액은 비공개예요</h3><p>선생님이 결과를 발표하면 순위와 펀딩 금액이 공개돼요. 그동안 ‘내 투자’에서 내 포트폴리오를 확인할 수 있어요.</p><button class="btn" data-go="portfolio">내 투자 보기</button></div>`;
  }else if(!S.teams.size){
    body=`<div class="empty"><h3>아직 등록된 팀이 없어요</h3><p>팀이 등록되면 이곳에 순위가 표시돼요.</p></div>`;
  }else{
    const list=rankList(sel,st.agg);
    body=list.length?boardHtml(list,sel==="all"?"all":"r",false):`<div class="empty"><h3>이 갤러리에 팀이 없어요</h3></div>`;
  }
  return masthead()+`<section class="wrap"><div class="section-head"><div><h2>${st.frozen?"최종 순위":"실시간 순위"}</h2><p>${st.frozen?"마감 시점에 확정된 결과예요.":"학생들이 투자할 때마다 바로 반영돼요."}</p></div>${c.cohorts.length?cohortChips(sel,"rank",true):""}</div>${body}</section>`;
}
function viewPortfolio(){
  const c=S.cfg;const ms=myState();
  let body;
  if(!S.uid||S.readOnly){body=`<div class="empty"><h3>투자 기록을 저장할 수 없어요</h3><p>${!S.uid?"접속 중이에요. 잠시 후 다시 열어 주세요.":"선생님께 문의하세요."}</p></div>`}
  else if(!S.me){body=`<div class="empty"><h3>아직 투자자로 등록하지 않았어요</h3><p>이름과 소속 갤러리, 우리 팀을 입력하면 ${won(c.budget)}의 투자금이 지급돼요.</p>${c.cohorts.length?`<button class="btn accent" data-act="register">투자자 등록</button>`:""}</div>`}
  else{
    const co=cohortById(S.me.cohortId);const own=S.teams.get(S.me.ownTeamId);
    const rows=[...ms.by].map(([tid,v])=>{const t=S.teams.get(tid);return {t,v}}).filter(x=>x.t).sort((a,b)=>b.v-a.v);
    body=`<div class="cols" style="margin-top:0">
      <div class="panel"><h3>투자자 정보</h3><p class="desc">소속 갤러리와 팀은 투자 전까지만 바꿀 수 있어요.</p>
        <dl class="kv"><dt>이름</dt><dd>${esc(S.me.name)}</dd><dt>학번</dt><dd>${esc(S.me.studentNo||"-")}</dd><dt>갤러리</dt><dd>${esc(cohortLabel(co))}</dd><dt>우리 팀</dt><dd>${own?esc(own.name):"없음"}</dd></dl>
        <div class="btn-row"><button class="btn sm" data-act="register">정보 수정</button></div></div>
      <div class="panel"><h3>투자 지갑</h3><p class="desc">마감 전까지 언제든 금액을 조정할 수 있어요.</p>
        <dl class="kv"><dt>받은 투자금</dt><dd class="num">${won(c.budget)}</dd><dt>투자한 금액</dt><dd class="num">${won(ms.sum)}</dd><dt>남은 잔액</dt><dd class="num" style="color:var(--accent)">${won(ms.remaining)}</dd></dl>
        <div class="meter" style="height:8px;margin-top:14px"><i style="width:${Math.min(100,ms.sum/c.budget*100)}%"></i></div></div>
    </div>
    <div class="section-head"><div><h2>내 포트폴리오</h2><p>${rows.length}개 팀에 투자했어요.</p></div></div>
    ${rows.length?`<div class="panel"><div class="list">${rows.map(({t,v})=>`<div class="li"><div class="thumb" style="--h:${hue(t.id)}">${esc((t.item||t.name).slice(0,1))}</div><div class="main"><b>${esc(t.item||t.name)}</b><span>${esc(t.name)} · 지분 ${Math.round(v/c.budget*100)}%</span></div><span class="num" style="font-weight:600">${won(v)}</span>${c.status==="open"&&!investBlock(t)?`<button class="btn sm" data-act="invest" data-id="${esc(t.id)}">조정</button>`:""}</div>`).join("")}</div></div>`
      :`<div class="empty"><h3>아직 투자한 팀이 없어요</h3><p>갤러리에서 발표자료를 살펴보고 마음에 드는 팀에 투자해 보세요.</p><button class="btn primary" data-go="gallery">갤러리로 가기</button></div>`}`;
  }
  return masthead()+`<section class="wrap"><div class="section-head"><div><h2>내 투자</h2></div></div>${body}</section>`;
}
function winnersBlock(agg){
  const c=S.cfg;
  const overall=winnersOf(rankList("all",agg));
  const per=c.cohorts.map(co=>({co,w:winnersOf(rankList(co.id,agg))})).filter(x=>x.w.length);
  if(!overall.length)return `<div class="empty"><h3>아직 투자 기록이 없어요</h3></div>`;
  return `<div class="champion"><div class="lab">GRAND PRIZE · 최다 펀딩 1위${overall.length>1?" (공동)":""}</div>
      <h2>${esc(overall.map(t=>t.item||t.name).join(" · "))}</h2>
      <div class="tn">${esc(overall.map(t=>t.name+" · "+cohortLabel(cohortById(t.cohortId))).join(" / "))}</div>
      <div class="wa">${won(overall[0].total)}</div></div>
    ${c.cohorts.length>1?`<div class="winners">${per.map(({co,w})=>`<div class="win-card"><div class="lab">${esc(cohortLabel(co))} 1위${w.length>1?" (공동)":""}</div><h3>${esc(w.map(t=>t.item||t.name).join(" · "))}</h3><div class="tn">${esc(w.map(t=>t.name).join(", "))} · 투자자 ${w[0].investors}명</div><div class="wa">${won(w[0].total)}</div></div>`).join("")}</div>`:""}`;
}
function viewStage(){
  const c=S.cfg;const st=standings();const sel=resolveSel(S.stageSel,true);
  const list=rankList(sel,st.agg);
  const revealed=c.status==="revealed";
  return `<section class="wrap stage-wrap">
    <div class="eyebrow"><span>${esc(c.title)}</span><span>·</span><span>${STATUS[c.status].label}</span>${st.frozen?`<span>· 확정 결과</span>`:""}</div>
    <h1 class="stage-title">${revealed?"최종 결과":"펀딩 현황"}</h1>
    ${revealed?winnersBlock(st.agg):""}
    <div class="section-head"><div><h2>${sel==="all"?"전체 순위":esc(cohortLabel(cohortById(sel)))+" 순위"}</h2><p>총 ${won(list.reduce((a,t)=>a+t.total,0))} · 투자자 ${st.investors}명</p></div>${cohortChips(sel,"stage",true)}</div>
    ${list.length?boardHtml(list,"s"+sel,true):`<div class="empty"><h3>표시할 팀이 없어요</h3></div>`}
    ${S.isAdmin?`<div class="btn-row" style="justify-content:center;margin-top:28px">
      ${c.status==="closed"?`<button class="btn gold lg" data-act="reveal">1위 공개하고 결과 발표</button>`:""}
      ${revealed?`<button class="btn lg" data-act="ceremony">시상 화면 다시 보기</button>`:""}
      ${c.status==="open"?`<span class="muted">펀딩을 마감하면 이곳에서 1위를 공개할 수 있어요.</span>`:""}
    </div>`:""}
  </section>`;
}

/* ───────── admin ───────── */
function viewAdmin(){
  const tabs=[["run","운영"],["teams","갤러리·팀"],["results","결과"],["people","투자자"]];
  const tab=S.adminTab;
  const inner={run:adminRun,teams:adminTeams,results:adminResults,people:adminPeople}[tab]();
  return `<section class="wrap mast" style="padding-bottom:0"><div class="eyebrow"><span>Admin</span><span>·</span><span>${STATUS[S.cfg.status].label}</span></div><h1>관리자</h1><p class="sub">${esc(S.cfg.title)}</p>
    <div class="subtabs" role="tablist">${tabs.map(([k,l])=>`<button role="tab" aria-selected="${tab===k}" data-act="atab" data-id="${k}">${l}</button>`).join("")}</div></section>
    <section class="wrap" style="padding-top:18px">${inner}</section>`;
}
function anyInvested(){for(const d of S.inv.values()){const a=d&&d.alloc;if(a&&Object.values(a).some(v=>Number(v)>0))return true}return false}
const parseAmt=s=>{const n=parseInt(String(s==null?"":s).replace(/[^\d]/g,""),10);return Number.isFinite(n)?n:0};
function koRead(n){
  if(!n)return "0원";
  const eok=Math.floor(n/1e8),man=Math.floor((n%1e8)/1e4),rest=n%1e4;const p=[];
  if(eok)p.push(eok.toLocaleString("ko-KR")+"억");if(man)p.push(man.toLocaleString("ko-KR")+"만");if(rest)p.push(rest.toLocaleString("ko-KR"));
  return p.join(" ")+" 원";
}
function investedStats(unit){
  let maxSpent=0,unitOk=true,count=0;
  for(const d of S.inv.values()){
    const r=evalDoc(d);if(!r.ok)continue;
    if(r.sum>0)count++;
    if(r.sum>maxSpent)maxSpent=r.sum;
    for(const [,v] of r.entries)if(v%unit!==0)unitOk=false;
  }
  return {maxSpent,unitOk,count};
}
function checkBudget(budget,unit){
  if(!(budget>0))return "투자금을 입력하세요.";
  if(budget>1e12)return "1조 원 이하로 입력하세요.";
  if(!(unit>0))return "투자 단위를 입력하세요.";
  if(unit>budget)return "투자 단위는 투자금보다 클 수 없어요.";
  if(budget%unit!==0)return `투자금이 투자 단위(${won(unit)})로 나누어떨어져야 해요.`;
  const s=investedStats(unit);
  if(s.maxSpent>budget)return `이미 ${won(s.maxSpent)}을 투자한 학생이 있어서 그보다 적게 줄일 수 없어요.`;
  if(!s.unitOk)return `이미 투자한 금액과 맞지 않는 단위예요. 지금 단위(${won(S.cfg.unit)})를 나누어떨어지게 하는 금액으로만 바꿀 수 있어요.`;
  return "";
}
const PRESETS=[300000,500000,1000000,3000000,5000000,10000000];
function budgetPanel(){
  const c=S.cfg;const d=S.bgDraft;
  const bTxt=d.budget!=null?d.budget:c.budget.toLocaleString("ko-KR");
  const uTxt=d.unit!=null?d.unit:c.unit.toLocaleString("ko-KR");
  const pb=parseAmt(bTxt),pu=parseAmt(uTxt);
  const dirty=pb!==c.budget||pu!==c.unit;
  const chk=dirty?checkBudget(pb,pu):"";
  const s=investedStats(c.unit);
  return `<div class="panel budget-panel">
    <div class="bp-head"><div><h3>1인당 투자금</h3><p class="desc">학생 한 명이 받는 가상 투자금이에요. 금액을 직접 입력하거나 아래 금액을 눌러 고르세요.</p></div>
      <div class="bp-now"><span>지금 적용 중</span><b class="num">${won(c.budget)}</b><small>${won(c.unit)} 단위</small></div></div>
    <div class="bp-grid">
      <div class="field"><label for="bg-budget">투자금</label><div class="bp-input"><input id="bg-budget" class="amt-input" type="text" inputmode="numeric" autocomplete="off" value="${esc(bTxt)}" aria-describedby="bg-budget-hint"><span>원</span></div>
        <span class="hint" id="bg-budget-hint">${pb?esc(koRead(pb)):"금액을 입력하세요"}</span></div>
      <div class="field"><label for="bg-unit">투자 단위</label><div class="bp-input"><input id="bg-unit" class="amt-input" type="text" inputmode="numeric" autocomplete="off" value="${esc(uTxt)}" aria-describedby="bg-unit-hint"><span>원</span></div>
        <span class="hint" id="bg-unit-hint">${pb&&pu&&pb%pu===0&&pu<=pb?`학생은 ${esc(koRead(pu))}씩 최대 ${(pb/pu).toLocaleString("ko-KR")}번 나눠 투자해요`:"투자금이 이 금액으로 나누어떨어져야 해요"}</span></div>
    </div>
    <div class="quick" role="group" aria-label="자주 쓰는 투자금">${PRESETS.map(v=>`<button class="btn sm ${pb===v?"primary":""}" type="button" data-act="bg-preset" data-id="${v}">${wonShort(v)}원</button>`).join("")}</div>
    ${chk?`<div class="err" role="alert">${esc(chk)}</div>`:""}
    <div class="btn-row" style="align-items:center">
      <button class="btn primary" data-act="bg-save" ${!dirty||chk?"disabled":""}>투자금 저장</button>
      ${dirty?`<button class="btn ghost" data-act="bg-cancel">되돌리기</button>`:""}
      <span class="muted" style="font-size:13px">${s.count?`투자한 학생 ${s.count}명 · 가장 많이 투자한 학생 ${won(s.maxSpent)} · 저장하면 모든 학생 잔액이 바로 바뀌어요`:"저장하면 모든 학생 화면에 바로 반영돼요"}</span>
    </div>
  </div>`;
}
async function saveBudget(){
  const c=S.cfg;const d=S.bgDraft;
  const budget=parseAmt(d.budget!=null?d.budget:c.budget),unit=parseAmt(d.unit!=null?d.unit:c.unit);
  const chk=checkBudget(budget,unit);if(chk){toast(chk,true);return}
  if(budget===c.budget&&unit===c.unit)return;
  const s=investedStats(c.unit);
  if(s.count){
    const ok=await confirmBox({title:"투자금 변경",text:`이미 ${s.count}명이 투자했어요. 1인당 투자금을 <b>${esc(won(c.budget))}</b>에서 <b>${esc(won(budget))}</b>(으)로 바꾸면 모든 학생의 잔액이 바로 다시 계산돼요. 이미 투자한 금액은 그대로 유지돼요.`,ok:"변경"});
    if(!ok)return;
    const again=checkBudget(budget,unit);if(again){toast(again,true);return}
  }
  try{await setCfg({budget,unit});S.bgDraft={};S.lastHtml="";schedule();toast(`1인당 투자금을 ${won(budget)}으로 정했어요`)}
  catch(e){toast(errMsg(e),true)}
}
function adminRun(){
  const c=S.cfg;const st=aggregate(S.inv);
  const order=["setup","open","closed","revealed"];const idx=order.indexOf(c.status);
  const steps=[
    [true,"펀딩 금액 정하기",`1인당 ${won(c.budget)} · 단위 ${won(c.unit)}`],
    [c.cohorts.length>0,"대상 학년·학과 갤러리 만들기",c.cohorts.length?c.cohorts.map(cohortLabel).join(", "):"아직 없음"],
    [S.teams.size>0,"모둠과 발표자료 등록",`${S.teams.size}팀 등록됨`],
    [S.roster.size>0,"학생에게 사이트 주소 공유","학생은 로그인 없이 주소만 열면 돼요"],
    [idx>=1,"펀딩 시작","학생들이 실시간으로 투자해요"],
    [idx>=3,"마감 후 결과 발표","1위 팀을 공개해요"]
  ];
  const statusBtns={
    setup:`<button class="btn accent lg" data-act="status-open" ${S.teams.size?"":"disabled"}>펀딩 시작</button>`,
    open:`<button class="btn primary lg" data-act="status-close">펀딩 마감</button>`,
    closed:`<button class="btn gold lg" data-act="reveal">결과 발표</button><button class="btn" data-act="status-reopen">펀딩 다시 열기</button>`,
    revealed:`<button class="btn" data-go="stage">발표 화면 보기</button><button class="btn" data-act="status-unreveal">발표 취소</button>`
  }[c.status];
  return budgetPanel()+`<div class="panel mt"><h3>펀딩 진행</h3><p class="desc">단계를 바꾸면 모든 학생 화면에 바로 반영돼요.</p>
    <div class="stage-ctl">${order.map((k,i)=>`<div class="${i===idx?"on":i<idx?"past":""}"><b>${STATUS[k].label}</b>${["학생 등록·자료 열람","투자 가능","투자 잠김·결과 확정","1위 공개"][i]}</div>`).join("")}</div>
    <div class="btn-row">${statusBtns}</div>
    ${c.status==="open"?`<p class="muted" style="font-size:13px;margin:12px 0 0">지금까지 ${st.investors}명이 ${won(st.totalFunded)}을 투자했어요.</p>`:""}
    <p class="${S.sumErr?"err":"muted"}" style="font-size:13px;margin:8px 0 0">${S.sumErr?"학생 화면 집계를 올리지 못했어요: "+esc(S.sumErr):`관리자 화면이 열려 있는 동안 ${Math.round(SUM_MS/1000)}초마다 학생 화면의 금액·순위가 갱신돼요. 펀딩하는 동안 이 화면(또는 발표 화면)을 켜 두세요.`}</p>
  </div>
  <div class="cols">
    <div class="panel"><h3>준비 체크리스트</h3><p class="desc">순서대로 진행하세요.</p><ol class="steps">${steps.map(([d,t,s])=>`<li class="${d?"done":""}"><span>${t}<small>${esc(s)}</small></span></li>`).join("")}</ol></div>
    <div class="panel"><h3>운영 규칙</h3><p class="desc">${anyInvested()?"투자가 시작되어 투자 범위는 잠겨 있어요. 투자금은 위에서 언제든 바꿀 수 있어요.":"투자금은 위 칸에서 입력하고, 나머지 규칙은 여기서 정하세요."}</p>
      <dl class="kv"><dt>행사 이름</dt><dd>${esc(c.title)}</dd>
      <dt>투자 범위</dt><dd>${c.scope==="own"?"내 갤러리 팀만":"모든 갤러리"}</dd><dt>학생 화면 실시간 금액</dt><dd>${c.showLive?"공개":"비공개 (발표 때 공개)"}</dd></dl>
      <div class="btn-row"><button class="btn" data-act="settings">설정 바꾸기</button></div></div>
  </div>
  <div class="panel mt"><h3>초기화</h3><p class="desc">모든 투자 기록을 지우고 ‘준비 중’ 단계로 돌아가요. 갤러리와 팀은 그대로 남아요.</p>
    <button class="btn danger" data-act="reset">투자 기록 초기화</button></div>`;
}
function adminTeams(){
  const c=S.cfg;
  const blocks=c.cohorts.map(co=>{
    const teams=[...S.teams.values()].filter(t=>t.cohortId===co.id).sort((a,b)=>a.createdAt-b.createdAt);
    return `<div class="panel cohort-block"><h4>${esc(cohortLabel(co))} <span class="pill">${teams.length}팀</span><span style="flex:1"></span><button class="btn sm ghost" data-act="cohort-edit" data-id="${esc(co.id)}">이름 수정</button><button class="btn sm ghost" data-act="cohort-del" data-id="${esc(co.id)}">삭제</button></h4>
      <div class="list">${teams.map(t=>{const di=deckInfo(t);return `<div class="li"><div class="thumb" style="--h:${hue(t.id)}">${di.cover?`<img src="${esc(di.cover)}" alt="" onerror="this.remove()">`:esc((t.item||t.name).slice(0,1))}</div>
        <div class="main"><b>${esc(t.name)} · ${esc(t.item||"아이템명 미정")}</b><span>${di.kind==="none"?"발표자료 없음":esc(di.label)+" · "+esc(di.open)}</span></div>
        <button class="btn sm" data-act="deck" data-id="${esc(t.id)}">보기</button><button class="btn sm" data-act="team-edit" data-id="${esc(t.id)}">수정</button></div>`}).join("")||`<p class="muted" style="margin:6px 0">아직 팀이 없어요.</p>`}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn sm accent" data-act="team-add" data-id="${esc(co.id)}">+ 팀 등록</button></div></div>`;
  }).join("");
  const orphan=[...S.teams.values()].filter(t=>!cohortById(t.cohortId));
  return `<div class="section-head" style="margin-top:6px"><div><h2>갤러리와 팀</h2><p>펀딩 대상 학년·학과마다 갤러리를 만들고 모둠과 발표자료(PDF·이미지·링크)를 등록하세요.</p></div><button class="btn primary" data-act="cohort-add">+ 갤러리 만들기</button></div>
    ${c.cohorts.length?blocks:`<div class="empty"><h3>갤러리가 없어요</h3><p>예: ‘2학년 경영과’, ‘3학년 디자인과’처럼 펀딩 대상 학년과 학과를 정해 갤러리를 만드세요.</p><button class="btn primary" data-act="cohort-add">첫 갤러리 만들기</button></div>`}
    ${orphan.length?`<div class="panel mt"><h3>갤러리가 없는 팀</h3><div class="list">${orphan.map(t=>`<div class="li"><div class="main"><b>${esc(t.name)}</b></div><button class="btn sm" data-act="team-edit" data-id="${esc(t.id)}">수정</button></div>`).join("")}</div></div>`:""}`;
}
function adminResults(){
  const c=S.cfg;const st=standings();
  const overall=rankList("all",st.agg);
  return `<div class="section-head" style="margin-top:6px"><div><h2>${st.frozen?"확정 결과":"실시간 결과"}</h2><p>${st.frozen?`마감 시점(${new Date(st.frozenAt||0).toLocaleString("ko-KR")})에 확정된 금액이에요.`:"학생들의 투자가 바로 반영되고 있어요."} 총 ${won(st.totalFunded)} · 투자자 ${st.investors}명</p></div>
    <div class="chips"><button class="btn" data-act="csv">결과 CSV 저장</button><button class="btn" data-go="stage">발표 화면</button></div></div>
    ${st.flagged.length?`<div class="notice warn" style="margin:0 0 16px"><div class="ic">!</div><div class="body"><b>규칙에 맞지 않는 투자 기록 ${st.flagged.length}건은 집계에서 뺐어요</b><p>한도 초과, 자기 팀 투자 같은 기록이에요. ‘투자자’ 탭에서 확인할 수 있어요.</p></div></div>`:""}
    ${overall.some(t=>t.total>0)?`<h3 style="font-family:var(--f-display);margin:0 0 12px">1위 팀</h3>${winnersBlock(st.agg)}`:""}
    ${c.cohorts.map(co=>{const l=rankList(co.id,st.agg);return `<div class="section-head"><div><h2>${esc(cohortLabel(co))}</h2><p>${l.length}팀 · ${won(l.reduce((a,t)=>a+t.total,0))}</p></div></div>${l.length?boardHtml(l,"a"+co.id,false):`<div class="empty"><p>팀이 없어요.</p></div>`}`}).join("")}
    ${c.cohorts.length>1?`<div class="section-head"><div><h2>전체 순위</h2></div></div>${boardHtml(overall,"all",false)}`:""}`;
}
function adminPeople(){
  const c=S.cfg;const q=S.rosterQ.trim().toLowerCase();
  const ids=new Set([...S.roster.keys(),...S.inv.keys()]);
  const rows=[...ids].map(id=>{const r=S.roster.get(id)||{};const d=S.inv.get(id);const e=d?evalDoc(d):{ok:true,sum:0,entries:[]};
    return {id,name:r.name||"(미등록)",no:r.studentNo||"",co:cohortById(r.cohortId||(d&&d.cohortId)),own:S.teams.get(r.ownTeamId||(d&&d.ownTeamId)),sum:e.ok?e.sum:0,n:e.entries.length,ok:e.ok,reason:e.reason,at:Number(d&&d.updatedAt)||Number(r.joinedAt)||0}})
    .filter(r=>!q||r.name.toLowerCase().includes(q)||r.no.toLowerCase().includes(q))
    .sort((a,b)=>(a.co?cohortLabel(a.co):"").localeCompare(b.co?cohortLabel(b.co):"","ko")||a.no.localeCompare(b.no,"ko",{numeric:true})||a.name.localeCompare(b.name,"ko"));
  return `<div class="section-head" style="margin-top:6px"><div><h2>투자자 명단</h2><p>등록 ${S.roster.size}명 · 투자 완료 ${rows.filter(r=>r.sum>0).length}명 · 이름은 관리자에게만 보여요 · 기기를 바꾼 학생은 ‘기기 해제’ 후 다시 등록해요</p></div>
    <input class="search" id="roster-q" type="search" placeholder="이름·학번 검색" value="${esc(S.rosterQ)}" aria-label="투자자 검색"></div>
    ${rows.length?`<div class="table-wrap"><table><thead><tr><th>이름</th><th>학번</th><th>갤러리</th><th>우리 팀</th><th class="r">투자 금액</th><th class="r">잔액</th><th class="r">투자 팀 수</th><th>최근 활동</th><th></th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.no||"-")}</td><td>${esc(r.co?cohortLabel(r.co):"-")}</td><td>${esc(r.own?r.own.name:"-")}</td><td class="r num">${r.ok?won(r.sum):`<span class="flag">${esc(r.reason)}</span>`}</td><td class="r num">${r.ok?won(c.budget-r.sum):"-"}</td><td class="r">${r.n}</td><td>${r.at?new Date(r.at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}):"-"}</td><td>${S.roster.has(r.id)?`<button class="btn sm ghost" data-act="release" data-id="${esc(r.id)}">기기 해제</button>`:""}</td></tr>`).join("")}
    </tbody></table></div>`:`<div class="empty"><h3>아직 등록한 학생이 없어요</h3><p>학생에게 사이트 주소를 알려 주면 학생이 직접 투자자로 등록해요.</p></div>`}`;
}

/* ───────── modal framework ───────── */
let modalClose=null;
function openModal(html,{wide=false,onMount}={}){
  closeModal();
  const root=$("#modal-root");
  const prevFocus=document.activeElement;
  root.innerHTML=`<div class="scrim" data-scrim><div class="modal ${wide?"wide":""}" role="dialog" aria-modal="true">${html}</div></div>`;
  const m=$(".modal",root);
  const onKey=e=>{if(e.key==="Escape")closeModal()};
  document.addEventListener("keydown",onKey);
  const scrim=root.firstChild;let down=false;
  scrim.addEventListener("mousedown",e=>{down=e.target===scrim});
  scrim.addEventListener("click",e=>{const d=down;down=false;if(e.target===scrim&&d)closeModal()});
  modalClose=()=>{document.removeEventListener("keydown",onKey);root.innerHTML="";modalClose=null;try{prevFocus&&prevFocus.focus()}catch(e){}};
  if(onMount)onMount(m);
  const f=m.querySelector("[autofocus]")||m.querySelector("input,select,textarea,button:not(.x)");if(f)f.focus();
  return m;
}
function closeModal(){if(modalClose)modalClose()}
function headHtml(title,sub){return `<div class="modal-head"><div><h3>${title}</h3>${sub?`<p>${sub}</p>`:""}</div><button class="x" data-close aria-label="닫기">×</button></div>`}
function confirmBox({title,text,ok="확인",danger=false,typeToConfirm=""}){
  return new Promise(res=>{
    let done=false;const fin=v=>{if(done)return;done=true;closeModal();res(v)};
    const m=openModal(headHtml(esc(title))+`<div class="modal-body"><p style="margin:0;color:var(--muted)">${text}</p>
      ${typeToConfirm?`<div class="field"><label for="cf-type">확인을 위해 <b>${esc(typeToConfirm)}</b>을(를) 입력하세요</label><input id="cf-type" type="text" autocomplete="off"></div>`:""}</div>
      <div class="modal-foot"><button class="btn" data-no>취소</button><button class="btn ${danger?"danger solid":"primary"}" data-yes ${typeToConfirm?"disabled":""}>${esc(ok)}</button></div>`);
    const yes=m.querySelector("[data-yes]");
    if(typeToConfirm){const inp=m.querySelector("#cf-type");inp.addEventListener("input",()=>{yes.disabled=inp.value.trim()!==typeToConfirm})}
    yes.addEventListener("click",()=>fin(true));
    m.querySelector("[data-no]").addEventListener("click",()=>fin(false));
    m.querySelector("[data-close]").addEventListener("click",()=>fin(false));
    const prev=modalClose;modalClose=()=>{prev&&prev();if(!done){done=true;res(false)}};
  });
}

/* ───────── student: register ───────── */
function claimKey(cid,no){return (cid+"__"+no).replace(/[^\w가-힣-]/g,"_").slice(0,200)}
function openRegister(){
  const c=S.cfg;const me=S.me||{};const ms=myState();
  const locked=ms.sum>0;
  const coSel=me.cohortId&&cohortById(me.cohortId)?me.cohortId:(c.cohorts[0]&&c.cohorts[0].id);
  const teamOpts=cid=>`<option value="">소속 팀 없음</option>`+[...S.teams.values()].filter(t=>t.cohortId===cid).sort((a,b)=>a.createdAt-b.createdAt).map(t=>`<option value="${esc(t.id)}" ${me.ownTeamId===t.id?"selected":""}>${esc(t.name)}${t.item?" · "+esc(t.item):""}</option>`).join("");
  const m=openModal(headHtml(S.me?"투자자 정보 수정":"투자자 등록",`등록하면 ${won(c.budget)}의 가상 투자금을 받아요.`)+`
    <form class="modal-body" id="reg-form" novalidate>
      <div class="two"><div class="field"><label for="reg-name">이름</label><input id="reg-name" type="text" maxlength="20" value="${esc(me.name||"")}" required autofocus></div>
      <div class="field"><label for="reg-no">학번</label><input id="reg-no" type="text" maxlength="20" value="${esc(me.studentNo||"")}" inputmode="numeric" required ${locked?"disabled":""}></div></div>
      <div class="field"><label for="reg-co">소속 갤러리 (학년·학과)</label><select id="reg-co" ${locked?"disabled":""}>${c.cohorts.map(co=>`<option value="${esc(co.id)}" ${co.id===coSel?"selected":""}>${esc(cohortLabel(co))}</option>`).join("")}</select></div>
      <div class="field"><label for="reg-team">우리 팀</label><select id="reg-team" ${locked?"disabled":""}>${teamOpts(coSel)}</select><span class="hint">${locked?"이미 투자해서 학번·갤러리·팀은 바꿀 수 없어요. 바꾸려면 모든 투자를 0원으로 조정하세요.":"우리 팀에는 투자할 수 없어요. 학번은 한 기기에서만 등록돼요."}</span></div>
      <div class="err" id="reg-err"></div>
    </form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn accent" id="reg-save">${S.me?"저장":"등록하고 투자금 받기"}</button></div>`);
  m.querySelector("#reg-co").addEventListener("change",e=>{m.querySelector("#reg-team").innerHTML=teamOpts(e.target.value)});
  const save=async()=>{
    const btn=m.querySelector("#reg-save");const err=m.querySelector("#reg-err");err.textContent="";
    const name=m.querySelector("#reg-name").value.trim();
    const no=locked?String(me.studentNo||""):m.querySelector("#reg-no").value.trim();
    const cohortId=locked?me.cohortId:m.querySelector("#reg-co").value;const ownTeamId=locked?(me.ownTeamId||""):m.querySelector("#reg-team").value;
    if(!name){err.textContent="이름을 입력하세요.";return}
    if(!no){err.textContent="학번을 입력하세요.";return}
    if(!cohortById(cohortId)){err.textContent="소속 갤러리를 선택하세요.";return}
    btn.disabled=true;btn.textContent="저장 중…";
    try{
      await enqueue("inv",()=>withRetry(()=>runTransaction(FB.fs,async tx=>{
        const newId=claimKey(cohortId,no);
        const cref=doc(FB.fs,"claims",newId);
        const iref=doc(FB.fs,"investments",S.uid);
        const [cs,is]=[await tx.get(cref),await tx.get(iref)];
        if(cs.exists()&&cs.data().uid!==S.uid)throw new UserError("이미 다른 기기에서 등록된 학번이에요. 기기를 바꿨다면 선생님께 ‘기기 해제’를 요청하세요.");
        const a=is.exists()&&is.data().alloc&&typeof is.data().alloc==="object"?is.data().alloc:{};
        const spent=Object.values(a).reduce((x,v)=>x+(Number(v)||0),0);
        if(spent>0&&(cohortId!==me.cohortId||ownTeamId!==(me.ownTeamId||"")||newId!==me.claimId))throw new UserError("이미 투자한 기록이 있어 학번·갤러리·팀을 바꿀 수 없어요.");
        if(!cs.exists())tx.set(cref,{uid:S.uid,at:Date.now()});
        if(me.claimId&&me.claimId!==newId)tx.delete(doc(FB.fs,"claims",me.claimId));
        tx.set(doc(FB.fs,"roster",S.uid),{name,studentNo:no,cohortId,ownTeamId,claimId:newId,joinedAt:Number(me.joinedAt)||Date.now()});
      })));
      S.cohortSel=cohortId;closeModal();toast(S.me?"정보를 저장했어요":"등록 완료! 이제 투자할 수 있어요");
    }catch(e){err.textContent=errMsg(e);btn.disabled=false;btn.textContent="다시 시도"}
  };
  m.querySelector("#reg-save").addEventListener("click",save);
  m.querySelector("#reg-form").addEventListener("submit",e=>{e.preventDefault();save()});
}
/* ───────── student: invest ───────── */
function openInvest(tid){
  const t=S.teams.get(tid);if(!t)return;
  if(!S.me){openRegister();return}
  const block=investBlock(t);if(block){toast(block,true);return}
  const c=S.cfg;const ms=myState();
  const cur=ms.by.get(tid)||0;
  const max=cur+ms.remaining;
  const m=openModal(headHtml("투자하기",`${esc(cohortLabel(cohortById(t.cohortId)))} 갤러리`)+`
    <div class="modal-body">
      <div class="inv-team"><div class="thumb" style="--h:${hue(t.id)}">${esc((t.item||t.name).slice(0,1))}</div><div style="min-width:0"><b style="display:block;font-family:var(--f-display);font-size:17px">${esc(t.item||t.name)}</b><span class="muted" style="font-size:13px">${esc(t.name)}</span></div></div>
      <div class="inv-wallet"><div><div class="k">이 팀에 투자한 금액</div><div class="v">${won(cur)}</div></div><div><div class="k">투자 가능 금액</div><div class="v" style="color:var(--accent)">${won(max)}</div></div></div>
      <div class="field"><label for="inv-amt">이 팀의 투자 금액 <span class="muted" style="font-weight:400">(${won(c.unit)} 단위)</span></label>
        <div class="stepper"><button class="btn" type="button" data-step="-1" aria-label="${won(c.unit)} 줄이기">−</button><input class="amt-input" id="inv-amt" type="text" inputmode="numeric" value="${cur.toLocaleString("ko-KR")}" aria-describedby="inv-hint"><button class="btn" type="button" data-step="1" aria-label="${won(c.unit)} 늘리기">+</button></div>
        <input class="slider" id="inv-range" type="range" min="0" max="${max}" step="${c.unit}" value="${cur}" aria-label="투자 금액 조절">
        <div class="quick">${[1,5,10].filter(k=>c.unit*k<=max).map(k=>`<button class="btn sm" type="button" data-add="${k}">+${wonShort(c.unit*k)}</button>`).join("")}<button class="btn sm" type="button" data-set="max">최대</button>${cur?`<button class="btn sm" type="button" data-set="0">투자 취소</button>`:""}</div>
        <span class="hint" id="inv-hint">투자 후 남는 잔액: <b class="num" id="inv-left"></b></span></div>
      <div class="err" id="inv-err"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn accent lg" id="inv-go">투자 확정</button></div>`);
  const inp=m.querySelector("#inv-amt"),rng=m.querySelector("#inv-range"),left=m.querySelector("#inv-left"),go=m.querySelector("#inv-go"),err=m.querySelector("#inv-err");
  let val=cur;
  const parse=s=>{const n=parseInt(String(s).replace(/[^\d]/g,""),10);return Number.isFinite(n)?n:0};
  const sync=(from)=>{
    if(from!=="input")inp.value=val.toLocaleString("ko-KR");
    rng.value=val;left.textContent=won(max-val);
    const bad=val%c.unit!==0||val>max||val<0;
    err.textContent=val>max?`투자 가능 금액(${won(max)})을 넘었어요.`:(val%c.unit!==0?`${won(c.unit)} 단위로 입력하세요.`:"");
    go.disabled=bad||val===cur;
    go.textContent=val===0&&cur>0?"투자 취소하기":val>cur?`${won(val-cur)} 추가 투자`:val<cur?`${won(cur-val)} 회수하기`:"투자 확정";
  };
  inp.addEventListener("input",()=>{val=parse(inp.value);sync("input")});
  inp.addEventListener("blur",()=>{sync()});
  rng.addEventListener("input",()=>{val=parseInt(rng.value,10)||0;sync()});
  m.querySelectorAll("[data-step]").forEach(b=>b.addEventListener("click",()=>{val=Math.min(max,Math.max(0,Math.round(val/c.unit)*c.unit+Number(b.dataset.step)*c.unit));sync()}));
  m.querySelectorAll("[data-add]").forEach(b=>b.addEventListener("click",()=>{val=Math.min(max,Math.round(val/c.unit)*c.unit+Number(b.dataset.add)*c.unit);sync()}));
  m.querySelectorAll("[data-set]").forEach(b=>b.addEventListener("click",()=>{val=b.dataset.set==="max"?max-(max%c.unit):0;sync()}));
  sync();
  go.addEventListener("click",async()=>{
    go.disabled=true;const label=go.textContent;go.textContent="처리 중…";err.textContent="";
    try{await commitInvestment(tid,val);closeModal();toast(val===0?"투자를 취소했어요":`${t.name}에 ${won(val)} 투자 완료`)}
    catch(e){err.textContent=errMsg(e);go.disabled=false;go.textContent=label}
  });
  inp.addEventListener("keydown",e=>{if(e.key==="Enter"&&!go.disabled)go.click()});
}
function commitInvestment(teamId,amount){
  return enqueue("inv",()=>withRetry(()=>runTransaction(FB.fs,async tx=>{
    const c=S.cfg;
    if(c.status!=="open")throw new UserError("지금은 펀딩 기간이 아니에요.");
    const me=S.me;if(!me)throw new UserError("먼저 투자자로 등록하세요.");
    const t=S.teams.get(teamId);if(!t)throw new UserError("삭제된 팀이에요.");
    const block=investBlock(t);if(block)throw new UserError(block);
    if(!Number.isInteger(amount)||amount<0||amount%c.unit!==0)throw new UserError(`${won(c.unit)} 단위로 입력하세요.`);
    const ref=doc(FB.fs,"investments",S.uid);
    const snap=await tx.get(ref);
    const cur=snap.exists()?snap.data():null;const alloc={};
    if(cur&&cur.alloc&&typeof cur.alloc==="object"){
      for(const [k,v] of Object.entries(cur.alloc)){
        const tt=S.teams.get(k);
        if(tt&&Number.isInteger(v)&&v>0&&v%c.unit===0&&k!==me.ownTeamId&&(c.scope!=="own"||tt.cohortId===me.cohortId))alloc[k]=v;
      }
    }
    if(amount>0)alloc[teamId]=amount;else delete alloc[teamId];
    const sum=Object.values(alloc).reduce((a,b)=>a+b,0);
    if(sum>c.budget)throw new UserError(`잔액이 부족해요. 남은 금액은 ${won(Math.max(0,c.budget-(sum-amount)))}이에요.`);
    tx.set(ref,{cohortId:me.cohortId,ownTeamId:me.ownTeamId||"",alloc,updatedAt:Date.now()});
  })));
}
/* ───────── deck viewer ───────── */
let pdfLibP=null;
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=()=>rej(new Error("load"));document.head.appendChild(s)})}
function loadPdf(){
  if(!pdfLibP){
    const base="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    pdfLibP=loadScript(base+"pdf.worker.min.js").then(()=>loadScript(base+"pdf.min.js")).then(()=>{
      const lib=window.pdfjsLib;lib.GlobalWorkerOptions.workerSrc=base+"pdf.worker.min.js";return lib;
    }).catch(e=>{pdfLibP=null;throw e});
  }
  return pdfLibP;
}
function openDeck(tid){
  const t=S.teams.get(tid);if(!t)return;
  const co=cohortById(t.cohortId);const di=deckInfo(t);
  const block=investBlock(t);const canInv=!S.isAdmin&&S.me&&!block;
  const foot=`<div class="modal-foot">${di.open?`<a class="btn" href="${esc(di.open)}" target="_blank" rel="noopener noreferrer">새 탭에서 열기 ↗</a>`:""}${canInv?`<button class="btn accent" data-invest-from-deck>이 팀에 투자하기</button>`:""}</div>`;
  let body;
  if(di.kind==="none")body=`<div class="empty"><h3>발표자료가 아직 없어요</h3><p>관리자가 자료를 등록하면 여기서 볼 수 있어요.</p></div>`;
  else if(di.kind==="link")body=`<div class="empty" style="padding:36px 20px"><h3>외부 링크로 등록된 발표자료예요</h3><p style="overflow-wrap:anywhere">${esc(di.open)}</p><a class="btn primary" href="${esc(di.open)}" target="_blank" rel="noopener noreferrer">발표자료 열기 ↗</a></div>`;
  else if(di.kind==="frame")body=`<div class="viewer"><div class="viewer-stage frame"><iframe class="viewer-frame" src="${esc(di.src)}" title="${esc(t.name)} 발표자료" allow="fullscreen" allowfullscreen loading="lazy"></iframe></div><p class="hint muted" style="margin:0">보이지 않으면 자료의 공유 설정을 ‘링크가 있는 모든 사용자 보기 가능’으로 바꿔 주세요.</p></div>`;
  else body=`<div class="viewer"><div class="viewer-stage" id="vw-stage"><div class="spinner"></div></div>
      <div class="viewer-nav"><button class="btn sm" id="vw-prev" aria-label="이전 장">← 이전</button><span class="num muted" id="vw-pg">-</span><button class="btn sm" id="vw-next" aria-label="다음 장">다음 →</button></div></div>`;
  const m=openModal(headHtml(esc(t.item||t.name),`${esc(t.name)} · ${esc(cohortLabel(co))}${t.members?" · "+esc(t.members):""}`)+`<div class="modal-body">${t.summary?`<p style="margin:0" class="muted">${esc(t.summary)}</p>`:""}${body}</div>`+foot,{wide:true});
  const ib=m.querySelector("[data-invest-from-deck]");if(ib)ib.addEventListener("click",()=>{closeModal();openInvest(tid)});
  if(di.kind!=="pdf"&&di.kind!=="imgs")return;
  const stage=m.querySelector("#vw-stage"),pg=m.querySelector("#vw-pg"),prev=m.querySelector("#vw-prev"),next=m.querySelector("#vw-next");
  let pages=[];let i=0;let pdf=null;let token=0;
  const fail=()=>{stage.innerHTML=`<div class="empty" style="border:0;background:none"><h3>미리보기를 열지 못했어요</h3><p>‘새 탭에서 열기’를 눌러 확인하세요. 저장소의 파일 경로나 링크가 맞는지도 확인해 주세요.</p></div>`;pg.textContent="";prev.disabled=next.disabled=true};
  const show=async()=>{
    const my=++token;pg.textContent=`${i+1} / ${pages.length}`;prev.disabled=i===0;next.disabled=i>=pages.length-1;
    const p=pages[i];
    if(p.kind==="img"){const img=new Image();img.alt=`${t.name} 발표자료 ${i+1}장`;img.onerror=()=>{if(my===token)stage.innerHTML=`<p class="muted" style="padding:24px">이미지를 불러오지 못했어요: ${esc(p.src)}</p>`};img.src=p.src;stage.innerHTML="";stage.appendChild(img);return}
    stage.innerHTML=`<div class="spinner"></div>`;
    try{
      const page=await pdf.getPage(p.n);if(my!==token)return;
      const w=Math.max(280,stage.clientWidth||800);const vp0=page.getViewport({scale:1});
      const dpr=Math.min(2,window.devicePixelRatio||1);const vp=page.getViewport({scale:w/vp0.width*dpr});
      const cv=document.createElement("canvas");cv.width=Math.floor(vp.width);cv.height=Math.floor(vp.height);cv.style.width=Math.floor(vp.width/dpr)+"px";
      await page.render({canvasContext:cv.getContext("2d"),viewport:vp}).promise;
      if(my!==token)return;stage.innerHTML="";stage.appendChild(cv);
    }catch(e){if(my===token)stage.innerHTML=`<p class="muted" style="padding:24px">이 장을 그리지 못했어요. ‘새 탭에서 열기’로 확인하세요.</p>`}
  };
  prev.addEventListener("click",()=>{if(i>0){i--;show()}});
  next.addEventListener("click",()=>{if(i<pages.length-1){i++;show()}});
  m.addEventListener("keydown",e=>{if(e.target.matches("input,textarea"))return;if(e.key==="ArrowLeft")prev.click();if(e.key==="ArrowRight")next.click()});
  (async()=>{
    try{
      if(di.kind==="imgs")pages=di.list.map(src=>({kind:"img",src}));
      else{
        const lib=await loadPdf();
        const res=await fetch(di.src);if(!res.ok)throw new Error("http "+res.status);
        pdf=await lib.getDocument({data:await res.arrayBuffer()}).promise;
        for(let n=1;n<=pdf.numPages;n++)pages.push({kind:"pdf",n});
      }
      if(!pages.length)throw new Error("empty");
      show();
    }catch(e){fail()}
  })();
}
/* ───────── admin actions ───────── */
function setCfg(patch){
  return enqueue("cfg",async()=>{
    const next=Object.assign({},S.cfg,patch,{updatedAt:Date.now()});
    await withRetry(()=>S.db.doc("config/main").set(next));
    S.cfg=normCfg(next);schedule();
  });
}
function openSettings(){
  const c=S.cfg;const locked=anyInvested();
  const m=openModal(headHtml("운영 규칙","행사 이름과 투자 규칙이에요. 투자금은 관리자 화면 맨 위에서 입력해요.")+`
    <form class="modal-body" id="set-form" novalidate>
      <div class="field"><label for="st-title">행사 이름</label><input id="st-title" type="text" maxlength="60" value="${esc(c.title)}"></div>
      <div class="field"><span class="lbl">투자 범위</span><div class="seg"><label><input type="radio" name="st-scope" value="own" ${c.scope==="own"?"checked":""} ${locked?"disabled":""}>내 갤러리 팀만</label><label><input type="radio" name="st-scope" value="all" ${c.scope==="all"?"checked":""} ${locked?"disabled":""}>모든 갤러리</label></div>
        <span class="hint">${locked?"투자가 시작되어 투자 범위는 바꿀 수 없어요.":"학생이 등록한 학년·학과 갤러리 안에서만 투자하게 할지 정하세요."}</span></div>
      <label class="switch" for="st-live"><span><b style="display:block;font-size:14px">학생 화면에 실시간 금액 공개</b><span class="hint">끄면 결과 발표 때까지 금액과 순위가 숨겨져요. 관리자는 항상 볼 수 있어요.</span></span><input id="st-live" type="checkbox" ${c.showLive?"checked":""}></label>
      <div class="err" id="st-err"></div>
    </form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn primary" id="st-save">저장</button></div>`);
  const save=async()=>{
    const err=m.querySelector("#st-err");err.textContent="";
    const title=m.querySelector("#st-title").value.trim()||DEFAULT_CFG.title;
    const patch={title,showLive:m.querySelector("#st-live").checked};
    if(!locked)patch.scope=(m.querySelector("input[name=st-scope]:checked")||{}).value==="all"?"all":"own";
    if(!locked&&anyInvested()){err.textContent="방금 투자가 시작됐어요. 창을 닫고 다시 열어 주세요.";return}
    const b=m.querySelector("#st-save");b.disabled=true;
    try{await setCfg(patch);closeModal();toast("설정을 저장했어요")}catch(e){err.textContent=errMsg(e);b.disabled=false}
  };
  m.querySelector("#st-save").addEventListener("click",save);
  m.querySelector("#set-form").addEventListener("submit",e=>{e.preventDefault();save()});
}
function openCohort(id){
  const co=id?cohortById(id):null;
  const grades=["1학년","2학년","3학년","4학년"];
  const m=openModal(headHtml(co?"갤러리 이름 수정":"갤러리 만들기","펀딩 대상 학년과 학과를 정하세요.")+`
    <form class="modal-body" id="co-form" novalidate><div class="two">
      <div class="field"><label for="co-grade">학년</label><select id="co-grade">${grades.map(g=>`<option ${co&&co.grade===g?"selected":""}>${g}</option>`).join("")}${co&&!grades.includes(co.grade)?`<option selected>${esc(co.grade)}</option>`:""}</select></div>
      <div class="field"><label for="co-dept">학과(반)</label><input id="co-dept" type="text" maxlength="30" placeholder="예: 경영과, 3반" value="${esc(co?co.dept:"")}" list="co-depts" autofocus><datalist id="co-depts">${[...new Set(S.cfg.cohorts.map(c=>c.dept))].map(d=>`<option value="${esc(d)}">`).join("")}</datalist></div>
    </div><div class="err" id="co-err"></div></form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn primary" id="co-save">${co?"저장":"만들기"}</button></div>`);
  const save=async()=>{
    const err=m.querySelector("#co-err");const grade=m.querySelector("#co-grade").value;const dept=m.querySelector("#co-dept").value.trim();
    if(!dept){err.textContent="학과(반)를 입력하세요.";return}
    if(S.cfg.cohorts.some(c=>c.id!==id&&c.grade===grade&&c.dept===dept)){err.textContent="같은 이름의 갤러리가 이미 있어요.";return}
    const b=m.querySelector("#co-save");b.disabled=true;
    try{
      const cohorts=S.cfg.cohorts.map(c=>Object.assign({},c));
      if(co){const x=cohorts.find(c=>c.id===id);x.grade=grade;x.dept=dept}else cohorts.push({id:rid("c"),grade,dept});
      await setCfg({cohorts});closeModal();toast(co?"갤러리 이름을 바꿨어요":`${grade} ${dept} 갤러리를 만들었어요`);
    }catch(e){err.textContent=errMsg(e);b.disabled=false}
  };
  m.querySelector("#co-save").addEventListener("click",save);
  m.querySelector("#co-form").addEventListener("submit",e=>{e.preventDefault();save()});
}
async function deleteCohort(id){
  const co=cohortById(id);if(!co)return;
  const n=[...S.teams.values()].filter(t=>t.cohortId===id).length;
  if(n){toast(`팀이 ${n}개 있어요. 팀을 먼저 삭제하세요.`,true);return}
  if(!await confirmBox({title:"갤러리 삭제",text:`${esc(cohortLabel(co))} 갤러리를 삭제할까요?`,ok:"삭제",danger:true}))return;
  try{await setCfg({cohorts:S.cfg.cohorts.filter(c=>c.id!==id)});toast("갤러리를 삭제했어요")}catch(e){toast(errMsg(e),true)}
}
const OK_TYPES=["application/pdf","image/png","image/jpeg","image/webp","image/gif"];
function openTeam(teamId,cohortId){
  const t=teamId?S.teams.get(teamId):null;
  const c=S.cfg;const cid=t?t.cohortId:cohortId;
  const m=openModal(headHtml(t?"팀 정보 수정":"팀 등록","모둠 정보와 IR 발표자료 주소를 등록하세요.")+`
    <form class="modal-body" id="tm-form" novalidate>
      <div class="field"><label for="tm-co">갤러리</label><select id="tm-co">${c.cohorts.map(co=>`<option value="${esc(co.id)}" ${co.id===cid?"selected":""}>${esc(cohortLabel(co))}</option>`).join("")}</select></div>
      <div class="two"><div class="field"><label for="tm-name">팀(모둠) 이름</label><input id="tm-name" type="text" maxlength="30" value="${esc(t?t.name:"")}" placeholder="예: 3모둠, 팀 그린웨이브" autofocus></div>
      <div class="field"><label for="tm-item">창업 아이템명</label><input id="tm-item" type="text" maxlength="40" value="${esc(t?t.item:"")}" placeholder="예: 급식 잔반 줄이기 앱"></div></div>
      <div class="field"><label for="tm-sum">한 줄 소개</label><textarea id="tm-sum" maxlength="160" placeholder="투자자에게 보여줄 핵심 가치 제안">${esc(t?t.summary:"")}</textarea></div>
      <div class="field"><label for="tm-mem">팀원</label><input id="tm-mem" type="text" maxlength="100" value="${esc(t?t.members:"")}" placeholder="예: 김민준, 이서연, 박지호"></div>
      <div class="field"><label for="tm-deck">발표자료 주소</label><textarea id="tm-deck" rows="3" placeholder="decks/3모둠.pdf&#10;또는 https://docs.google.com/presentation/d/…">${esc(t?t.deck:"")}</textarea>
        <span class="hint">이렇게 넣을 수 있어요 · 저장소 decks 폴더에 올린 파일: <b>decks/파일이름.pdf</b> · 구글 슬라이드·구글 드라이브·캔바 공유 링크 · 슬라이드 이미지 여러 장은 한 줄에 하나씩</span>
        <span class="hint" id="tm-kind"></span></div>
      <div class="err" id="tm-err"></div>
    </form>
    <div class="modal-foot">${t?`<button class="btn danger" id="tm-del" style="margin-right:auto">팀 삭제</button>`:""}<button class="btn" data-close>취소</button><button class="btn primary" id="tm-save">${t?"저장":"등록"}</button></div>`);
  const err=m.querySelector("#tm-err");const deckEl=m.querySelector("#tm-deck");const kindEl=m.querySelector("#tm-kind");
  const showKind=()=>{
    const raw=deckEl.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    const bad=raw.filter(x=>!safeDeckUrl(x));
    if(bad.length){kindEl.innerHTML=`<span style="color:var(--danger)">쓸 수 없는 주소: ${esc(bad[0])}</span>`;return}
    const di=deckInfo({deck:raw.join("\n")});
    kindEl.textContent=di.kind==="none"?"":`인식된 형식: ${di.label}${di.kind==="link"?" (앱 안에서 미리보기 없이 링크로 열려요)":""}`;
  };
  deckEl.addEventListener("input",showKind);showKind();
  const save=async()=>{
    err.textContent="";
    const name=m.querySelector("#tm-name").value.trim();const item=m.querySelector("#tm-item").value.trim();
    const cohort=m.querySelector("#tm-co").value;
    if(!name){err.textContent="팀 이름을 입력하세요.";return}
    if(!cohortById(cohort)){err.textContent="갤러리를 선택하세요.";return}
    if(t&&cohort!==t.cohortId&&anyInvested()){err.textContent="투자가 시작된 뒤에는 팀의 갤러리를 옮길 수 없어요.";return}
    const raw=deckEl.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(raw.some(x=>!safeDeckUrl(x))){err.textContent="발표자료 주소는 https:// 링크 또는 decks/파일이름 형식으로 입력하세요.";return}
    const b=m.querySelector("#tm-save");b.disabled=true;b.textContent="저장 중…";
    try{
      const id=t?t.id:rid("t");
      const d={cohortId:cohort,name,item,summary:m.querySelector("#tm-sum").value.trim(),members:m.querySelector("#tm-mem").value.trim(),deck:deckLines(raw.join("\n")).join("\n"),createdAt:t?t.createdAt:Date.now(),updatedAt:Date.now()};
      await enqueue("team-"+id,()=>withRetry(()=>S.db.doc("teams/"+id).set(d)));
      closeModal();toast(t?"팀 정보를 저장했어요":`${name} 팀을 등록했어요`);
    }catch(e){err.textContent=errMsg(e);b.disabled=false;b.textContent=t?"저장":"등록"}
  };
  m.querySelector("#tm-save").addEventListener("click",save);
  m.querySelector("#tm-form").addEventListener("submit",e=>{e.preventDefault();save()});
  const del=m.querySelector("#tm-del");
  if(del)del.addEventListener("click",async()=>{
    const {agg}=aggregate(S.inv);const a=agg.get(t.id);
    const ok=await confirmBox({title:"팀 삭제",text:`<b>${esc(t.name)}</b> 팀을 삭제할까요?${a&&a.total?` 이 팀이 받은 ${won(a.total)}은 학생들 잔액으로 돌아가요.`:""}`,ok:"삭제",danger:true});
    if(!ok)return;
    try{await withRetry(()=>S.db.doc("teams/"+t.id).delete());toast("팀을 삭제했어요")}catch(e){toast(errMsg(e),true)}
  });
}
async function freezeResults(){
  const q=await withRetry(()=>S.db.collection("investments").get());
  const m=new Map();q.docs.forEach(d=>{if(d.exists)m.set(d.id,d.data())});
  const st=aggregate(m);
  const teams={};for(const [k,v] of st.agg)teams[k]={total:v.total,investors:v.investors};
  await withRetry(()=>S.db.doc("results/final").set({frozenAt:Date.now(),teams,totalFunded:st.totalFunded,investors:st.investors,flagged:st.flagged.length,budget:S.cfg.budget,unit:S.cfg.unit}));
}
async function statusAction(act){
  try{
    if(act==="status-open"){
      if(!await confirmBox({title:"펀딩 시작",text:`학생들이 지금부터 투자할 수 있어요. 1인당 ${won(S.cfg.budget)}, ${won(S.cfg.unit)} 단위로 투자해요.`,ok:"펀딩 시작"}))return;
      await setCfg({status:"open"});toast("펀딩을 시작했어요");
    }else if(act==="status-reopen"){
      if(!await confirmBox({title:"펀딩 다시 열기",text:"확정 결과를 지우고 학생들이 다시 투자할 수 있게 해요.",ok:"다시 열기"}))return;
      await setCfg({status:"open"});await withRetry(()=>S.db.doc("results/final").delete());toast("펀딩을 다시 열었어요");
    }else if(act==="status-close"){
      if(!await confirmBox({title:"펀딩 마감",text:"모든 학생의 투자가 잠기고 현재 금액으로 결과가 확정돼요.",ok:"마감하고 결과 확정"}))return;
      const done=busy("마감 중… 마지막 투자까지 모으고 있어요");
      try{await setCfg({status:"closed",closedAt:Date.now()});await sleep(2000);await freezeResults();await publishSummary()}finally{done()}
      toast("마감했어요. 결과가 확정됐어요");
    }else if(act==="reveal"){
      if(!await confirmBox({title:"결과 발표",text:"모든 학생 화면에 순위와 1위 팀이 공개돼요.",ok:"1위 공개"}))return;
      if(!S.final){const done=busy("결과 확정 중…");try{await freezeResults()}finally{done()}}
      await setCfg({status:"revealed",revealedAt:Date.now()});
      checkCeremony();
    }else if(act==="status-unreveal"){
      await setCfg({status:"closed"});toast("발표를 취소했어요. 학생 화면에서 결과가 다시 숨겨져요");
    }
  }catch(e){toast(errMsg(e),true)}
}
async function resetAll(){
  const ok=await confirmBox({title:"투자 기록 초기화",text:"모든 학생의 투자 기록과 확정 결과를 지워요. 등록한 학생 명단은 남아요. 되돌릴 수 없어요.",ok:"모두 지우기",danger:true,typeToConfirm:"초기화"});
  if(!ok)return;
  const done=busy("투자 기록을 지우는 중…");
  try{
    await setCfg({status:"setup",closedAt:0,revealedAt:0});
    const q=await withRetry(()=>S.db.collection("investments").get());
    const ids=q.docs.map(d=>d.id);
    for(let i=0;i<ids.length;i+=400){
      const b=writeBatch(FB.fs);ids.slice(i,i+400).forEach(id=>b.delete(doc(FB.fs,"investments",id)));
      await withRetry(()=>b.commit());
    }
    await withRetry(()=>S.db.doc("results/final").delete());
    toast(`투자 기록 ${ids.length}건을 지웠어요`);
  }catch(e){toast(errMsg(e),true)}finally{done()}
}
async function releaseDevice(uid){
  const r=S.roster.get(uid)||{};
  const ok=await confirmBox({title:"기기 해제",text:`<b>${esc(r.name||"이 학생")}</b>(${esc(r.studentNo||"-")})의 등록을 풀어요. 이 학생의 투자 기록도 함께 지워지고, 새 기기에서 같은 학번으로 다시 등록할 수 있어요.`,ok:"기기 해제",danger:true});
  if(!ok)return;
  try{
    const b=writeBatch(FB.fs);
    if(r.claimId)b.delete(doc(FB.fs,"claims",r.claimId));
    b.delete(doc(FB.fs,"roster",uid));b.delete(doc(FB.fs,"investments",uid));
    await withRetry(()=>b.commit());toast("기기를 해제했어요");
  }catch(e){toast(errMsg(e),true)}
}
async function saveCsv(){
  const st=standings();const rows=[["갤러리","순위","팀","아이템","팀원","펀딩 금액","투자자 수"]];
  for(const co of S.cfg.cohorts)for(const t of rankList(co.id,st.agg))rows.push([cohortLabel(co),t.total>0?t.rank:"-",t.name,t.item,t.members,t.total,t.investors]);
  rows.push([]);rows.push(["투자자","학번","갤러리","우리 팀","투자 금액","투자 내역"]);
  const ids=new Set([...S.roster.keys(),...S.inv.keys()]);
  for(const id of ids){const r=S.roster.get(id)||{};const d=S.inv.get(id);const e=d?evalDoc(d):{ok:true,sum:0,entries:[]};
    rows.push([r.name||"(미등록)",r.studentNo||"",cohortLabel(cohortById(r.cohortId||(d&&d.cohortId))),(S.teams.get(r.ownTeamId||(d&&d.ownTeamId))||{}).name||"",e.ok?e.sum:"무효("+e.reason+")",e.entries.map(([k,v])=>(S.teams.get(k)||{}).name+":"+v).join(" / ")])}
  const csv="﻿"+rows.map(r=>r.map(v=>{v=String(v==null?"":v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const a=document.createElement("a");a.href=url;a.download=`IR펀딩_결과_${new Date().toISOString().slice(0,10)}.csv`;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
/* ───────── ceremony ───────── */
function checkCeremony(){
  const c=S.cfg;
  if(c.status!=="revealed"||!c.revealedAt)return;
  const key="ir-reveal-seen-"+c.revealedAt;
  if(S.ceremonyFor===c.revealedAt||lsGet(key))return;
  S.ceremonyFor=c.revealedAt;
  const tryShow=()=>{
    if(!(S.loaded.teams&&S.loaded.inv)){setTimeout(tryShow,300);return}
    if(S.cfg.status!=="revealed")return;
    lsSet(key,"1");showCeremony(true);
  };
  setTimeout(tryShow,600);
}
function showCeremony(countdown){
  const st=standings();const overall=winnersOf(rankList("all",st.agg));
  const per=S.cfg.cohorts.map(co=>({co,w:winnersOf(rankList(co.id,st.agg))})).filter(x=>x.w.length);
  const root=$("#overlay-root");
  const el=document.createElement("div");el.className="ceremony";el.setAttribute("role","dialog");el.setAttribute("aria-label","결과 발표");
  root.appendChild(el);
  const close=()=>{el.remove();stopConfetti();document.removeEventListener("keydown",onKey)};
  const onKey=e=>{if(e.key==="Escape")close()};document.addEventListener("keydown",onKey);
  const final=()=>{
    if(!overall.length){el.innerHTML=`<div class="lab">RESULT</div><h2>투자 기록이 없어요</h2><div class="close"><button class="btn">닫기</button></div>`}
    else el.innerHTML=`<div class="lab">${esc(S.cfg.title)} · 최다 펀딩 1위${overall.length>1?" (공동)":""}</div>
      <h2>${esc(overall.map(t=>t.item||t.name).join(" · "))}</h2>
      <div class="tn">${esc(overall.map(t=>t.name+" · "+cohortLabel(cohortById(t.cohortId))).join(" / "))}</div>
      <div class="wa">${won(overall[0].total)}</div>
      ${per.length>1?`<div class="others">${per.map(({co,w})=>`<div><small>${esc(cohortLabel(co))} 1위</small><b>${esc(w.map(t=>t.item||t.name).join(" · "))}</b><span class="num">${won(w[0].total)}</span></div>`).join("")}</div>`:""}
      <div class="close"><button class="btn">닫기</button></div>`;
    el.querySelector(".close .btn").addEventListener("click",close);el.querySelector(".close .btn").focus();
    if(overall.length)confetti();
  };
  const reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!countdown||reduce){final();return}
  let n=3;
  const tick=()=>{if(!el.isConnected)return;if(n===0){final();return}el.innerHTML=`<div class="lab">AND THE TOP-FUNDED TEAM IS</div><div class="count" aria-live="polite">${n}</div>`;n--;setTimeout(tick,1000)};
  tick();
}
let confettiRaf=null;
function stopConfetti(){if(confettiRaf)cancelAnimationFrame(confettiRaf);confettiRaf=null;$("#confetti").hidden=true}
function confetti(){
  if(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  const cv=$("#confetti");cv.hidden=false;const ctx=cv.getContext("2d");
  const dpr=Math.min(2,window.devicePixelRatio||1);const W=cv.clientWidth,H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.scale(dpr,dpr);
  const cs=getComputedStyle(document.documentElement);
  const cols=["--gold","--gold-2","--accent","--accent-2","--paper"].map(v=>cs.getPropertyValue(v).trim()).filter(Boolean);
  const ps=Array.from({length:160},()=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*14-4,r:Math.random()*6+4,c:cols[Math.random()*cols.length|0],a:Math.random()*6,va:(Math.random()-.5)*.3}));
  const t0=performance.now();
  const step=t=>{
    ctx.clearRect(0,0,W,H);
    for(const p of ps){p.vy+=.32;p.vx*=.992;p.x+=p.vx;p.y+=p.vy;p.a+=p.va;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.a);ctx.fillStyle=p.c;ctx.fillRect(-p.r/2,-p.r/4,p.r,p.r/2);ctx.restore()}
    if(t-t0<4500)confettiRaf=requestAnimationFrame(step);else stopConfetti();
  };
  confettiRaf=requestAnimationFrame(step);
}

/* ───────── events ───────── */
document.addEventListener("click",e=>{
  const goEl=e.target.closest("[data-go]");if(goEl){e.preventDefault();go(goEl.dataset.go);return}
  const cl=e.target.closest("[data-close]");if(cl){closeModal();return}
  const a=e.target.closest("[data-act]");if(!a||a.disabled)return;
  const id=a.dataset.id;
  switch(a.dataset.act){
    case "cohort":S.cohortSel=id;S.lastHtml="";schedule();break;
    case "rank":S.rankSel=id;S.lastHtml="";schedule();break;
    case "stage":S.stageSel=id;S.lastHtml="";schedule();break;
    case "atab":S.adminTab=id;S.lastHtml="";schedule();break;
    case "register":openRegister();break;
    case "invest":openInvest(id);break;
    case "deck":openDeck(id);break;
    case "settings":openSettings();break;
    case "cohort-add":openCohort(null);break;
    case "cohort-edit":openCohort(id);break;
    case "cohort-del":deleteCohort(id);break;
    case "team-add":openTeam(null,id);break;
    case "team-edit":openTeam(id);break;
    case "status-open":case "status-close":case "status-reopen":case "reveal":case "status-unreveal":statusAction(a.dataset.act);break;
    case "reset":resetAll();break;
    case "bg-preset":S.bgDraft={budget:Number(id).toLocaleString("ko-KR"),unit:S.bgDraft.unit};render();break;
    case "bg-cancel":S.bgDraft={};render();break;
    case "bg-save":saveBudget();break;
    case "admin-login":adminLogin();break;
    case "admin-logout":adminLogout();break;
    case "release":releaseDevice(id);break;
    case "reload":location.reload();break;
    case "csv":saveCsv();break;
    case "ceremony":showCeremony(false);break;
  }
});
document.addEventListener("input",e=>{
  if(e.target.id==="roster-q"){
    S.rosterQ=e.target.value;S.lastHtml="";render();
  }else if(e.target.id==="bg-budget"||e.target.id==="bg-unit"){
    S.bgDraft[e.target.id==="bg-budget"?"budget":"unit"]=e.target.value;render();
  }
});
document.addEventListener("keydown",e=>{
  if((e.target.id==="bg-budget"||e.target.id==="bg-unit")&&e.key==="Enter"){e.preventDefault();saveBudget()}
});
document.addEventListener("focusout",e=>{
  if(e.target.id==="bg-budget"||e.target.id==="bg-unit"){
    const k=e.target.id==="bg-budget"?"budget":"unit";const v=S.bgDraft[k];
    if(v!=null&&parseAmt(v)>0){S.bgDraft[k]=parseAmt(v).toLocaleString("ko-KR");e.target.value=S.bgDraft[k];S.lastHtml=""}
  }
});

boot();
})();
