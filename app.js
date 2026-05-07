import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, startAfter, getDocs,
  writeBatch, serverTimestamp, addDoc
} from "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

/* global QRCode */

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const PAGE_SIZE = 100; // Increased to ensure more history is visible

let currentUser = null;
let userProfile = null;
let userRole = null;
let tamanConfig = { name: "", roads: [] };
const listeners = {};
const allResidents = [];
let allInvoices = []; 
let residentFilterRoad = "All";
const visitorCursor = { last: null, hasMore: true };
const invoiceCursor = { last: null, hasMore: true };

const validators = {
  phone: (v) => /^01\d{8,9}$/.test(v.replace(/[-\s]/g, "")),
  plate: (v) => /^[A-Z]{1,3}\s?\d{1,4}\s?[A-Z]{0,2}$/i.test(v),
  pin: (v) => /^\d{4,6}$/.test(v)
};

function qs(s, p = document) { return p.querySelector(s); }
function qsa(s, p = document) { return p.querySelectorAll(s); }

function toast(msg, type = "info") {
  const el = qs("#toast");
  const map = { error: "bg-red-600", success: "bg-emerald-600", info: "bg-blue-600" };
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-opacity duration-300 pointer-events-none text-white ${map[type] || map.info}`;
  el.textContent = msg;
  el.classList.remove("opacity-0");
  setTimeout(() => el.classList.add("opacity-0"), 3500);
}

function setLoading(btn, on) {
  if (on) {
    btn.dataset.og = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>Please wait…`;
    btn.disabled = true;
    btn.classList.add("opacity-70", "cursor-not-allowed");
  } else {
    btn.innerHTML = btn.dataset.og || btn.textContent;
    btn.disabled = false;
    btn.classList.remove("opacity-70", "cursor-not-allowed");
  }
}

function closeModal(id) { qs(`#${id}`).classList.add("hidden"); }

function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function loadStats() {
  try {
    const resSnap = await getDocs(collection(db, "residents"));
    qs("#statResidents").textContent = resSnap.size;
    const visitSnap = await getDocs(query(collection(db, "visits"), where("status", "==", "entered")));
    qs("#statVisits").textContent = visitSnap.size;
    const billSnap = await getDocs(query(collection(db, "invoices"), where("status", "==", "pending")));
    qs("#statBills").textContent = billSnap.size;
  } catch (e) { console.error(e); }
}

function unsub(key) { if (listeners[key]) { listeners[key](); delete listeners[key]; } }
function unsubAll() { Object.keys(listeners).forEach(k => unsub(k)); }

function applyRoleVisibility() {
  const map = {
    news: ["super_admin", "treasurer", "manager"],
    residents: ["super_admin", "manager"],
    visitors: ["super_admin", "manager"],
    billing: ["super_admin", "treasurer"],
    analytics: ["super_admin", "treasurer", "manager"],
    settings: ["super_admin"]
  };
  qsa(".tab-btn").forEach(btn => {
    const ok = (map[btn.dataset.tab] || []).includes(userRole);
    btn.style.display = ok ? "flex" : "none";
    if (!ok && btn.classList.contains("active")) showTab("news");
  });
}

async function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        currentUser = null; userProfile = null; userRole = null; unsubAll();
        qs("#adminOverlay").classList.remove("hidden");
        qs("#userBadge").classList.add("hidden");
        qs("#logoutBtn").classList.add("hidden");
        return;
      }
      const snap = await getDoc(doc(db, "admin_accounts", user.uid));
      if (!snap.exists()) { await signOut(auth); toast("Account unauthorized.", "error"); return; }
      userProfile = snap.data();
      userRole = userProfile.role;
      currentUser = user;
      qs("#adminOverlay").classList.add("hidden");
      qs("#userBadge").classList.remove("hidden");
      qs("#logoutBtn").classList.remove("hidden");
      qs("#userName").textContent = userProfile.name || user.email;
      qs("#userRole").textContent = userRole.replace("_", " ");
      applyRoleVisibility();
      loadSettings(); 
      showTab("news");
      loadStats(); 
    } catch (err) { console.error(err); }
  });
}

qs("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = qs("#loginBtn");
  setLoading(btn, true);
  try { 
    await signInWithEmailAndPassword(auth, qs("#loginEmail").value.trim(), qs("#loginPassword").value); 
    toast("Welcome!", "success"); 
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(btn, false); }
});

qs("#logoutBtn").addEventListener("click", async () => { await signOut(auth); unsubAll(); toast("Logged out", "info"); });

/* Tabs Management */
function showTab(name) {
  qsa(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  qsa(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  unsub("currentTab");
  if (name === "news") loadNews();
  if (name === "residents") loadResidents();
  if (name === "visitors") loadVisitors(true);
  if (name === "billing") { preloadResidentData().then(() => loadBilling(true)); updateInvoiceResidentList(); }
  if (name === "settings") { loadSettings(); loadAdmins(); }
}

qsa(".tab-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

// NEW: Helper to ensure search works immediately even if Treasurer hasn't clicked Residents tab
async function preloadResidentData() {
    if (allResidents.length > 0) return;
    const snap = await getDocs(collection(db, "residents"));
    allResidents.length = 0;
    snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
}

/* Settings */
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "taman_config"));
  if (snap.exists()) tamanConfig = snap.data();
  qs("#tamanNameInput").value = tamanConfig.name || "";
  qs("#tamanNameDisplay").textContent = tamanConfig.name || "TamanGuard";
  renderRoads();
}

function renderRoads() {
  const box = qs("#roadList");
  if(!box) return; box.innerHTML = "";
  (tamanConfig.roads || []).forEach(r => {
    const chip = document.createElement("div");
    chip.className = "px-3 py-1 rounded-full bg-slate-700 text-sm flex items-center gap-2";
    chip.innerHTML = `<span>${r}</span><button class="text-slate-400 hover:text-red-400"><i class="fas fa-times"></i></button>`;
    chip.querySelector("button").onclick = () => removeRoad(r);
    box.appendChild(chip);
  });
  const sel = qs("#resRoad");
  if(sel) {
    sel.innerHTML = '<option value="">Select Road/Block</option>';
    (tamanConfig.roads || []).forEach(r => {
      const o = document.createElement("option");
      o.value = r; o.textContent = r;
      sel.appendChild(o);
    });
  }
}

qs("#addRoadBtn").addEventListener("click", async () => {
  const v = qs("#newRoadName").value.trim();
  if (!v || (tamanConfig.roads || []).includes(v)) return toast("Invalid road.", "error");
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads: [...(tamanConfig.roads || []), v], updatedAt: serverTimestamp() });
    qs("#newRoadName").value = ""; loadSettings();
  } catch (err) { toast(err.message, "error"); }
});

async function removeRoad(r) {
  if (!confirm(`Remove ${r}?`)) return;
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads: (tamanConfig.roads || []).filter(x => x !== r), updatedAt: serverTimestamp() });
    loadSettings();
  } catch (err) { toast(err.message, "error"); }
}

qs("#saveSettingsBtn").addEventListener("click", async () => {
  const name = qs("#tamanNameInput").value.trim();
  if (!name) return toast("Name required.", "error");
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, name, updatedAt: serverTimestamp() });
    qs("#tamanNameDisplay").textContent = name; toast("Saved.", "success");
  } catch (err) { toast(err.message, "error"); }
});

/* News Management */
function loadNews() {
  unsub("currentTab");
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  listeners.currentTab = onSnapshot(q, (snap) => {
    const box = qs("#newsList");
    box.innerHTML = "";
    if (snap.empty) { box.innerHTML = '<p class="text-slate-400 text-center py-8">No announcements.</p>'; return; }
    snap.forEach(d => {
      const card = document.createElement("div");
      card.className = "glass rounded-xl p-4 flex flex-col md:flex-row gap-4";
      const data = d.data();
      card.innerHTML = `
        <div class="flex-1">
          <div class="flex justify-between items-start mb-2"><h4 class="font-bold text-lg">${data.title}</h4><button class="text-red-400"><i class="fas fa-trash"></i></button></div>
          <p class="text-slate-300 text-sm mb-3">${data.content}</p>
          <div class="text-xs text-slate-500"><i class="far fa-clock mr-2"></i>${data.createdAt?.toDate().toLocaleString("en-MY") || "Just now"}</div>
        </div>`;
      card.querySelector("button").onclick = async () => { if(confirm("Delete?")) await deleteDoc(doc(db, "announcements", d.id)); };
      box.appendChild(card);
    });
  });
}

qs("#postNewsBtn").addEventListener("click", async () => {
  const title = qs("#newsTitle").value.trim();
  const content = qs("#newsContent").value.trim();
  if (!title || !content) return toast("Fields required.", "error");
  setLoading(qs("#postNewsBtn"), true);
  try {
    await addDoc(collection(db, "announcements"), { title, content, createdAt: serverTimestamp() });
    qs("#newsTitle").value = ""; qs("#newsContent").value = ""; toast("Posted.", "success");
  } finally { setLoading(qs("#postNewsBtn"), false); }
});

/* Residents Management */
function loadResidents() {
  unsub("currentTab");
  listeners.currentTab = onSnapshot(query(collection(db, "residents"), orderBy("unitNumber")), (snap) => {
    allResidents.length = 0;
    snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
    qs("#statResidents").textContent = allResidents.length;
    buildRoadFilters(); renderResidents();
  });
}

function buildRoadFilters() {
  const box = qs("#roadFilters"); box.innerHTML = "";
  const mk = (label, active) => {
    const b = document.createElement("button");
    b.className = `px-3 py-1 rounded-full text-sm transition-all ${active ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300"}`;
    b.textContent = label;
    b.onclick = () => { residentFilterRoad = label; buildRoadFilters(); renderResidents(); };
    return b;
  };
  box.appendChild(mk("All", residentFilterRoad === "All"));
  (tamanConfig.roads || []).forEach(r => box.appendChild(mk(r, residentFilterRoad === r)));
}

function renderResidents() {
  const term = qs("#residentSearch").value.toLowerCase();
  const grid = qs("#residentsGrid"); grid.innerHTML = "";
  allResidents.filter(r => {
    const okRoad = residentFilterRoad === "All" || (r.road || "") === residentFilterRoad;
    const okTerm = !term || `${r.unitNumber} ${r.name} ${r.phone}`.toLowerCase().includes(term);
    return okRoad && okTerm;
  }).forEach(r => {
    const card = document.createElement("div");
    card.className = "glass rounded-xl p-4 hover:bg-slate-800/50 transition-all group";
    card.innerHTML = `
      <div class="flex justify-between items-start mb-3">
        <div class="w-12 h-12 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-400 font-bold">${r.name.charAt(0)}</div>
        <div class="opacity-0 group-hover:opacity-100 flex gap-2">
            <button class="edit-res text-blue-400"><i class="fas fa-pen"></i></button>
            <button class="del-res text-red-400"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <h4 class="font-bold text-lg">${r.name}</h4>
      <p class="text-slate-400 text-sm mb-3">Unit ${r.unitNumber} • ${r.road}</p>
      <div class="text-sm text-slate-300"><div><i class="fas fa-phone mr-2"></i>${r.phone}</div></div>
      <div class="mt-3 pt-3 border-t border-slate-700/50 flex justify-between">
        <span class="text-xs text-slate-500">PIN</span><span class="font-mono text-emerald-400 font-bold">${r.pin}</span>
      </div>`;
    card.querySelector(".edit-res").onclick = () => openResidentModal(r.id, r);
    card.querySelector(".del-res").onclick = () => { if(confirm("Delete?")) deleteDoc(doc(db, "residents", r.id)); };
    grid.appendChild(card);
  });
}

qs("#residentSearch").addEventListener("input", debounce(() => renderResidents()));

function openResidentModal(id = null, data = {}) {
  qs("#residentModal").classList.remove("hidden");
  qs("#residentId").value = id || "";
  qs("#resUnit").value = data.unitNumber || "";
  qs("#resRoad").value = data.road || "";
  qs("#resName").value = data.name || "";
  qs("#resPhone").value = data.phone || "";
  qs("#resPin").value = data.pin || "";
  qs("#resVehicle").value = data.vehiclePlate || "";
}

qs("#residentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = qs("#residentId").value;
  const payload = {
    unitNumber: qs("#resUnit").value.trim(), road: qs("#resRoad").value, name: qs("#resName").value.trim(),
    phone: qs("#resPhone").value.trim(), pin: qs("#resPin").value.trim(), vehiclePlate: qs("#resVehicle").value.toUpperCase()
  };
  setLoading(qs("#residentSubmitBtn"), true);
  try {
    if (id) await updateDoc(doc(db, "residents", id), payload);
    else await addDoc(collection(db, "residents"), payload);
    closeModal("residentModal");
  } finally { setLoading(qs("#residentSubmitBtn"), false); }
});

/* Visitors Management */
async function loadVisitors(reset = true) {
  if (reset) { visitorCursor.last = null; visitorCursor.hasMore = true; qs("#visitorsTableBody").innerHTML = ""; }
  const snap = await getDocs(query(collection(db, "visits"), orderBy("entryTime", "desc"), limit(PAGE_SIZE)));
  snap.forEach(d => {
    const tr = document.createElement("tr");
    const data = d.data();
    tr.innerHTML = `<td class="px-4 py-3">${data.entryTime?.toDate().toLocaleString("en-MY") || "-"}</td><td class="px-4 py-3">${data.carPlate}</td><td class="px-4 py-3">${data.unitNumber}</td><td class="px-4 py-3">${data.visitorName}</td><td class="px-4 py-3">${data.status}</td>`;
    qs("#visitorsTableBody").appendChild(tr);
  });
}

/* Billing Management - Treasurer Dash */
async function loadBilling(reset = true) {
  if (reset) { invoiceCursor.last = null; invoiceCursor.hasMore = true; allInvoices = []; }
  const snap = await getDocs(query(collection(db, "invoices"), orderBy("createdAt", "desc"), limit(PAGE_SIZE)));
  snap.forEach(d => allInvoices.push({ id: d.id, ...d.data() }));
  renderInvoices();
}

function renderInvoices() {
  const tbody = qs("#invoicesTableBody");
  const rawTerm = qs("#invoiceSearch").value.toLowerCase().trim();
  const hidePaid = qs("#hidePaidToggle").checked;
  const cleanTerm = rawTerm.replace(/[^0-9a-z]/g, ""); // Normalizes search term

  tbody.innerHTML = "";
  
  const filtered = allInvoices.filter(inv => {
    if (hidePaid && inv.status === "paid") return false;
    if (!rawTerm) return true;

    // Smart Match Logic
    const matchUnit = inv.unitNumber.toLowerCase() === rawTerm || inv.unitNumber.toLowerCase().startsWith(rawTerm);
    
    // Resident lookup for Name/Phone
    const resident = allResidents.find(r => r.unitNumber === inv.unitNumber && r.road === inv.road);
    const resName = (resident?.name || "").toLowerCase();
    const resPhone = (resident?.phone || "").replace(/[^0-9]/g, "");
    
    const matchName = resName.includes(rawTerm);
    const matchPhone = cleanTerm !== "" && resPhone.includes(cleanTerm);
    
    return matchUnit || matchName || matchPhone;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">No matching bills found.</td></tr>';
    return;
  }

  filtered.forEach(inv => tbody.appendChild(createBillRow(inv)));
}

function createBillRow(inv) {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-800/30 transition-colors group";
    const sClass = inv.status === 'paid' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400';
    tr.innerHTML = `
      <td class="px-4 py-3 font-mono text-[10px] text-slate-500">${(inv.invoiceId || inv.id).substring(0,12)}</td>
      <td class="px-4 py-3">
        <button class="view-h text-left group-hover:text-purple-400 transition-colors">
            <span class="block font-bold text-white text-sm">${inv.unitNumber}</span>
            <span class="text-[10px] text-slate-500 block">${inv.road}</span>
        </button>
      </td>
      <td class="px-4 py-3 text-slate-300 text-sm">${inv.month} ${inv.year}</td>
      <td class="px-4 py-3 font-bold text-white">RM ${parseFloat(inv.amount).toFixed(2)}</td>
      <td class="px-4 py-3 text-slate-300 text-xs">${inv.dueDate}</td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-full text-[10px] font-bold ${sClass}">${inv.status.toUpperCase()}</span></td>
      <td class="px-4 py-3 text-right">
        <button class="pay-b bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded text-xs hover:bg-emerald-500 hover:text-white transition-all ${inv.status === 'paid' ? 'hidden' : ''}">Pay</button>
        <button class="del-b text-red-400 px-2 py-1"><i class="fas fa-trash"></i></button>
      </td>`;
    
    tr.querySelector(".view-h").onclick = () => showHouseHistory(inv.unitNumber, inv.road);
    if(tr.querySelector(".pay-b")) tr.querySelector(".pay-b").onclick = () => payInvoice(inv.id);
    tr.querySelector(".del-b").onclick = () => { if(confirm("Delete this bill?")) deleteInvoice(inv.id); };
    return tr;
}

qs("#invoiceSearch").addEventListener("input", debounce(() => renderInvoices(), 50)); 
qs("#hidePaidToggle").addEventListener("change", () => renderInvoices());

function showHouseHistory(unit, road) {
    const tbody = qs("#historyTableBody");
    qs("#historyUnitTitle").textContent = `UNIT ${unit} — ${road}`;
    tbody.innerHTML = "";
    
    allInvoices.filter(i => i.unitNumber === unit && i.road === road).forEach(inv => {
        const tr = document.createElement("tr");
        tr.className = "border-b border-slate-700/30 hover:bg-slate-800/20";
        const isPaid = inv.status === 'paid';
        tr.innerHTML = `
            <td class="px-4 py-4 text-white font-medium">${inv.month} ${inv.year}</td>
            <td class="px-4 py-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td>
            <td class="px-4 py-4"><span class="text-[10px] font-bold ${isPaid ? 'text-emerald-400' : 'text-amber-400'}">${inv.status.toUpperCase()}</span></td>
            <td class="px-4 py-4 text-right">
                ${isPaid ? `<span class="text-[10px] text-slate-500 font-mono">${inv.receiptNumber || '-'}</span>` : 
                `<button class="hist-pay-btn bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-all">PAY NOW</button>`}
            </td>`;
        
        const btn = tr.querySelector(".hist-pay-btn");
        if(btn) btn.onclick = () => { payInvoice(inv.id); closeModal("historyModal"); };
        tbody.appendChild(tr);
    });
    qs("#historyModal").classList.remove("hidden");
}

async function payInvoice(id) {
    if(!confirm("Confirm resident has paid this month?")) return;
    const rcpt = `RCP-${Date.now()}`;
    await updateDoc(doc(db, "invoices", id), { status: "paid", receiptNumber: rcpt, paidAt: serverTimestamp() });
    toast(`Payment recorded!`, "success");
    loadBilling(true);
}

async function deleteInvoice(id) { await deleteDoc(doc(db, "invoices", id)); loadBilling(true); }

function updateInvoiceResidentList() {
    const sel = qs("#invResidentSelect"); if(!sel) return;
    sel.innerHTML = '<option value="">-- Click to Search --</option>';
    allResidents.forEach(r => {
        const o = document.createElement("option");
        o.value = JSON.stringify({u: r.unitNumber, r: r.road});
        o.textContent = `Unit ${r.unitNumber} (${r.road}) - ${r.name}`;
        sel.appendChild(o);
    });
}

qs("#invResidentSelect")?.addEventListener("change", (e) => {
    if(!e.target.value) return;
    const data = JSON.parse(e.target.value);
    qs("#invUnit").value = data.u; qs("#invRoad").value = data.r;
});

qs("#generateBulkBtn").addEventListener("click", async () => {
    const m = qs("#bulkMonth").value; const y = qs("#bulkYear").value; const a = parseFloat(qs("#bulkAmount").value);
    if(!m || isNaN(a)) return toast("Check input values.", "error");
    setLoading(qs("#generateBulkBtn"), true);
    try {
        const batch = writeBatch(db);
        allResidents.forEach(r => {
            const id = `INV-${r.unitNumber}-${r.road}-${m}-${y}`.replace(/\s+/g, '');
            batch.set(doc(db, "invoices", id), { invoiceId: id, unitNumber: r.unitNumber, road: r.road, month: m, year: parseInt(y), amount: a, status: "pending", createdAt: serverTimestamp() });
        });
        await batch.commit(); loadBilling(true); toast("Bills generated!", "success");
    } catch(e) { toast(e.message, "error"); }
    finally { setLoading(qs("#generateBulkBtn"), false); }
});

async function loadAdmins() {
  const snap = await getDocs(collection(db, "admin_accounts"));
  qs("#adminTableBody").innerHTML = "";
  snap.forEach(d => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="px-4 py-3">${d.data().name}</td><td class="px-4 py-3">${d.data().email}</td><td class="px-4 py-3 text-right"><button class="text-red-400"><i class="fas fa-trash"></i></button></td>`;
    tr.querySelector("button").onclick = () => deleteDoc(doc(db, "admin_accounts", d.id));
    qs("#adminTableBody").appendChild(tr);
  });
}

qsa("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.closeModal)));

function init() { initAuth(); setupYearDropdowns(); }
function setupYearDropdowns() {
    const y = new Date().getFullYear();
    const html = [y-1, y, y+1].map(v => `<option value="${v}" ${v===y?'selected':''}>${v}</option>`).join('');
    if(qs("#bulkYear")) qs("#bulkYear").innerHTML = html;
    if(qs("#invYear")) qs("#invYear").innerHTML = html;
}

init();
