/* Laboratório 3 (25/11/2026): vale avisar com score >= 75 SEM gatilho? E varrer a cada 15 min?
   Uso: node scripts/lab3.js ATIVO (um por ativo, ~1 min cada; usa .bt-data-mt5/) e depois node scripts/lab3.js stats */
// Mede no histórico MT5: (A) ENTRADA checando a cada 15 min, (B) a cada 30 min, (C) ordem limite na área quando score>=75 sem gatilho,
// (D) entrada a mercado quando score>=75 sem gatilho. Cada amostra grava resultado de tp1/tp3.
const fs=require('fs');const B=require('path').join(__dirname,'..')+'/';globalThis.localStorage={getItem:()=>null,setItem(){}};
for(const f of ['config','indicators','data','analysis','risk'])require(B+'js/'+f+'.js');
for(const f of ['setups','backtest'])require(B+'js/'+f+'.js');
if(process.argv[2]==='stats'){stats();}else{run();}
function stats(){
const D=B+'.bt-data-mt5/';let all=[];for(const f of fs.readdirSync(D).filter(f=>/^lab3_.*json/.test(f)))all.push(...JSON.parse(fs.readFileSync(D+f)));
all.sort((a,b)=>a.t-b.t);const CUT=Date.UTC(2025,6,1)/1000,TOP=['XAUUSD','NAS100','US30','EURJPY','EURUSD'];
function stat(f,v,per){const busy={},rs=[],fl={};for(const s of all){if(!f(s)||!s.o[v])continue;if(per==='tr'&&s.t>=CUT||per==='te'&&s.t<CUT)continue;
 const st=v.startsWith("lim")?s.t+(s.fill-s.i-1)*900:s.t; if(v.startsWith("lim")){const q=s.asset+s.fill;if(fl[q])continue;fl[q]=1} if(busy[s.asset]&&st<busy[s.asset])continue;busy[s.asset]=s.o[v].exitT;rs.push(s.o[v].r)}
 const n=rs.length,t=rs.reduce((a,b)=>a+b,0),m=t/n,sd=Math.sqrt(rs.reduce((a,b)=>a+(b-m)**2,0)/n);let e=0,p=0,d=0;for(const r of rs){e+=r;p=Math.max(p,e);d=Math.max(d,p-e)}
 return `n ${String(n).padStart(5)} acerto ${(100*rs.filter(r=>r>0).length/n).toFixed(0)}% média ${m.toFixed(3)} (±${(2*sd/Math.sqrt(n)).toFixed(2)}) tot ${t.toFixed(0)} dd ${d.toFixed(0)}`}
const L=(nm,f,vs)=>{for(const v of vs){console.log('\n'+nm,v);for(const p of['tr','te'])console.log('  12 ativos',p,stat(f,v,p));for(const p of['tr','te'])console.log('   5 ativos',p,stat(s=>f(s)&&TOP.includes(s.asset),v,p))}};
L('A ENTRADA 15min',s=>s.status==='ENTRADA',['tp1','tp3']);
L('B ENTRADA 30min',s=>s.status==='ENTRADA'&&s.half,['tp1','tp3']);
L('A2 ENTRADA só :15/:45',s=>s.status==='ENTRADA'&&!s.half,['tp3']);
L('C LIMITE score>=75 s/gatilho',s=>!s.trig&&s.dist>0.05,['lim_tp1','lim_tp3']);
L('C2 LIMITE score>=85',s=>!s.trig&&s.dist>0.05&&s.score>=85,['lim_tp1','lim_tp3']);
L('D MERCADO score>=75',s=>!s.trig,['mkt_tp1','mkt_tp3']);
L('D2 MERCADO score>=85',s=>!s.trig&&s.score>=85,['mkt_tp1','mkt_tp3']);
L('E gatilho bloqueado score>=75',s=>s.trig&&s.status!=='ENTRADA',['tp1','tp3']);
}
function run(){
const MA=globalThis.MA,name=process.argv[2];
const TF={M15:900,H1:3600,H4:14400,D1:86400},WIN={M15:500,H1:1200,H4:300,D1:400};
const full=JSON.parse(fs.readFileSync(B+'.bt-data-mt5/'+name+'.json'));const a0=MA.DEFAULT_ASSETS.find(a=>a.name===name);
const asset={...a0,spread:Math.max(full.spread||0,a0.spread||0)};const st=structuredClone(MA.DEFAULT_SETTINGS);
const H4=MA.data.resample(full.H1,14400,3600,Infinity),m=full.M15;
const cnt=(c,T,s)=>{let l=0,h=c.length;while(l<h){const k=(l+h)>>1;if(c[k].t+s<=T)l=k+1;else h=k}return l};
const start=Math.max(full.H1[300].t,full.D1[210].t);const i0=Math.max(500,cnt(m,start,0));
const cache={},out=[],lastK={};
for(let i=i0;i<m.length-97;i++){const T=m[i].t+900;const ses=MA.an.sessions(T);if(!ses.good)continue;
 const d={};for(const[k,s]of[['M15',m],['H1',full.H1],['H4',H4],['D1',full.D1]]){const n=k==='M15'?i+1:cnt(s,T,TF[k]);d[k]=s.slice(Math.max(0,n-WIN[k]),n)}
 if(d.H4.length<60||d.D1.length<60)continue;
 const tf={};for(const k of['H1','H4','D1']){const key=k+d[k].at(-1).t;if(!cache[key]){for(const o in cache)if(o.startsWith(k))delete cache[o];cache[key]=MA.an.analyzeTF(d[k],st.indicators)}tf[k]=cache[key]}
 if(tf.D1.bias.dir==='neutro'||tf.D1.bias.dir!==tf.H4.bias.dir)continue; // trava D1/H4 elimina o resto
 tf.M15=MA.an.analyzeTF(d.M15,st.indicators);
 const r=MA.setups.analyzeFromTF(asset,tf,d,st,T);
 for(const c of r.candidates){ if(c.breakdown.alinhamento<30)continue;
  const p=c.plan,s=c.dir==='compra'?1:-1,k=c.name[0]+c.dir[0];
  const rec={t:T,i,asset:name,k,score:c.score,trig:c.triggered,status:c.status,nb:c.blocks.length,rr:p.rrNext,dist:c.area.distAtr,half:T%1800===0,o:{}};
  if(c.triggered){ if(!(c.status==='ENTRADA'||c.score>=75))continue;
   for(const v of['tp1','tp3'])rec.o[v]=MA.backtest.simulate(m,i,{dir:c.dir,entry:p.entry,sl:p.sl,tp1:p.tp1,tp2:p.tp2,tp3:p.tp3,R:p.R},v,asset.spread/p.R);
  } else { if(c.score<75||c.blocks.length)continue;
   // limite: preenche se tocar a entrada nas próximas 16 velas (4h), cancela depois
   let f=-1;for(let j=i+1;j<=i+16;j++){if(s>0?m[j].l<=p.entry:m[j].h>=p.entry){f=j;break}}
   rec.fill=f; if(f>=0)for(const v of['tp1','tp3']){ // vela do preenchimento: se tocar SL conta SL; TP só conta depois
     const sl=s>0?m[f].l<=p.sl:m[f].h>=p.sl;
     const x=sl?{r:-1-asset.spread/p.R,exitT:m[f].t+900}:MA.backtest.simulate(m,f,{dir:c.dir,entry:p.entry,sl:p.sl,tp1:p.tp1,tp2:p.tp2,tp3:p.tp3,R:p.R},v,asset.spread/p.R);
     rec.o['lim_'+v]=x}
   // mercado: preço atual, mesmo SL da área -> R maior; alvo 1R/3R
   const e=m[i].c,R=s*(e-p.sl); if(R>0)for(const[v,q]of[['tp1',1],['tp3',3]])rec.o['mkt_'+v]=MA.backtest.simulate(m,i,{dir:c.dir,entry:e,sl:p.sl,tp1:e+s*R,tp2:e+s*2*R,tp3:e+s*q*R,R},v,asset.spread/R);
  }
  out.push(rec)}}
fs.writeFileSync(B+'.bt-data-mt5/lab3_'+name+'.json',JSON.stringify(out));console.log(name,out.length);
}
