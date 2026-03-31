import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";

/* ═══ Platform Detection ═══ */
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const isMobile = !isTauri && typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// Tauri APIs — loaded only in desktop app, no-op in browser
let getCurrentWindow=()=>({setSize:async()=>{},setPosition:async()=>{},setAlwaysOnTop:async()=>{},startDragging:async()=>{},startResizeDragging:async()=>{},scaleFactor:async()=>1,outerPosition:async()=>({x:0,y:0}),isVisible:async()=>true,show:async()=>{},hide:async()=>{},setFocus:async()=>{}});
let LogicalSize=class{constructor(w,h){this.width=w;this.height=h}};
let LogicalPosition=class{constructor(x,y){this.x=x;this.y=y}};
let autostartEnable=async()=>{},autostartDisable=async()=>{},autostartIsEnabled=async()=>false;
let registerShortcut=async()=>{},unregisterShortcut=async()=>{};

// tauriReady resolves when all Tauri APIs are loaded
let tauriReady=Promise.resolve();
if(isTauri){
  tauriReady=Promise.all([
    import("@tauri-apps/api/dpi").then(m=>{LogicalSize=m.LogicalSize;LogicalPosition=m.LogicalPosition}),
    import("@tauri-apps/api/window").then(m=>{getCurrentWindow=m.getCurrentWindow}),
    import("@tauri-apps/plugin-autostart").then(m=>{autostartEnable=m.enable;autostartDisable=m.disable;autostartIsEnabled=m.isEnabled}).catch(()=>{}),
    import("@tauri-apps/plugin-global-shortcut").then(m=>{registerShortcut=m.register;unregisterShortcut=m.unregister}).catch(()=>{})
  ]);
}

/* ═══ Storage Abstraction ═══ */

const STORE_KEY = "floatask-data";

async function loadLocalStore() {
  try {
    if (window.storage) {
      const r = await window.storage.get(STORE_KEY);
      if (r && r.value) return JSON.parse(r.value);
    }
  } catch (e) {}
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (s) return JSON.parse(s);
  } catch (e) {}
  return null;
}

async function saveLocalStore(data) {
  const json = JSON.stringify(data);
  try { if (window.storage) await window.storage.set(STORE_KEY, json); } catch (e) {}
  try { localStorage.setItem(STORE_KEY, json); } catch (e) {}
}

function makeEmptyStore() {
  return {
    tasks: [],
    archived: [],
    tags: DEFAULT_TAGS,
    statuses: DEFAULT_STATUSES,
    settings: DEFAULT_SETTINGS,
    themeName: "Ocean blue",
  };
}

function mapTaskToRow(task, userId, isArchived) {
  return {
    id: task.id,
    user_id: userId,
    name: task.name,
    status: task.status,
    tags: task.tags || [],
    short_note: task.shortNote || "",
    full_note: task.fullNote || "",
    sort_order: task.order ?? 0,
    created_at: task.createdAt || null,
    started_at: task.startedAt || null,
    completed_at: task.completedAt || null,
    archived_at: isArchived ? task.archivedAt || task.completedAt || today() : null,
    is_archived: isArchived,
  };
}

function mapRowToTask(row) {
  const task = {
    id: row.id,
    name: row.name,
    status: row.status,
    tags: row.tags || [],
    shortNote: row.short_note || "",
    fullNote: row.full_note || "",
    order: row.sort_order ?? 0,
    createdAt: row.created_at || "",
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    updatedAt: row.updated_at || "",
  };
  return row.is_archived ? { ...task, archivedAt: row.archived_at || row.completed_at || "" } : task;
}

function buildCloudStore(taskRows, settingsRow, localData) {
  const tasks = [];
  const archived = [];
  for (const row of taskRows || []) {
    const task = mapRowToTask(row);
    if (row.is_archived) archived.push(task);
    else tasks.push(task);
  }
  return {
    tasks,
    archived,
    tags: settingsRow?.tags || DEFAULT_TAGS,
    statuses: settingsRow?.statuses || DEFAULT_STATUSES,
    settings: { ...DEFAULT_SETTINGS, ...(settingsRow?.settings || {}) },
    themeName: settingsRow?.theme_name || "Ocean blue",
    pinned: localData?.pinned ?? false,
  };
}

function hasStoredTaskData(data) {
  return !!(data && ((data.tasks?.length ?? 0) > 0 || (data.archived?.length ?? 0) > 0));
}

async function loadStore(userId) {
  const localData = await loadLocalStore();
  if (!userId || !supabase) return { data: localData };
  const [{ data: taskRows, error: taskError }, { data: settingsRow, error: settingsError }] = await Promise.all([
    supabase.from("tasks").select("*").eq("user_id", userId).order("sort_order", { ascending: true }),
    supabase.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  if (taskError) throw taskError;
  if (settingsError) throw settingsError;

  const hasCloudData = (taskRows?.length ?? 0) > 0 || !!settingsRow;
  if (!hasCloudData && hasStoredTaskData(localData)) {
    return { data: localData, shouldPromptImport: true, localData };
  }

  const data = hasCloudData ? buildCloudStore(taskRows, settingsRow, localData) : makeEmptyStore();
  await saveLocalStore(data);
  return { data };
}

async function saveStore(data, userId) {
  await saveLocalStore(data);
  if (!userId || !supabase) return;

  const taskRows = [
    ...(data.tasks || []).map(task => mapTaskToRow(task, userId, false)),
    ...(data.archived || []).map(task => mapTaskToRow(task, userId, true)),
  ];
  const settingsRow = {
    user_id: userId,
    theme_name: data.themeName || "Ocean blue",
    settings: data.settings || DEFAULT_SETTINGS,
    statuses: data.statuses || DEFAULT_STATUSES,
    tags: data.tags || DEFAULT_TAGS,
  };

  const { data: remoteRows, error: remoteError } = await supabase.from("tasks").select("id").eq("user_id", userId);
  if (remoteError) throw remoteError;

  const localIds = new Set(taskRows.map(row => row.id));
  const missingIds = (remoteRows || []).map(row => row.id).filter(id => !localIds.has(id));
  if (missingIds.length) {
    const { error } = await supabase.from("tasks").delete().eq("user_id", userId).in("id", missingIds);
    if (error) throw error;
  }
  if (taskRows.length) {
    const { error } = await supabase.from("tasks").upsert(taskRows, { onConflict: "id,user_id" });
    if (error) throw error;
  } else {
    const { error } = await supabase.from("tasks").delete().eq("user_id", userId);
    if (error) throw error;
  }

  const { error: settingsUpsertError } = await supabase.from("user_settings").upsert(settingsRow, { onConflict: "user_id" });
  if (settingsUpsertError) throw settingsUpsertError;
}

/* ═══ Constants ═══ */

const DEFAULT_STATUSES = [
  { id:"ip", name:"in progress", color:"#378ADD", bg:"#E6F1FB", text:"#0C447C", border:"#85B7EB" },
  { id:"ns", name:"not started", color:"#888780", bg:"#F1EFE8", text:"#444441", border:"#B4B2A9" },
  { id:"na", name:"not applicable", color:"#BA7517", bg:"#FAEEDA", text:"#633806", border:"#FAC775" },
  { id:"dn", name:"done", color:"#639922", bg:"#EAF3DE", text:"#27500A", border:"#97C459" },
];
const DEFAULT_TAGS = [
  { name:"Work",color:"#7F77DD" },{ name:"Personal",color:"#1D9E75" },
  { name:"Learning",color:"#378ADD" },{ name:"Side Project",color:"#D85A30" },
];
const THEMES = {
  "Ocean blue":{ panelBg:"#E6F1FB",panelBorder:"#378ADD",divider:"#85B7EB",cardBg:"#FFFFFF",accentLeft:"#378ADD",accentRight:"#7F77DD",headerText:"#0C447C",newTaskBorder:"#85B7EB",textPrimary:"#0C447C",textSecondary:"#444441",inputBg:"#FFFFFF",inputBorder:"#85B7EB",btnBg:"#E6F1FB",btnText:"#0C447C",btnPrimaryBg:"#378ADD",btnPrimaryText:"#FFFFFF",btnDangerBg:"#FCEBEB",btnDangerText:"#A32D2D" },
  "Slate dark":{ panelBg:"#1C1C1E",panelBorder:"#48484A",divider:"#3A3A3C",cardBg:"#2C2C2E",accentLeft:"#64D2FF",accentRight:"#BF5AF2",headerText:"#F2F2F7",newTaskBorder:"#48484A",textPrimary:"#F2F2F7",textSecondary:"#AEAEB2",inputBg:"#3A3A3C",inputBorder:"#636366",btnBg:"#3A3A3C",btnText:"#F2F2F7",btnPrimaryBg:"#64D2FF",btnPrimaryText:"#1C1C1E",btnDangerBg:"#3A1515",btnDangerText:"#FF6B6B" },
  "Coral":{ panelBg:"#FFF0EB",panelBorder:"#D85A30",divider:"#F0997B",cardBg:"#FFFFFF",accentLeft:"#D85A30",accentRight:"#BA7517",headerText:"#712B13",newTaskBorder:"#F0997B",textPrimary:"#712B13",textSecondary:"#8B5E3C",inputBg:"#FFFFFF",inputBorder:"#F0997B",btnBg:"#FFF0EB",btnText:"#712B13",btnPrimaryBg:"#D85A30",btnPrimaryText:"#FFFFFF",btnDangerBg:"#FCEBEB",btnDangerText:"#A32D2D" },
};
const DEFAULT_SETTINGS = { autostart:true, defaultStatus:"ns", collapsedMax:3 };
const genId = () => Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const today = () => new Date().toISOString().slice(0,10);
const fmtDate = d => { if(!d)return""; const p=d.split("-"); return `${p[0].slice(2)}/${p[1]}/${p[2]}`; };
const COLORS = ["#7F77DD","#1D9E75","#378ADD","#D85A30","#D4537E","#BA7517","#639922","#E24B4A","#888780","#64D2FF"];
const getS = (ss,id) => ss.find(s=>s.id===id)||ss[0];
const REPO_URL = "https://github.com/Yikuan-Yan/floatask";
const VER = "1.0.0";
const EXPANDED_WINDOW = { w:400, h:580 };
const COLLAPSED_WINDOW = { w:260, h:160 };

function mainDate(t){ if(t.status==="ip")return t.startedAt||t.createdAt; if(t.status==="dn"||t.status==="na")return t.completedAt||t.createdAt; return t.createdAt; }
function applyStatusDates(t,ns){ const r={...t,status:ns}; if(ns==="ip"&&!r.startedAt)r.startedAt=today(); if((ns==="dn"||ns==="na")&&!r.completedAt)r.completedAt=today(); return r; }
function weekLabel(ds){ if(!ds)return"Unknown"; const d=new Date(ds),day=d.getDay(); const mon=new Date(d); mon.setDate(d.getDate()-((day+6)%7)); const sun=new Date(mon); sun.setDate(mon.getDate()+6); const f=dt=>`${String(dt.getMonth()+1).padStart(2,"0")}/${String(dt.getDate()).padStart(2,"0")}`; return `${f(mon)} - ${f(sun)}`; }

const mk=(n,s,tg,sn,fn,o,c,st,cp)=>({id:String(o+1),name:n,status:s,tags:tg,shortNote:sn,fullNote:fn,order:o,createdAt:c,startedAt:st||"",completedAt:cp||""});
const INITIAL_TASKS=[
  mk("Design landing page","ip",["Work"],"Waiting for feedback","Hero section done. Need to finalize the [color palette](https://coolors.co).\n\n**Remaining:**\n- Footer layout\n- Mobile responsive",0,"2025-03-01","2025-03-02",""),
  mk("ReadERTA paper","ip",["Learning"],"Section 3","Reading through **methodology** section. Key insight: `O(n log n)` complexity.",1,"2025-03-10","2025-03-12",""),
  mk("Grocery list app","ip",["Side Project"],"Auth flow","Firebase auth integrated. Next: add shared lists feature.",2,"2025-03-15","2025-03-16",""),
  mk("Q1 report","ns",["Work"],"","",3,"2025-03-20","",""),
  mk("Learn Rust basics","ns",["Learning"],"","",4,"2025-03-22","",""),
  mk("Fix login bug","dn",["Work"],"","",5,"2025-02-10","2025-02-10","2025-02-12"),
  mk("Setup CI/CD pipeline","dn",["Work"],"","",6,"2025-02-15","2025-02-15","2025-02-20"),
  mk("Blog post draft","dn",["Personal"],"","",7,"2025-02-18","2025-02-18","2025-02-25"),
  mk("Update portfolio","dn",["Personal"],"","",8,"2025-03-01","2025-03-01","2025-03-08"),
  mk("Database migration","na",["Work"],"Cancelled","Switched to new provider instead.",9,"2025-02-20","","2025-03-01"),
];

/* ═══ Simple Markdown Renderer ═══ */

function MdText({ text, color }) {
  if (!text) return null;
  const lines = text.split("\n");
  const els = [];
  let key = 0;
  for (const line of lines) {
    if (line.trim() === "") { els.push(<br key={key++} />); continue; }
    const isLi = /^[-*]\s/.test(line.trim());
    const content = isLi ? line.trim().slice(2) : line;
    const rendered = renderInline(content, color);
    if (isLi) els.push(<div key={key++} style={{ display: "flex", gap: 6, paddingLeft: 4, margin: "1px 0" }}><span style={{ color, opacity: 0.4, userSelect: "none" }}>•</span><span>{rendered}</span></div>);
    else els.push(<div key={key++}>{rendered}</div>);
  }
  return <>{els}</>;
}

function renderInline(text, color) {
  const parts = [];
  let i = 0, key = 0;
  const re = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > i) parts.push(<span key={key++}>{text.slice(i, match.index)}</span>);
    if (match[1]) parts.push(<strong key={key++} style={{ fontWeight: 600 }}>{match[2]}</strong>);
    else if (match[3]) parts.push(<code key={key++} style={{ fontSize: "0.9em", padding: "1px 4px", borderRadius: 3, background: color ? color + "10" : "rgba(0,0,0,0.06)" }}>{match[4]}</code>);
    else if (match[5]) {const url=match[7];parts.push(<a key={key++} href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#378ADD", textDecoration: "underline", cursor: "pointer" }} onClick={e => {e.stopPropagation();e.preventDefault();import("@tauri-apps/plugin-opener").then(m=>m.openUrl(url)).catch(()=>window.open(url,"_blank"))}}>{match[6]}</a>);}
    i = match.index + match[0].length;
  }
  if (i < text.length) parts.push(<span key={key++}>{text.slice(i)}</span>);
  return parts;
}

/* ═══ UI Components ═══ */

function TagPill({name,color,small}){return <span style={{display:"inline-flex",fontSize:small?10:11,lineHeight:1,padding:small?"1px 6px":"2px 8px",borderRadius:99,background:color+"15",color,fontWeight:500,whiteSpace:"nowrap",border:`0.5px solid ${color}25`}}>{name}</span>}
function StatusBadge({status,statuses}){const s=getS(statuses,status);return <span style={{fontSize:10,padding:"1px 7px",borderRadius:99,background:s.bg,color:s.text,fontWeight:500,border:`0.5px solid ${s.border}40`,whiteSpace:"nowrap"}}>{s.name}</span>}
function ChevronIcon({open,size=11}){return <svg width={size} height={size} viewBox="0 0 12 12" style={{transform:open?"rotate(90deg)":"rotate(0deg)",transition:"transform 0.15s ease",flexShrink:0,opacity:0.5}}><path d="M4.5 2.5L8 6L4.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}

function DropSelect({value,options,onChange,multi,placeholder,labelKey="name",valueKey="id",colorKey="color",theme}){
  const[open,setOpen]=useState(false);const trigRef=useRef(null);const dropRef=useRef(null);const[ds,setDs]=useState({});
  useEffect(()=>{if(!open)return;const h=e=>{if(trigRef.current&&!trigRef.current.contains(e.target)&&dropRef.current&&!dropRef.current.contains(e.target))setOpen(false)};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h)},[open]);
  useEffect(()=>{if(!open||!trigRef.current)return;const r=trigRef.current.getBoundingClientRect();const below=window.innerHeight-r.bottom,maxH=180,up=below<maxH&&r.top>below;setDs({position:"fixed",left:r.left,width:r.width,zIndex:10000,maxHeight:Math.min(maxH,up?r.top-8:below-8),...(up?{bottom:window.innerHeight-r.top+2}:{top:r.bottom+2})});},[open]);
  const sel=multi?options.filter(o=>value.includes(o[valueKey])):options.filter(o=>o[valueKey]===value);
  const label=sel.length===0?placeholder:sel.map(o=>o[labelKey]).join(", ");
  return(
    <div style={{position:"relative",flex:1}}>
      <div ref={trigRef} onClick={()=>setOpen(!open)} style={{fontSize:11,padding:"5px 8px",borderRadius:6,border:`1px solid ${theme.inputBorder}`,background:theme.inputBg,color:sel.length?theme.textPrimary:theme.textSecondary,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",minHeight:26,userSelect:"none"}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{flexShrink:0,opacity:0.4,transform:open?"rotate(180deg)":"none"}}><path d="M2.5 3.5L5 6.5L7.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      {open&&<div ref={dropRef} style={{...ds,background:theme.cardBg,border:`1px solid ${theme.inputBorder}`,borderRadius:8,padding:4,overflowY:"auto"}}>
        {options.map(o=>{const active=multi?value.includes(o[valueKey]):value===o[valueKey];return(
          <div key={o[valueKey]} onClick={()=>{if(multi)onChange(active?value.filter(v=>v!==o[valueKey]):[...value,o[valueKey]]);else{onChange(o[valueKey]);setOpen(false)}}}
            style={{fontSize:11,padding:"5px 8px",borderRadius:5,cursor:"pointer",display:"flex",alignItems:"center",gap:6,background:active?(o[colorKey]||theme.accentLeft)+"12":"transparent",color:active?(o[colorKey]||theme.textPrimary):theme.textSecondary}}
            onMouseEnter={e=>{if(!active)e.currentTarget.style.background=theme.inputBg}} onMouseLeave={e=>{e.currentTarget.style.background=active?(o[colorKey]||theme.accentLeft)+"12":"transparent"}}>
            {multi&&<span style={{width:13,height:13,borderRadius:3,border:`1.5px solid ${active?o[colorKey]:theme.inputBorder}`,background:active?o[colorKey]+"30":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{active&&<svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 5L4.5 7.5L8 3" fill="none" stroke={o[colorKey]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</span>}
            {!multi&&o[colorKey]&&<span style={{width:6,height:6,borderRadius:"50%",background:o[colorKey],flexShrink:0}}/>}
            {o[labelKey]}
          </div>
        )})}
      </div>}
    </div>
  );
}

/* ═══ Settings ═══ */

function ItemManager({title,items,onUpdate,nameKey,colorKey,protectedCount=0,theme}){
  const[nn,setNn]=useState("");
  const add=()=>{if(!nn.trim()||items.find(i=>i[nameKey]===nn.trim()))return;const uc=items.map(i=>i[colorKey]);const c=COLORS.find(x=>!uc.includes(x))||COLORS[items.length%COLORS.length];const ni={[nameKey]:nn.trim(),[colorKey]:c};if(title==="Statuses"){ni.id=genId();ni.bg=c+"18";ni.text=c;ni.border=c+"60"}onUpdate([...items,ni]);setNn("")};
  return(<div style={{padding:"6px 0"}}><p style={{fontSize:11,fontWeight:500,margin:"0 0 6px",color:theme.textSecondary}}>{title}</p><div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>{items.map((item,i)=>(<span key={item[nameKey]} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,padding:"2px 8px",borderRadius:99,background:item[colorKey]+"15",color:item[colorKey],fontWeight:500,border:`0.5px solid ${item[colorKey]}25`}}>{item[nameKey]}{i>=protectedCount&&<span onClick={()=>onUpdate(items.filter((_,j)=>j!==i))} style={{cursor:"pointer",opacity:0.5,fontSize:10}}>×</span>}</span>))}</div><div style={{display:"flex",gap:6}}><input value={nn} onChange={e=>setNn(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")add()}} placeholder="New..." style={{flex:1,fontSize:11,padding:"4px 8px",borderRadius:6,border:`1px solid ${theme.inputBorder}`,background:theme.inputBg,color:theme.textPrimary}}/><button onClick={add} style={{fontSize:11,padding:"4px 10px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Add</button></div></div>);
}

function Toggle({value,onChange,theme}){
  return(<div onClick={()=>onChange(!value)} style={{width:36,height:20,borderRadius:10,background:value?theme.btnPrimaryBg:theme.inputBorder,cursor:"pointer",position:"relative",transition:"background 0.2s",flexShrink:0}}>
    <div style={{position:"absolute",top:2,left:value?18:2,width:16,height:16,borderRadius:8,background:"#FFF",transition:"left 0.2s"}}/>
  </div>);
}

function AuthScreen({onLocal}){
  const theme=THEMES["Ocean blue"];const[mode,setMode]=useState("login");const[email,setEmail]=useState("");const[password,setPassword]=useState("");const[error,setError]=useState("");const[message,setMessage]=useState("");const[loading,setLoading]=useState(false);
  const submit=async()=>{if(!supabase){setError("Supabase is not configured.");return}if(!email.trim()||!password){setError("Please enter your email and password.");return}setLoading(true);setError("");setMessage("");try{if(mode==="login"){const{error:authError}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(authError)throw authError}else{const{data,error:authError}=await supabase.auth.signUp({email:email.trim(),password});if(authError)throw authError;setMessage(data.session?"Account created.":"Account created. Check your email to confirm your account.")}}catch(e){setError(e.message||"Authentication failed.")}setLoading(false)};
  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:24,background:`linear-gradient(180deg,${theme.panelBg},#FFFFFF)`}}>
      <div style={{width:"100%",maxWidth:380,background:theme.cardBg,border:`1.5px solid ${theme.panelBorder}`,borderRadius:18,padding:24,boxShadow:"0 16px 40px rgba(12,68,124,0.12)"}}>
        <div style={{display:"flex",gap:6,marginBottom:18}}>
          {["login","signup"].map(tab=><button key={tab} onClick={()=>{setMode(tab);setError("");setMessage("")}} style={{flex:1,padding:"9px 12px",borderRadius:999,cursor:"pointer",border:`1px solid ${mode===tab?theme.panelBorder:theme.inputBorder}`,background:mode===tab?theme.panelBorder:"transparent",color:mode===tab?theme.btnPrimaryText:theme.textSecondary,fontSize:12,fontWeight:600,textTransform:"capitalize"}}>{tab==="signup"?"Sign up":"Log in"}</button>)}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" type="email" autoComplete="email" style={{width:"100%",boxSizing:"border-box",fontSize:13,padding:"10px 12px",borderRadius:10,border:`1px solid ${theme.inputBorder}`,background:theme.inputBg,color:theme.textPrimary}}/>
          <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" type="password" autoComplete={mode==="login"?"current-password":"new-password"} style={{width:"100%",boxSizing:"border-box",fontSize:13,padding:"10px 12px",borderRadius:10,border:`1px solid ${theme.inputBorder}`,background:theme.inputBg,color:theme.textPrimary}}/>
          {error&&<div style={{fontSize:12,color:theme.btnDangerText,background:theme.btnDangerBg,borderRadius:8,padding:"8px 10px"}}>{error}</div>}
          {message&&<div style={{fontSize:12,color:theme.headerText,background:theme.panelBg,borderRadius:8,padding:"8px 10px"}}>{message}</div>}
          <button onClick={submit} disabled={loading} style={{padding:"10px 12px",borderRadius:10,cursor:loading?"default":"pointer",border:"none",background:theme.btnPrimaryBg,color:theme.btnPrimaryText,fontSize:13,fontWeight:600,opacity:loading?0.7:1}}>{loading?(mode==="login"?"Logging in...":"Signing up..."):(mode==="login"?"Log in":"Create account")}</button>
          <button onClick={onLocal} style={{padding:"10px 12px",borderRadius:10,cursor:"pointer",border:`1px solid ${theme.inputBorder}`,background:"transparent",color:theme.textSecondary,fontSize:12,fontWeight:500}}>Continue in local mode (not syncing)</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({theme,themeName,onThemeChange,statuses,onStatusesChange,tags,onTagsChange,settings,onSettingsChange,onExport,onImport,userEmail,localMode,onSignOut,theme:th}){
  const fileRef=useRef(null);
  const handleFile=e=>{const f=e.target.files?.[0];if(!f){alert("No file selected");return}const r=new FileReader();r.onload=ev=>{try{const data=JSON.parse(ev.target.result);onImport(data)}catch(err){alert("Invalid file: "+err.message)}};r.onerror=()=>alert("Failed to read file");r.readAsText(f);e.target.value=""};
  return(
    <div style={{padding:"8px 0"}}>
      {/* Themes */}
      <p style={{fontSize:11,fontWeight:500,margin:"0 0 8px",color:theme.textSecondary}}>Theme</p>
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:12}}>
        {Object.entries(THEMES).map(([name,t])=>(
          <span key={name} onClick={()=>onThemeChange(name)} style={{fontSize:10,padding:"3px 10px",borderRadius:99,cursor:"pointer",background:themeName===name?t.panelBorder+"20":"transparent",color:themeName===name?t.panelBorder:theme.textSecondary,border:`1px solid ${themeName===name?t.panelBorder+"50":theme.inputBorder}`,fontWeight:500,display:"inline-flex",alignItems:"center",gap:5}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:t.panelBorder,flexShrink:0}}/>{name}
          </span>
        ))}
      </div>

      {/* Preferences */}
      <div style={{borderTop:`0.5px solid ${theme.divider}`,paddingTop:8,marginBottom:8}}>
        <p style={{fontSize:11,fontWeight:500,margin:"0 0 8px",color:theme.textSecondary}}>Preferences</p>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0"}}>
          <span style={{fontSize:11,color:theme.textSecondary}}>Auto-start on boot</span>
          <Toggle value={settings.autostart} onChange={v=>onSettingsChange({...settings,autostart:v})} theme={theme}/>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0"}}>
          <span style={{fontSize:11,color:theme.textSecondary}}>Default new task status</span>
          <select value={settings.defaultStatus} onChange={e=>onSettingsChange({...settings,defaultStatus:e.target.value})}
            style={{fontSize:11,padding:"3px 6px",borderRadius:6,border:`1px solid ${theme.inputBorder}`,background:theme.inputBg,color:theme.textPrimary}}>
            {statuses.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0"}}>
          <span style={{fontSize:11,color:theme.textSecondary}}>Collapsed tasks shown</span>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <input type="range" min={1} max={8} value={settings.collapsedMax} onChange={e=>onSettingsChange({...settings,collapsedMax:Number(e.target.value)})} style={{width:60}}/>
            <span style={{fontSize:11,color:theme.textPrimary,minWidth:12,textAlign:"center"}}>{settings.collapsedMax}</span>
          </div>
        </div>
      </div>

      {/* Statuses & Tags */}
      <div style={{borderTop:`0.5px solid ${theme.divider}`,paddingTop:8}}>
        <ItemManager title="Statuses" items={statuses} onUpdate={onStatusesChange} nameKey="name" colorKey="color" protectedCount={4} theme={theme}/>
        <ItemManager title="Tags" items={tags} onUpdate={onTagsChange} nameKey="name" colorKey="color" theme={theme}/>
      </div>

      {/* Data Management */}
      <div style={{borderTop:`0.5px solid ${theme.divider}`,paddingTop:8,marginTop:4}}>
        <p style={{fontSize:11,fontWeight:500,margin:"0 0 8px",color:theme.textSecondary}}>Data</p>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button onClick={onExport} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Export JSON</button>
          <button onClick={()=>fileRef.current?.click()} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Import JSON</button>
          <input ref={fileRef} type="file" accept=".json" onChange={handleFile} style={{display:"none"}}/>
        </div>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" onClick={e=>{e.stopPropagation();e.preventDefault();import("@tauri-apps/plugin-opener").then(m=>m.openUrl(`${REPO_URL}/releases`)).catch(()=>window.open(`${REPO_URL}/releases`,"_blank"))}} style={{fontSize:10,color:theme.textSecondary,opacity:0.5,margin:"8px 0 0",display:"block",textDecoration:"none",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.8"} onMouseLeave={e=>e.currentTarget.style.opacity="0.5"}>Floatask v{VER}</a>
      </div>
      <div style={{borderTop:`0.5px solid ${theme.divider}`,paddingTop:8,marginTop:8}}>
        <p style={{fontSize:11,fontWeight:500,margin:"0 0 8px",color:theme.textSecondary}}>Account</p>
        {userEmail?<><div style={{fontSize:11,color:theme.textPrimary,marginBottom:8,wordBreak:"break-all"}}>{userEmail}</div><button onClick={onSignOut} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Log out</button></>:<div style={{fontSize:11,color:localMode?theme.textSecondary:theme.textPrimary}}>{localMode?"Local mode - not syncing":"Not signed in"}</div>}
      </div>
    </div>
  );
}

/* ═══ Task Card ═══ */

function TaskCard({task,allTags,statuses,onUpdate,onDelete,onDuplicate,theme,isDragOver,onDragStart,onDragEnter,onDragEnd}){
  const[expanded,setExpanded]=useState(false);const[editing,setEditing]=useState(false);const[ed,setEd]=useState({...task});const[hover,setHover]=useState(false);
  const[confirmDel,setConfirmDel]=useState(false);const[ctxMenu,setCtxMenu]=useState(null);
  useEffect(()=>{setEd({...task})},[task]);
  const save=()=>{onUpdate({...ed});setEditing(false)};const cancel=()=>{setEd({...task});setEditing(false)};const startEdit=()=>{setEditing(true);setExpanded(true)};
  const sc=getS(statuses,task.status);const isActive=task.status==="ip";const hasNotes=task.fullNote||task.shortNote;const md=fmtDate(mainDate(task));
  const handleStatusChange=v=>setEd(applyStatusDates({...ed},v));
  const handleContext=e=>{e.preventDefault();e.stopPropagation();setCtxMenu({x:e.clientX,y:e.clientY})};

  if(editing){return(
    <div style={{background:theme.cardBg,border:`1.5px solid ${theme.panelBorder}`,borderRadius:10,padding:"12px 14px",marginBottom:5}}>
      <input value={ed.name} onChange={e=>setEd({...ed,name:e.target.value})} placeholder="Task name" style={{width:"100%",boxSizing:"border-box",fontSize:13,fontWeight:500,border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"6px 8px",marginBottom:8,background:theme.inputBg,color:theme.textPrimary}}/>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <DropSelect value={ed.status} options={statuses} onChange={handleStatusChange} placeholder="Status" valueKey="id" labelKey="name" colorKey="color" theme={theme}/>
        <DropSelect value={ed.tags} options={allTags.map(t=>({...t,id:t.name}))} onChange={v=>setEd({...ed,tags:v})} multi placeholder="Tags" valueKey="id" labelKey="name" colorKey="color" theme={theme}/>
      </div>
      <input value={ed.shortNote} onChange={e=>setEd({...ed,shortNote:e.target.value})} placeholder="Short reminder" style={{width:"100%",boxSizing:"border-box",fontSize:12,border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"5px 8px",marginBottom:6,background:theme.inputBg,color:theme.textPrimary}}/>
      <textarea value={ed.fullNote} onChange={e=>setEd({...ed,fullNote:e.target.value})} placeholder="Full notes (supports **bold**, `code`, [links](url))" rows={4}
        style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"inherit",border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"5px 8px",marginBottom:8,resize:"vertical",background:theme.inputBg,color:theme.textPrimary}}/>
      <div style={{display:"flex",gap:6,justifyContent:"space-between"}}>
        <button onClick={()=>setConfirmDel(true)} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnDangerBg,border:`1px solid ${theme.btnDangerText}30`,color:theme.btnDangerText,fontWeight:500}}>Delete</button>
        <div style={{display:"flex",gap:6}}>
          <button onClick={cancel} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Cancel</button>
          <button onClick={save} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnPrimaryBg,border:"none",color:theme.btnPrimaryText,fontWeight:500}}>Save</button>
        </div>
      </div>
      {confirmDel&&<ConfirmDialog message={`Delete "${task.name}"?`} onConfirm={()=>onDelete(task.id)} onCancel={()=>setConfirmDel(false)} theme={theme}/>}
    </div>
  )}

  return(
    <div draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",task.id);onDragStart(task.id)}} onDragEnter={e=>{e.preventDefault();onDragEnter(task.id)}} onDragOver={e=>e.preventDefault()} onDragEnd={onDragEnd}
      onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} onContextMenu={handleContext}
      style={{background:theme.cardBg,border:`1px solid ${isDragOver?theme.panelBorder:hover?theme.inputBorder:theme.divider+"60"}`,borderLeft:isActive?`3px solid ${sc.color}`:undefined,borderRadius:10,marginBottom:5,opacity:1,transition:"border-color 0.15s ease",overflow:"hidden",borderTopWidth:isDragOver?2:1,borderTopColor:isDragOver?theme.accentLeft:undefined}}>
      <div onClick={()=>setExpanded(!expanded)} style={{display:"flex",alignItems:"center",gap:7,padding:"8px 10px",cursor:"pointer"}}>
        <ChevronIcon open={expanded}/>
        <span style={{flex:1,fontSize:13,fontWeight:500,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:theme.textPrimary}}>{task.name}</span>
        <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
          {task.tags.slice(0,2).map(t=>{const tag=allTags.find(at=>at.name===t);return tag?<TagPill key={t} name={t} color={tag.color} small/>:null})}
          {task.tags.length>2&&<span style={{fontSize:10,color:theme.textSecondary}}>+{task.tags.length-2}</span>}
          {md&&<span style={{fontSize:10,color:theme.textSecondary,opacity:0.6,whiteSpace:"nowrap"}}>{md}</span>}
          <StatusBadge status={task.status} statuses={statuses}/>
        </div>
      </div>
      {expanded&&(
        <div style={{padding:"0 10px 10px 28px",borderTop:`0.5px solid ${theme.divider}40`,paddingTop:8}}>
          {task.shortNote&&<p style={{fontSize:12,margin:"0 0 3px",fontWeight:500,color:theme.textPrimary}}>{task.shortNote}</p>}
          {task.fullNote&&<div style={{fontSize:12,margin:"0 0 6px",lineHeight:1.6,color:theme.textSecondary}}><MdText text={task.fullNote} color={theme.textSecondary}/></div>}
          {!hasNotes&&<p style={{fontSize:11,margin:"0 0 6px",color:theme.textSecondary,fontStyle:"italic",opacity:0.6}}>No notes yet</p>}
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
            <span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>created {fmtDate(task.createdAt)}</span>
            {task.startedAt&&<span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>started {fmtDate(task.startedAt)}</span>}
            {task.completedAt&&<span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>done {fmtDate(task.completedAt)}</span>}
            {task.tags.map(t=>{const tag=allTags.find(at=>at.name===t);return tag?<TagPill key={t} name={t} color={tag.color} small/>:null})}
            <span style={{flex:1}}/>
            <span onClick={e=>{e.stopPropagation();startEdit()}} style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:11,color:theme.btnText,cursor:"pointer",padding:"2px 8px",borderRadius:6,background:theme.btnBg,border:`0.5px solid ${theme.inputBorder}`}}>
              <svg width="10" height="10" viewBox="0 0 12 12"><path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg>edit
            </span>
          </div>
        </div>
      )}
      {ctxMenu&&<ContextMenu x={ctxMenu.x} y={ctxMenu.y} theme={theme} onClose={()=>setCtxMenu(null)} onEdit={()=>startEdit()} onDelete={()=>setConfirmDel(true)} onDuplicate={()=>onDuplicate(task)}/>}
      {confirmDel&&<ConfirmDialog message={`Delete "${task.name}"?`} onConfirm={()=>onDelete(task.id)} onCancel={()=>setConfirmDel(false)} theme={theme}/>}
    </div>
  );
}

/* ═══ Archive Card ═══ */

function ArchiveCard({task,allTags,statuses,onRestore,theme}){
  const[expanded,setExpanded]=useState(false);const hasNotes=task.fullNote||task.shortNote;const md=fmtDate(task.completedAt||task.createdAt);
  return(<div style={{background:theme.cardBg,border:`1px solid ${theme.divider}40`,borderRadius:10,marginBottom:5,overflow:"hidden"}}>
    <div onClick={()=>setExpanded(!expanded)} style={{display:"flex",alignItems:"center",gap:7,padding:"8px 10px",cursor:"pointer"}}>
      <ChevronIcon open={expanded}/><span style={{flex:1,fontSize:12,color:theme.textSecondary,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.name}</span>
      <span style={{fontSize:10,color:theme.textSecondary,opacity:0.5,whiteSpace:"nowrap"}}>{md}</span><StatusBadge status={task.status} statuses={statuses}/>
    </div>
    {expanded&&(<div style={{padding:"0 10px 10px 28px",borderTop:`0.5px solid ${theme.divider}40`,paddingTop:8}}>
      {task.shortNote&&<p style={{fontSize:12,margin:"0 0 3px",fontWeight:500,color:theme.textPrimary}}>{task.shortNote}</p>}
      {task.fullNote&&<div style={{fontSize:12,margin:"0 0 6px",lineHeight:1.6,color:theme.textSecondary}}><MdText text={task.fullNote} color={theme.textSecondary}/></div>}
      {!hasNotes&&<p style={{fontSize:11,margin:"0 0 6px",color:theme.textSecondary,fontStyle:"italic",opacity:0.5}}>No notes</p>}
      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
        <span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>created {fmtDate(task.createdAt)}</span>
        {task.completedAt&&<span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>done {fmtDate(task.completedAt)}</span>}
        <span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>archived {fmtDate(task.archivedAt)}</span>
        {task.tags.map(t=>{const tag=allTags.find(at=>at.name===t);return tag?<TagPill key={t} name={t} color={tag.color} small/>:null})}
        <span style={{flex:1}}/>
        <button onClick={e=>{e.stopPropagation();onRestore(task.id)}} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.accentLeft,fontWeight:500}}>Restore</button>
      </div>
    </div>)}
  </div>);
}

/* ═══ Add Task ═══ */

function AddTaskForm({allTags,statuses,onAdd,onCancel,theme,defaultStatus}){
  const[name,setName]=useState("");const[status,setStatus]=useState(defaultStatus);const[tags,setTags]=useState([]);
  const[shortNote,setShortNote]=useState("");const[fullNote,setFullNote]=useState("");
  const inputRef=useRef(null);useEffect(()=>{inputRef.current?.focus()},[]);
  const submit=()=>{if(!name.trim())return;onAdd(applyStatusDates({id:genId(),name:name.trim(),status,tags,shortNote:shortNote.trim(),fullNote:fullNote.trim(),order:Date.now(),createdAt:today(),startedAt:"",completedAt:""},status));onCancel()};
  return(<div style={{border:`1.5px solid ${theme.panelBorder}`,borderRadius:10,padding:"10px 12px",marginBottom:8,background:theme.cardBg}}>
    <input ref={inputRef} value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==="Escape")onCancel()}} placeholder="Task name" style={{width:"100%",boxSizing:"border-box",fontSize:13,fontWeight:500,border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"6px 8px",marginBottom:8,background:theme.inputBg,color:theme.textPrimary}}/>
    <div style={{display:"flex",gap:8,marginBottom:8}}>
      <DropSelect value={status} options={statuses} onChange={setStatus} placeholder="Status" valueKey="id" labelKey="name" colorKey="color" theme={theme}/>
      <DropSelect value={tags} options={allTags.map(t=>({...t,id:t.name}))} onChange={setTags} multi placeholder="Tags" valueKey="id" labelKey="name" colorKey="color" theme={theme}/>
    </div>
    <input value={shortNote} onChange={e=>setShortNote(e.target.value)} placeholder="Short reminder" style={{width:"100%",boxSizing:"border-box",fontSize:12,border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"5px 8px",marginBottom:6,background:theme.inputBg,color:theme.textPrimary}}/>
    <textarea value={fullNote} onChange={e=>setFullNote(e.target.value)} placeholder="Full notes (supports **bold**, `code`, [links](url))" rows={2}
      style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"inherit",border:`1px solid ${theme.inputBorder}`,borderRadius:6,padding:"5px 8px",marginBottom:8,resize:"vertical",background:theme.inputBg,color:theme.textPrimary}}/>
    <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
      <button onClick={onCancel} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Cancel</button>
      <button onClick={submit} style={{fontSize:11,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:theme.btnPrimaryBg,border:"none",color:theme.btnPrimaryText,fontWeight:500}}>Add</button>
    </div>
  </div>);
}

/* ═══ Context Menu ═══ */

function ContextMenu({x,y,onEdit,onDelete,onDuplicate,onClose,theme}){
  const ref=useRef(null);
  useEffect(()=>{const h=e=>{if(ref.current&&!ref.current.contains(e.target))onClose()};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h)},[onClose]);
  const items=[{label:"Edit",action:onEdit},{label:"Duplicate",action:onDuplicate},{label:"Delete",action:onDelete,danger:true}];
  return(<div ref={ref} style={{position:"fixed",left:x,top:y,zIndex:10001,background:theme.cardBg,border:`1px solid ${theme.inputBorder}`,borderRadius:8,padding:4,minWidth:120,boxShadow:"0 4px 16px rgba(0,0,0,0.15)"}}>
    {items.map(it=><div key={it.label} onClick={()=>{it.action();onClose()}}
      style={{fontSize:12,padding:"6px 12px",borderRadius:5,cursor:"pointer",color:it.danger?theme.btnDangerText:theme.textPrimary}}
      onMouseEnter={e=>e.currentTarget.style.background=it.danger?theme.btnDangerBg:theme.inputBg}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{it.label}</div>)}
  </div>);
}

/* ═══ Confirm Dialog ═══ */

function ConfirmDialog({message,onConfirm,onCancel,theme,confirmLabel="Delete",confirmDanger=true}){
  return(<div style={{position:"fixed",inset:0,zIndex:10002,background:"rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onCancel}>
    <div onClick={e=>e.stopPropagation()} style={{background:theme.cardBg,border:`1px solid ${theme.inputBorder}`,borderRadius:12,padding:"20px 24px",minWidth:220,maxWidth:300,boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}}>
      <p style={{fontSize:13,color:theme.textPrimary,margin:"0 0 16px",lineHeight:1.5}}>{message}</p>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={onCancel} style={{fontSize:12,padding:"6px 16px",borderRadius:6,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.btnText}}>Cancel</button>
        <button onClick={onConfirm} style={{fontSize:12,padding:"6px 16px",borderRadius:6,cursor:"pointer",background:confirmDanger?theme.btnDangerBg:theme.btnPrimaryBg,border:confirmDanger?`1px solid ${theme.btnDangerText}30`:"none",color:confirmDanger?theme.btnDangerText:theme.btnPrimaryText,fontWeight:500}}>{confirmLabel}</button>
      </div>
    </div>
  </div>);
}

function ImportDialog({data,onReplace,onMerge,onCancel,theme,title="Import Data",description,replaceLabel="Replace all data",replaceHint="Clear current data and import",mergeLabel="Merge",mergeHint="Add imported tasks to existing data"}){
  const tc=data.tasks?data.tasks.length:0;const ac=data.archived?data.archived.length:0;
  return(<div style={{position:"fixed",inset:0,zIndex:10002,background:"rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onCancel}>
    <div onClick={e=>e.stopPropagation()} style={{background:theme.cardBg,border:`1px solid ${theme.inputBorder}`,borderRadius:12,padding:"20px 24px",minWidth:260,maxWidth:340,boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}}>
      <p style={{fontSize:14,fontWeight:600,color:theme.textPrimary,margin:"0 0 8px"}}>{title}</p>
      <p style={{fontSize:12,color:theme.textSecondary,margin:"0 0 16px",lineHeight:1.5}}>{description||`Found ${tc} tasks${ac>0?` and ${ac} archived`:""}${data.themeName?`, theme: ${data.themeName}`:""}`}</p>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <button onClick={onReplace} style={{fontSize:12,padding:"10px 16px",borderRadius:8,cursor:"pointer",background:theme.btnPrimaryBg,border:"none",color:theme.btnPrimaryText,fontWeight:500,textAlign:"left"}}>{replaceLabel}<br/><span style={{fontSize:11,opacity:0.8,fontWeight:400}}>{replaceHint}</span></button>
        <button onClick={onMerge} style={{fontSize:12,padding:"10px 16px",borderRadius:8,cursor:"pointer",background:theme.btnBg,border:`1px solid ${theme.inputBorder}`,color:theme.textPrimary,fontWeight:500,textAlign:"left"}}>{mergeLabel}<br/><span style={{fontSize:11,opacity:0.6,fontWeight:400}}>{mergeHint}</span></button>
        <button onClick={onCancel} style={{fontSize:12,padding:"8px 16px",borderRadius:8,cursor:"pointer",background:"transparent",border:"none",color:theme.textSecondary,textAlign:"center"}}>Cancel</button>
      </div>
    </div>
  </div>);
}

/* ═══ Resize Handles ═══ */

const RESIZE_DIR_MAP={n:"North",s:"South",e:"East",w:"West",nw:"NorthWest",ne:"NorthEast",sw:"SouthWest",se:"SouthEast"};
function ResizeHandles(){if(!isTauri)return null;const H=6;return <>{["n","s","e","w","nw","ne","sw","se"].map(d=>{const cm={n:"ns-resize",s:"ns-resize",e:"ew-resize",w:"ew-resize",ne:"nesw-resize",nw:"nwse-resize",se:"nwse-resize",sw:"nesw-resize"};const pm={n:{top:0,left:H,right:H,height:H},s:{bottom:0,left:H,right:H,height:H},w:{top:H,bottom:H,left:0,width:H},e:{top:H,bottom:H,right:0,width:H},nw:{top:0,left:0,width:H*2,height:H*2},ne:{top:0,right:0,width:H*2,height:H*2},sw:{bottom:0,left:0,width:H*2,height:H*2},se:{bottom:0,right:0,width:H*2,height:H*2}};return <div key={d} onMouseDown={e=>{e.preventDefault();getCurrentWindow().startResizeDragging(RESIZE_DIR_MAP[d])}} style={{position:"absolute",cursor:cm[d],zIndex:d.length>1?11:10,...pm[d]}}/>})}</>}

/* ═══ Search Overlay ═══ */

function SearchOverlay({tasks,archived,allTags,statuses,theme,onClose}){
  const[q,setQ]=useState("");const ref=useRef(null);
  useEffect(()=>{ref.current?.focus()},[]);
  const lq=q.toLowerCase();
  const results=q.length<1?[]:[...tasks,...archived].filter(t=>t.name.toLowerCase().includes(lq)||t.shortNote.toLowerCase().includes(lq)||t.fullNote.toLowerCase().includes(lq)||t.tags.some(tg=>tg.toLowerCase().includes(lq))).slice(0,12);
  return(
    <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.3)",zIndex:9999,display:"flex",flexDirection:"column",padding:16,borderRadius:14}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:theme.cardBg,borderRadius:12,border:`1px solid ${theme.panelBorder}`,overflow:"hidden",maxHeight:"90%",display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderBottom:`1px solid ${theme.divider}`}}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={theme.textSecondary} strokeWidth="1.5" strokeLinecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4 4"/></svg>
          <input ref={ref} value={q} onChange={e=>setQ(e.target.value)} placeholder="Search tasks..." onKeyDown={e=>{if(e.key==="Escape")onClose()}}
            style={{flex:1,fontSize:13,border:"none",outline:"none",background:"transparent",color:theme.textPrimary}}/>
          <span onClick={onClose} style={{fontSize:11,color:theme.textSecondary,cursor:"pointer",padding:"2px 6px",borderRadius:4,background:theme.btnBg,border:`0.5px solid ${theme.inputBorder}`}}>ESC</span>
        </div>
        <div style={{overflowY:"auto",padding:8,flex:1}}>
          {q.length<1&&<p style={{fontSize:12,color:theme.textSecondary,opacity:0.5,textAlign:"center",padding:16}}>Type to search...</p>}
          {q.length>=1&&results.length===0&&<p style={{fontSize:12,color:theme.textSecondary,opacity:0.5,textAlign:"center",padding:16}}>No results</p>}
          {results.map(t=>{
            const isArchived=!!t.archivedAt;const sc=getS(statuses,t.status);
            return(<div key={t.id+(isArchived?"a":"")} style={{padding:"8px 10px",borderRadius:8,marginBottom:2,display:"flex",alignItems:"center",gap:8,cursor:"default"}}
              onMouseEnter={e=>e.currentTarget.style.background=theme.inputBg} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <span style={{flex:1,fontSize:12,color:theme.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</span>
              {isArchived&&<span style={{fontSize:9,color:theme.textSecondary,opacity:0.5}}>archived</span>}
              {t.tags.slice(0,1).map(tg=>{const tag=allTags.find(at=>at.name===tg);return tag?<TagPill key={tg} name={tg} color={tag.color} small/>:null})}
              <StatusBadge status={t.status} statuses={statuses}/>
            </div>)
          })}
        </div>
      </div>
    </div>
  );
}

/* ═══ Main ═══ */

export default function App(){
  const[session,setSession]=useState(null);const[localMode,setLocalMode]=useState(false);
  useEffect(()=>{if(!supabase){setLocalMode(true);return}supabase.auth.getSession().then(({data})=>setSession(data.session));const{data:listener}=supabase.auth.onAuthStateChange((_,nextSession)=>setSession(nextSession));return()=>listener.subscription.unsubscribe()},[]);
  if(!localMode&&!session)return <AuthScreen onLocal={()=>setLocalMode(true)}/>;
  return <TaskTracker userId={session?.user?.id} userEmail={session?.user?.email||""} localMode={localMode} onSignOut={async()=>{if(!supabase)return;await supabase.auth.signOut()}}/>;
}

function TaskTracker({userId,userEmail,localMode,onSignOut}){
  const[tasks,setTasks]=useState(userId?[]:INITIAL_TASKS);const[archived,setArchived]=useState([]);const[tags,setTags]=useState(DEFAULT_TAGS);const[statuses,setStatuses]=useState(DEFAULT_STATUSES);
  const[collapsed,setCollapsed]=useState(true);const[loaded,setLoaded]=useState(false);const[showSettings,setShowSettings]=useState(false);const[showArchive,setShowArchive]=useState(false);
  const[filterTag,setFilterTag]=useState(null);const[themeName,setThemeName]=useState("Ocean blue");const[pinned,setPinned]=useState(false);const[minimized,setMinimized]=useState(false);
  const[showOverflow,setShowOverflow]=useState(false);const[showSearch,setShowSearch]=useState(false);const[settings,setSettings]=useState(DEFAULT_SETTINGS);const[addingTask,setAddingTask]=useState(false);const[importPending,setImportPending]=useState(null);const[cloudImportPending,setCloudImportPending]=useState(null);
  const panelRef=useRef(null);const preExpandPos=useRef(null);const collapsedSizeRef=useRef({...COLLAPSED_WINDOW});const expandedSizeRef=useRef({...EXPANDED_WINDOW});const preOverflowH=useRef(null);const saveTimerRef=useRef(null);const pendingWriteRef=useRef(new Set());const theme=THEMES[themeName]||THEMES["Ocean blue"];
  const[winWidth,setWinWidth]=useState(window.innerWidth||COLLAPSED_WINDOW.w);

  // Drag reorder state
  const[dragFromId,setDragFromId]=useState(null);const[dragOverId,setDragOverId]=useState(null);

  const markPendingWrite=ids=>{ids.forEach(id=>pendingWriteRef.current.add(id));window.setTimeout(()=>ids.forEach(id=>pendingWriteRef.current.delete(id)),2000)};
  const syncToCloud=async data=>{if(!userId||!supabase)return;const ids=[...(data.tasks||[]).map(task=>`task:${task.id}`),...(data.archived||[]).map(task=>`task:${task.id}`),"settings"];markPendingWrite(ids);await saveStore(data,userId)};
  const shouldUseRemoteTask=(currentTask,nextTask)=>!currentTask||!currentTask.updatedAt||!nextTask.updatedAt||new Date(nextTask.updatedAt).getTime()>=new Date(currentTask.updatedAt).getTime();

  useEffect(()=>{const h=()=>setWinWidth(window.innerWidth);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h)},[]);

  useEffect(()=>{let cancelled=false;(async()=>{await tauriReady;try{const result=await loadStore(userId);if(cancelled)return;const d=result?.data;let nextSettings=DEFAULT_SETTINGS;if(d){if(d.tasks)setTasks(d.tasks);if(d.archived)setArchived(d.archived);if(d.tags)setTags(d.tags);if(d.statuses)setStatuses(d.statuses);if(d.themeName)setThemeName(d.themeName);if(d.pinned!==undefined)setPinned(d.pinned);if(d.settings)nextSettings={...DEFAULT_SETTINGS,...d.settings}}setCloudImportPending(result?.shouldPromptImport?result.localData:null);try{nextSettings={...nextSettings,autostart:await autostartIsEnabled()}}catch(e){}setSettings(nextSettings)}catch(e){}if(!cancelled)setLoaded(true)})();return()=>{cancelled=true;if(saveTimerRef.current)clearTimeout(saveTimerRef.current)}},[userId]);

  // Sync pinned state to Tauri window — runs on load and on every toggle
  useEffect(()=>{if(!loaded||!isTauri)return;tauriReady.then(()=>getCurrentWindow().setAlwaysOnTop(pinned)).catch(()=>{})},[pinned,loaded]);

  useEffect(()=>{if(!loaded)return;const data={tasks,archived,tags,statuses,themeName,pinned,settings};if(saveTimerRef.current)clearTimeout(saveTimerRef.current);if(userId&&cloudImportPending){saveLocalStore(data);return}if(userId&&supabase){saveTimerRef.current=setTimeout(()=>{syncToCloud(data).catch(()=>{})},800);return()=>{if(saveTimerRef.current)clearTimeout(saveTimerRef.current)}}saveStore(data,userId).catch(()=>{})},[tasks,archived,tags,statuses,themeName,pinned,settings,loaded,userId,cloudImportPending]);

  // Track latest collapsed state for global shortcut callback
  const collapsedRef=useRef(collapsed);useEffect(()=>{collapsedRef.current=collapsed},[collapsed]);

  // Global shortcut: Ctrl+Shift+T works even when window is hidden (Tauri only)
  useEffect(()=>{if(!isTauri)return;let registered=false;const SHORTCUT="CmdOrCtrl+Shift+T";tauriReady.then(async()=>{await registerShortcut(SHORTCUT,async()=>{const appWindow=getCurrentWindow();const visible=await appWindow.isVisible();if(!visible){await appWindow.show();await appWindow.setFocus();return}if(collapsedRef.current)await expandPanel();else await collapsePanel()});registered=true}).catch(()=>{});return()=>{if(registered)tauriReady.then(()=>unregisterShortcut(SHORTCUT)).catch(()=>{})}},[]);

  useEffect(()=>{
    if(!userId||!supabase)return;
    const upsertTask=(list,row)=>{const task=mapRowToTask(row);const idx=list.findIndex(item=>item.id===task.id);if(idx===-1)return[...list,task];if(!shouldUseRemoteTask(list[idx],task))return list;const next=[...list];next[idx]={...list[idx],...task};return next};
    const channel=supabase.channel(`user-${userId}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"tasks",filter:`user_id=eq.${userId}`},payload=>{
        const row=payload.eventType==="DELETE"?payload.old:payload.new;
        if(!row?.id||pendingWriteRef.current.has(`task:${row.id}`))return;
        if(payload.eventType==="DELETE"){setTasks(prev=>prev.filter(task=>task.id!==row.id));setArchived(prev=>prev.filter(task=>task.id!==row.id));return}
        if(row.is_archived){setArchived(prev=>upsertTask(prev,row));setTasks(prev=>prev.filter(task=>task.id!==row.id))}
        else{setTasks(prev=>upsertTask(prev,row));setArchived(prev=>prev.filter(task=>task.id!==row.id))}
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"user_settings",filter:`user_id=eq.${userId}`},payload=>{
        if(payload.eventType==="DELETE"||pendingWriteRef.current.has("settings"))return;
        const row=payload.new;
        setTags(row.tags||DEFAULT_TAGS);
        setStatuses(row.statuses||DEFAULT_STATUSES);
        setSettings(prev=>({...prev,...DEFAULT_SETTINGS,...(row.settings||{})}));
        setThemeName(row.theme_name||"Ocean blue");
      })
      .subscribe();
    return()=>{supabase.removeChannel(channel)};
  },[userId]);

  const startMove=(e,toggle)=>{if(e.target.closest("[data-no-drag]"))return;if(!isTauri){if(toggle)toggle();return}e.preventDefault();const sx=e.clientX,sy=e.clientY;let dragging=false;const onMove=ev=>{if(!dragging&&(Math.abs(ev.clientX-sx)>=3||Math.abs(ev.clientY-sy)>=3)){dragging=true;document.removeEventListener("mousemove",onMove);document.removeEventListener("mouseup",onUp);getCurrentWindow().startDragging()}};const onUp=()=>{document.removeEventListener("mousemove",onMove);document.removeEventListener("mouseup",onUp);if(!dragging&&toggle)toggle()};document.addEventListener("mousemove",onMove);document.addEventListener("mouseup",onUp)};
  const resizeWindow=isTauri?(width,height)=>getCurrentWindow().setSize(new LogicalSize(width,height)):async()=>{};
  const expandPanel=async()=>{const appWindow=getCurrentWindow();collapsedSizeRef.current={w:window.innerWidth,h:window.innerHeight};try{const factor=await appWindow.scaleFactor();const pos=await appWindow.outerPosition();preExpandPos.current={x:Math.round(pos.x/factor),y:Math.round(pos.y/factor)}}catch(e){}const es=expandedSizeRef.current;await resizeWindow(es.w,es.h);setCollapsed(false);setShowOverflow(false);try{const factor=await appWindow.scaleFactor();const pos=await appWindow.outerPosition();const sw=window.screen.availWidth;const sh=window.screen.availHeight;const px=Math.round(pos.x/factor),py=Math.round(pos.y/factor);let nx=px,ny=py;if(px+es.w>sw)nx=Math.max(0,sw-es.w);if(py+es.h>sh)ny=Math.max(0,sh-es.h);if(nx!==px||ny!==py)await appWindow.setPosition(new LogicalPosition(nx,ny))}catch(e){}};
  const collapsePanel=async()=>{expandedSizeRef.current={w:window.innerWidth,h:window.innerHeight};setCollapsed(true);const cs=collapsedSizeRef.current;await resizeWindow(cs.w,cs.h);if(preExpandPos.current){try{await getCurrentWindow().setPosition(new LogicalPosition(preExpandPos.current.x,preExpandPos.current.y))}catch(e){}preExpandPos.current=null}};

  const doArchive=()=>{const toA=tasks.filter(t=>t.status==="dn"||t.status==="na").map(t=>({...t,archivedAt:today()}));if(!toA.length)return;setArchived([...toA,...archived]);setTasks(tasks.filter(t=>t.status!=="dn"&&t.status!=="na"))};
  const restoreTask=id=>{const t=archived.find(a=>a.id===id);if(!t)return;const{archivedAt,...rest}=t;setTasks([...tasks,rest]);setArchived(archived.filter(a=>a.id!==id))};

  const handleStatusUpdate=u=>{const orig=tasks.find(t=>t.id===u.id);setTasks(tasks.map(t=>t.id===u.id?(orig&&orig.status!==u.status?applyStatusDates(u,u.status):u):t))};

  // Drag reorder (insert) + drag across status groups to change status
  const handleDragEnd=()=>{
    if(dragFromId&&dragOverId&&dragFromId!==dragOverId){
      const ordered=[...tasks].sort((a,b)=>a.order-b.order);
      const fromIdx=ordered.findIndex(t=>t.id===dragFromId);
      const toIdx=ordered.findIndex(t=>t.id===dragOverId);
      if(fromIdx!==-1&&toIdx!==-1){
        const targetStatus=ordered[toIdx].status;
        const[item]=ordered.splice(fromIdx,1);
        if(item.status!==targetStatus)Object.assign(item,applyStatusDates(item,targetStatus));
        ordered.splice(toIdx,0,item);
        const updated=ordered.map((t,i)=>({...t,order:i}));
        setTasks(updated);
      }
    }
    setDragFromId(null);setDragOverId(null);
  };

  // Export / Import
  const exportData=()=>{const data={tasks,archived,tags,statuses,settings,themeName,version:VER};const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`task-tracker-${today()}.json`;a.click();URL.revokeObjectURL(url)};
  const importData=data=>setImportPending(data);
  const doImportReplace=()=>{const d=importPending;if(!d)return;if(d.tasks)setTasks(d.tasks);if(d.archived)setArchived(d.archived);if(d.tags)setTags(d.tags);if(d.statuses)setStatuses(d.statuses);if(d.settings)setSettings({...DEFAULT_SETTINGS,...d.settings});if(d.themeName)setThemeName(d.themeName);setShowSettings(false);setImportPending(null)};
  const doImportMerge=()=>{const d=importPending;if(!d)return;if(d.tasks){const existIds=new Set(tasks.map(t=>t.id));const newTasks=d.tasks.filter(t=>!existIds.has(t.id));setTasks([...tasks,...newTasks.map((t,i)=>({...t,order:tasks.length+i}))])}if(d.archived){const existAIds=new Set(archived.map(a=>a.id));const newArchived=d.archived.filter(a=>!existAIds.has(a.id));setArchived([...archived,...newArchived])}if(d.tags){const existTagNames=new Set(tags.map(t=>t.name));const newTags=d.tags.filter(t=>!existTagNames.has(t.name));setTags([...tags,...newTags])}if(d.statuses){const existStatIds=new Set(statuses.map(s=>s.id));const newStats=d.statuses.filter(s=>!existStatIds.has(s.id));setStatuses([...statuses,...newStats])}setShowSettings(false);setImportPending(null)};
  const doCloudImportReplace=async()=>{const d=cloudImportPending;if(!d)return;await syncToCloud({tasks:d.tasks||[],archived:d.archived||[],tags:d.tags||DEFAULT_TAGS,statuses:d.statuses||DEFAULT_STATUSES,themeName:d.themeName||"Ocean blue",pinned:d.pinned??pinned,settings:{...DEFAULT_SETTINGS,...(d.settings||{})}});setCloudImportPending(null)};
  const doCloudImportMerge=async()=>{const d=cloudImportPending;if(!d)return;const mergedTasks=[...tasks];for(const task of d.tasks||[]){if(!mergedTasks.find(existing=>existing.id===task.id))mergedTasks.push({...task,order:mergedTasks.length})}const mergedArchived=[...archived];for(const task of d.archived||[]){if(!mergedArchived.find(existing=>existing.id===task.id))mergedArchived.push(task)}const mergedTags=[...tags];for(const tag of d.tags||[]){if(!mergedTags.find(existing=>existing.name===tag.name))mergedTags.push(tag)}const mergedStatuses=[...statuses];for(const status of d.statuses||[]){if(!mergedStatuses.find(existing=>existing.id===status.id))mergedStatuses.push(status)}await syncToCloud({tasks:mergedTasks,archived:mergedArchived,tags:mergedTags,statuses:mergedStatuses,themeName:d.themeName||themeName,pinned:d.pinned??pinned,settings:{...DEFAULT_SETTINGS,...settings,...(d.settings||{})}});setCloudImportPending(null)};
  const handleSettingsChange=async nextSettings=>{if(nextSettings.autostart!==settings.autostart){try{if(nextSettings.autostart)await autostartEnable();else await autostartDisable()}catch(e){}}setSettings(nextSettings)};

  const activeTasks=tasks.filter(t=>t.status==="ip").sort((a,b)=>a.order-b.order);
  const groupedTasks=statuses.map(s=>s.id).map(sid=>({status:getS(statuses,sid),tasks:tasks.filter(t=>t.status===sid&&(!filterTag||t.tags.includes(filterTag))).sort((a,b)=>a.order-b.order)})).filter(g=>g.tasks.length>0);
  const sortedArchived=[...archived].sort((a,b)=>(b.completedAt||"").localeCompare(a.completedAt||""));
  const archivedByWeek=[];sortedArchived.forEach(t=>{const wk=weekLabel(t.completedAt||t.createdAt);const last=archivedByWeek[archivedByWeek.length-1];if(last&&last.week===wk)last.tasks.push(t);else archivedByWeek.push({week:wk,tasks:[t]})});

  const deleteTask=id=>setTasks(tasks.filter(t=>t.id!==id));
  const addTask=task=>setTasks([...tasks,task]);
  const duplicateTask=t=>{const dup={...t,id:genId(),name:t.name+" (copy)",order:t.order+0.5,createdAt:today(),startedAt:"",completedAt:""};setTasks([...tasks,dup])};

  if(!loaded)return <div style={{padding:20,textAlign:"center",fontSize:13}}>Loading...</div>;

  const cScale=winWidth/COLLAPSED_WINDOW.w;const iconS=Math.max(10,12*cScale);
  const shownActive=showOverflow?activeTasks:activeTasks.slice(0,settings.collapsedMax);const overC=activeTasks.length-settings.collapsedMax;
  const archivable=tasks.filter(t=>t.status==="dn"||t.status==="na").length;

  /* ── Mobile (PWA) ── */
  if(isMobile||(!isTauri&&!collapsed)){
    const mfs=isMobile?15:13;const mpad=isMobile?12:10;
    return(
      <div style={{width:"100%",height:"100vh",background:theme.panelBg,display:"flex",flexDirection:"column",overflow:"hidden",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"}}>
        <div style={{position:"relative",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${theme.accentLeft},${theme.accentRight}80)`,flexShrink:0}}/>
        {showSearch&&<SearchOverlay tasks={tasks} archived={archived} allTags={tags} statuses={statuses} theme={theme} onClose={()=>setShowSearch(false)}/>}

        {/* Header */}
        <div style={{padding:`${mpad+4}px ${mpad+4}px ${mpad}px`,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:mfs+3,fontWeight:600,color:theme.headerText}}>Floatask</span>
            <span style={{fontSize:mfs-2,color:theme.headerText,opacity:0.5}}>{tasks.length} tasks</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <span onClick={()=>window.location.reload()} style={{cursor:"pointer",padding:6,borderRadius:8,display:"flex",alignItems:"center",opacity:0.4}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.4"}>
              <svg width={mfs} height={mfs} viewBox="0 0 16 16" fill="none" stroke={theme.headerText} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8a6 6 0 0111.5-2.5M14 2v3.5h-3.5"/><path d="M14 8a6 6 0 01-11.5 2.5M2 14v-3.5h3.5"/></svg>
            </span>
            <span onClick={()=>setShowSearch(true)} style={{cursor:"pointer",padding:6,borderRadius:8,display:"flex",alignItems:"center",opacity:0.5}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.5"}>
              <svg width={mfs} height={mfs} viewBox="0 0 16 16" fill="none" stroke={theme.headerText} strokeWidth="1.5" strokeLinecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4 4"/></svg>
            </span>
          </div>
        </div>

        {/* Filter */}
        <div style={{padding:`4px ${mpad+4}px 8px`,flexShrink:0,display:"flex",gap:6,flexWrap:"wrap",borderBottom:`1px solid ${theme.divider}`,WebkitOverflowScrolling:"touch"}}>
          <span onClick={()=>setFilterTag(null)} style={{fontSize:mfs-3,padding:"4px 12px",borderRadius:99,cursor:"pointer",background:filterTag===null?theme.cardBg:"transparent",color:filterTag===null?theme.textPrimary:theme.textSecondary,border:filterTag===null?`1px solid ${theme.divider}`:"1px solid transparent",fontWeight:500}}>All</span>
          {tags.map(t=><span key={t.name} onClick={()=>setFilterTag(filterTag===t.name?null:t.name)} style={{fontSize:mfs-3,padding:"4px 12px",borderRadius:99,cursor:"pointer",background:filterTag===t.name?t.color+"18":"transparent",color:filterTag===t.name?t.color:theme.textSecondary,border:`1px solid ${filterTag===t.name?t.color+"35":"transparent"}`,fontWeight:500}}>{t.name}</span>)}
        </div>

        {/* Content */}
        <div style={{flex:1,overflowY:"auto",padding:`${mpad}px ${mpad+4}px`,WebkitOverflowScrolling:"touch",userSelect:"text"}}>
          {!showArchive?groupedTasks.map(group=>(
            <div key={group.status.id} style={{marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,padding:"0 2px"}}><div style={{width:7,height:7,borderRadius:"50%",background:group.status.color,flexShrink:0}}/><span style={{fontSize:mfs-2,color:theme.textSecondary,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:500}}>{group.status.name}</span><span style={{fontSize:mfs-3,color:theme.textSecondary,opacity:0.5}}>{group.tasks.length}</span></div>
              {group.tasks.map(task=><TaskCard key={task.id} task={task} allTags={tags} statuses={statuses} theme={theme} onUpdate={handleStatusUpdate} onDelete={deleteTask} onDuplicate={duplicateTask} isDragOver={dragOverId===task.id} onDragStart={setDragFromId} onDragEnter={setDragOverId} onDragEnd={handleDragEnd}/>)}
            </div>
          )):(
            <><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><span style={{fontSize:mfs+1,fontWeight:500,color:theme.headerText}}>Archived</span><span style={{fontSize:mfs-2,color:theme.textSecondary}}>{archived.length}</span></div>
            {archived.length===0&&<p style={{fontSize:mfs-1,color:theme.textSecondary,fontStyle:"italic",opacity:0.6}}>No archived tasks</p>}
            {archivedByWeek.map(g=><div key={g.week} style={{marginBottom:14}}><div style={{fontSize:mfs-3,color:theme.textSecondary,opacity:0.5,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:500}}>Week of {g.week}</div>{g.tasks.map(t=><ArchiveCard key={t.id} task={t} allTags={tags} statuses={statuses} onRestore={restoreTask} theme={theme}/>)}</div>)}</>
          )}
          {addingTask&&!showArchive&&<AddTaskForm allTags={tags} statuses={statuses} onAdd={addTask} onCancel={()=>setAddingTask(false)} theme={theme} defaultStatus={settings.defaultStatus}/>}
        </div>

        {/* Settings */}
        {showSettings&&<div style={{padding:`0 ${mpad+4}px 8px`,flexShrink:0,borderTop:`1px solid ${theme.divider}`,maxHeight:300,overflowY:"auto",WebkitOverflowScrolling:"touch"}}><SettingsPanel theme={theme} themeName={themeName} onThemeChange={setThemeName} statuses={statuses} onStatusesChange={setStatuses} tags={tags} onTagsChange={setTags} settings={settings} onSettingsChange={handleSettingsChange} onExport={exportData} onImport={importData} userEmail={userEmail} localMode={localMode} onSignOut={onSignOut}/></div>}

        {/* Bottom */}
        <div style={{padding:`8px ${mpad+4}px ${isMobile?16:12}px`,flexShrink:0,borderTop:`1px solid ${theme.divider}`,background:theme.panelBg,display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={()=>{setShowSettings(!showSettings);setShowArchive(false)}} style={{padding:"0 10px",height:isMobile?44:36,borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${showSettings?theme.panelBorder:theme.newTaskBorder}`,background:showSettings?theme.panelBorder+"15":theme.btnBg,color:showSettings?theme.panelBorder:theme.headerText,display:"flex",alignItems:"center",justifyContent:"center"}}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/></svg></button>
          <button onClick={()=>{setShowArchive(!showArchive);setShowSettings(false)}} style={{padding:"0 10px",height:isMobile?44:36,borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${showArchive?theme.panelBorder:theme.newTaskBorder}`,background:showArchive?theme.panelBorder+"15":theme.btnBg,color:showArchive?theme.panelBorder:theme.headerText,display:"flex",alignItems:"center",justifyContent:"center",gap:3}}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="4" rx="1"/><path d="M2 6v7a1 1 0 001 1h10a1 1 0 001-1V6"/><path d="M6 9h4"/></svg>{archived.length>0&&<span style={{fontSize:10,opacity:0.6}}>{archived.length}</span>}</button>
          {!showArchive&&archivable>0&&<button onClick={doArchive} style={{padding:"0 12px",height:isMobile?44:36,borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${theme.newTaskBorder}`,background:theme.btnBg,color:theme.headerText,display:"flex",alignItems:"center",gap:4,fontSize:mfs-2}} onMouseEnter={e=>e.currentTarget.style.borderColor=theme.panelBorder} onMouseLeave={e=>e.currentTarget.style.borderColor=theme.newTaskBorder}>Archive {archivable}</button>}
          {!showArchive&&<button onClick={()=>setAddingTask(!addingTask)} style={{flex:1,height:isMobile?44:36,borderRadius:10,cursor:"pointer",border:`1px ${addingTask?"solid":"dashed"} ${addingTask?theme.panelBorder:theme.newTaskBorder}`,background:addingTask?theme.panelBorder+"15":"none",color:addingTask?theme.panelBorder:theme.headerText,fontSize:mfs-1,display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={e=>{if(!addingTask)e.currentTarget.style.borderColor=theme.panelBorder}} onMouseLeave={e=>{if(!addingTask)e.currentTarget.style.borderColor=theme.newTaskBorder}}>+ New</button>}
        </div>
        {cloudImportPending&&<ImportDialog data={cloudImportPending} theme={theme} title="Upload Local Data" description="Cloud storage is empty. Upload your local tasks to Supabase?" replaceLabel="Upload local data" replaceHint="Push your current local tasks and settings to the cloud" mergeLabel="Merge local into cloud" mergeHint="Keep the current state and sync any missing local items" onReplace={doCloudImportReplace} onMerge={doCloudImportMerge} onCancel={()=>setCloudImportPending(null)}/>}
        {importPending&&<ImportDialog data={importPending} theme={theme} onReplace={doImportReplace} onMerge={doImportMerge} onCancel={()=>setImportPending(null)}/>}
      </div>
    );
  }

  /* ── Minimized ── */
  if(minimized){return(<div style={{width:"100%",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}><div onClick={()=>setMinimized(false)} style={{width:36,height:36,background:theme.panelBorder,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"transform 0.15s",position:"relative"}} onMouseEnter={e=>e.currentTarget.style.transform="scale(1.1)"} onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}><svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2" stroke="#FFF" strokeWidth="1.3"/><path d="M5 7h6M5 9.5h4" stroke="#FFF" strokeWidth="1" strokeLinecap="round"/></svg>{activeTasks.length>0&&<div style={{position:"absolute",top:-4,right:-4,width:16,height:16,borderRadius:"50%",background:"#378ADD",color:"#FFF",fontSize:9,fontWeight:500,display:"flex",alignItems:"center",justifyContent:"center"}}>{activeTasks.length}</div>}</div></div>)}

  /* ── Collapsed ── */
  if(collapsed){return(
      <div ref={panelRef} style={{width:"100%",height:"100vh",background:theme.panelBg,border:`1.5px solid ${theme.panelBorder}`,borderRadius:14*Math.min(cScale,1.2),padding:`${11*cScale}px ${16*cScale}px`,userSelect:"none",overflow:"hidden",position:"relative"}}>
        <ResizeHandles/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:Math.max(2,3*cScale),background:activeTasks.length>0?`linear-gradient(90deg,${theme.accentLeft},${theme.accentLeft}60)`:theme.divider}}/>
        <div style={{position:"absolute",top:Math.max(4,6*cScale),right:Math.max(6,8*cScale),display:"flex",gap:Math.max(2,4*cScale),zIndex:12}}>
          <span data-no-drag onClick={e=>{e.stopPropagation();setPinned(!pinned)}} style={{width:iconS+6,height:iconS+6,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",borderRadius:4,background:pinned?theme.panelBorder+"20":"transparent"}} onMouseEnter={e=>{if(!pinned)e.currentTarget.style.background=theme.panelBorder+"10"}} onMouseLeave={e=>{e.currentTarget.style.background=pinned?theme.panelBorder+"20":"transparent"}}><svg width={iconS} height={iconS} viewBox="0 0 16 16" fill="none" stroke={pinned?theme.panelBorder:theme.headerText} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{opacity:pinned?1:0.5,transform:pinned?"rotate(0deg)":"rotate(45deg)",transition:"transform 0.2s"}}><path d="M5 2L11 2L12 7L10 9L10 14L6 14L6 9L4 7Z" fill={pinned?theme.panelBorder+"30":"none"}/></svg></span>
          <span data-no-drag onClick={async e=>{e.stopPropagation();await getCurrentWindow().hide()}} style={{width:iconS+6,height:iconS+6,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",borderRadius:4}} onMouseEnter={e=>e.currentTarget.style.background=theme.panelBorder+"10"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}><svg width={iconS} height={iconS} viewBox="0 0 16 16" fill="none" stroke={theme.headerText} strokeWidth="1.3" strokeLinecap="round" style={{opacity:0.5}}><path d="M4 4L12 12M12 4L4 12"/></svg></span>
        </div>
        <div onMouseDown={e=>startMove(e,expandPanel)} style={{cursor:"grab"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:activeTasks.length>0?8*cScale:0}}>
            <div style={{display:"flex",alignItems:"center",gap:7*cScale}}><div style={{width:7*cScale,height:7*cScale,borderRadius:"50%",background:activeTasks.length>0?theme.accentLeft:theme.divider,flexShrink:0}}/><span style={{fontSize:13*cScale,fontWeight:500,color:theme.headerText}}>{activeTasks.length>0?`${activeTasks.length} active`:"No active tasks"}</span></div>
            <span style={{fontSize:10*cScale,color:theme.headerText,opacity:0.6,marginRight:(iconS+6)*2+8}}>{tasks.length} total</span>
          </div>
          {shownActive.map(t=>(<div key={t.id} style={{fontSize:12*cScale,padding:`${3*cScale}px 0`,display:"flex",alignItems:"center",gap:7*cScale,color:theme.headerText}}><div style={{width:4*cScale,height:4*cScale,borderRadius:"50%",background:theme.divider,flexShrink:0}}/><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</span></div>))}
          {overC>0&&!showOverflow&&<div data-no-drag onClick={async e=>{e.stopPropagation();preOverflowH.current=window.innerHeight;const extraRows=overC;const rowH=Math.round(18*cScale);setShowOverflow(true);await resizeWindow(window.innerWidth,window.innerHeight+extraRows*rowH)}} style={{fontSize:14*cScale,color:theme.accentLeft,cursor:"pointer",padding:`${2*cScale}px 0`,textAlign:"center",opacity:0.7,letterSpacing:3,lineHeight:1}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.7"}>···</div>}
          {showOverflow&&<div data-no-drag onClick={async e=>{e.stopPropagation();setShowOverflow(false);const h=preOverflowH.current||collapsedSizeRef.current.h;preOverflowH.current=null;await resizeWindow(window.innerWidth,h)}} style={{fontSize:11*cScale,color:theme.accentLeft,cursor:"pointer",padding:`${2*cScale}px 0`,textAlign:"center",opacity:0.7}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.7"}>▲</div>}
        </div>
      </div>
  )}

  /* ── Expanded ── */
  return(
      <div ref={panelRef} style={{width:"100%",height:"100vh",background:theme.panelBg,border:`1.5px solid ${theme.panelBorder}`,borderRadius:14,display:"flex",flexDirection:"column",overflow:"hidden",userSelect:"none"}}>
        <ResizeHandles/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,zIndex:5,background:`linear-gradient(90deg,${theme.accentLeft},${theme.accentRight}80)`}}/>
        {showSearch&&<SearchOverlay tasks={tasks} archived={archived} allTags={tags} statuses={statuses} theme={theme} onClose={()=>setShowSearch(false)}/>}

        {/* Header */}
        <div onMouseDown={e=>startMove(e,collapsePanel)} style={{padding:"14px 16px 10px",flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"grab"}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <span style={{fontSize:15,fontWeight:500,color:theme.headerText}}>Tasks</span>
            <span style={{fontSize:11,color:theme.headerText,opacity:0.5}}>{tasks.length}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" style={{color:theme.headerText,opacity:0.5}}><path d="M7.5 3.5L5 1.5L2.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M7.5 7L5 5L2.5 7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:2}}>
            <span data-no-drag onClick={()=>window.location.reload()} style={{cursor:"pointer",padding:"2px 6px",borderRadius:6,display:"flex",alignItems:"center",opacity:0.4}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.4"}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={theme.headerText} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8a6 6 0 0111.5-2.5M14 2v3.5h-3.5"/><path d="M14 8a6 6 0 01-11.5 2.5M2 14v-3.5h3.5"/></svg>
            </span>
            <span data-no-drag onClick={()=>setShowSearch(true)} style={{cursor:"pointer",padding:"2px 6px",borderRadius:6,display:"flex",alignItems:"center",opacity:0.5}} onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0.5"}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={theme.headerText} strokeWidth="1.5" strokeLinecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4 4"/></svg>
            </span>
          </div>
        </div>

        {/* Filter */}
        <div data-no-drag style={{padding:"6px 16px 8px",flexShrink:0,display:"flex",gap:4,flexWrap:"wrap",borderBottom:`1px solid ${theme.divider}`}}>
          <span onClick={()=>setFilterTag(null)} style={{fontSize:10,padding:"2px 9px",borderRadius:99,cursor:"pointer",background:filterTag===null?theme.cardBg:"transparent",color:filterTag===null?theme.textPrimary:theme.textSecondary,border:filterTag===null?`1px solid ${theme.divider}`:"1px solid transparent",fontWeight:500}}>All</span>
          {tags.map(t=><span key={t.name} onClick={()=>setFilterTag(filterTag===t.name?null:t.name)} style={{fontSize:10,padding:"2px 9px",borderRadius:99,cursor:"pointer",background:filterTag===t.name?t.color+"18":"transparent",color:filterTag===t.name?t.color:theme.textSecondary,border:`1px solid ${filterTag===t.name?t.color+"35":"transparent"}`,fontWeight:500}}>{t.name}</span>)}
        </div>

        {/* Content */}
        <div data-no-drag style={{flex:1,overflowY:"auto",padding:"10px 14px 8px",userSelect:"text"}}>
          {!showArchive?groupedTasks.map(group=>(
            <div key={group.status.id} style={{marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,padding:"0 2px"}}><div style={{width:6,height:6,borderRadius:"50%",background:group.status.color,flexShrink:0}}/><span style={{fontSize:11,color:theme.textSecondary,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:500}}>{group.status.name}</span><span style={{fontSize:10,color:theme.textSecondary,opacity:0.5}}>{group.tasks.length}</span></div>
              {group.tasks.map(task=><TaskCard key={task.id} task={task} allTags={tags} statuses={statuses} theme={theme} onUpdate={handleStatusUpdate} onDelete={deleteTask} onDuplicate={duplicateTask} isDragOver={dragOverId===task.id} onDragStart={setDragFromId} onDragEnter={setDragOverId} onDragEnd={handleDragEnd}/>)}
            </div>
          )):(
            <><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}><span style={{fontSize:13,fontWeight:500,color:theme.headerText}}>Archived</span><span style={{fontSize:11,color:theme.textSecondary}}>{archived.length}</span></div>
            {archived.length===0&&<p style={{fontSize:12,color:theme.textSecondary,fontStyle:"italic",opacity:0.6}}>No archived tasks</p>}
            {archivedByWeek.map(g=><div key={g.week} style={{marginBottom:12}}><div style={{fontSize:10,color:theme.textSecondary,opacity:0.5,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:500}}>Week of {g.week}</div>{g.tasks.map(t=><ArchiveCard key={t.id} task={t} allTags={tags} statuses={statuses} onRestore={restoreTask} theme={theme}/>)}</div>)}</>
          )}
          {addingTask&&!showArchive&&<AddTaskForm allTags={tags} statuses={statuses} onAdd={addTask} onCancel={()=>setAddingTask(false)} theme={theme} defaultStatus={settings.defaultStatus}/>}
        </div>

        {/* Settings */}
        {showSettings&&<div data-no-drag style={{padding:"0 14px 8px",flexShrink:0,borderTop:`1px solid ${theme.divider}`,maxHeight:300,overflowY:"auto"}}><SettingsPanel theme={theme} themeName={themeName} onThemeChange={setThemeName} statuses={statuses} onStatusesChange={setStatuses} tags={tags} onTagsChange={setTags} settings={settings} onSettingsChange={handleSettingsChange} onExport={exportData} onImport={importData} userEmail={userEmail} localMode={localMode} onSignOut={onSignOut}/></div>}

        {/* Bottom */}
        <div data-no-drag style={{padding:"8px 14px 12px",flexShrink:0,borderTop:`1px solid ${theme.divider}`,background:theme.panelBg,display:"flex",gap:6,alignItems:"stretch"}}>
          <button onClick={()=>{setShowSettings(!showSettings);setShowArchive(false)}} style={{padding:"0 8px",borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${showSettings?theme.panelBorder:theme.newTaskBorder}`,background:showSettings?theme.panelBorder+"15":theme.btnBg,color:showSettings?theme.panelBorder:theme.headerText,display:"flex",alignItems:"center",justifyContent:"center"}}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/></svg></button>
          <button onClick={()=>{setShowArchive(!showArchive);setShowSettings(false)}} style={{padding:"0 8px",borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${showArchive?theme.panelBorder:theme.newTaskBorder}`,background:showArchive?theme.panelBorder+"15":theme.btnBg,color:showArchive?theme.panelBorder:theme.headerText,display:"flex",alignItems:"center",justifyContent:"center",gap:3}}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="4" rx="1"/><path d="M2 6v7a1 1 0 001 1h10a1 1 0 001-1V6"/><path d="M6 9h4"/></svg>{archived.length>0&&<span style={{fontSize:9,opacity:0.6}}>{archived.length}</span>}</button>
          {!showArchive&&archivable>0&&<button onClick={doArchive} style={{padding:"0 10px",borderRadius:10,cursor:"pointer",flexShrink:0,border:`1px solid ${theme.newTaskBorder}`,background:theme.btnBg,color:theme.headerText,display:"flex",alignItems:"center",gap:4,fontSize:11}} onMouseEnter={e=>e.currentTarget.style.borderColor=theme.panelBorder} onMouseLeave={e=>e.currentTarget.style.borderColor=theme.newTaskBorder}>Archive {archivable}</button>}
          {!showArchive&&<button onClick={()=>setAddingTask(!addingTask)} style={{flex:1,padding:"0",borderRadius:10,cursor:"pointer",border:`1px ${addingTask?"solid":"dashed"} ${addingTask?theme.panelBorder:theme.newTaskBorder}`,background:addingTask?theme.panelBorder+"15":"none",color:addingTask?theme.panelBorder:theme.headerText,fontSize:12,display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={e=>{if(!addingTask)e.currentTarget.style.borderColor=theme.panelBorder}} onMouseLeave={e=>{if(!addingTask)e.currentTarget.style.borderColor=theme.newTaskBorder}}>+ New</button>}
        </div>
        {cloudImportPending&&<ImportDialog data={cloudImportPending} theme={theme} title="Upload Local Data" description="Cloud storage is empty. Upload your local tasks to Supabase?" replaceLabel="Upload local data" replaceHint="Push your current local tasks and settings to the cloud" mergeLabel="Merge local into cloud" mergeHint="Keep the current state and sync any missing local items" onReplace={doCloudImportReplace} onMerge={doCloudImportMerge} onCancel={()=>setCloudImportPending(null)}/>}
        {importPending&&<ImportDialog data={importPending} theme={theme} onReplace={doImportReplace} onMerge={doImportMerge} onCancel={()=>setImportPending(null)}/>}
      </div>
  );
}
