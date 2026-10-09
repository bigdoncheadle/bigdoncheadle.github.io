/* Payline — real-time pay tracker. All data stays in localStorage. */
'use strict';
const $ = id => document.getElementById(id);
const LS_KEY = 'payline.v1';

const DEFAULTS = { wage:'', regHrs:8, otMult:1.5, weekOt:40, dtAfter:12, dtMult:2.0, weekStart:0, pdDefault:0, otMode:'both' };

let S;
try { S = JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch(e){ S = null; }
if (!S || !S.settings) S = { settings:{...DEFAULTS}, shifts:[], live:null };
S.settings = {...DEFAULTS, ...S.settings};
// v1.1: work week now defaults to Sunday–Saturday; migrate installs still on the old Monday default
if (!S.settings._migratedSun){
  if (S.settings.weekStart === 1) S.settings.weekStart = 0;
  S.settings._migratedSun = true;
}
S.shifts = S.shifts || [];
S.backfill = S.backfill || {}; // dateKey -> hours worked, entered via "Catch up this week"
const save = () => localStorage.setItem(LS_KEY, JSON.stringify(S));
const st = () => S.settings;

/* ---------- helpers ---------- */
const pad2 = n => String(n).padStart(2,'0');
const money = n => '$' + (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
const hrs2 = s => ((Number(s)||0)/3600).toFixed(2);
function hms(totalSec){
  totalSec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(totalSec/3600), m = Math.floor(totalSec%3600/60), s = totalSec%60;
  return h + ':' + pad2(m) + ':' + pad2(s);
}
function dayKey(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function parseDay(key){ const [y,m,dd]=key.split('-').map(Number); return new Date(y, m-1, dd); }
function weekStartOf(d){
  const ws = st().weekStart, x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let diff = (x.getDay() - ws + 7) % 7;
  x.setDate(x.getDate() - diff); return x;
}
function fmtDay(key){
  const d = parseDay(key), t = new Date(), y = new Date(); y.setDate(t.getDate()-1);
  if (key === dayKey(t)) return 'Today';
  if (key === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'});
}
function fmtTime(ts){ return new Date(ts).toLocaleTimeString('en-US',{hour:'numeric', minute:'2-digit'}); }

/* ---------- pay engine ---------- */
function allocate(shiftSec, priorRegSec, priorOtSec, weekRegSec, s, wage){
  shiftSec = Math.max(0, shiftSec);
  const mode = s.otMode || 'both'; // 'both' | 'daily' | 'weekly'
  let reg, ot, dt;
  if (mode === 'weekly'){
    reg = shiftSec; ot = 0; dt = 0; // no daily tiers: everything is regular until the weekly threshold
  } else {
    const regCap = Math.max(0, s.regHrs) * 3600;
    const dtOn = s.dtAfter > s.regHrs && s.dtAfter > 0;
    const otDayCap = dtOn ? Math.max(0, (s.dtAfter - s.regHrs)) * 3600 : Infinity;
    reg = Math.min(shiftSec, Math.max(0, regCap - priorRegSec));
    let rem = shiftSec - reg;
    ot = Math.min(rem, Math.max(0, otDayCap - priorOtSec));
    rem -= ot;
    dt = rem;
  }
  if (mode !== 'daily' && s.weekOt > 0){ // weekly OT converts regular hours past the weekly threshold
    const weekAvail = Math.max(0, s.weekOt * 3600 - weekRegSec);
    if (reg > weekAvail){ const move = reg - weekAvail; reg -= move; ot += move; }
  }
  const earn = (reg*wage + ot*wage*s.otMult + dt*wage*s.dtMult) / 3600;
  return { reg, ot, dt, earn }; // seconds in, dollars out
}
function marginalTier(priorRegSec, priorOtSec, weekRegSec, s){
  const mode = s.otMode || 'both';
  if (mode === 'weekly'){
    if (s.weekOt > 0 && weekRegSec >= s.weekOt * 3600) return 'ot';
    return 'reg';
  }
  const regCap = Math.max(0, s.regHrs) * 3600;
  const dtOn = s.dtAfter > s.regHrs && s.dtAfter > 0;
  const otDayCap = dtOn ? Math.max(0, (s.dtAfter - s.regHrs)) * 3600 : Infinity;
  if (priorRegSec < regCap){
    if (s.weekOt > 0 && weekRegSec >= s.weekOt * 3600) return 'ot';
    return 'reg';
  }
  return priorOtSec < otDayCap ? 'ot' : 'dt';
}
const tierMult = (t, s) => t==='ot' ? s.otMult : t==='dt' ? s.dtMult : 1;
const TIER_LABEL = { reg:'Regular', ot:'Overtime', dt:'Double time' };

/* ---------- aggregations ---------- */
function shiftsOn(dateKey){ return S.shifts.filter(x => x.date === dateKey); }
function shiftEarn(x){
  const om = x.otMult ?? st().otMult, dm = x.dtMult ?? st().dtMult;
  return (x.regSec*x.wage + x.otSec*x.wage*om + x.dtSec*x.wage*dm) / 3600 + (x.pd||0);
}
function dayAgg(dateKey, includeLive){
  const a = { reg:0, ot:0, dt:0, sec:0, earn:0, pd:0 };
  for (const x of shiftsOn(dateKey)){
    a.reg+=x.regSec; a.ot+=x.otSec; a.dt+=x.dtSec; a.sec+=x.sec;
    a.earn += shiftEarn(x);
    a.pd += (x.pd||0);
  }
  if (includeLive && S.live){
    const lv = liveAlloc();
    if (lv && dayKey(new Date(S.live.startTs)) === dateKey){
      a.reg+=lv.reg; a.ot+=lv.ot; a.dt+=lv.dt; a.sec+=lv.sec;
      a.earn += lv.earn + (S.live.pdOn ? S.live.pdAmt : 0);
      a.pd += (S.live.pdOn ? S.live.pdAmt : 0);
    }
  }
  return a;
}
function rangeAgg(startKey, endKey, includeLive){
  const a = { reg:0, ot:0, dt:0, sec:0, earn:0, pd:0 };
  for (const x of S.shifts){
    if (x.date < startKey || x.date > endKey) continue;
    a.reg+=x.regSec; a.ot+=x.otSec; a.dt+=x.dtSec; a.sec+=x.sec;
    a.earn += shiftEarn(x); a.pd += (x.pd||0);
  }
  if (includeLive && S.live){
    const lv = liveAlloc(), ldk = dayKey(new Date(S.live.startTs));
    if (lv && ldk >= startKey && ldk <= endKey){
      a.reg+=lv.reg; a.ot+=lv.ot; a.dt+=lv.dt; a.sec+=lv.sec;
      a.earn += lv.earn + (S.live.pdOn ? S.live.pdAmt : 0);
      a.pd += (S.live.pdOn ? S.live.pdAmt : 0);
    }
  }
  return a;
}
function weekKeys(refDate){
  const start = weekStartOf(refDate), keys = [];
  for (let i=0;i<7;i++){ const d = new Date(start); d.setDate(start.getDate()+i); keys.push(dayKey(d)); }
  return keys;
}
function weekAgg(refDate, includeLive){
  const a = { reg:0, ot:0, dt:0, sec:0, earn:0, pd:0 };
  for (const k of weekKeys(refDate)){
    const d = dayAgg(k, includeLive && k === dayKey(new Date()));
    a.reg+=d.reg; a.ot+=d.ot; a.dt+=d.dt; a.sec+=d.sec; a.earn+=d.earn; a.pd+=d.pd;
  }
  return a;
}
function liveElapsedMs(){
  const L = S.live; if (!L) return 0;
  return L.accMs + (L.paused ? 0 : Date.now() - L.startTs);
}
function liveAlloc(){
  const L = S.live; if (!L) return null;
  const s = st(), wage = Number(L.wage)||0;
  const sec = liveElapsedMs()/1000;
  const dk = dayKey(new Date(L.startTs));
  const prior = dayAgg(dk, false);
  const wk = weekAgg(new Date(L.startTs), false);
  const r = allocate(sec, prior.reg, prior.ot, wk.reg, s, wage);
  const tier = marginalTier(prior.reg + r.reg, prior.ot + r.ot, wk.reg + r.reg, s);
  return {...r, sec, tier, wage};
}

/* ---------- backfill: hours from earlier days this week ----------
   Backfilled hours are materialized as shifts (flagged) so every total,
   overtime calc and projection picks them up. Tiers are recomputed in
   chronological order so weekly-OT allocation stays correct. */
function recomputeBackfill(){
  S.shifts = S.shifts.filter(x => !x.backfill);
  const dates = Object.keys(S.backfill).filter(k => (S.backfill[k]||0) > 0).sort();
  if (!dates.length){ save(); return; }
  const s = st(), wage = Number(s.wage)||0;
  const nonBack = S.shifts.slice(); // snapshot: S.shifts grows below as backfill is materialized
  for (const dk of dates){
    const sec = S.backfill[dk]*3600;
    const prior = dayAgg(dk, false);
    const wkStart = dayKey(weekStartOf(parseDay(dk)));
    let weekReg = 0;
    for (const x of nonBack){
      if (x.date <= dk && dayKey(weekStartOf(parseDay(x.date))) === wkStart) weekReg += x.regSec;
    }
    for (const d2 of dates){
      if (d2 >= dk) break;
      const b = S.shifts.find(x => x.backfill && x.date === d2);
      if (b && dayKey(weekStartOf(parseDay(d2))) === wkStart) weekReg += b.regSec;
    }
    const r = allocate(sec, prior.reg, prior.ot, weekReg, s, wage);
    S.shifts.push({ id:'b'+dk, date:dk, startTs:0, endTs:0, sec,
      regSec:r.reg, otSec:r.ot, dtSec:r.dt, wage, otMult:s.otMult, dtMult:s.dtMult,
      pd:0, manual:true, backfill:true });
  }
  save();
}
function renderBackfill(){
  const card = $('backfillCard'); if (!card) return;
  const now = new Date(), ws = weekStartOf(now), todayK = dayKey(now), rows = [];
  for (let i=0;i<7;i++){
    const d = new Date(ws); d.setDate(ws.getDate()+i);
    if (dayKey(d) > todayK) break;
    rows.push(d);
  }
  if (!rows.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('backfillRows').innerHTML = rows.map(d => {
    const k = dayKey(d), v = S.backfill[k] || '';
    const isToday = k === todayK;
    const name = isToday ? 'Today' : d.toLocaleDateString('en-US',{weekday:'long'});
    const sub = isToday ? 'already worked' : (d.getMonth()+1) + '/' + d.getDate();
    return `<div class="bf-row"><span>${name} <span class="muted small">${sub}</span></span><input type="number" inputmode="decimal" min="0" step="0.25" data-bf="${k}" value="${v}" placeholder="0"></div>`;
  }).join('');
  $('backfillRows').querySelectorAll('[data-bf]').forEach(inp => inp.addEventListener('change', e => {
    const k = e.target.dataset.bf, h = Math.min(24, Math.max(0, Number(e.target.value)||0));
    if (h > 0) S.backfill[k] = h; else delete S.backfill[k];
    recomputeBackfill(); renderAll();
  }));
}

/* ---------- clock tab ---------- */
function renderClock(){
  const s = st(), now = new Date();
  $('todayLabel').textContent = now.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});

  const L = S.live, lv = liveAlloc();
  const wage = Number(s.wage)||0;

  if (lv){
    $('earnBig').textContent = money(lv.earn + (L.pdOn ? L.pdAmt : 0));
    $('elapsedBig').textContent = hms(lv.sec);
    const badge = $('tierBadge');
    badge.textContent = TIER_LABEL[lv.tier];
    badge.className = 'tier-badge ' + lv.tier;
    $('rateNow').textContent = money(wage * tierMult(lv.tier, s)) + '/hr';
  } else {
    $('earnBig').textContent = money(0);
    $('elapsedBig').textContent = hms(0);
    const badge = $('tierBadge');
    badge.textContent = 'Ready'; badge.className = 'tier-badge reg';
    $('rateNow').textContent = wage ? money(wage)+'/hr' : '—';
  }
  $('btnStart').classList.toggle('hidden', !!L);
  $('btnPause').classList.toggle('hidden', !L);
  $('btnStop').classList.toggle('hidden', !L);
  $('elapsedBig').classList.toggle('editable', !!L);
  if (L) $('btnPause').textContent = L.paused ? 'Resume' : 'Pause';

  // today
  const t = dayAgg(dayKey(now), true);
  $('todayHours').textContent = hrs2(t.sec);
  $('todayEarn').textContent = money(t.earn);
  $('todayPD').textContent = money(t.pd);
  renderSplit($('todayBars'), t.reg, t.ot, t.dt, true);

  // week
  const w = weekAgg(now, true);
  $('weekHours').textContent = hrs2(w.sec);
  $('weekEarn').textContent = money(w.earn);
  const ws = weekStartOf(now), we = new Date(ws); we.setDate(ws.getDate()+6);
  $('weekRange').textContent = ws.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + we.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  if (s.weekOt > 0){
    const left = Math.max(0, s.weekOt*3600 - w.reg);
    $('weekOTLabel').textContent = 'To OT';
    $('weekOTLeft').textContent = left > 0 ? hrs2(left) + ' h' : 'in OT';
    $('weekBar').style.width = Math.min(100, w.reg/(s.weekOt*3600)*100) + '%';
  } else {
    $('weekOTLabel').textContent = 'Reg hrs';
    $('weekOTLeft').textContent = hrs2(w.reg) + ' h';
    $('weekBar').style.width = '100%';
  }

  // month & year totals
  const tk = dayKey(now);
  const mo = rangeAgg(dayKey(new Date(now.getFullYear(), now.getMonth(), 1)), tk, true);
  const yr = rangeAgg(now.getFullYear() + '-01-01', tk, true);
  $('monthLabel').textContent = now.toLocaleDateString('en-US',{month:'long'});
  $('monthEarn').textContent = money(mo.earn);
  $('monthHours').textContent = hrs2(mo.sec) + ' hours';
  $('yearLabel').textContent = String(now.getFullYear());
  $('yearEarn').textContent = money(yr.earn);
  $('yearHours').textContent = hrs2(yr.sec) + ' hours';
}
function renderSplit(el, reg, ot, dt, withLegend){
  const total = reg+ot+dt;
  const pct = v => total>0 ? (v/total*100).toFixed(1)+'%' : '0%';
  el.innerHTML = `<i class="b-reg" style="width:${pct(reg)}"></i><i class="b-ot" style="width:${pct(ot)}"></i><i class="b-dt" style="width:${pct(dt)}"></i>`;
  let leg = el.parentElement.querySelector('.legend');
  if (withLegend){
    if (!leg){ leg = document.createElement('div'); leg.className='legend'; el.after(leg); }
    leg.innerHTML = `<span><b class="k-reg">${hrs2(reg)}h</b> reg</span><span><b class="k-ot">${hrs2(ot)}h</b> OT</span><span><b class="k-dt">${hrs2(dt)}h</b> DT</span>`;
  }
}

/* tap elapsed to correct the shift's time */
$('elapsedBig').onclick = () => {
  if (!S.live) return;
  const sec = Math.floor(liveElapsedMs()/1000);
  $('eeH').value = Math.floor(sec/3600);
  $('eeM').value = Math.floor(sec%3600/60);
  $('elapsedEditor').classList.toggle('hidden');
};
$('eeCancel').onclick = () => $('elapsedEditor').classList.add('hidden');
$('eeSet').onclick = () => {
  const L = S.live; if (!L) return;
  const h = Math.max(0, Math.floor(Number($('eeH').value)||0));
  const m = Math.min(59, Math.max(0, Math.floor(Number($('eeM').value)||0)));
  L.accMs = (h*3600 + m*60)*1000;
  L.startTs = Date.now();
  $('elapsedEditor').classList.add('hidden');
  save(); renderClock();
};

/* shift controls */
$('btnStart').onclick = () => {
  const wage = Number(st().wage)||0;
  if (!wage){ $('wageInput').focus(); $('wageInput').style.outline='2px solid #e0655c'; setTimeout(()=>$('wageInput').style.outline='',1200); return; }
  S.live = { startTs:Date.now(), accMs:0, paused:false, pauseTs:0, wage,
             pdOn:$('livePerDiem').checked, pdAmt:Number($('livePerDiemAmt').value)||0 };
  $('elapsedEditor').classList.add('hidden');
  save(); renderClock();
};
$('btnPause').onclick = () => {
  const L = S.live; if (!L) return;
  if (L.paused){ L.startTs = Date.now(); L.paused = false; }
  else { L.accMs += Date.now() - L.startTs; L.paused = true; L.pauseTs = Date.now(); }
  save(); renderClock();
};
$('btnStop').onclick = () => {
  const L = S.live; if (!L) return;
  const lv = liveAlloc();
  if (!lv || lv.sec < 1){ S.live = null; save(); renderClock(); return; }
  if (!confirm('End shift at ' + hms(lv.sec) + ' — ' + money(lv.earn + (L.pdOn?L.pdAmt:0)) + '?')) return;
  const realStart = L.paused ? L.pauseTs - L.accMs : L.startTs - L.accMs;
  S.shifts.push({ id:'s'+Date.now(), date:dayKey(new Date(realStart)),
    startTs:realStart, endTs:Date.now(),
    sec:Math.floor(lv.sec), regSec:lv.reg, otSec:lv.ot, dtSec:lv.dt,
    wage:Number(L.wage)||0, otMult:st().otMult, dtMult:st().dtMult,
    pd:L.pdOn ? L.pdAmt : 0, manual:false });
  S.live = null; $('livePerDiem').checked = false;
  $('elapsedEditor').classList.add('hidden');
  save(); renderAll();
};

/* ---------- projection ---------- */
function renderProjection(){
  const s = st();
  const hrsDay = Math.max(0, Number($('pjHrsDay').value)||0);
  const days = Math.max(1, Math.floor(Number($('pjDays').value)||1));
  const pdDay = Math.max(0, Number($('pjPD').value)||0);
  const wage = Number($('pjWage').value)||Number(s.wage)||0;
  const includeWeek = $('pjIncludeWeek').checked;
  const spread = $('pjSpreadWeek').checked;

  let wkReg=0, wkOt=0, wkDt=0, dayReg=0, dayOt=0, pdTotal=0, tReg=0, tOt=0, tDt=0;
  const now = new Date();
  if (includeWeek){
    const w = weekAgg(now, true), t = dayAgg(dayKey(now), true);
    wkReg=w.reg; wkOt=w.ot; wkDt=w.dt; dayReg=t.reg; dayOt=t.ot;
  }
  const sim = {...s};
  for (let d=0; d<days; d++){
    if (d>0){ dayReg=0; dayOt=0; }
    if (spread && d>0 && (now.getDay()+d)%7 === s.weekStart){ wkReg=0; wkOt=0; wkDt=0; }
    const r = allocate(hrsDay*3600, dayReg, dayOt, wkReg, sim, wage);
    dayReg+=r.reg; dayOt+=r.ot; wkReg+=r.reg; wkOt+=r.ot; wkDt+=r.dt;
    tReg+=r.reg; tOt+=r.ot; tDt+=r.dt;
    if (hrsDay>0 && pdDay>0) pdTotal += pdDay;
  }
  const earn = (tReg*wage + tOt*wage*s.otMult + tDt*wage*s.dtMult) / 3600;
  const total = earn + pdTotal;
  $('pjTotal').textContent = money(total);
  renderSplit($('pjBars'), tReg, tOt, tDt, false);
  $('pjStats').innerHTML =
    stat('Regular', hrs2(tReg)+' h') + stat('Overtime', hrs2(tOt)+' h') + stat('Double', hrs2(tDt)+' h') +
    stat('Per diem', money(pdTotal)) + stat('Wage base', money(earn)) + stat('Eff. rate', hrs2(tReg+tOt+tDt)>0 ? money(total/((tReg+tOt+tDt)/3600))+'/h' : '—');
  function stat(l,v){ return `<div><span class="muted">${l}</span><strong>${v}</strong></div>`; }
}
['pjHrsDay','pjDays','pjPD','pjWage'].forEach(id => $(id).addEventListener('input', renderProjection));
['pjIncludeWeek','pjSpreadWeek'].forEach(id => $(id).addEventListener('change', renderProjection));

/* ---------- history ---------- */
function renderHistory(){
  const list = $('historyList');
  const byDay = {};
  for (const x of S.shifts){ (byDay[x.date] = byDay[x.date] || []).push(x); }
  const keys = Object.keys(byDay).sort().reverse();
  if (!keys.length){ list.innerHTML = '<div class="card"><p class="muted center">No shifts yet. Start the clock or log a past shift.</p></div>'; return; }
  list.innerHTML = keys.map(k => {
    const rows = byDay[k].sort((a,b)=>(b.startTs||0)-(a.startTs||0)).map(x => {
      const earn = shiftEarn(x);
      const when = x.backfill ? 'Backfilled' : x.manual ? 'Logged manually' : fmtTime(x.startTs)+' – '+fmtTime(x.endTs);
      const pdTag = x.pd ? `<span class="pd-tag">+${money(x.pd)} pd</span>` : '';
      return `<div class="hist-head"><div><strong>${hrs2(x.sec)} h · ${money(earn)}</strong>${pdTag}<div class="muted">${when}</div></div>
        <button class="hist-del" data-del="${x.id}">Delete</button></div>
        <div class="split-bars"><i class="b-reg" style="width:${x.sec?x.regSec/x.sec*100:0}%"></i><i class="b-ot" style="width:${x.sec?x.otSec/x.sec*100:0}%"></i><i class="b-dt" style="width:${x.sec?x.dtSec/x.sec*100:0}%"></i></div>`;
    }).join('');
    return `<div class="card hist"><div class="hist-head"><strong>${fmtDay(k)}</strong></div>${rows}</div>`;
  }).join('');
  list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm('Delete this shift?')) return;
    const x = S.shifts.find(y => y.id === b.dataset.del);
    S.shifts = S.shifts.filter(y => y.id !== b.dataset.del);
    if (x && x.backfill){ delete S.backfill[x.date]; recomputeBackfill(); }
    save(); renderAll();
  });
}
$('btnManual').onclick = () => { $('manualForm').classList.toggle('hidden'); $('mDate').value = dayKey(new Date()); };
$('btnManualSave').onclick = () => {
  const s = st(), hrs = Math.min(24, Math.max(0, Number($('mHrs').value)||0));
  if (!hrs){ $('mHrs').focus(); return; }
  const date = $('mDate').value || dayKey(new Date());
  const wage = Number($('mWage').value)||Number(s.wage)||0;
  const pd = Math.max(0, Number($('mPD').value)||0);
  const sec = hrs*3600, prior = dayAgg(date,false), wk = weekAgg(parseDay(date),false);
  const r = allocate(sec, prior.reg, prior.ot, wk.reg, s, wage);
  S.shifts.push({ id:'s'+Date.now(), date, startTs:0, endTs:0, sec, regSec:r.reg, otSec:r.ot, dtSec:r.dt,
    wage, otMult:s.otMult, dtMult:s.dtMult, pd, manual:true });
  $('mHrs').value=''; $('mWage').value=''; $('mPD').value='';
  $('manualForm').classList.add('hidden');
  save(); renderAll();
};

/* ---------- settings ---------- */
const SET_BIND = [['sWage','wage'],['sRegHrs','regHrs'],['sOtMode','otMode'],['sOtMult','otMult'],['sWeekOt','weekOt'],['sDtAfter','dtAfter'],['sDtMult','dtMult'],['sWeekStart','weekStart'],['sPD','pdDefault']];
function renderSettings(){
  for (const [id,key] of SET_BIND) $(id).value = st()[key];
  if (!$('livePerDiemAmt').value) $('livePerDiemAmt').value = st().pdDefault || '';
  $('wageInput').value = st().wage || '';
}
for (const [id,key] of SET_BIND) $(id).addEventListener('change', e => {
  S.settings[key] = (id === 'sOtMode') ? e.target.value : (Number(e.target.value)||0);
  recomputeBackfill(); save(); renderClock(); renderProjection();
});
$('wageInput').addEventListener('change', e => { S.settings.wage = e.target.value; recomputeBackfill(); save(); renderClock(); renderProjection(); });
$('livePerDiemAmt').addEventListener('change', e => { if (S.live){ S.live.pdAmt = Number(e.target.value)||0; save(); } });
$('livePerDiem').addEventListener('change', e => { if (S.live){ S.live.pdOn = e.target.checked; save(); renderClock(); } });
$('btnWipe').onclick = () => {
  if (!confirm('Erase ALL Payline data on this device? This cannot be undone.')) return;
  localStorage.removeItem(LS_KEY); location.reload();
};

/* ---------- tabs ---------- */
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabbar button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('tab-'+b.dataset.tab).classList.add('active');
  window.scrollTo(0,0);
  if (b.dataset.tab==='project') renderProjection();
  if (b.dataset.tab==='history') renderHistory();
});

/* ---------- boot ---------- */
function renderAll(){ renderClock(); renderBackfill(); renderProjection(); renderHistory(); }
renderSettings(); renderAll();
setInterval(() => { if (S.live) renderClock(); }, 200);

/* PWA: offline support when served over http(s). No-op inside the Android wrapper (file://). */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
