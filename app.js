import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, getDocs, writeBatch, serverTimestamp, addDoc, startAfter, documentId } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { indexInvoices, position as libPosition, portfolio as libPortfolio } from "./lib/position.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const PAGE_SIZE = 250;
let userProfile = null;
let userRole = null;
let tamanConfig = { name: "", roads: [], monthlyFee: 80 };
const allResidents = [];
let allInvoices = []; 
/* Live bindings, NOT snapshots.
   admin/index.html renders analytics from window.allInvoices / window.allResidents.
   Assigning the array objects once made window.* point at the ORIGINAL empty
   arrays forever, because loadBilling() and deleteInvoice() REBIND allInvoices
   (allInvoices = []) instead of mutating it. Analytics then always rendered
   RM 0 / 0% / "No billing data found". Getters always resolve to the current
   binding, so every rebind site is covered without touching them. */
Object.defineProperty(window, "allResidents", { get: () => allResidents, configurable: true });
Object.defineProperty(window, "allInvoices", { get: () => allInvoices, configurable: true });

function qs(s, p = document) { return p.querySelector(s); }
function qsa(s, p = document) { return p.querySelectorAll(s); }

function toast(msg, type = "info") {
  const el = qs("#toast");
  const map = { error: "bg-red-600", success: "bg-emerald-600", info: "bg-blue-600" };
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[1000] px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-opacity duration-300 pointer-events-none text-white ${map[type]}`;
  el.textContent = msg; el.classList.remove("opacity-0");
  setTimeout(() => el.classList.add("opacity-0"), 3500);
}

function setLoading(btn, on) {
  if (on) { btn.dataset.og = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>`; btn.disabled = true; } 
  else { btn.innerHTML = btn.dataset.og || btn.textContent; btn.disabled = false; }
}

function closeModal(id) { qs(`#${id}`).classList.add("hidden"); }

function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* INITIALIZATION */
async function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { qs("#adminOverlay").classList.remove("hidden"); return; }
    const snap = await getDoc(doc(db, "admin_accounts", user.uid));
    if (!snap.exists()) { await signOut(auth); return; }
    userProfile = snap.data(); userRole = userProfile.role;
    qs("#adminOverlay").classList.add("hidden");
    qs("#userBadge").classList.remove("hidden");
    qs("#logoutBtn").classList.remove("hidden");
    qs("#userName").textContent = userProfile.name;
    qs("#userRole").textContent = userRole.replace("_", " ");
    applyRoleVisibility(); loadSettings(); showTab("news"); loadStats(); preloadResidentData();
  });
}

function applyRoleVisibility() {
  const map = {
    news: ["super_admin", "treasurer", "manager"],
    residents: ["super_admin", "manager"],
    visitors: ["super_admin", "manager"],
    billing: ["super_admin", "treasurer", "manager"],
    verify: ["super_admin", "treasurer"],
    analytics: ["super_admin", "treasurer", "manager"],
    settings: ["super_admin"]
  };
  qsa(".tab-btn").forEach(btn => {
    const roleOk = (map[btn.dataset.tab] || []).includes(userRole);
    const moduleOff = btn.dataset.tab === "visitors" && tamanConfig.visitorsEnabled === false;
    btn.style.display = roleOk && !moduleOff ? "flex" : "none";
  });
}

const BUILD_STAMP = "2026-10-27-m";

/* A module can be switched off for the whole Taman. The role gate decides WHO can
   see a tab; this gate decides WHETHER the feature exists at all. Both write
   inline `display`, so they can be applied in either order without fighting. */
function applyModuleVisibility() {
    const visitorsOn = tamanConfig.visitorsEnabled !== false;
    applyRoleVisibility();
    const card = qs("#statCardVisits");
    if (card) {
        card.style.display = visitorsOn ? "" : "none";
        if (card.parentElement) {
            card.parentElement.classList.toggle("grid-cols-3", visitorsOn);
            card.parentElement.classList.toggle("grid-cols-2", !visitorsOn);
        }
    }
    // never leave the committee parked on a tab that no longer exists
    const pane = qs("#tab-visitors");
    if (!visitorsOn && pane && !pane.classList.contains("hidden")) showTab("news");
    // a default tab the resident app cannot show is a broken landing page
    const defTab = qs("#residentDefaultTab");
    if (defTab && !visitorsOn && defTab.value === "invite") defTab.value = "news";
    const stamp = qs("#buildStamp");
    if (stamp) stamp.textContent = BUILD_STAMP;
}

qs("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = qs("#loginBtn"); setLoading(btn, true);
  try { await signInWithEmailAndPassword(auth, qs("#loginEmail").value.trim(), qs("#loginPassword").value); }
  catch (err) { toast("Login failed", "error"); }
  finally { setLoading(btn, false); }
});

qs("#logoutBtn").addEventListener("click", () => signOut(auth));

/* TAB NAVIGATION */
function showTab(name) {
  qsa(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  qsa(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  if (name === "news") loadNews();
  if (name === "residents") { loadResidents(); }
  if (name === "visitors") loadVisitors();
  if (name === "billing") { preloadResidentData().then(() => loadBilling(true)); updateInvoiceResidentList(); }
  if (name === "analytics") {
    preloadResidentData()
      .then(() => {
        /* figures come from the per-resident aggregates; scanning 8k invoices here
           was the single largest read cost in the app */
        if (typeof window.loadAnalytics === "function") window.loadAnalytics();
        else console.error("window.loadAnalytics is not defined — admin/index.html inline analytics module missing");
      })
      .catch(err => {
        console.error("Analytics load failed:", err);
        toast("Analytics failed to load", "error");
      });
  }
  if (name === "verify") { loadVerifyQueue(); }
  if (name === "settings") { loadSettings(); loadAdmins(); }
}
qsa(".tab-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* Spark budget: 50k reads/day. A realtime listener + a fresh getDocs on every tab
   open cost 342 reads each time. Cache the roster for five minutes instead; every
   write path below refreshes the specific resident it touches. */
const RES_TTL_MS = 5 * 60 * 1000;
let _resLoadedAt = 0;

async function preloadResidentData(force = false) {
    if (!force && allResidents.length && Date.now() - _resLoadedAt < RES_TTL_MS) return;
    // allow-full-read: the roster is 342 documents and every screen needs all of them
    const snap = await getDocs(collection(db, "residents"));
    allResidents.length = 0;
    snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
    _resLoadedAt = Date.now();
}

/* SETTINGS */
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "taman_config"));
  if (snap.exists()) {
    tamanConfig = snap.data();
    if(qs("#defaultMonthlyFee")) qs("#defaultMonthlyFee").value = tamanConfig.monthlyFee || 80;
    if(qs("#chatEnabledToggle")) qs("#chatEnabledToggle").checked = tamanConfig.isChatEnabled ?? true;
    if(qs("#visitorsEnabledToggle")) qs("#visitorsEnabledToggle").checked = tamanConfig.visitorsEnabled !== false;
    applyModuleVisibility();
    if(qs("#residentDefaultTab")) {
      const allowed = ["news", "bills", "invite"];
      qs("#residentDefaultTab").value = allowed.includes(tamanConfig.defaultTab) ? tamanConfig.defaultTab : "news";
    }
  }
  const msgDefaults = {
    msgAllClear: "Thank you! Your contributions keep our Taman safe.",
    msgPending: "Pending · help us keep our Taman safe",
    msgOutstanding: "Outstanding · we are counting on you to contribute",
    msgNoBills: "No bills issued to your unit yet.",
    msgProvisional: "Payment recorded — awaiting committee verification"
  };
  Object.entries(msgDefaults).forEach(([id, fallback]) => {
    const el = qs("#" + id);
    if (el) el.value = tamanConfig[id] || fallback;
  });
  qs("#tamanNameDisplay").textContent = tamanConfig.name || "TamanGuard";
  if(qs("#tamanNameInput")) qs("#tamanNameInput").value = tamanConfig.name || "";
  renderRoads();
}

function renderRoads() {
  const box = qs("#roadList"); if(!box) return; box.innerHTML = "";
  (tamanConfig.roads || []).forEach(r => {
    const chip = document.createElement("div");
    chip.className = "px-3 py-1 rounded-full bg-slate-700 text-xs flex items-center gap-2 border border-slate-600";
    chip.innerHTML = `<span>${r}</span><button class="hover:text-red-400">×</button>`;
    chip.querySelector("button").onclick = () => removeRoad(r);
    box.appendChild(chip);
  });
  const sel = qs("#resRoad"); if(sel) {
    sel.innerHTML = '<option value="">Road/Block Name</option>';
    (tamanConfig.roads || []).forEach(r => {
        const o = document.createElement("option"); o.value = r; o.textContent = r; sel.appendChild(o);
    });
  }
}

qs("#addRoadBtn").addEventListener("click", async () => {
    const v = qs("#newRoadName").value.trim(); if(!v) return;
    const roads = [...(tamanConfig.roads || []), v];
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads, updatedAt: serverTimestamp() });
    qs("#newRoadName").value = ""; loadSettings();
});

async function removeRoad(r) {
    if(!confirm(`Remove ${r}?`)) return;
    const roads = (tamanConfig.roads || []).filter(x => x !== r);
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads, updatedAt: serverTimestamp() });
    loadSettings();
}

qs("#saveSettingsBtn").addEventListener("click", async () => {
    const name = qs("#tamanNameInput").value.trim();
    const fee = parseFloat(qs("#defaultMonthlyFee").value) || 80;
    const isChatEnabled = qs("#chatEnabledToggle").checked; // Get toggle state
  const visitorsEnabled = qs("#visitorsEnabledToggle") ? qs("#visitorsEnabledToggle").checked : true;
    const defaultTab = qs("#residentDefaultTab") ? qs("#residentDefaultTab").value : "news";
  if(!name) return;
    const wording = {};
    ["msgAllClear", "msgPending", "msgOutstanding", "msgNoBills", "msgProvisional"].forEach(id => {
      const el = qs("#" + id);
      if (el) wording[id] = el.value.trim();
    });
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, ...wording, name, monthlyFee: fee, isChatEnabled: isChatEnabled, visitorsEnabled: visitorsEnabled, defaultTab: defaultTab, updatedAt: serverTimestamp() });
  applyModuleVisibility();
    toast("Config updated!", "success"); loadSettings();
});

async function loadAdmins() {
  // allow-full-read: two or three committee accounts
  const snap = await getDocs(collection(db, "admin_accounts"));
  const tbody = qs("#adminTableBody"); tbody.innerHTML = "";
  snap.forEach(d => {
    const data = d.data(); const tr = document.createElement("tr");
    tr.innerHTML = `<td class="py-3 text-white font-medium">${data.name}</td><td class="py-3 text-right"><button class="text-red-400"><i class="fas fa-trash"></i></button></td>`;
    tr.querySelector("button").onclick = async () => { if(confirm("Remove admin?")) { await deleteDoc(doc(db, "admin_accounts", d.id)); loadAdmins(); }};
    tbody.appendChild(tr);
  });
}

qs("#adminForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = qs("#adminSubmitBtn"); setLoading(btn, true);
    try {
        const email = qs("#admEmail").value.trim(); const pass = qs("#admPassword").value;
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, "admin_accounts", cred.user.uid), { name: qs("#admName").value.trim(), email, role: qs("#admRole").value, createdAt: serverTimestamp() });
        toast("Admin added!", "success"); closeModal("adminModal"); qs("#adminForm").reset(); loadAdmins();
    } catch(e) { toast(e.message, "error"); }
    finally { setLoading(btn, false); }
});

/* NEWS */
function loadNews() {
  onSnapshot(query(collection(db, "announcements"), limit(20)), (snap) => {
    const box = qs("#newsList"); box.innerHTML = "";
    // orderBy("createdAt") silently drops announcements with no createdAt — sort here instead
    const docs = snap.docs.slice().sort((a, b) => tsMillis(b.data().createdAt) - tsMillis(a.data().createdAt));
    docs.forEach(d => {
        const data = d.data(); const card = document.createElement("div"); 
        card.className = "glass rounded-xl p-5 relative border border-white/5";
        card.innerHTML = `
            <div class="flex justify-between items-start mb-2">
                <h4 class="font-bold text-lg text-white">${data.title}</h4>
                <button class="del-news text-slate-600 hover:text-red-400 transition-colors"><i class="fas fa-trash-alt"></i></button>
            </div>
            <p class="text-slate-300 text-sm leading-relaxed">${data.content}</p>
            <div class="mt-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest"><i class="far fa-clock mr-1"></i>${tsMillis(data.createdAt) ? new Date(tsMillis(data.createdAt)).toLocaleString("en-MY") : 'JUST NOW'}</div>`;
        card.querySelector(".del-news").onclick = async () => { if(confirm("Delete this news?")) await deleteDoc(doc(db, "announcements", d.id)); };
        box.appendChild(card);
    });
  });
}

qs("#postNewsBtn").addEventListener("click", async () => {
    const title = qs("#newsTitle").value.trim(); const content = qs("#newsContent").value.trim();
    if(!title || !content) return toast("Fill Title and Content", "error");
    setLoading(qs("#postNewsBtn"), true);
    try {
        await addDoc(collection(db, "announcements"), { title, content, image: qs("#newsImage").value.trim(), createdAt: serverTimestamp() });
        qs("#newsTitle").value = ""; qs("#newsContent").value = ""; qs("#newsImage").value = "";
        toast("News posted!", "success");
    } finally { setLoading(qs("#postNewsBtn"), false); }
});

/* RESIDENTS */
async function loadResidents(force = false) {
    try {
        await preloadResidentData(force);
        buildRoadChips(); renderResidents(); loadStats();
    } catch (e) { console.error("residents load failed", e); }
}

/* RESIDENTS — view mode + road filter */
let residentView = "card";
try { if (localStorage.getItem("tg_resident_view") === "list") residentView = "list"; } catch (e) { /* storage blocked */ }
let residentRoad = "All";

function residentRoadCounts() {
    const counts = new Map();
    allResidents.forEach(r => {
        const k = r.road || "Unassigned";
        counts.set(k, (counts.get(k) || 0) + 1);
    });
    return counts;
}

function paintResidentViewToggle() {
    document.querySelectorAll(".res-view-btn").forEach(b => {
        const on = b.dataset.view === residentView;
        b.className = "res-view-btn px-3 py-1.5 rounded-md text-xs font-bold transition-colors " +
            (on ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white");
    });
}

function buildRoadChips() {
    const wrap = qs("#residentRoadChips");
    if (!wrap) return;
    const counts = residentRoadCounts();
    const chip = (value, label, count, active) => `
        <button type="button" data-road="${value}" class="res-road-chip shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-colors ${active
            ? "bg-emerald-600 text-white"
            : "bg-slate-800 text-slate-300 border border-slate-700 hover:border-emerald-600"}">${label} · ${count}</button>`;
    const roads = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let html = chip("All", "All", allResidents.length, residentRoad === "All");
    roads.forEach(r => {
        html += chip(r, r.replace("Jalan Suasana ", ""), counts.get(r), residentRoad === r);
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll(".res-road-chip").forEach(btn => {
        btn.onclick = () => {
            residentRoad = btn.dataset.road;
            buildRoadChips();
            renderResidents();
        };
    });
}

/* ------------------------------------------------------------------
   Financial position per house = opening position carried forward
   (residents.soa*) + live invoices. Single source of truth for the
   residents list, dashboard and analytics.
   ------------------------------------------------------------------ */
let _invIdx = null, _invIdxKey = "";
function invoiceIndex() {
    const key = allInvoices.length + ":" + (allInvoices[allInvoices.length - 1]?.id || "");
    if (_invIdx && _invIdxKey === key) return _invIdx;
    _invIdx = indexInvoices(allInvoices);
    _invIdxKey = key;
    return _invIdx;
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/* Keep the aggregate on the resident document in step with the ledger. One extra
   write per payment/generation buys analytics with zero invoice scans. */
function bumpResidentAggregate(road, unit, delta = {}) {
    const res = allResidents.find(r => r.road === road && r.unitNumber === unit);
    if (!res) return null;
    res.soaCharged = Number(res.soaCharged || 0) + (delta.charged || 0);
    res.soaPaid = Number(res.soaPaid || 0) + (delta.paid || 0);
    res.soaBills = Number(res.soaBills || 0) + (delta.bills || 0);
    res.soaPaidCount = Number(res.soaPaidCount || 0) + (delta.paidCount || 0);
    res.soaPending = Math.max(0, Number(res.soaPending || 0) + (delta.pending || 0));
    res.soaPendingCount = Math.max(0, Number(res.soaPendingCount || 0) + (delta.pendingCount || 0));
    res.soaBalance = res.soaCharged - res.soaPaid - Number(res.soaAdvance || 0);
    if (res.id) {
        updateDoc(doc(db, "residents", res.id), {
            soaCharged: res.soaCharged, soaPaid: res.soaPaid, soaBalance: res.soaBalance,
            soaBills: res.soaBills, soaPaidCount: res.soaPaidCount,
            soaPending: res.soaPending, soaPendingCount: res.soaPendingCount
        }).catch(() => {});
    }
    return res;
}

/* Position from the cached aggregate only. Never from allInvoices: that array holds
   a 300-row slice of the ledger, and one bill for a house is not its full history. */
function residentPosition(res) {
    return libPosition(res, null, null);
}

/* Position from a house's COMPLETE bill list (profile / statement call this after
   querying that one house). */
function housePosition(res, invoices) {
    return libPosition(res, invoices || [], indexInvoices(invoices || []));
}

function portfolioTotals(list = allResidents) {
    /* cache only — allInvoices holds one page of the ledger, which is not a house's
       full history and would understate every balance it touched */
    return libPortfolio(list, null, null);
}

window.tgPosition = residentPosition;
/* preview the module-off state without saving it (no writes, local state only) */
window.tgPreviewVisitorModule = (on) => { tamanConfig.visitorsEnabled = on; applyModuleVisibility(); return tamanConfig.visitorsEnabled; };
window.tgPortfolio = portfolioTotals;
window.tgShowProfile = showResidentProfile;
window.tgMonthlyStats = async function () {
    // allow-full-read: 24 monthly summaries, one per billing month
    const snap = await getDocs(query(collection(db, "stats_monthly"), orderBy("ym")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

/* createdAt can be a Timestamp, {seconds}, ISO string or number — never assume. */
function tsMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v.seconds === "number") return v.seconds * 1000;
    if (typeof v === "number") return v;
    if (typeof v === "string") { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
    return 0;
}

function escHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money2(v) {
    return Math.abs(v).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function balanceBadge(res) {
    const b = residentPosition(res).balance;
    if (b > 0.004) return `<span class="text-[10px] font-bold text-rose-400 font-mono">RM ${money2(b)}</span>`;
    if (b < -0.004) return `<span class="text-[10px] font-bold text-emerald-400 font-mono">(${money2(b)})</span>`;
    return `<span class="text-[10px] font-bold text-slate-500 font-mono">nil</span>`;
}

function openStatement(res) {
    const url = `../statement.html?road=${encodeURIComponent(res.road || "")}&unit=${encodeURIComponent(res.unitNumber || "")}`;
    window.open(url, "_blank");
}

function residentCard(res) {
    const card = document.createElement("div");
    card.className = "glass rounded-xl p-4 hover:bg-slate-800/50 cursor-pointer transition-all group relative border border-slate-700/30";

    const statusBadge = res.isJoined
        ? `<span class="flex items-center gap-1 text-[9px] text-emerald-400 font-bold uppercase tracking-tighter bg-emerald-500/10 px-1.5 py-0.5 rounded-full"><i class="fas fa-check-circle"></i> Joined</span>`
        : `<span class="text-[9px] text-slate-500 font-bold uppercase tracking-tighter italic">Not Joined</span>`;

    card.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex flex-col gap-1">
                <h4 class="font-bold text-white group-hover:text-emerald-400 transition-colors">${res.name}</h4>
                ${statusBadge}
            </div>
            <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                <button class="invite-btn p-2 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white" title="Invite via WhatsApp">
                    <i class="fab fa-whatsapp text-xs"></i>
                </button>
                <button class="soa-btn p-2 rounded bg-slate-800 text-slate-500 hover:text-indigo-400" title="Statement of Account">
                    <i class="fas fa-file-invoice-dollar text-xs"></i>
                </button>
                <button class="edit-btn p-2 rounded bg-slate-800 text-slate-500 hover:text-blue-400">
                    <i class="fas fa-pen text-xs"></i>
                </button>
            </div>
        </div>
        <p class="text-[11px] text-slate-400 uppercase tracking-widest font-bold">Unit ${res.unitNumber} • ${res.road || '-'}</p>
        <p class="text-[11px] text-slate-500 mt-1">${res.phone}</p>
        <div class="mt-2 pt-2 border-t border-slate-700/50 flex justify-between items-center">
            <span class="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Balance</span>
            ${balanceBadge(res)}
        </div>`;

    card.querySelector(".soa-btn").onclick = (e) => { e.stopPropagation(); openStatement(res); };
    card.querySelector(".edit-btn").onclick = (e) => { e.stopPropagation(); openResidentModal(res.id, res); };
    card.querySelector(".invite-btn").onclick = (e) => { e.stopPropagation(); sendWhatsAppInvite(res); };
    card.onclick = () => showResidentProfile(res);
    return card;
}

function residentRow(res) {
    const row = document.createElement("div");
    row.className = "flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors";
    const dot = res.isJoined
        ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Joined"></span>'
        : '<span class="w-1.5 h-1.5 rounded-full bg-slate-600 shrink-0" title="Not joined"></span>';
    const phone = res.phone ? res.phone : '<span class="text-slate-600">no phone</span>';
    row.innerHTML = `
        <div class="w-11 h-11 shrink-0 rounded-lg bg-slate-800 border border-slate-700/60 flex items-center justify-center">
            <span class="text-[13px] font-black text-emerald-400">${res.unitNumber}</span>
        </div>
        <div class="min-w-0 flex-1">
            <p class="text-[13px] font-bold text-white leading-tight truncate">${res.name}</p>
            <p class="text-[11px] text-slate-400 truncate mt-0.5">${res.road || '-'} · ${phone}</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
            ${balanceBadge(res)}
            <button class="invite-btn p-2 rounded text-emerald-400 hover:bg-emerald-600/20" title="Invite via WhatsApp">
                <i class="fab fa-whatsapp text-xs"></i>
            </button>
            <button class="soa-btn p-2 rounded text-slate-400 hover:text-indigo-400" title="Statement of Account">
                <i class="fas fa-file-invoice-dollar text-xs"></i>
            </button>
            <button class="edit-btn p-2 rounded text-slate-500 hover:text-blue-400">
                <i class="fas fa-pen text-xs"></i>
            </button>
        </div>`;

    row.querySelector(".soa-btn").onclick = (e) => { e.stopPropagation(); openStatement(res); };
    row.querySelector(".edit-btn").onclick = (e) => { e.stopPropagation(); openResidentModal(res.id, res); };
    row.querySelector(".invite-btn").onclick = (e) => { e.stopPropagation(); sendWhatsAppInvite(res); };
    row.onclick = () => showResidentProfile(res);
    return row;
}

function renderResidents() {
    const grid = qs("#residentsGrid");
    if (!grid) return;
    grid.innerHTML = "";
    paintResidentViewToggle();

    const term = qs("#residentSearch").value.toLowerCase().trim();
    const rows = allResidents.filter(r => {
        if (residentRoad !== "All" && (r.road || "") !== residentRoad) return false;
        if (!term) return true;
        return `${r.name} ${r.unitNumber} ${r.phone} ${r.road || ""} ${r.payRef || ""}`.toLowerCase().includes(term);
    });

    if (residentView === "list") {
        grid.className = "flex flex-col";
        const wrap = document.createElement("div");
        wrap.className = "glass rounded-xl overflow-hidden border border-slate-700/50";
        if (!rows.length) {
            wrap.innerHTML = `<p class="text-center text-slate-500 text-xs py-10">No residents match.</p>`;
        } else {
            rows.forEach(r => wrap.appendChild(residentRow(r)));
        }
        grid.appendChild(wrap);
    } else {
        grid.className = "grid grid-cols-1 md:grid-cols-3 gap-4";
        if (!rows.length) {
            grid.innerHTML = `<p class="text-center text-slate-500 text-xs py-10 col-span-full">No residents match.</p>`;
        } else {
            rows.forEach(r => grid.appendChild(residentCard(r)));
        }
    }
}


// --- WHATSAPP INVITE LOGIC ---
function sendWhatsAppInvite(res) {
    const baseUrl = "https://bthosuasana.tamanguard.my"; 
    
    // 1. FIRST ENCODE: Handle the spaces/slashes in the Road name so the link doesn't break
    const u = encodeURIComponent(res.unitNumber);
    const r = encodeURIComponent(res.road);
    const p = encodeURIComponent(res.pin);

    // This creates a "clean" link with no spaces: ...?u=1&r=JLN%20SUASANA%205%2F3&p=1234
    const magicLink = `${baseUrl}?u=${u}&r=${r}&p=${p}`;

    // 2. Build the message text
    const rawMessage = `*TamanGuard Official Access*

Hello ${res.name}, welcome! Click the secure link below to instantly log in for Unit ${res.unitNumber}:

${magicLink}

Once logged in, you can generate guest passes and view bills.`;
    
    // 3. SECOND ENCODE: Wrap the whole message for the WhatsApp wa.me API
    const encodedMessage = encodeURIComponent(rawMessage);
    
    // 4. Format the phone number
    let phone = res.phone.replace(/\D/g, ''); 
    if (phone.startsWith('0')) phone = '6' + phone;
    else if (phone.startsWith('1')) phone = '60' + phone;

    // 5. Open WhatsApp
    window.open(`https://wa.me/${phone}?text=${encodedMessage}`, '_blank');
}

async function showResidentProfile(res) {
    const modal = qs("#residentProfileModal");
    qs("#profInitial").textContent = res.name.charAt(0).toUpperCase();
    qs("#profName").textContent = res.name;
    qs("#profMeta").textContent = `UNIT ${res.unitNumber} — ${res.road || '-'}`;
    qs("#profPhone").textContent = res.phone;
    qs("#profVehicle").textContent = res.vehiclePlate || '-';
    qs("#profPin").textContent = res.pin;

    const soaBtn = qs("#profSoaBtn");
    if (soaBtn) soaBtn.onclick = () => openStatement(res);

    const tbody = qs("#profHistoryBody");
    tbody.innerHTML = '<tr><td colspan="4" class="py-12 text-center text-slate-500"><span class="spinner"></span></td></tr>';
    modal.classList.remove("hidden");

    // one query for this house only (~24 docs). Unit numbers repeat across roads,
    // so both fields are filtered — a unit-only query reads 11 houses' bills.
    let history = [];
    try {
        const snap = await getDocs(query(collection(db, "invoices"),
            where("road", "==", res.road), where("unitNumber", "==", res.unitNumber)));
        history = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.year - a.year) || (MONTH_NAMES.indexOf(b.month) - MONTH_NAMES.indexOf(a.month)));
    } catch (e) { console.error("profile bills failed", e); }

    const pos = history.length ? housePosition(res, history) : residentPosition(res);

    const cell = (label, value, cls) => `
        <div class="bg-slate-800/30 border border-slate-700/50 rounded-lg px-3 py-2">
            <p class="text-[9px] uppercase font-bold tracking-widest text-slate-500">${label}</p>
            <p class="font-mono text-sm font-bold ${cls}">${value}</p>
        </div>`;
    const balCls = pos.balance > 0.004 ? "text-rose-400" : pos.balance < -0.004 ? "text-emerald-400" : "text-slate-400";
    const balTxt = pos.balance < -0.004 ? `(${money2(pos.balance)})` : money2(pos.balance);
    qs("#profSummary").innerHTML =
        cell("Payment Ref", res.payRef || "not assigned", "text-indigo-300") +
        cell("Charged", "RM " + money2(pos.charged), "text-slate-200") +
        cell("Paid", "RM " + money2(pos.paid), "text-emerald-400") +
        cell("Balance", "RM " + balTxt, balCls) +
        cell("Paid through", res.soaPaidThrough || (pos.paid > 0 ? "—" : "never"), "text-slate-300");

    tbody.innerHTML = "";

    if (!history.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-12 text-center text-slate-500 text-xs">No bills raised for this house yet.</td></tr>';
        return;
    }

    history.forEach(inv => {
        const isPaid = inv.status === "paid";
        const tr = document.createElement("tr");
        tr.className = "border-b border-slate-700/20";
        tr.innerHTML = `
            <td class="py-4 px-4 text-white">${inv.month || "-"} ${inv.year || ""}
                <span class="block text-[9px] text-slate-500">${escHtml(inv.remarks || "")}</span></td>
            <td class="py-4 px-4 text-slate-300 font-mono">RM ${parseFloat(inv.amount || 0).toFixed(2)}</td>
            <td class="py-4 px-4"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">${(inv.status || "").toUpperCase()}</span></td>
            <td class="py-4 px-4 text-right text-[10px] font-mono text-slate-500">${inv.receiptNumber || "NIL"}</td>`;
        tbody.appendChild(tr);
    });
}

qs("#residentSearch").addEventListener("input", debounce(() => renderResidents(), 100));

/* Residents view toggle — card / list, remembered across sessions */
document.querySelectorAll(".res-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        residentView = btn.dataset.view === "list" ? "list" : "card";
        try { localStorage.setItem("tg_resident_view", residentView); } catch (e) { /* storage blocked */ }
        renderResidents();
    });
});

/* BILLING */
let billingCursor = null;
async function loadBilling(reset = true) {
  /* 300 newest bills per page, newest first. The ledger is far too big to scan on
     a free-tier project (8k+ reads per open), and balances no longer depend on it:
     they come from the aggregates cached on each resident. */
  try {
    const base = collection(db, "invoices");
    const q = (!reset && billingCursor)
      ? query(base, orderBy("createdAt", "desc"), startAfter(billingCursor), limit(300))
      : query(base, orderBy("createdAt", "desc"), limit(300));
    const snap = await getDocs(q);
    if (reset) { allInvoices.length = 0; billingCursor = null; }
    snap.forEach(d => allInvoices.push({ id: d.id, ...d.data() }));
    billingCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
    renderInvoices(); loadStats();
  } catch (e) { console.error("billing load failed", e); }
}

/* The ledger is never scanned wholesale. All estate-wide figures come from the
   aggregates cached on the resident documents (see lib/position.js). */

function updateBillingDefaults() {
    const month = qs("#bulkMonth").value;
    const year = parseInt(qs("#bulkYear").value);
    if(!month || !year) return;
    qs("#bulkAmount").value = tamanConfig.monthlyFee || 80;
    qs("#bulkRemarks").value = `Security Payment for ${month.substring(0,3)} ${year}`;
    const monthIndex = ["January","February","March","April","May","June","July","August","September","October","November","December"].indexOf(month);
    const lastDay = new Date(year, monthIndex + 1, 0);
    const yyyy = lastDay.getFullYear();
    const mm = String(lastDay.getMonth() + 1).padStart(2, '0');
    const dd = String(lastDay.getDate()).padStart(2, '0');
    qs("#bulkDue").value = `${yyyy}-${mm}-${dd}`;
}

qs("#bulkMonth")?.addEventListener("change", updateBillingDefaults);
qs("#bulkYear")?.addEventListener("change", updateBillingDefaults);

/* ---- Monthly Billing Tool: collapsible so the bill list owns the screen ----
   Collapsed is the resting state; the open choice is remembered so a billing run
   is not interrupted by re-collapsing on every tab switch. */
function billingToolSummary() {
  const el = qs("#billingToolSummary"); if (!el) return;
  const m = qs("#bulkMonth")?.value || "";
  const y = qs("#bulkYear")?.value || "";
  const a = parseFloat(qs("#bulkAmount")?.value || 0);
  if (!m || !y) { el.textContent = "Tap to generate bills"; el.className = "text-[9px] text-slate-500 uppercase tracking-wide mt-0.5 truncate"; return; }
  el.textContent = m.slice(0, 3).toUpperCase() + " " + y + (a > 0 ? " · RM" + a : "");
  el.className = "text-[9px] font-mono text-purple-300 mt-0.5 truncate";
}

function setBillingToolOpen(open) {
  const body = qs("#billingToolBody"), chev = qs("#billingToolChevron");
  if (!body) return;
  body.classList.toggle("hidden", !open);
  if (chev) chev.style.transform = open ? "rotate(180deg)" : "";
  try { localStorage.setItem("billingToolOpen", open ? "1" : "0"); } catch (e) {}
}

function initBillingTool() {
  if (!qs("#billingToolToggle")) return;
  let open = false;
  try { open = localStorage.getItem("billingToolOpen") === "1"; } catch (e) {}
  setBillingToolOpen(open);
  qs("#billingToolToggle").addEventListener("click", () => {
    setBillingToolOpen(qs("#billingToolBody").classList.contains("hidden"));
  });
  ["#bulkMonth", "#bulkYear", "#bulkAmount"].forEach(sel => {
    qs(sel)?.addEventListener("change", billingToolSummary);
    qs(sel)?.addEventListener("input", billingToolSummary);
  });
  billingToolSummary();
}
initBillingTool();

function renderInvoices() {
  const tbody = qs("#invoicesTableBody"); if(!tbody) return;
  const rawTerm = qs("#invoiceSearch").value.toLowerCase().trim();
  const hidePaid = qs("#hidePaidToggle").checked;

  tbody.innerHTML = "";
  /* One index built once per render instead of a find() per invoice: 300 bills used
     to mean 300 full scans of 342 residents. Matching now covers what the committee
     actually types — unit, name, phone, road, payer reference and the bill title —
     and typed digits ignore the dashes/spaces people put in phone numbers. */
  const residentsByKey = new Map();
  allResidents.forEach(r => residentsByKey.set((r.road || "") + "|" + (r.unitNumber || ""), r));
  const digitsOnly = rawTerm.replace(/[^0-9]/g, "");
  const terms = rawTerm.split(/\s+/).filter(Boolean);

  const filtered = allInvoices.filter(inv => {
    if (hidePaid && inv.status === "paid") return false;
    if (!rawTerm) return true;
    const res = residentsByKey.get((inv.road || "") + "|" + (inv.unitNumber || ""));
    const unit = String(inv.unitNumber || "").toLowerCase();
    const road = String(inv.road || "").toLowerCase();
    const name = String(res?.name || "").toLowerCase();
    const phone = String(res?.phone || "").replace(/[^0-9]/g, "");
    const payRef = String(res?.payRef || "").toLowerCase();
    const title = String(inv.remarks || inv.title || "").toLowerCase();  // backfilled bills store the title in remarks
    const amount = String(inv.amount || "");

    // every word must match somewhere, so "5/3 azly" narrows instead of widening
    return terms.every(t => {
      const td = t.replace(/[^0-9]/g, "");
      return unit.includes(t) || name.includes(t) || road.includes(t) || payRef.includes(t) ||
             title.includes(t) || amount.includes(t) || (td.length >= 3 && phone.includes(td));
    });
  });

  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="7" class="py-12 text-center text-slate-500 text-xs">No matching bills.</td></tr>'; return; }

  const shown = filtered.slice(0, 300);
  shown.forEach(inv => {
    const isPaid = inv.status === 'paid';
    const st = inv.status || 'pending';
    const badge = st === 'paid'
        ? (inv.verification === 'legacy'
            ? `<span class="px-2 py-1 rounded-full text-[10px] font-bold bg-slate-600/30 text-slate-400" title="Reconstructed from the committee's coverage record — no receipt evidence">PAID · LEGACY</span>`
            : `<span class="px-2 py-1 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400">PAID · VERIFIED</span>`)
        : st === 'provisional'
            ? `<span class="px-2 py-1 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300">PROVISIONAL</span>`
            : st === 'void'
                ? `<span class="px-2 py-1 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-400" title="${(inv.voidReason || '').replace(/"/g, '&quot;')}">VOID</span>`
                : `<span class="px-2 py-1 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400">PENDING</span>`;
    const tr = document.createElement("tr"); tr.className = "hover:bg-slate-800/30 group border-b border-slate-700/30 transition-colors";

    tr.innerHTML = `
        <td class="px-4 py-4 font-mono text-[10px] text-slate-500">${inv.id.substring(0,8)}</td>
        <td class="px-4 py-4"><button class="view-h text-left hover:text-purple-400 transition-colors"><span class="block font-bold text-white">${inv.unitNumber}</span><span class="text-[10px] text-slate-500">${inv.road}</span></button></td>
        <td class="px-4 py-4 text-slate-300 text-xs">${inv.month || ''} ${inv.year || ''}</td>
        <td class="px-4 py-4 text-slate-500 text-[10px] italic max-w-[150px] truncate">${inv.remarks || '-'}</td>
        <td class="px-4 py-4 font-bold text-white">RM ${parseFloat(inv.amount || 0).toFixed(2)}</td>
        <td class="px-4 py-4">${badge}</td>
        <td class="px-4 py-4 text-right">
            <div class="flex justify-end gap-2 items-center">
                ${st === 'pending'
                    ? `<button class="pay-b bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded text-[10px] font-bold">RECORD</button>`
                    : st === 'provisional'
                        ? (isVerifier()
                            ? `<button class="verify-b bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded text-[10px] font-bold">VERIFY</button><button class="void-b text-slate-600 hover:text-rose-400 p-1" title="Void"><i class="fas fa-ban text-[10px]"></i></button>`
                            : `<span class="text-[10px] text-indigo-300 font-bold">AWAITING TREASURER</span>`)
                        : (inv.receiptNumber
                            ? `<button class="view-rcpt text-blue-400 font-mono text-[10px] hover:underline">${inv.receiptNumber}</button>`
                            : `<span class="text-[10px] font-mono text-slate-600">NIL</span>`)
                }
                <button class="del-b text-slate-600 hover:text-red-500 p-1"><i class="fas fa-trash-alt text-xs"></i></button>
            </div>
        </td>`;

    tr.querySelector(".view-h").onclick = () => showHouseHistoryModal(inv.unitNumber, inv.road);
    if(tr.querySelector(".view-rcpt")) tr.querySelector(".view-rcpt").onclick = () => showReceipt(inv);
    if(tr.querySelector(".pay-b")) tr.querySelector(".pay-b").onclick = () => recordPayment(inv.id);
    if(tr.querySelector(".verify-b")) tr.querySelector(".verify-b").onclick = async (e) => {
        const note = prompt("Verify payment — bank reference or statement date:\n(e.g. MBB 26/10 ref 53-001)");
        if (!note) return;
        e.target.disabled = true;
        try { await verifyPayment(inv.id, note); loadBilling(true); loadStats(); renderResidents(); }
        catch (err) { toast("Verification failed", "error"); e.target.disabled = false; }
    };
    if(tr.querySelector(".void-b")) tr.querySelector(".void-b").onclick = async () => {
        const reason = prompt("Void this recorded payment — reason:");
        if (!reason || reason.trim().length < 3) return;
        await voidPayment(inv.id, reason.trim());
    };
    tr.querySelector(".del-b").onclick = () => deleteInvoice(inv.id);
    tbody.appendChild(tr);
  });

  if (!rawTerm && shown.length >= 300 && billingCursor) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" class="py-4 text-center"><button id="loadMoreBills" class="text-[10px] font-bold uppercase tracking-widest text-indigo-400 hover:text-indigo-300">Load 300 older bills</button></td>';
    tr.querySelector("#loadMoreBills").onclick = (e) => { e.target.disabled = true; e.target.textContent = "Loading…"; loadBilling(false); };
    tbody.appendChild(tr);
  }
}

function showReceipt(inv) {
    qs("#rcptTamanName").textContent = tamanConfig.name || "TAMANGUARD";
    qs("#rcptNo").textContent = inv.receiptNumber || "NIL";
    qs("#rcptDate").textContent = inv.paidAt?.toDate().toLocaleDateString('en-GB') || '-';
    qs("#rcptUnit").textContent = `${inv.unitNumber} (${inv.road})`;
    qs("#rcptRemarks").textContent = inv.remarks || `${inv.month} ${inv.year} Maintenance`;
    qs("#rcptAmount").textContent = parseFloat(inv.amount).toFixed(2);
    qs("#receiptViewModal").classList.remove("hidden");
}

async function deleteInvoice(id) {
    if(!confirm("Are you sure you want to delete this bill?")) return;
    try {
        const gone = allInvoices.find(i => i.id === id);
        await deleteDoc(doc(db, "invoices", id));
        allInvoices = allInvoices.filter(i => i.id !== id);
        if (gone) bumpResidentAggregate(gone.road, gone.unitNumber, {
            charged: -(parseFloat(gone.amount) || 0), bills: -1,
            paid: gone.status === "paid" ? -(parseFloat(gone.amount) || 0) : 0,
            paidCount: gone.status === "paid" ? -1 : 0
        });
        renderInvoices(); loadStats();
        toast("Bill deleted", "info");
    } catch(e) { toast("Error deleting", "error"); }
}

function syncHidePaidChip() {
  const on = qs("#hidePaidToggle")?.checked;
  const chip = qs("#hidePaidChip"), icon = qs("#hidePaidChipIcon");
  if (chip) chip.className = "h-[38px] flex items-center gap-1.5 px-3 rounded-lg border cursor-pointer whitespace-nowrap text-[10px] font-black uppercase tracking-wide " +
    (on ? "bg-purple-500/20 border-purple-500/50 text-purple-300" : "bg-slate-800 border-slate-700 text-slate-400");
  if (icon) icon.textContent = on ? "☑" : "☐";
}

qs("#invoiceSearch").addEventListener("input", debounce(() => {
  const btn = qs("#invoiceSearchClear");
  if (btn) btn.classList.toggle("hidden", !qs("#invoiceSearch").value);
  renderInvoices();
}, 50));
qs("#hidePaidToggle").addEventListener("change", () => { syncHidePaidChip(); renderInvoices(); });
qs("#invoiceSearchClear")?.addEventListener("click", () => {
  qs("#invoiceSearch").value = "";
  qs("#invoiceSearchClear").classList.add("hidden");
  qs("#invoiceSearch").focus();
  renderInvoices();
});
syncHidePaidChip();

/* ---- House History bulk selection -------------------------------------------------
   Ticking exists so a backlog of recorded months is verified in one pass instead of one
   prompt per bill. Pending and provisional are tickable; paid and void are not, because
   they have no action left. Record and Verify never merge into one button: they are two
   different officers' steps under the two-person rule. */
let historyRows = [];
const historySel = new Set();

function isTickable(inv) {
    const st = inv.status || "pending";
    if (st === "pending") return true;
    if (st === "provisional") return isVerifier();
    return false;
}

function paintHistoryRow(tr, on) {
    tr.classList.toggle("bg-indigo-500/10", on);
    const cb = tr.querySelector(".h-sel");
    if (cb) cb.checked = on;
}

function historySelectedRows() { return historyRows.filter(r => historySel.has(r.id)); }

function updateHistoryBulk() {
    const bar = qs("#historyBulkBar"); if (!bar) return;
    const sel = historySelectedRows();
    const pend = sel.filter(r => (r.status || "pending") === "pending");
    const prov = sel.filter(r => r.status === "provisional");
    const sum = rows => rows.reduce((t, r) => t + (parseFloat(r.amount) || 0), 0);

    bar.classList.toggle("hidden", sel.length === 0);

    const cnt = qs("#historyBulkCount");
    if (cnt) {
        const mixed = pend.length > 0 && prov.length > 0;
        cnt.textContent = mixed
            ? `${prov.length} provisional · RM${sum(prov).toFixed(2)}  ·  ${pend.length} pending · RM${sum(pend).toFixed(2)}`
            : `${sel.length} selected · RM${sum(sel).toFixed(2)}`;
        cnt.className = "text-[10px] font-black uppercase tracking-wider " +
            (mixed ? "text-slate-300" : prov.length ? "text-indigo-300" : "text-emerald-300");
    }

    const vBtn = qs("#historyVerifyBtn"), rBtn = qs("#historyRecordBtn");
    if (vBtn) { vBtn.classList.toggle("hidden", prov.length === 0); vBtn.textContent = `Verify ${prov.length}`; }
    if (rBtn) { rBtn.classList.toggle("hidden", pend.length === 0); rBtn.textContent = `Record ${pend.length}`; }

    const all = qs("#historySelectAll");
    if (all) {
        const tickable = historyRows.filter(isTickable).length;
        all.checked = tickable > 0 && sel.length === tickable;
        all.indeterminate = sel.length > 0 && sel.length < tickable;
    }
}

function initHistoryBulkHandlers(unit, road) {
    const all = qs("#historySelectAll");
    if (all) all.onchange = () => {
        historySel.clear();
        if (all.checked) historyRows.filter(isTickable).forEach(r => historySel.add(r.id));
        qs("#historyTableBody").querySelectorAll("tr").forEach(tr => {
            const cb = tr.querySelector(".h-sel");
            if (cb) paintHistoryRow(tr, historySel.has(cb.dataset.id));
        });
        updateHistoryBulk();
    };

    const clear = qs("#historyClearSel");
    if (clear) clear.onclick = () => {
        historySel.clear();
        qs("#historyTableBody").querySelectorAll("tr").forEach(tr => paintHistoryRow(tr, false));
        updateHistoryBulk();
    };

    const vBtn = qs("#historyVerifyBtn");
    if (vBtn) vBtn.onclick = async () => {
        const note = (qs("#historyBankRef")?.value || "").trim();
        if (note.length < 3) { toast("Bank reference or date is required", "error"); qs("#historyBankRef")?.focus(); return; }
        try { localStorage.setItem("historyBankRef", note); } catch (e) {}
        const rows = historySelectedRows().filter(r => r.status === "provisional");
        if (!rows.length) return;
        const label = vBtn.textContent;
        vBtn.disabled = true; vBtn.innerHTML = '<span class="spinner"></span>';
        try { await verifyBatch(rows, note); } finally { vBtn.disabled = false; vBtn.textContent = label; }
        showHouseHistoryModal(unit, road);
    };

    const rBtn = qs("#historyRecordBtn");
    if (rBtn) rBtn.onclick = async () => {
        const rows = historySelectedRows().filter(r => (r.status || "pending") === "pending");
        if (!rows.length) return;
        const note = (qs("#historyBankRef")?.value || "").trim();
        try { localStorage.setItem("historyBankRef", note); } catch (e) {}
        const label = rBtn.textContent;
        rBtn.disabled = true; rBtn.innerHTML = '<span class="spinner"></span>';
        let ok = 0, failed = 0;
        for (const inv of rows) {
            try { await recordPayment(inv.id, { method: "cash", reference: note, silent: true }, inv); ok++; }
            catch (e) { console.error("bulk record failed", inv.id, e); failed++; }
        }
        rBtn.disabled = false; rBtn.textContent = label;
        toast(`${ok} recorded${failed ? `, ${failed} failed` : ""} — awaiting verification`, failed ? "error" : "info");
        loadBilling(true); loadStats(); renderResidents();
        showHouseHistoryModal(unit, road);
    };
}

async function showHouseHistoryModal(unit, road) {
    const tbody = qs("#historyTableBody"); qs("#historyUnitTitle").textContent = `${unit} — ${road}`;
    tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500"><span class="spinner"></span></td></tr>';
    const snap = await getDocs(query(collection(db, "invoices"),
        where("road", "==", road), where("unitNumber", "==", unit)));
    const history = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a,b) => (b.year - a.year) || (MONTH_NAMES.indexOf(b.month) - MONTH_NAMES.indexOf(a.month)));

    historyRows = history;
    historySel.clear();
    if (qs("#historyBankRef")) {
        qs("#historyBankRef").value = (() => { try { return localStorage.getItem("historyBankRef") || "CASH"; } catch(e) { return "CASH"; } })();
    }

    tbody.innerHTML = "";
    if (!history.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500 text-xs">No bills for this house.</td></tr>';
        updateHistoryBulk(); initHistoryBulkHandlers(unit, road);
        qs("#historyModal").classList.remove("hidden");
        return;
    }

    history.forEach(inv => {
        const tr = document.createElement("tr"); tr.className = "border-b border-slate-700/20 hover:bg-slate-800/30 transition-colors";
        const st = inv.status || 'pending';
        const third = st === 'paid'
            ? `<span class="text-[10px] font-bold text-emerald-400">PAID</span>`
            : st === 'provisional'
                ? `<span class="text-[10px] font-bold text-indigo-300">PROVISIONAL</span>`
                : st === 'void'
                    ? `<span class="text-[10px] font-bold text-rose-400">VOID</span>`
                    : `<span class="text-[10px] font-bold text-amber-400">PENDING</span>`;
        const action = st === 'pending'
            ? `<button class='h-pay-btn bg-emerald-600 text-white text-[10px] font-bold px-3 py-1.5 rounded'>RECORD</button>`
            : st === 'provisional'
                ? (isVerifier()
                    ? `<button class='h-verify-btn bg-indigo-600 text-white text-[10px] font-bold px-3 py-1.5 rounded'>VERIFY</button>`
                    : `<span class='text-[10px] text-indigo-300 font-bold'>AWAITING</span>`)
                : `<span class='text-[10px] text-slate-500 font-mono'>${inv.receiptNumber || 'NIL'}</span>`;
        tr.innerHTML = `<td class="px-2 py-4">${isTickable(inv) ? `<input type="checkbox" class="h-sel w-4 h-4 accent-indigo-500 align-middle" data-id="${inv.id}">` : ""}</td>`
            + `<td class="px-3 py-4 text-white font-medium">${inv.month || ''} ${inv.year || ''}</td>`
            + `<td class="px-3 py-4 text-slate-300">RM ${parseFloat(inv.amount || 0).toFixed(2)}</td>`
            + `<td class="px-3 py-4">${third}</td>`
            + `<td class="px-3 py-4 text-right">${action}</td>`;

        const cb = tr.querySelector(".h-sel");
        if (cb) cb.addEventListener("change", () => {
            if (cb.checked) historySel.add(inv.id); else historySel.delete(inv.id);
            paintHistoryRow(tr, cb.checked);
            updateHistoryBulk();
        });

        if (tr.querySelector(".h-pay-btn")) {
            tr.querySelector(".h-pay-btn").onclick = async (e) => {
                e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span>';
                await recordPayment(inv.id, {}, inv); showHouseHistoryModal(unit, road);
            };
        }
        if (tr.querySelector(".h-verify-btn")) {
            tr.querySelector(".h-verify-btn").onclick = async (e) => {
                const note = prompt("Verify payment — bank reference or statement date:");
                if (!note) return;
                e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span>';
                try { await verifyPayment(inv.id, note, inv); } catch (err) { toast("Verification failed", "error"); }
                showHouseHistoryModal(unit, road);
            };
        }
        tbody.appendChild(tr);
    });

    updateHistoryBulk();
    initHistoryBulkHandlers(unit, road);
    qs("#historyModal").classList.remove("hidden");
}

/* ============================================================
   PAYMENTS — two-person control
   Anyone on the committee RECORDS a payment; only a Treasurer or
   Super Admin VERIFIES it. A recorded payment is provisional: it does
   not count as collected and the resident does not see PAID.
   ============================================================ */

function isVerifier() { return userRole === "treasurer" || userRole === "super_admin"; }

/* Keep the 24 monthly summaries in step with the ledger. One extra write per
   payment transition; the trend chart then costs 24 reads instead of 8,184. */
async function bumpMonthly(month, year, delta = {}) {
    const MONTHS = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
    const idx = MONTHS.indexOf(month);
    if (idx < 0 || !year) return;
    const ym = year + "-" + String(idx + 1).padStart(2, "0");
    try {
        const ref = doc(db, "stats_monthly", ym);
        const snap = await getDoc(ref);
        if (!snap.exists()) return;
        const cur = snap.data();
        await updateDoc(ref, {
            paid: Number(cur.paid || 0) + (delta.paid || 0),
            paidCount: Math.max(0, Number(cur.paidCount || 0) + (delta.paidCount || 0)),
            pending: Math.max(0, Number(cur.pending || 0) + (delta.pending || 0)),
            pendingCount: Math.max(0, Number(cur.pendingCount || 0) + (delta.pendingCount || 0))
        });
    } catch (e) { console.error("monthly summary bump failed", e); }
}

async function logPaymentEvent(invoiceId, action, from, to, note) {
    try {
        await addDoc(collection(db, "payment_events"), {
            invoiceId, action, from, to,
            by: auth.currentUser.uid,
            byName: (userProfile && userProfile.name) || "",
            at: serverTimestamp(),
            note: note || ""
        });
    } catch (e) { console.error("audit log failed", e); }
}

async function recordPayment(id, opts = {}, invDoc = null) {
    const inv = invDoc || allInvoices.find(i => i.id === id) || {};
    const rcpt = `RCP-${Date.now()}`;
    await updateDoc(doc(db, "invoices", id), {
        status: "provisional",
        recordedBy: auth.currentUser.uid,
        recordedAt: serverTimestamp(),
        receiptNumber: rcpt,
        paymentMethod: opts.method || "cash",
        paymentReference: opts.reference || ""
    });
    await logPaymentEvent(id, "recorded", "pending", "provisional", opts.method || "cash");

    const amt = parseFloat(inv.amount) || 0;
    if (inv.id) {
        Object.assign(inv, { status: "provisional", receiptNumber: rcpt, recordedBy: auth.currentUser.uid });
        bumpResidentAggregate(inv.road, inv.unitNumber, { pending: amt, pendingCount: 1 });
        bumpMonthly(inv.month, inv.year, { pending: amt, pendingCount: 1 });
    }
    // soaPaid is untouched on purpose: provisional money is not collected money
    if (!opts.silent) {
        toast("Recorded — awaiting Treasurer verification", "info");
        loadBilling(true); loadStats(); renderResidents();
    }
}

async function verifyPayment(id, note, invDoc = null) {
    const inv = invDoc || allInvoices.find(i => i.id === id) || {};
    if (!note || note.trim().length < 3) { toast("Bank reference or date is required", "error"); return false; }
    const self = auth.currentUser.uid === inv.recordedBy;
    await updateDoc(doc(db, "invoices", id), {
        status: "paid",
        verification: "verified",
        verifiedBy: auth.currentUser.uid,
        verifiedAt: serverTimestamp(),
        verifyNote: note.trim(),
        selfVerified: self
    });
    await logPaymentEvent(id, "verified", "provisional", "paid", (note + (self ? " [self-verified]" : "")));
    const amt = parseFloat(inv.amount) || 0;
    if (inv.id) {
        Object.assign(inv, { status: "paid", verification: "verified", verifiedBy: auth.currentUser.uid });
        bumpResidentAggregate(inv.road, inv.unitNumber,
            { paid: amt, paidCount: 1, pending: -amt, pendingCount: -1 });
        bumpMonthly(inv.month, inv.year, { paid: amt, paidCount: 1, pending: -amt, pendingCount: -1 });
    }
    return true;
}

async function voidPayment(id, reason, invDoc = null) {
    const inv = invDoc || allInvoices.find(i => i.id === id) || {};
    await updateDoc(doc(db, "invoices", id), {
        status: "void",
        voidReason: reason,
        voidedBy: auth.currentUser.uid,
        voidedAt: serverTimestamp()
    });
    await logPaymentEvent(id, "voided", inv.status || "?", "void", reason);
    const amt = parseFloat(inv.amount) || 0;
    if (inv.status === "paid") {
        bumpResidentAggregate(inv.road, inv.unitNumber, { paid: -amt, paidCount: -1 });
        bumpMonthly(inv.month, inv.year, { paid: -amt, paidCount: -1 });
    } else if (inv.status === "provisional") {
        bumpResidentAggregate(inv.road, inv.unitNumber, { pending: -amt, pendingCount: -1 });
        bumpMonthly(inv.month, inv.year, { pending: -amt, pendingCount: -1 });
    }
    if (inv.id) Object.assign(inv, { status: "void", voidReason: reason });
    toast("Payment voided", "info");
    loadBilling(true); loadStats(); renderResidents();
}

/* Batch confirm — reconciliation happens once, against the bank statement. */
async function verifyBatch(items, note) {
    let ok = 0, failed = 0;
    for (const it of items) {
        const id = typeof it === "string" ? it : it.id;
        const invDoc = typeof it === "string" ? null : it;
        try { if (await verifyPayment(id, note, invDoc)) ok++; else failed++; }
        catch (e) { console.error("verify failed", id, e); failed++; }
    }
    toast(`${ok} verified${failed ? `, ${failed} failed` : ""}`, failed ? "error" : "success");
    loadBilling(true); loadStats(); renderResidents(); loadVerifyQueue();
}

/* ===== Verification queue (treasurer / super_admin) ===== */
let verifyItems = [];

async function loadVerifyQueue() {
    const btn = qs("#verifyTabBtn");
    if (btn) btn.classList.toggle("hidden", !isVerifier());
    if (!isVerifier()) return;

    const tbody = qs("#verifyTableBody"); if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500 text-xs"><span class="spinner"></span></td></tr>';

    // who recorded what — map uid to a human name
    const names = {};
    try {
        // allow-full-read: a handful of committee accounts, read once when the queue opens
        const admins = await getDocs(collection(db, "admin_accounts"));
        admins.forEach(d => { names[d.id] = (d.data().name || d.data().email || "unknown"); });
    } catch (e) { console.error("admin names failed", e); }

    let snap;
    try {
        snap = await getDocs(query(collection(db, "invoices"), where("status", "==", "provisional"), limit(100)));
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-rose-400 text-xs">Could not load the queue.</td></tr>';
        return;
    }

    verifyItems = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => tsMillis(b.recordedAt) - tsMillis(a.recordedAt));

    const count = qs("#verifyCount");
    if (count) {
        count.textContent = verifyItems.length;
        count.classList.toggle("hidden", !verifyItems.length);
    }
    qs("#verifyEmpty")?.classList.toggle("hidden", verifyItems.length > 0);

    tbody.innerHTML = "";
    verifyItems.forEach(inv => {
        const tr = document.createElement("tr");
        tr.className = "border-b border-slate-700/30";
        tr.innerHTML = `
            <td class="py-3 px-3"><input type="checkbox" class="v-check" data-id="${inv.id}"></td>
            <td class="py-3 px-3"><span class="block font-bold text-white text-xs">${inv.unitNumber}</span><span class="text-[10px] text-slate-500">${inv.road}</span></td>
            <td class="py-3 px-3 text-slate-300 text-xs">${inv.month || ''} ${inv.year || ''}</td>
            <td class="py-3 px-3 font-bold text-white text-xs">RM ${parseFloat(inv.amount || 0).toFixed(2)}</td>
            <td class="py-3 px-3 text-slate-400 text-xs">${names[inv.recordedBy] || 'unknown'}</td>
            <td class="py-3 px-3 text-right font-mono text-[10px] text-slate-500">${inv.receiptNumber || 'NIL'}</td>`;
        tbody.appendChild(tr);
    });
}

qs("#verifySelectAll")?.addEventListener("change", (e) => {
    qsa(".v-check").forEach(c => { c.checked = e.target.checked; });
});

qs("#verifyAllBtn")?.addEventListener("click", async () => {
    const note = qs("#verifyNote").value.trim();
    if (note.length < 3) { toast("Bank reference or statement date is required", "error"); return; }
    const ids = qsa(".v-check").filter(c => c.checked).map(c => c.dataset.id);
    if (!ids.length) { toast("Select at least one payment", "error"); return; }
    if (!confirm(`Confirm ${ids.length} payment(s) against: "${note}"?`)) return;
    const btn = qs("#verifyAllBtn"); setLoading(btn, true);
    try { await verifyBatch(ids, note); } finally { setLoading(btn, false); qs("#verifyNote").value = ""; }
});

/* GENERATE ALL (FIXED ID SANITIZATION) */
qs("#generateBulkBtn").addEventListener("click", async () => {
    const m = qs("#bulkMonth").value; 
    const y = qs("#bulkYear").value; 
    const a = parseFloat(qs("#bulkAmount").value);
    const rem = qs("#bulkRemarks").value.trim();
    const due = qs("#bulkDue").value; 
    if(!m || isNaN(a)) return toast("Month and Amount required", "error");
    setLoading(qs("#generateBulkBtn"), true);
    try {
        const batch = writeBatch(db);
        allResidents.forEach(r => {
            // keep the cached aggregate in step with the bill being raised
            r.soaCharged = Number(r.soaCharged || 0) + a;
            r.soaBills = Number(r.soaBills || 0) + 1;
            r.soaBalance = r.soaCharged - Number(r.soaPaid || 0) - Number(r.soaAdvance || 0);
            if (r.id) batch.update(doc(db, "residents", r.id), {
                soaCharged: r.soaCharged, soaBills: r.soaBills, soaBalance: r.soaBalance
            });
            const safeRoad = r.road.replace(/[\s/]+/g, '-');
            const safeUnit = r.unitNumber.replace(/[\s/]+/g, '-');
            const id = `INV-${safeUnit}-${safeRoad}-${m}-${y}`;
            batch.set(doc(db, "invoices", id), { 
                invoiceId: id, unitNumber: r.unitNumber, road: r.road, 
                month: m, year: parseInt(y), amount: a, remarks: rem,
                dueDate: due, status: "pending", createdAt: serverTimestamp() 
            });
        });
        await batch.commit(); toast("Bills generated!", "success"); loadBilling(true);
    } catch(e) { toast("Generation failed.", "error"); }
    finally { setLoading(qs("#generateBulkBtn"), false); }
});

// Locate the qs("#invoiceForm").addEventListener("submit" ... section and replace it
qs("#invoiceForm").addEventListener("submit", async (e) => {
    e.preventDefault(); 
    const unit = qs("#invUnit").value; 
    const amount = parseFloat(qs("#invAmount").value);
    const remarks = qs("#invRemarks").value.trim(); 
    const dueDateValue = qs("#invDue").value; 

    if(!unit || isNaN(amount) || !dueDateValue) return toast("Please fill all fields", "error");

    setLoading(qs("#invoiceSubmitBtn"), true);

    try {
        // Parse the picked date to get the Month Name and Year
        const parts = dueDateValue.split('-'); // [YYYY, MM, DD]
        const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        
        const selectedMonth = months[parseInt(parts[1]) - 1]; // Converts "05" to "May"
        const selectedYear = parseInt(parts[0]);            // Converts "2026" to 2026

        await addDoc(collection(db, "invoices"), { 
            unitNumber: unit, 
            road: qs("#invRoad").value, 
            amount: amount, 
            month: selectedMonth,   // THIS FIXES THE "CUSTOM" LABEL
            year: selectedYear,    // SETS THE CHOSEN YEAR
            remarks: remarks || 'Custom Bill', 
            dueDate: dueDateValue,
            status: "pending", 
            createdAt: serverTimestamp() 
        });
        
        bumpResidentAggregate(qs("#invRoad").value, unit, { charged: amount, bills: 1 });
        toast("Custom bill created", "success"); 
        closeModal("invoiceModal"); 
        qs("#invoiceForm").reset(); 
        loadBilling(true);
    } catch(e) { 
        console.error(e);
        toast("Error creating bill", "error"); 
    } finally { 
        setLoading(qs("#invoiceSubmitBtn"), false); 
    }
});

function updateInvoiceResidentList() {
    const sel = qs("#invResidentSelect"); if(!sel) return;
    sel.innerHTML = '<option value="">-- Choose Resident --</option>';
    allResidents.forEach(r => {
        const o = document.createElement("option"); o.value = JSON.stringify({u: r.unitNumber, r: r.road});
        o.textContent = `Unit ${r.unitNumber} (${r.road}) - ${r.name}`; sel.appendChild(o);
    });
}
qs("#invResidentSelect")?.addEventListener("change", (e) => {
    if(!e.target.value) return; const data = JSON.parse(e.target.value);
    qs("#invUnit").value = data.u; qs("#invRoad").value = data.r;
});

/* VISITORS & STATS */

async function loadVisitors() {
    const snap = await getDocs(query(collection(db, "visits"), orderBy("entryTime", "desc"), limit(50)));
    const tbody = qs("#visitorsTableBody"); 
    tbody.innerHTML = "";
    
    snap.forEach(d => {
        const data = d.data();
        const tr = document.createElement("tr");
        tr.className = "hover:bg-slate-800/40 transition-colors group";

        // Status Style Logic
        const status = (data.status || 'PENDING').toUpperCase();
        let sStyle = "text-slate-400 bg-slate-400/10";
        if(status === 'PENDING')   sStyle = "text-amber-400 bg-amber-500/10 border-amber-500/20";
        if(status === 'ENTERED')   sStyle = "text-blue-400 bg-blue-500/10 border-blue-500/20";
        if(status === 'EXITED')    sStyle = "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
        if(status === 'CANCELLED') sStyle = "text-rose-400 bg-rose-500/10 border-rose-500/20";

        const dateObj = data.entryTime?.toDate();
        const dateStr = dateObj ? dateObj.toLocaleDateString('en-MY', {day:'2-digit', month:'2-digit'}) : '--/--';
        const timeStr = dateObj ? dateObj.toLocaleTimeString('en-MY', {hour:'2-digit', minute:'2-digit', hour12: true}) : '';

        tr.innerHTML = `
            <td class="px-6 py-3">
                <div class="text-sm font-medium text-slate-300">${dateStr}</div>
                <div class="text-[10px] text-slate-500 font-mono uppercase">${timeStr}</div>
            </td>
            <td class="px-6 py-3">
                <div class="flex items-center gap-2">
                    <i class="fas fa-car-side text-slate-600 text-xs"></i>
                    <span class="text-sm font-black text-white tracking-wide">${data.carPlate}</span>
                </div>
            </td>
            <td class="px-6 py-3">
                <div class="text-sm font-bold text-white">${data.unitNumber}</div>
                <div class="text-[10px] text-slate-500 uppercase tracking-tight truncate max-w-[150px]">
                    ${data.road || 'Unassigned Road'}
                </div>
            </td>
            <td class="px-6 py-3">
                <div class="text-sm text-slate-300 font-medium capitalize">${data.visitorName || 'Guest'}</div>
                <div class="text-[10px] text-slate-500 italic">${data.visitorPhone || ''}</div>
            </td>
            <td class="px-6 py-3 text-right">
                <button class="view-det px-3 py-1 rounded-md text-[9px] font-black tracking-widest border transition-all active:scale-95 ${sStyle}">
                    ${status}
                </button>
            </td>
        `;

        tr.querySelector(".view-det").onclick = () => showVisitDetails(data);
        tbody.appendChild(tr);
    });
}

function showVisitDetails(data) {
    const modal = qs("#visitDetailModal");
    
    // Format helper
    const fmt = (ts) => ts ? ts.toDate().toLocaleString('en-MY', { 
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' 
    }) : 'Not yet recorded';

    // Populate data
    qs("#detCreated").textContent = fmt(data.entryTime); // entryTime is used as creation time in your schema
    
    // Entered Time
    if (data.status === 'entered' || data.status === 'exited') {
        qs("#detEntered").textContent = fmt(data.actualEntryTime || data.entryTime);
        qs("#detEnteredRow").classList.remove('hidden');
    } else {
        qs("#detEnteredRow").classList.add('hidden');
    }

    // Cancelled Time
    if (data.status === 'cancelled') {
        qs("#detCancelled").textContent = fmt(data.cancelledAt);
        qs("#detCancelledRow").classList.remove('hidden');
    } else {
        qs("#detCancelledRow").classList.add('hidden');
    }

    modal.classList.remove("hidden");
}

async function loadStats() {
    try {
        /* no queries here on purpose: the old version pulled every resident AND
           every pending invoice on each render (≈6k reads per dashboard load). */
        qs("#statResidents").textContent = allResidents.length;
        const t = portfolioTotals();
        const billsEl = qs("#statBills");
        if (billsEl) billsEl.textContent = t.debtors;
        const amtEl = qs("#statArrearsAmt");
        if (amtEl) amtEl.textContent = `${t.debtors} houses · RM ${money2(t.arrears)}`;
    } catch(e) {}
}

function openResidentModal(id = null, data = {}) {
  qs("#residentModal").classList.remove("hidden");
  qs("#residentModalTitle").textContent = id ? "Edit Resident" : "Add Resident";
  
  // Toggle Delete button: Show if id exists (editing), hide if id is null (adding)
  const delBtn = qs("#deleteResidentBtn");
  if (id) delBtn.classList.remove("hidden");
  else delBtn.classList.add("hidden");

  qs("#residentId").value = id || ""; 
  qs("#resUnit").value = data.unitNumber || ""; 
  qs("#resRoad").value = data.road || "";
  qs("#resName").value = data.name || ""; 
  qs("#resPhone").value = data.phone || ""; 
  qs("#resPin").value = data.pin || ""; 
  qs("#resVehicle").value = data.vehiclePlate || "";
}

// --- UPDATED RESIDENT FORM WITH DUPLICATE CHECK ---
qs("#residentForm").addEventListener("submit", async (e) => {
    e.preventDefault(); 
    const id = qs("#residentId").value; // Current ID (if editing)
    const unit = qs("#resUnit").value.trim();
    const road = qs("#resRoad").value.trim();
    
    setLoading(qs("#residentSubmitBtn"), true);

    try {
        // 1. UNIQUE CHECK: Search local cache for existing Unit + Road
        const isDuplicate = allResidents.some(res => 
            String(res.unitNumber) === String(unit) && 
            String(res.road).toLowerCase() === String(road).toLowerCase() &&
            res.id !== id // Ignore the current record if we are just editing it
        );

        if (isDuplicate) {
            toast(`Error: Unit ${unit} on ${road} is already registered!`, "error");
            setLoading(qs("#residentSubmitBtn"), false);
            return; // Stop the save process
        }

        // 2. Prepare the data
        const payload = { 
            unitNumber: unit, 
            road: road, 
            name: qs("#resName").value.trim(), 
            phone: qs("#resPhone").value.trim(), 
            pin: qs("#resPin").value.trim(), 
            vehiclePlate: qs("#resVehicle").value.toUpperCase().trim(),
            updatedAt: serverTimestamp()
        };

        // 3. Save to Firestore
        if (id) {
            await updateDoc(doc(db, "residents", id), payload);
        } else {
            // New resident defaults
            payload.createdAt = serverTimestamp();
            payload.isJoined = false; 
            await addDoc(collection(db, "residents"), payload);
        }

        toast("Saved successfully!", "success"); 
        closeModal("residentModal"); 
        loadResidents(true); // Refresh the list
    } catch(e) { 
        console.error(e);
        toast("Save failed: " + e.message, "error"); 
    } finally { 
        setLoading(qs("#residentSubmitBtn"), false); 
    }
});

qs("#addResidentBtn").addEventListener("click", () => openResidentModal());
// This button opens the Custom Bill modal
// 1. When the Delete button in the "Edit Resident" modal is clicked
// Open the custom confirmation modal
qs("#deleteResidentBtn").addEventListener("click", () => {
    qs("#deleteTargetName").textContent = qs("#resName").value;
    qs("#deleteConfirmModal").classList.remove("hidden");
});



// 2. When the "Yes, Delete" button inside the custom confirmation is clicked
qs("#executeDeleteBtn").addEventListener("click", async () => {
    const id = qs("#residentId").value; // This is the ID currently in the Edit form
    const btn = qs("#executeDeleteBtn");
    
    if (!id) return;

    setLoading(btn, true);
    try {
        await deleteDoc(doc(db, "residents", id));
        
        toast("Resident removed", "info");
        
        // Close both modals
        closeModal("deleteConfirmModal");
        closeModal("residentModal");
        
        loadResidents(true); // Refresh the grid
    } catch (e) {
        toast("Delete failed", "error");
    } finally {
        setLoading(btn, false);
    }
});
qs("#addInvoiceBtn").addEventListener("click", () => {
    // 1. Show the modal
    qs("#invoiceModal").classList.remove("hidden");

    // 2. Calculate Today's Date in YYYY-MM-DD format
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;

    // 3. Set the input value
    const dateInput = qs("#invDue");
    if (dateInput) {
        dateInput.value = today;
    }
});
qs("#createAdminShowBtn").addEventListener("click", () => qs("#adminModal").classList.remove("hidden"));
qsa("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.closeModal)));

/* Analytics rendering lives in admin/index.html (window.renderOverallStats /
   renderLedger / renderTrends). The module-scope copies that used to sit here read
   allInvoices — a 300-row page, not the ledger — and were never called; keeping two
   renderers meant the wrong one could win a race. Deleted deliberately. */

function init() {
    const stamp = qs("#buildStamp");
    if (stamp) stamp.textContent = BUILD_STAMP;
    initAuth(); const y = new Date().getFullYear();
    const opts = [y-1, y, y+1].map(v => `<option value='${v}' ${v===y?'selected':''}>${v}</option>`).join('');
    if(qs("#bulkYear")) qs("#bulkYear").innerHTML = opts;
}
init();
