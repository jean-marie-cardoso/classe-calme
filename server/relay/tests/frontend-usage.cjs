const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../../public/relay.js'), 'utf8');
const turns = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
function setup() {
 let now=0,nextTimer=0,mic=false,stops=0,revision=0;
 const timers=new Map(),elements=new Map(),sent=[];
 class El extends EventTarget {
  constructor(){super();this.hidden=false;this.checked=true;this.disabled=false;this.value='55';this.dataset={};this.textContent='';this.classList={toggle(){}};}
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
  static OPEN=1;readyState=0;holdNoise=false;
  constructor(url){super();this.id=new URL(url).searchParams.get('deviceId');ctx.socket=this;timer(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));room={type:'remote',v:1,revision:0,serverNow:Date.now(),display:displayState,tools:structuredClone(toolsState),devices:[{deviceId:this.id,label:'Mac'}],controller:{deviceId:this.id,label:'Mac'},microphone:null,noise:{level:0,alarm:false},linkActivities:true,viewers:0,activities:[]};this.emit();},0);}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  emit(patch={}){room={...room,...patch,revision:++revision,serverNow:base+now};this.message(room);}
  send(raw){const c=JSON.parse(raw);sent.push({...c,at:now});if(c.type==='ping')return;
   if(c.action==='microphone')room.microphone=c.enabled?{deviceId:this.id,label:'Mac'}:null;
   if(c.action==='noise')room.noise=c.noise;
   if(c.action==='tools')room.tools=c.tools;
   if(c.action==='display')room.display=c.display;
   if(c.action==='take-control')room.controller={deviceId:this.id,label:'Mac'};
   if(c.action==='correction')room.correction=c.enabled;
   if(c.action==='link')room.linkActivities=c.enabled;
   if(c.action==='noise'&&this.holdNoise)return;
   queueMicrotask(()=>{this.message({type:'ack',requestId:c.requestId,ok:true});this.emit();});
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
 }
 const base=Date.UTC(2026,9,18,9);
 class ClockDate extends Date {static now(){return base+now;}}
 const window=new EventTarget();
 const ctx={window,document,navigator:{platform:'Mac'},crypto,URL,WebSocket:Socket,AbortController,Event,CustomEvent,Date:ClockDate,performance:{now:()=>now},setTimeout:timer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({status:404}),console};
 window.ClasseCalmeAuth={getGrant:()=> 'test-grant',getChannel:()=> 'test',canAutoConnect:()=>false,connect(){},clearGrant(){}};
 window.ClasseCalmeDisplay={getState:()=>structuredClone(displayState),getFile:()=>null,applyState:async value=>{displayState=structuredClone(value);},getMicrophoneState:()=>mic,setFollowing(){},setRemoteNoise(){},stopMicrophone(){mic=false;stops++;document.dispatchEvent(new CustomEvent('classe-calme:microphone',{detail:{active:false}}));}};
 window.ClasseCalmeTools={getBroadcastState:()=>structuredClone(toolsState),setFollowing(){},closePanel(){},applyBroadcastState(value){toolsState=structuredClone(value);}};
 vm.runInNewContext(source,ctx);
 async function advance(ms){const until=now+ms;while(true){let id=null,first=null;for(const [key,t]of timers)if(t.at<=until&&(!first||t.at<first.at)){id=key;first=t;}if(!first)break;now=first.at;timers.delete(id);first.fn();await turns();}now=until;await turns();}
 const emitNoise=(level,alarm=false)=>document.dispatchEvent(new CustomEvent('classe-calme:noise',{detail:{level,alarm}}));
 async function activate(){mic=true;document.dispatchEvent(new CustomEvent('classe-calme:microphone',{detail:{active:true}}));await turns();}
 return{ctx,sent,advance,activate,emitNoise,document,get room(){return room;},get now(){return now;},get stops(){return stops;},get mic(){return mic;}};
}
const counts=h=>({noise:h.sent.filter(c=>c.action==='noise').length,ping:h.sent.filter(c=>c.type==='ping').length,tools:h.sent.filter(c=>c.action==='tools').length,display:h.sent.filter(c=>c.action==='display').length});
(async()=>{
 const variable=setup();await variable.advance(1000);await variable.activate();variable.sent.length=0;
 for(let i=1;i<=6*3600*4;i++){await variable.advance(250);variable.emitNoise(10+i%70);await turns();}
 const varied=counts(variable);assert.equal(varied.noise,0);assert.equal(varied.ping,1440);assert.equal(varied.tools,0);assert.equal(varied.display,0);
 const constant=setup();await constant.advance(1000);await constant.activate();constant.emitNoise(33);await constant.advance(10000);constant.sent.length=0;
 for(let i=1;i<=6*3600*4;i++){await constant.advance(250);constant.emitNoise(33);await turns();}
 const stable=counts(constant);assert.equal(stable.noise,0);assert.equal(stable.ping,1440);assert.equal(stable.tools,0);
 const changes=setup();await changes.advance(1000);await changes.activate();changes.sent.length=0;changes.ctx.socket.holdNoise=true;
 await changes.advance(100);changes.emitNoise(80,true);await turns();
 await changes.advance(100);changes.emitNoise(10,false);await turns();
 assert.deepEqual(changes.sent.filter(c=>c.action==='noise').map(c=>[c.at,c.noise.alarm]),[[1100,true],[1200,false]]);
 assert.ok(changes.sent.filter(c=>c.action==='noise').every(c=>c.noise.level===0));
 changes.ctx.socket.holdNoise=false;
 for(let i=0;i<25;i++)changes.ctx.socket.emit();await turns();
 assert.equal(changes.sent.filter(c=>c.action==='noise').length,2);
 changes.ctx.socket.emit({controller:{deviceId:'other',label:'PC'}});await turns();
 assert.equal(changes.mic,true);assert.equal(changes.stops,0);
 await changes.advance(100);changes.emitNoise(80,true);await turns();
 assert.equal(changes.sent.filter(c=>c.action==='noise').at(-1).noise.alarm,true);
 const follower=setup();await follower.advance(1000);follower.ctx.socket.emit({controller:{deviceId:'other',label:'PC'},microphone:{deviceId:'other',label:'PC'}});follower.sent.length=0;
 for(let i=0;i<100;i++){follower.emitNoise(50+i%20);follower.ctx.socket.emit();}await turns();assert.equal(follower.sent.filter(c=>c.action==='noise').length,0);
 const dedup=setup();await dedup.advance(1000);dedup.sent.length=0;
 for(let i=0;i<100;i++){dedup.document.dispatchEvent(new Event('classe-calme:state'));dedup.document.dispatchEvent(new Event('classe-calme:display'));}
 await dedup.advance(1000);assert.deepEqual(counts(dedup),{noise:0,ping:0,tools:0,display:0});
 const slow=setup();await slow.advance(1000);await slow.activate();slow.sent.length=0;slow.ctx.socket.holdNoise=true;
 slow.emitNoise(90,true);await turns();const held=slow.sent.find(c=>c.action==='noise');
 await slow.advance(9000);slow.ctx.socket.message({type:'ack',requestId:held.requestId,ok:true});await turns();
 await slow.advance(5999);assert.equal(counts(slow).ping,0);await slow.advance(1);assert.equal(counts(slow).ping,1);
 const retry=setup();await retry.advance(1000);await retry.activate();retry.sent.length=0;retry.ctx.socket.holdNoise=true;retry.emitNoise(90,true);await turns();
 for(let i=0;i<79;i++){await retry.advance(250);retry.emitNoise(20+i%70,true);await turns();}
 assert.equal(counts(retry).noise,1);await retry.advance(250);assert.equal(counts(retry).noise,2);
 console.log(JSON.stringify({virtualHours:6,variable:varied,constant:stable,twoTeachersIdlePings:varied.ping+stable.ping,assertions:'no remote gauge measurements; alarm changes immediate despite pending ACK; repeated snapshots silent; microphone follows its owner independently of controller; mirror without local microphone silent; unchanged tools and display silent'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
