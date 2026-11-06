// League data pull for ESPN league 2097036320. Runs on GitHub's servers (see .github/workflows/pull.yml).
// Writes data/live_espn.json (this season, refreshed every run) and data/history.json (every past season, pulled once).
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
const LID=2097036320;
const HDR={'Accept':'application/json','User-Agent':'Mozilla/5.0 (LeagueSiteBot)'};
let S2=(process.env.ESPN_S2||'').trim().replace(/^["']|["']$/g,'').replace(/^espn_s2=/i,'');
let SW=(process.env.SWID||'').trim().replace(/^["']|["']$/g,'').replace(/^SWID=/i,'');
if(S2&&!/%[0-9A-Fa-f]{2}/.test(S2)&&/[+/=]/.test(S2))S2=encodeURIComponent(S2);
if(SW&&!SW.startsWith('{'))SW='{'+SW+'}';
console.log(`Login check: ESPN_S2 ${S2?`found (${S2.length} characters)`:'MISSING'}, SWID ${SW?(/^\{[0-9A-Fa-f-]{36}\}$/.test(SW)?'found, looks right':`found but unusual format (${SW.length} characters)`):'MISSING'}`);
if(S2&&SW)HDR.Cookie=`espn_s2=${S2}; SWID=${SW}`;
mkdirSync('data',{recursive:true});
const PN={1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'D/ST'};const SL={0:'QB',2:'RB',4:'WR',6:'TE',23:'FLEX',16:'DST',17:'K',20:'BN',21:'IR'};
const TIER={NONE:'N',WINNERS_BRACKET:'W',WINNERS_CONSOLATION_LADDER:'C',LOSERS_CONSOLATION_LADDER:'L'};
const r2=v=>Math.round(v*100)/100;

async function pullSeason(Y,current){
  const old=Y<2018;
  const B=old?`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${LID}`:`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${Y}/segments/0/leagues/${LID}`;
  const get=async(q,h)=>{const url=old?B+(q.startsWith('?')?q+'&':'?')+`seasonId=${Y}`:B+q;const r=await fetch(url,{headers:{...HDR,...(h||{})}});if(!r.ok)throw new Error(`ESPN answered ${r.status} for ${Y} ${q.slice(0,40)}. If this is 401, add the ESPN_S2 and SWID secrets.`);const x=await r.json();return Array.isArray(x)?x[0]:x};
  const j=await get('?view=mTeam&view=mMatchupScore&view=mSettings&view=mStatus&view=mDraftDetail&view=mRoster');
  const mem={};(j.members||[]).forEach(m=>mem[m.id]=((m.firstName||'')+' '+(m.lastName||'')).trim()||m.displayName||'');
  const mgr={};j.teams.forEach(t=>mgr[t.id]=(t.owners||[]).map(o=>mem[o]).filter(Boolean).join(' & ')||((t.location||'')+' '+(t.nickname||'')).trim());
  const ss=j.settings.scheduleSettings||{};const reg=ss.matchupPeriodCount;
  const settings={name:j.settings.name,reg,playoffTeams:ss.playoffTeamCount,playoffLen:ss.playoffMatchupPeriodLength||1,size:j.teams.length};
  const games=[],remaining=[];let week=0;const byWk={};
  for(const g of j.schedule||[]){if(!g.away)continue;const w=g.matchupPeriodId;(byWk[w]=byWk[w]||[]).push(g);}
  Object.keys(byWk).map(Number).sort((a,b)=>a-b).forEach(w=>{const gs=byWk[w];const done=gs.every(g=>g.winner&&g.winner!=='UNDECIDED');if(done&&w===week+1)week=w;
    gs.forEach(g=>{if(g.winner&&g.winner!=='UNDECIDED')games.push([w,g.home.teamId,g.away.teamId,r2(g.home.totalPoints),r2(g.away.totalPoints),TIER[g.playoffTierType]||'N']);else if(w<=reg)remaining.push([w,g.home.teamId,g.away.teamId]);});});
  const played=games.filter(g=>g[0]<=week);
  const teams=j.teams.map(t=>{const tc=t.transactionCounter||{};return [t.id,(t.name||((t.location||'')+' '+(t.nickname||''))).trim(),mgr[t.id],t.rankCalculatedFinal||0,t.playoffSeed,[tc.acquisitions||0,tc.drops||0,tc.trades||0,tc.moveToActive||0,tc.acquisitionBudgetSpent||0]]});
  const out={season:Y,settings,pulled:new Date().toISOString(),week,teams,games:played,remaining};
  // draft board: [overall, round, teamId, player, pos, seasonPts, keeper]
  const picks=(j.draftDetail&&j.draftDetail.picks)||[];const names={},pos={};const pickPts={};
  const ids=[...new Set(picks.map(p=>p.playerId))];
  try{for(let i=0;i<ids.length;i+=40){const k=await get('?view=kona_player_info',{'x-fantasy-filter':JSON.stringify({players:{filterIds:{value:ids.slice(i,i+40)}}})});(k.players||[]).forEach(pp=>{const p=pp.player;names[p.id]=p.fullName;pos[p.id]=PN[p.defaultPositionId]||'?';const st=(p.stats||[]).find(s=>s.id==='00'+Y);pickPts[p.id]=st?r2(st.appliedTotal):0});}}catch(e){console.log(`  ${Y}: no player info (${e.message})`)}
  out.draft=picks.map(p=>[p.overallPickNumber,p.roundId,p.teamId,names[p.playerId]||String(p.playerId),pos[p.playerId]||'',pickPts[p.playerId]||0,p.keeper?1:0]);
  out.pickPts=Object.fromEntries(Object.entries(pickPts).map(([id,v])=>[names[id]||id,v]));
  let PROG={},PRO={};
  if(current){const pt=await (await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${Y}?view=proTeamSchedules_wl`,{headers:HDR})).json();((pt.settings&&pt.settings.proTeams)||[]).forEach(t=>{PRO[t.id]=[t.abbrev,t.byeWeek];PROG[t.id]=t.proGamesByScoringPeriod||{}});
    const seasonPts=p=>{const s=(p.stats||[]).find(s=>s.seasonId===Y&&s.statSourceId===0&&s.statSplitTypeId===0);return s?r2(s.appliedTotal):0};
    const stat=(p,src,split)=>{const s=(p.stats||[]).find(s=>s.seasonId===Y&&s.statSourceId===src&&s.statSplitTypeId===split);return s?r2(s.appliedTotal):0};
    out.roster={};j.teams.forEach(t=>out.roster[t.id]=(t.roster?t.roster.entries:[]).map(e=>{const p=e.playerPoolEntry.player;const pr=PRO[p.proTeamId]||['FA',0];return [p.fullName,PN[p.defaultPositionId]||'?',seasonPts(p),pr[0],pr[1],e.lineupSlotId===21?'IR':e.lineupSlotId===20?'B':'S',stat(p,1,0),(()=>{const s2=(p.stats||[]).filter(s=>s.seasonId===Y&&s.statSourceId===1&&s.statSplitTypeId===1).sort((a,b)=>b.scoringPeriodId-a.scoringPeriodId);return s2.length?r2(s2[0].appliedTotal):0})(),p.injuryStatus||'ACTIVE']}));}
  // box scores, week by week (older seasons may not have them)
  const liveT={},WKP={},optWk={},slot={},weekTop=[],weekBench=[],starter={},proj={},mv={},lu={};
  const optimal=ents=>{const pool=ents.filter(e=>e.sl!=='IR').map(e=>({...e}));const take=(ps,n)=>{let s=0;for(let i=0;i<n;i++){const c=pool.filter(e=>ps.includes(e.pos)&&!e.u).sort((a,b)=>b.pts-a.pts)[0];if(c){c.u=1;s+=c.pts}}return s};
    return take(['QB'],1)+take(['RB'],2)+take(['WR'],3)+take(['TE'],1)+take(['RB','WR','TE'],1)+take(['D/ST'],1)+take(['K'],1)};
  const maxW=Math.max(0,...Object.keys(byWk).map(Number));const lastWk=current?Math.min(week+1,maxW):maxW;
  for(let w=1;w<=lastWk&&!old;w++){let b;try{b=await get(`?view=mBoxscore&view=mMatchupScore&scoringPeriodId=${w}`)}catch(e){console.log(`  ${Y} week ${w}: no box score`);continue}let best=null,bb=null;
    for(const g of b.schedule||[]){if(g.matchupPeriodId!==w)continue;for(const side of [g.home,g.away]){if(!side||!side.rosterForCurrentScoringPeriod)continue;const tid=side.teamId;const ents=[];let pr=0;
      for(const e of side.rosterForCurrentScoringPeriod.entries){const p=e.playerPoolEntry.player;names[p.id]=p.fullName;const st=p.stats||[];const a=st.find(s=>s.scoringPeriodId===w&&s.statSourceId===0);const q=st.find(s=>s.scoringPeriodId===w&&s.statSourceId===1);const pts=a?a.appliedTotal:0;const sl=SL[e.lineupSlotId]||'X';const ps=PN[p.defaultPositionId]||'?';
        const isStart=sl!=='BN'&&sl!=='IR';if(isStart)pr+=q?q.appliedTotal:0;
        if(current&&w===week+1&&isStart){const gm=((PROG[p.proTeamId]||{})[w]||[])[0];const now=Date.now();const state=!gm?'bye':(gm.statsOfficial||now>gm.date+4*36e5)?'done':now>=gm.date?'live':'yet';(liveT[tid]=liveT[tid]||[]).push([p.fullName,ps,sl,r2(pts),r2(q?q.appliedTotal:0),state,gm?gm.date:0]);}
        if(w>week)continue;
        (WKP[w]=WKP[w]||[]).push([tid,p.fullName,ps,sl,r2(pts),r2(q?q.appliedTotal:0)]);ents.push({sl,pos:ps,pts});
        if(w<=reg){slot[tid]=slot[tid]||{};slot[tid][sl]=(slot[tid][sl]||0)+pts}
        if(isStart){starter[tid+'|'+p.id+'|'+w]=pts;if(!best||pts>best[4])best=[w,tid,p.fullName,ps,r2(pts)];const m=(mv[tid]=mv[tid]||{});const x=(m[p.fullName]=m[p.fullName]||[p.fullName,ps,0,0]);x[2]+=pts;x[3]++;}
        else if(sl==='BN'){if(!bb||pts>bb[4])bb=[w,tid,p.fullName,ps,r2(pts)]}}
      (proj[w]=proj[w]||{})[tid]=r2(pr);
      if(w<=week){const act=ents.filter(e=>e.sl!=='BN'&&e.sl!=='IR').reduce((s,e)=>s+e.pts,0),bn=ents.filter(e=>e.sl==='BN').reduce((s,e)=>s+e.pts,0),opt=Math.max(optimal(ents),act);(optWk[w]=optWk[w]||{})[tid]=r2(opt);const L=(lu[tid]=lu[tid]||[0,0,0,0,0]);L[0]+=act;L[1]+=bn;L[2]+=opt;L[3]+=opt-act;if(opt-act<0.01)L[4]++;}}}
    if(w<=week){if(best)weekTop.push(best);if(bb)weekBench.push(bb);}}
  for(const k in slot)for(const s in slot[k])slot[k][s]=r2(slot[k][s]);
  // transactions
  const adds=[],trades=[];const seenT=new Set();
  for(let w=0;w<=lastWk&&!old;w++){let tj;try{tj=await get(`?view=mTransactions2&scoringPeriodId=${w}`)}catch(e){continue}
    for(const t of tj.transactions||[]){if(t.status!=='EXECUTED')continue;
      if(t.type==='WAIVER'||t.type==='FREEAGENT'){for(const it of t.items||[])if(it.type==='ADD')adds.push({w:t.scoringPeriodId,tid:it.toTeamId,pid:it.playerId,bid:t.bidAmount||0})}
      if(/^TRADE/.test(t.type)){for(const it of t.items||[]){if(it.type!=='TRADE')continue;const k=it.playerId+'|'+it.fromTeamId+'|'+it.toTeamId+'|'+t.scoringPeriodId;if(seenT.has(k))continue;seenT.add(k);trades.push({id:t.relatedTransactionId||t.id,w:t.scoringPeriodId,date:new Date(t.processDate||t.proposedDate).toISOString().slice(0,10),pid:it.playerId,from:it.fromTeamId,to:it.toTeamId})}}}}
  const seenA=new Set();const faab={};
  adds.filter(a=>{const k=a.tid+'|'+a.pid+'|'+a.w;if(seenA.has(k))return false;seenA.add(k);return true}).forEach(a=>{let pts=0;for(let w=a.w;w<=18;w++){const v=starter[a.tid+'|'+a.pid+'|'+w];if(v!=null)pts+=v}const f=faab[a.tid]=faab[a.tid]||{adds:0,spent:0,pts:0,best:null};f.adds++;f.spent+=a.bid;f.pts+=pts;if(!f.best||pts>f.best[2])f.best=[names[a.pid]||String(a.pid),a.bid,Math.round(pts*10)/10]});
  for(const k in faab)faab[k].pts=Math.round(faab[k].pts*10)/10;
  const need=[...new Set(trades.map(t=>t.pid))].filter(id=>!names[id]);
  if(need.length){try{const k=await get('?view=kona_player_info',{'x-fantasy-filter':JSON.stringify({players:{filterIds:{value:need}}})});(k.players||[]).forEach(pp=>{names[pp.player.id]=pp.player.fullName;pos[pp.player.id]=PN[pp.player.defaultPositionId]})}catch(e){}}
  const tradeIds=[...new Set(trades.map(t=>t.id))];
  out.trades=trades.map(t=>{let pts=0;for(let w=t.w;w<=18;w++){const v=starter[t.to+'|'+t.pid+'|'+w];if(v!=null)pts+=v}return [Y,tradeIds.indexOf(t.id)+1,t.w,t.date,names[t.pid]||String(t.pid),pos[t.pid]||'',mgr[t.from],mgr[t.to],r2(pts)]});
  out.mvps={};for(const tid in mv)out.mvps[mgr[tid]]=Object.values(mv[tid]).sort((a,b)=>b[2]-a[2]).slice(0,3).map(x=>[x[0],x[1],r2(x[2]),x[3]]);
  out.lineup=Object.entries(lu).map(([tid,L])=>[Y,mgr[tid],r2(L[0]),r2(L[1]),r2(L[2]),r2(L[3]),L[4]]);
  out.box={slot,weekTop,weekBench,faab,proj:proj[week+1]||{}};out.proj=Object.fromEntries(Object.entries(proj).filter(([w])=>+w<=week));out.optWk=optWk;out.players=WKP;
  if(current){const liveW=week+1;out.live=byWk[liveW]&&liveW<=maxW?{week:liveW,updated:new Date().toISOString(),teams:liveT,matchups:byWk[liveW].map(g=>[g.home.teamId,g.away.teamId,TIER[g.playoffTierType]||'N'])}:null;}
  out.previousSeasons=(j.status&&j.status.previousSeasons)||[];
  return out;
}

let failed=false;
try{
  const cur=await pullSeason(2026,true);
  writeFileSync('data/live_espn.json',JSON.stringify(cur));
  console.log(`2026: week ${cur.week}, ${cur.games.length} games, live week ${cur.live&&cur.live.week}`);
  // Past seasons change once a year, so pull them only when history.json is missing (delete it to force a re-pull).
  if(!existsSync('data/history.json')){
    const hist={};
    for(const Y of cur.previousSeasons.sort()){try{const s=await pullSeason(Y,false);hist[Y]=s;console.log(`${Y}: ${s.games.length} games, ${s.draft.length} picks, ${s.trades.length} trade rows`)}catch(e){console.error(`${Y} failed: ${e.message}`)}}
    writeFileSync('data/history.json',JSON.stringify(hist));
  }
}catch(e){failed=true;console.error('ESPN pull failed: '+e.message)}
writeFileSync('data/status.json',JSON.stringify({ran:new Date().toISOString(),ok:!failed}));
if(failed)process.exit(1);
