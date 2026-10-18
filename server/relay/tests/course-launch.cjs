const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../../public/relay.js'), 'utf8');
const turns = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
function setup(options={}) {
 let now=0,nextTimer=0,mic=false,stops=0,revision=0;
 const timers=new Map(),elements=new Map(),sent=[];
 class El extends EventTarget {
  constructor(){super();this.hidden=false;this.checked=true;this.disabled=false;this.value='55';this.style={};this.dataset={};this.textContent='';this.classList={toggle(){}};}
  set id(v){this._id=v;elements.set(v,this);}get id(){return this._id;}
  setAttribute(){} append(){} before(){} replaceChildren(){} insertBefore(){} focus(){}querySelector(){return null;}
 }
 class Doc extends EventTarget {
  constructor(){super();this.body=new El();this.visibilityState='visible';this.activeElement=null;}
  createElement(){return new El();}getElementById(id){if(!elements.has(id)){const el=new El();el.id=id;}return elements.get(id);}
 }
 const document=new Doc();document.getElementById('activitySummary').hidden=true;
 let toolsState={message:'MOINS DE BRUIT, MERCI.',notice:null,timer:null,preferences:{threshold:55,delay:3,mode:'cover',pulse:true}};
 let displayState={documents:[],activeId:null};
 let room=null;
 const timer=(fn,ms)=>{const id=++nextTimer;timers.set(id,{at:now+ms,fn});return id;};
 class Socket extends EventTarget {
  static OPEN=1;readyState=0;holdNoise=false;holdTools=false;
  constructor(url){super();this.id=new URL(url).searchParams.get('deviceId');ctx.socket=this;timer(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));room={type:'remote',v:1,revision:0,serverNow:Date.now(),display:displayState,tools:structuredClone(toolsState),devices:[{deviceId:this.id,label:'Mac'}],controller:{deviceId:options.follower?'someone-else':this.id,label:'Mac'},microphone:null,noise:{level:0,alarm:false},linkActivities:true,targetActivity:null,viewers:0,totalViewers:0,activities:[]};this.emit();},0);}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  emit(patch={}){room={...room,...patch,revision:++revision,serverNow:base+now};this.message(room);}
  send(raw){const c=JSON.parse(raw);sent.push({...c,at:now});if(c.type==='ping')return;
   if(c.action==='microphone')room.microphone=c.enabled?{deviceId:this.id,label:'Mac'}:null;
   if(c.action==='noise')room.noise=c.noise;
   if(c.action==='tools')room.tools=c.tools;
   if(c.action==='display')room.display=c.display;
   if(c.action==='take-control')room.controller={deviceId:this.id,label:'Mac'};
   if(c.action==='activity'&&c.activity!==room.targetActivity){room.targetActivity=c.activity;room.correction=false;room.tools={...room.tools,notice:null,timer:null};}
   if(c.action==='correction')room.correction=c.enabled;
   if(c.action==='link')room.linkActivities=c.enabled;
   if(c.action==='noise'&&this.holdNoise)return;
   if(c.action==='tools'&&this.holdTools)return;
   queueMicrotask(()=>{this.message({type:'ack',requestId:c.requestId,ok:true});this.emit();});
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
 }
 const base=Date.UTC(2026,9,18,9);
 class ClockDate extends Date {static now(){return base+now;}}
 const window=new EventTarget();window.location={href:options.url || "https://jean-marie-cardoso.github.io/classe-calme/"};
 const ctx={window,document,navigator:{platform:'Mac'},crypto,URL,WebSocket:Socket,AbortController,Event,CustomEvent,Date:ClockDate,performance:{now:()=>now},setTimeout:timer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({status:404}),console};
 window.ClasseCalmeActivities=[{id:'projets/5',title:'Maison',correction:false},{id:'exposes/3',title:'Exposé',correction:false},{id:'3/01',title:'3e · S01'},{id:'5/07',title:'5e · S07'},{id:'5/08',title:'5e · S08'}];
 window.ClasseCalmeAuth={getGrant:()=> options.loggedOut ? null : 'test-grant',getChannel:()=> 'test',canAutoConnect:()=>false,connect(){},clearGrant(){}};
 window.ClasseCalmeDisplay={openActivity(id,title,session){ctx.opened=(ctx.opened||[]).concat({id,title,session});return true;},getState:()=>structuredClone(displayState),getFile:()=>null,applyState:async value=>{displayState=structuredClone(value);},getMicrophoneState:()=>mic,setFollowing(){},setRemoteNoise(){},stopMicrophone(){mic=false;stops++;document.dispatchEvent(new CustomEvent('classe-calme:microphone',{detail:{active:false}}));}};
 window.ClasseCalmeTools={getBroadcastState:()=>structuredClone(toolsState),setFollowing(){},closePanel(){},applyBroadcastState(value){toolsState=structuredClone(value);}};
 vm.runInNewContext(source,ctx);
 async function advance(ms){const until=now+ms;while(true){let id=null,first=null;for(const [key,t]of timers)if(t.at<=until&&(!first||t.at<first.at)){id=key;first=t;}if(!first)break;now=first.at;timers.delete(id);first.fn();await turns();}now=until;await turns();}
 const emitNoise=(level,alarm=false)=>document.dispatchEvent(new CustomEvent('classe-calme:noise',{detail:{level,alarm}}));
 async function activate(){mic=true;document.dispatchEvent(new CustomEvent('classe-calme:microphone',{detail:{active:true}}));await turns();}
 return{ctx,sent,advance,activate,emitNoise,document,get room(){return room;},get now(){return now;},get stops(){return stops;},get mic(){return mic;}};
}
const counts=h=>({noise:h.sent.filter(c=>c.action==='noise').length,ping:h.sent.filter(c=>c.type==='ping').length,tools:h.sent.filter(c=>c.action==='tools').length,display:h.sent.filter(c=>c.action==='display').length});

(async()=>{
 for (const id of ['projets/5','exposes/3','5/07']) {
   const h=setup({url:'https://jean-marie-cardoso.github.io/classe-calme/?activity='+encodeURIComponent(id)+'&seance=3'});
   await h.advance(1000);await h.advance(1000);
   assert.equal(h.room.targetActivity,id);
   assert.equal(h.ctx.opened.length,1);assert.equal(h.ctx.opened[0].session,3);
   await h.advance(30000);assert.equal(h.ctx.opened.length,1,'no repeated launch');
   if(id!=='5/07')assert.equal(h.document.getElementById('toggleCorrection').disabled,true);
 }
 for (const options of [{loggedOut:true},{follower:true}]) {
  const h=setup({...options,url:'https://jean-marie-cardoso.github.io/classe-calme/?activity=projets%2F5'});
  await h.advance(1000);assert.equal(h.sent.some(c=>c.action==='activity'),false);assert.equal(h.ctx.opened,undefined);
 }
 const bad=setup({url:'https://jean-marie-cardoso.github.io/classe-calme/?activity=https://evil.example'});await bad.advance(1000);
 assert.equal(bad.ctx.opened,undefined);assert.equal(bad.room.targetActivity,null);
 console.log('PASS course launch, session, auth, follower, invalid target, single open, guides without correction');
})().catch(error=>{console.error(error);process.exitCode=1;});
