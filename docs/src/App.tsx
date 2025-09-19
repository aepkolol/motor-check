import React, { useMemo, useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceArea, ReferenceLine } from "recharts";

// ================= Helpers =================
function byId(arr, id){ return (arr||[]).find(a => a.id === id); }
function buildSeries(points){
  if(!points) return [];
  return points
    .filter(p => Number.isFinite(p.current) && Number.isFinite(p.thrust_kg))
    .map(p => ({ x:p.current, y:p.thrust_kg, throttle:p.throttle }))
    .sort((a,b)=> a.x - b.x);
}
function interpolateCurrentForLift(series, liftKgPerMotor){
  if(!series || !series.length) return { ok:false, reason:'no-data' };
  const pts = [...series].sort((a,b)=>a.y-b.y);
  const min = pts[0], max = pts[pts.length-1];

  // Below the first real thrust: extrapolate using the first two points.
  // Prefer a power-law fit (I ≈ a * T^b). If not possible, fall back to linear.
  if(liftKgPerMotor < min.y){
    if(pts.length >= 2){
      const a = pts[0], b = pts[1];
      const dy = (b.y - a.y) || 1e-9;
      // Try power-law on positive pairs
      if(a.y>0 && b.y>0 && a.x>0 && b.x>0){
        const bExp = Math.log(b.x/a.x) / Math.log(b.y/a.y); // exponent b in I=a*T^b
        const aCoef = a.x / Math.pow(a.y, bExp);            // coefficient a
        const currentPL = aCoef * Math.pow(Math.max(liftKgPerMotor, 1e-9), bExp);
        // Throttle: if available, fit throttle ≈ c * T^d; else approximate thr ∝ sqrt(T)
        let thr;
        if((a.throttle??0)>0 && (b.throttle??0)>0){
          const dExp = Math.log((b.throttle||1)/(a.throttle||1)) / Math.log(b.y/a.y);
          const cCoef = (a.throttle||1) / Math.pow(a.y, dExp);
          thr = cCoef * Math.pow(Math.max(liftKgPerMotor, 1e-9), dExp);
        } else {
          // T ~ RPM^2, throttle ~ RPM → throttle ~ sqrt(T)
          const k = (a.throttle ?? 0) / Math.sqrt(a.y || 1e-9);
          thr = k * Math.sqrt(Math.max(liftKgPerMotor, 0));
        }
        return { ok:true, currentA: Math.max(0,currentPL), throttle: Math.max(0,thr), noteLow:true };
      }
      // Fallback: linear in thrust-current and thrust-throttle
      const slopeIx = (b.x - a.x) / dy;           // dI/dT
      const slopeTh = ((b.throttle ?? 0) - (a.throttle ?? 0)) / dy; // dThr/dT
      const current = Math.max(0, a.x + (liftKgPerMotor - a.y) * slopeIx);
      const thr = Math.max(0, (a.throttle ?? 0) + (liftKgPerMotor - a.y) * slopeTh);
      return { ok:true, currentA: current, throttle: thr, noteLow:true };
    }
    // Fallback: single point → scale towards origin
    const scale = Math.max(0, liftKgPerMotor / Math.max(min.y, 1e-9));
    return { ok:true, currentA: min.x * scale, throttle: (min.throttle ?? 0) * scale, noteLow:true };
  }

  if(liftKgPerMotor > max.y){
    return { ok:false, reason:'exceeds-max' };
  }

  for(let i=0;i<pts.length-1;i++){
    const a=pts[i], b=pts[i+1];
    if(liftKgPerMotor >= a.y && liftKgPerMotor <= b.y){
      const t = (liftKgPerMotor - a.y) / ((b.y - a.y) || 1);
      const current = a.x + t*(b.x - a.x);
      const thr = (a.throttle ?? 0) + t*((b.throttle ?? 0) - (a.throttle ?? 0));
      return { ok:true, currentA:current, throttle:thr, noteLow:false };
    }
  }
  return { ok:false, reason:'segment-not-found' };
}
// Converts github.com URLs to raw.githubusercontent.com and fixes refs/heads paths
function normalizeCatalogUrl(u){
  try{
    if(!u) return u;
    const m1 = u.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/raw\/([^\/]+)\/(.+)$/);
    if(m1) return `https://raw.githubusercontent.com/${m1[1]}/${m1[2]}/${m1[3]}/${m1[4]}`;
    const m2 = u.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/);
    if(m2) return `https://raw.githubusercontent.com/${m2[1]}/${m2[2]}/${m2[3]}/${m2[4]}`;
    const m3 = u.match(/^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/refs\/heads\/([^\/]+)\/(.+)$/);
    if(m3) return `https://raw.githubusercontent.com/${m3[1]}/${m3[2]}/${m3[3]}/${m3[4]}`;
    return u;
  }catch{ return u; }
}
// Weight→time curve from a per-motor series
function buildFlightCurve(series, motorCount, capacityAh, usablePct, points = 60){
  if(!series || !series.length) return [];
  const ys = series.map(p=>p.y).filter(n=>Number.isFinite(n));
  const minPerMotorLift = ys.length ? Math.min(...ys) : 0;
  const maxPerMotorLift = ys.length ? Math.max(...ys) : 0;

  // Sample by per‑motor lift so we can place a point exactly at the real boundary
  const startPer = Math.max(0, minPerMotorLift * 0.7);   // extend 30% below
  const endPer   = Math.max(startPer + 0.01, maxPerMotorLift * 0.99);
  const usableAh = capacityAh * (usablePct/100);
  const floorPerMotorA = 0.1; // smaller floor so the orange segment isn't flat

  const out = [];
  for(let i=0;i<points;i++){
    const perMotor = startPer + (endPer - startPer) * (i/(points-1));
    const interp = interpolateCurrentForLift(series, perMotor);
    if(interp && interp.ok){
      const perMotorA = Math.max(interp.currentA || 0, floorPerMotorA);
      const totalCurrent = perMotorA * motorCount;
      const minutes = totalCurrent > 0 ? Math.min((usableAh / totalCurrent) * 60, 120) : 0;
      const isEst = perMotor < minPerMotorLift - 1e-9;
      out.push({ w: perMotor * motorCount, t: minutes, est: isEst });
    }
  }
  // Ensure a point exactly at the boundary so orange and blue/green touch
  if(minPerMotorLift > 0){
    const b = interpolateCurrentForLift(series, minPerMotorLift);
    if(b && b.ok){
      const perMotorA = Math.max(b.currentA || 0, floorPerMotorA);
      const totalCurrent = perMotorA * motorCount;
      const minutes = totalCurrent > 0 ? Math.min((usableAh / totalCurrent) * 60, 120) : 0;
      const boundary = { w: minPerMotorLift * motorCount, t: minutes, est: false };
      // de-dup close weights
      const exists = out.some(p => Math.abs(p.w - boundary.w) < 1e-6);
      if(!exists) out.push(boundary);
    }
  }
  // Sort by weight for clean lines
  out.sort((a,b)=>a.w - b.w);
  return out;
}

// ================= Small UI components =================
function MotorPropPicker({ catalog, motorId, setMotorId, motorSpec, prop, setProp, voltage }){
  const hasSpec = !!motorSpec;
  const props = (motorSpec?.props || []).filter(p => p.data && p.data[voltage] && p.data[voltage].length);
  useEffect(()=>{ if(prop && props.every(p => p.id !== prop)) setProp(undefined); }, [voltage, motorId]);
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm text-gray-600 mb-1">Motor</div>
        <select className="border rounded px-2 py-1 w-full" value={motorId || ''} onChange={e=>setMotorId(e.target.value || undefined)}>
          <option value="">Select a motor…</option>
          {(catalog||[]).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div>
        <div className="text-sm text-gray-600 mb-1">Prop (filtered by voltage {voltage})</div>
        <select className="border rounded px-2 py-1 w-full" value={prop || ''} onChange={e=>setProp(e.target.value || undefined)} disabled={!hasSpec}>
          <option value="">{hasSpec ? 'Select a prop…' : 'Select a motor first'}</option>
          {props.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    </div>
  );
}
function LegendInline({ specA, propA, specB, propB }){
  return (
    <div className="text-sm text-gray-700">
      <span className="inline-flex items-center gap-2 mr-4"><span className="inline-block w-3 h-3 rounded-full bg-blue-600" />{specA ? specA.name : 'Motor A'}{propA ? ` • ${propA.name}` : ''}</span>
      <span className="inline-flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-full bg-green-600" />{specB ? specB.name : 'Motor B'}{propB ? ` • ${propB.name}` : ''}</span>
    </div>
  );
}
function HoverTip({ active, payload, propAName, propBName, mode }){
  if (!active || !payload || !payload.length) return null;
  const row = payload.reduce((acc, p) => ({ ...acc, ...p.payload }), {});
  const a = payload.find(p => p.dataKey === 'A');
  const b = payload.find(p => p.dataKey === 'B');
  const x = row.x;
  const xLabel = mode === 'total' ? 'Total current' : 'Current per motor';
  return (
    <div className="bg-white/95 border rounded-md p-2 text-xs shadow">
      <div className="font-semibold">{xLabel}: {Number(x).toFixed(2)} A</div>
      {a && a.value != null && (<div>A{propAName ? ` • ${propAName}` : ''}: {Number(a.value).toFixed(3)} kg</div>)}
      {b && b.value != null && (<div>B{propBName ? ` • ${propBName}` : ''}: {Number(b.value).toFixed(3)} kg</div>)}
      {row.tA != null && <div>Throttle A: {row.tA}%</div>}
      {row.tB != null && <div>Throttle B: {row.tB}%</div>}
    </div>
  );
}
function HoverCard({ title, hover, timeMin, limitMode }){
  return (
    <div className="border rounded-xl p-3">
      <div className="font-semibold mb-1">{title}</div>
      {hover?.ok ? (
        <div className="text-sm">
          <div>{limitMode==='total'?'Total hover current':'Hover current per motor'}: <b>{hover.currentA.toFixed(2)} A{hover.noteLow ? '*' : ''}</b></div>
          <div>Estimated throttle: <b>{hover.throttle.toFixed(1)}%{hover.noteLow ? '*' : ''}</b></div>
          {limitMode==='perMotor' && <div>Total current (4 motors): <b>{(hover.currentA * 4).toFixed(1)} A{hover.noteLow ? '*' : ''}</b></div>}
          {Number.isFinite(timeMin) ? (
            <div>Estimated flight time: <b>{Number(timeMin).toFixed(1)} min{hover.noteLow ? '*' : ''}</b></div>
          ) : (<div className="text-gray-500">Add battery info to see flight time.</div>)}
        </div>
      ) : (
        <div className="text-sm text-red-600">{hover?.reason === 'exceeds-max' ? 'Required lift exceeds the max in the spec sheet.' : 'No data for this selection.'}</div>
      )}
    </div>
  );
}

// Drone totals display
function TotalsDisplay({ series, motorCount }){
  if(!series || !series.length) return <div className="text-gray-500">Select a motor & prop.</div>;
  const maxPt = series.reduce((m,p)=> (p.y>m.y? p : m), series[0]);
  const maxThrustDrone = maxPt.y * motorCount;
  const peakCurrentTotal = maxPt.x * motorCount;
  return (
    <div>
      <div>Max thrust (drone): <b>{maxThrustDrone.toFixed(2)} kg</b></div>
      <div>Peak current (drone): <b>{peakCurrentTotal.toFixed(1)} A</b></div>
    </div>
  );
}

// ================= Main =================
export default function App(){
  // Catalog state
  const [catalog, setCatalog] = useState([]);
  const [catError, setCatError] = useState(null);
  const [catalogUrl, setCatalogUrl] = useState('./motors/index.json');
  const [tempCatalogUrl, setTempCatalogUrl] = useState('./motors/index.json');

  // Selections
  const [motorAId, setMotorAId] = useState();
  const [motorBId, setMotorBId] = useState();
  const [motorASpec, setMotorASpec] = useState();
  const [motorBSpec, setMotorBSpec] = useState();
  const [propA, setPropA] = useState();
  const [propB, setPropB] = useState();
  const [voltage, setVoltage] = useState('12S');

  // Battery / mode
  const motorCount = 4;
  const [takeoffKg, setTakeoffKg] = useState(10);
  const [capacityAh, setCapacityAh] = useState(20);
  const [usablePct, setUsablePct] = useState(80);
  const [batteryMaxA, setBatteryMaxA] = useState(100);
  const [limitMode, setLimitMode] = useState('perMotor'); // 'perMotor' | 'total'

  // Load catalog
  useEffect(()=>{
    let cancelled=false;
    async function load(){
      try{
        setCatError(null);
        const res = await fetch(normalizeCatalogUrl(catalogUrl), { cache:'no-store' });
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.catalog || []);
        if(!cancelled) setCatalog(list);
      }catch(e){ if(!cancelled) setCatError(String(e)); }
    }
    load();
    return ()=>{cancelled=true};
  }, [catalogUrl]);

  // Load motor specs
  const urlFor = (id)=> (catalog.find(m=>m.id===id)?.url);
  useEffect(()=>{
    let cancelled=false;
    async function loadOne(id, setter){
      if(!id){ setter(undefined); return; }
      const url = urlFor(id);
      if(!url){ setter(undefined); return; }
      try{
        const res = await fetch(url, { cache:'no-store' });
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if(!cancelled) setter(data);
      }catch(_){ if(!cancelled) setter(undefined); }
    }
    loadOne(motorAId, setMotorASpec);
    loadOne(motorBId, setMotorBSpec);
    return ()=>{cancelled=true};
  }, [motorAId, motorBId, catalog]);

  // Series
  const propSpecA = useMemo(()=> motorASpec ? byId(motorASpec.props, propA) : undefined, [motorASpec, propA]);
  const propSpecB = useMemo(()=> motorBSpec ? byId(motorBSpec.props, propB) : undefined, [motorBSpec, propB]);
  const seriesA = useMemo(()=> buildSeries(propSpecA?.data?.[voltage]), [propSpecA, voltage]);
  const seriesB = useMemo(()=> buildSeries(propSpecB?.data?.[voltage]), [propSpecB, voltage]);

  // Mode scaling for X axis
  const modeScale = limitMode === 'total' ? 4 : 1;
  const merged = useMemo(()=>{
    const yScale = limitMode === 'total' ? motorCount : 1;
    const A = seriesA.map(p=>({ x:p.x * modeScale, A:p.y * yScale, tA:p.throttle }));
    const B = seriesB.map(p=>({ x:p.x * modeScale, B:p.y * yScale, tB:p.throttle }));
    return [...A, ...B].sort((a,b)=>(a.x??0)-(b.x??0));
  }, [seriesA, seriesB, modeScale, limitMode]);

  // Limits & shading
  const effectiveMax = useMemo(()=> limitMode==='perMotor' ? (batteryMaxA / motorCount) : batteryMaxA, [batteryMaxA, limitMode]);
  const warnThreshold = useMemo(()=> effectiveMax * 0.8, [effectiveMax]);
  const dataMaxX = useMemo(()=> Math.max(...merged.map(d => d.x || 0), 0), [merged]);
  const chartMaxX = useMemo(()=> Math.max(dataMaxX, (effectiveMax||0) * 1.1, (warnThreshold||0) * 1.1), [dataMaxX, effectiveMax, warnThreshold]);

  // Hover & time (based on per‑motor data)
  const perMotorLiftNeeded = useMemo(()=> takeoffKg / motorCount, [takeoffKg]);
  const hoverA = useMemo(()=> interpolateCurrentForLift(seriesA, perMotorLiftNeeded), [seriesA, perMotorLiftNeeded]);
  const hoverB = useMemo(()=> interpolateCurrentForLift(seriesB, perMotorLiftNeeded), [seriesB, perMotorLiftNeeded]);
  const timeA = useMemo(()=>{
    if(!hoverA?.ok) return null;
    const totalCurrent = hoverA.currentA * motorCount;
    const usableAh = capacityAh * (usablePct/100);
    if(totalCurrent <= 0) return null;
    return Math.min((usableAh / totalCurrent) * 60, 120);
  }, [hoverA, capacityAh, usablePct]);
  const timeB = useMemo(()=>{
    if(!hoverB?.ok) return null;
    const totalCurrent = hoverB.currentA * motorCount;
    const usableAh = capacityAh * (usablePct/100);
    if(totalCurrent <= 0) return null;
    return Math.min((usableAh / totalCurrent) * 60, 120);
  }, [hoverB, capacityAh, usablePct]);

  // Weight → Flight-time curves
  const flightCurveA = useMemo(()=> buildFlightCurve(seriesA, motorCount, capacityAh, usablePct, 40), [seriesA, motorCount, capacityAh, usablePct]);
  const flightCurveB = useMemo(()=> buildFlightCurve(seriesB, motorCount, capacityAh, usablePct, 40), [seriesB, motorCount, capacityAh, usablePct]);
  // Split known/est with a shared boundary point to visually connect the lines
  const splitCurve = (curve)=>{
    if(!curve || !curve.length) return { known:[], est:[] };
    const known = curve.filter(d=>!d.est);
    const est = curve.filter(d=> d.est);
    if(known.length && est.length){
      // First known point is the boundary (sorted in buildFlightCurve)
      const boundary = known[0];
      const lastEst = est[est.length-1];
      if(!lastEst || Math.abs(lastEst.w - boundary.w) > 1e-6){
        est.push({ ...boundary, est:true }); // duplicate boundary into est to stitch lines
      }
    }
    return { known, est };
  };
  const { known: flightCurveA_known, est: flightCurveA_est } = useMemo(()=> splitCurve(flightCurveA), [flightCurveA]);
  const { known: flightCurveB_known, est: flightCurveB_est } = useMemo(()=> splitCurve(flightCurveB), [flightCurveB]);
  const weightMax = useMemo(()=> Math.max(
    ...(flightCurveA.map(d=>d.w)),
    ...(flightCurveB.map(d=>d.w)),
    takeoffKg || 0,
    0
  ), [flightCurveA, flightCurveB, takeoffKg]);
  const timeMax = 120; // hard cap axis at 2 hours to avoid runaway scales

  // ================= Render =================
  return (
    <div className="min-h-screen bg-gray-50 p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Motor Power Curve Compare</h1>
        {catError && <p className="text-red-600 text-sm">Catalog load failed: {catError}</p>}
        <div className="mt-2 flex gap-2 items-center">
          <input type="url" placeholder="https://.../index.json" className="flex-1 border rounded px-2 py-1 text-sm" value={tempCatalogUrl} onChange={e=>setTempCatalogUrl(e.target.value)} />
          <button className="px-3 py-1 rounded bg-gray-800 text-white text-sm" onClick={()=>setCatalogUrl(tempCatalogUrl)}>Load catalog</button>
          <button className="px-3 py-1 rounded bg-gray-200 text-sm" onClick={()=>{setTempCatalogUrl('./motors/index.json'); setCatalogUrl('./motors/index.json');}}>Reset</button>
        </div>
        <p className="text-xs text-gray-500 mt-1">Catalog URL: <code>{normalizeCatalogUrl(catalogUrl)}</code></p>
        <p className="text-xs text-amber-700 mt-1">Tip: Paste a GitHub URL; I’ll auto-convert to raw.</p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left column */}
        <section className="space-y-6 xl:col-span-1">
          {/* Voltage */}
          <div className="p-4 bg-white rounded-2xl shadow-sm space-y-3">
            <h2 className="text-lg font-semibold">Voltage</h2>
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="volt" value="6S" checked={voltage==='6S'} onChange={()=>setVoltage('6S')} /> 6S
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="volt" value="12S" checked={voltage==='12S'} onChange={()=>setVoltage('12S')} /> 12S
              </label>
            </div>
          </div>

          {/* Motor A */}
          <div className="p-4 bg-white rounded-2xl shadow-sm space-y-3">
            <h2 className="text-lg font-semibold">Motor A</h2>
            <MotorPropPicker catalog={catalog} motorId={motorAId} setMotorId={setMotorAId} motorSpec={motorASpec} prop={propA} setProp={setPropA} voltage={voltage} />
          </div>

          {/* Motor B */}
          <div className="p-4 bg-white rounded-2xl shadow-sm space-y-3">
            <h2 className="text-lg font-semibold">Motor B</h2>
            <MotorPropPicker catalog={catalog} motorId={motorBId} setMotorId={setMotorBId} motorSpec={motorBSpec} prop={propB} setProp={setPropB} voltage={voltage} />
          </div>

          {/* Flight-time & Battery */}
          <div className="p-4 bg-white rounded-2xl shadow-sm space-y-3">
            <h2 className="text-lg font-semibold">Flight‑time & Battery</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Takeoff weight (kg)
                <input type="number" step="0.1" className="mt-1 border rounded px-2 py-1 w-full" value={takeoffKg} onChange={e=>setTakeoffKg(Number(e.target.value)||0)} />
              </label>
              <label className="text-sm">Battery capacity (Ah)
                <input type="number" step="0.1" className="mt-1 border rounded px-2 py-1 w-full" value={capacityAh} onChange={e=>setCapacityAh(Number(e.target.value)||0)} />
              </label>
              <label className="text-sm">Usable %
                <input type="number" step="1" className="mt-1 border rounded px-2 py-1 w-full" value={usablePct} onChange={e=>setUsablePct(Number(e.target.value)||0)} />
              </label>
              <label className="text-sm">Motors
                <input type="number" className="mt-1 border rounded px-2 py-1 w-full bg-gray-100" value={motorCount} readOnly />
              </label>
              <label className="text-sm col-span-2">Battery max current (A)
                <input type="number" step="1" className="mt-1 border rounded px-2 py-1 w-full" value={batteryMaxA} onChange={e=>setBatteryMaxA(Number(e.target.value)||0)} />
              </label>
            </div>
            <div className="flex gap-4 mt-2">
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="limit" value="perMotor" checked={limitMode==='perMotor'} onChange={()=>setLimitMode('perMotor')} /> Per motor
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="limit" value="total" checked={limitMode==='total'} onChange={()=>setLimitMode('total')} /> Whole drone
              </label>
            </div>
            <p className="text-xs text-gray-500">Shading shows yellow ≥ 80% and red ≥ 100% of the selected current limit.</p>

            {/* Hover summary */}
            <div className="space-y-3 pt-2">
              <h3 className="text-base font-semibold">Drone Specs</h3>
              <p className="text-sm text-gray-600">Required per‑motor lift: <b>{(takeoffKg / motorCount).toFixed(3)} kg</b></p>
              {/* Totals per motor variant */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-50 rounded p-2">
                  <div className="font-medium">Motor A totals</div>
                  <TotalsDisplay series={seriesA} motorCount={motorCount} />
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="font-medium">Motor B totals</div>
                  <TotalsDisplay series={seriesB} motorCount={motorCount} />
                </div>
              </div>
              <HoverCard title="Motor A (hover)" hover={hoverA} timeMin={timeA} limitMode={limitMode} />
              <HoverCard title="Motor B (hover)" hover={hoverB} timeMin={timeB} limitMode={limitMode} />
              <p className="text-xs text-gray-500">* If shown, spec sheet doesn’t include data that low; displayed at the lowest listed throttle, so actual time would be longer.</p>
            </div>
            <p className="mt-2 text-xs text-amber-700">Orange segments indicate <b>estimated</b> performance below the lowest thrust data in the spec sheet. We extrapolate using a power‑law fit from the first two real points and cap times at 120&nbsp;min. Treat as indicative only.</p>
          </div>
        </section>

        {/* Right column: charts */}
        <section className="xl:col-span-2 space-y-6">
          {/* Power Curves */}
          <div className="p-4 bg-white rounded-2xl shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-semibold">Power Curves</h2>
              <LegendInline
                specA={motorASpec}
                propA={byId(motorASpec?.props, propA)}
                specB={motorBSpec}
                propB={byId(motorBSpec?.props, propB)}
              />
            </div>
            <div className="flex items-center gap-3 mb-2 text-sm">
              <span className="px-2 py-1 rounded bg-gray-100">Mode: {limitMode === 'total' ? 'Whole drone (×4)' : 'Per motor'}</span>
              <span className="px-2 py-1 rounded bg-gray-100">Warn ≥ {Math.round(warnThreshold)} A{limitMode==='total'?' total':' per motor'}</span>
              <span className="px-2 py-1 rounded bg-gray-100">Max = {Math.round(effectiveMax)} A{limitMode==='total'?' total':' per motor'}</span>
            </div>
            <div className="h-[560px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={merged} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  {/* Current limit shading */}
                  {Number.isFinite(effectiveMax) && Number.isFinite(warnThreshold) && (
                    <>
                      <ReferenceArea x1={Math.max(warnThreshold, 0)} x2={Math.min(effectiveMax, chartMaxX)} y1={-Infinity} y2={Infinity} ifOverflow="extendDomain" fill="#facc15" fillOpacity={0.25} strokeOpacity={0} />
                      <ReferenceArea x1={Math.max(effectiveMax, 0)} x2={chartMaxX} y1={-Infinity} y2={Infinity} ifOverflow="extendDomain" fill="#ef4444" fillOpacity={0.25} strokeOpacity={0} />
                    </>
                  )}
                  <XAxis type="number" dataKey="x" name="Current" unit=" A" label={{ value: (limitMode==='total' ? 'Total Current (A)' : 'Current per Motor (A)'), position: 'insideBottom', offset: -5 }} domain={[0, chartMaxX]} />
                  <YAxis type="number" yAxisId="left" dataKey="A" name="Lift" unit=" kg" label={{ value: (limitMode==='total' ? 'Lift (kg) • Total' : 'Lift (kg) • Per motor'), angle: -90, position: "insideLeft" }} domain={["auto","auto"]} />
                  <YAxis type="number" yAxisId="right" orientation="right" dataKey="B" name="Lift" unit=" kg" hide />
                  <Tooltip content={<HoverTip mode={limitMode} propAName={byId(motorASpec?.props, propA)?.name} propBName={byId(motorBSpec?.props, propB)?.name} />} />
                  <Line connectNulls yAxisId="left" type="monotone" dataKey="A" name={(motorASpec?.name||'A') + (byId(motorASpec?.props, propA) ? ` • ${byId(motorASpec?.props, propA)?.name}` : '')} dot={false} strokeWidth={2} stroke="#2563eb" />
                  <Line connectNulls yAxisId="left" type="monotone" dataKey="B" name={(motorBSpec?.name||'B') + (byId(motorBSpec?.props, propB) ? ` • ${byId(motorBSpec?.props, propB)?.name}` : '')} dot={false} strokeWidth={2} stroke="#16a34a" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Flight Time vs Takeoff Weight */}
          <div className="p-4 bg-white rounded-2xl shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-semibold">Flight Time vs Takeoff Weight</h2>
              <div className="text-sm text-gray-600">Battery: {capacityAh} Ah × {usablePct}% usable</div>
            </div>
            <div className="h-[420px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="w" name="Weight" unit=" kg" domain={[0, Math.max(weightMax, takeoffKg||0)]} label={{ value: 'Takeoff Weight (kg)', position: 'insideBottom', offset: -5 }} />
                  <YAxis type="number" name="Time" unit=" min" domain={[0, 120]} label={{ value: 'Flight Time (min)', angle: -90, position: 'insideLeft' }} />
                  <Tooltip formatter={(value, name)=>[Number(value).toFixed(1)+' min', name]} labelFormatter={(label)=>`Weight: ${Number(label).toFixed(2)} kg`} />
                  <ReferenceLine x={takeoffKg} stroke="#334155" strokeDasharray="4 4" label={{ value: `Current weight (${takeoffKg} kg)`, position: 'top' }} />
                  <Line type="monotone" dataKey="t" name={(motorASpec?.name||'A') + ' • time'} data={flightCurveA_known} dot={false} strokeWidth={2} stroke="#2563eb" />
                  <Line type="monotone" dataKey="t" name={(motorASpec?.name||'A') + ' • time (est)'} data={flightCurveA_est} dot={false} strokeWidth={2} stroke="#f59e0b" />
                  <Line type="monotone" dataKey="t" name={(motorBSpec?.name||'B') + ' • time'} data={flightCurveB_known} dot={false} strokeWidth={2} stroke="#16a34a" />
                  <Line type="monotone" dataKey="t" name={(motorBSpec?.name||'B') + ' • time (est)'} data={flightCurveB_est} dot={false} strokeWidth={2} stroke="#f59e0b" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
