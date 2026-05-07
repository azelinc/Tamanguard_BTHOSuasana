import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, getDocs, writeBatch, serverTimestamp, addDoc } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const PAGE_SIZE = 200;
let userProfile = null;
let userRole = null;
let tamanConfig = { name: "", roads: [] };
const allResidents = [];
let allInvoices = []; 

function qs(s, p = document) { return p.querySelector(s); }
function qsa(s, p = document) { return p.querySelectorAll(s); }

function toast(msg, type = "info") {
  const el = qs("#toast");
  const map = { error: "bg-red-600", success: "bg-emerald-600", info: "bg-blue-600" };
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[500] px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-opacity duration-300 pointer-events-none text-white ${map[type]}`;
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

/* AUTH & INITIAL LOAD */
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
    loadSettings(); showTab("news"); loadStats(); preloadResidentData();
  });
}

qs("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const btn = qs("#loginBtn"); setLoading(btn, true);
  try { await signInWithEmailAndPassword(auth, qs("#loginEmail").value.trim(), qs("#loginPassword").value); }
  catch (err) { toast("Login failed", "error"); }
  finally { setLoading(btn, false); }
});

qs("#logoutBtn").addEventListener("click", () => signOut(auth));

/* TABS MANAGEMENT */
function showTab(name) {
  qsa(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  qsa(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  if (name === "news") loadNews();
  if (name === "residents") loadResidents();
  if (name === "visitors") loadVisitors();
  if (name === "billing") { preloadResidentData().then(() => loadBilling(true)); updateInvoiceResidentList(); }
  if (name === "settings") { loadSettings(); loadAdmins(); }
}

qsa(".tab-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

async function preloadResidentData() {
    const snap = await getDocs(collection(db, "residents"));
    allResidents.length = 0; snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
}

/* SETTINGS LOGIC */
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "taman_config"));
  if (snap.exists()) tamanConfig = snap.data();
  qs("#tamanNameDisplay").textContent = tamanConfig.name || "TamanGuard";
  if(qs("#tamanNameInput")) qs("#tamanNameInput").value = tamanConfig.name || "";
  renderRoads();
}

function renderRoads() {
  const box = qs("#roadList"); if(!box) return; box.innerHTML = "";
  (tamanConfig.roads || []).forEach(r => {
    const chip = document.createElement("div");
    chip.className = "px-3 py-1 rounded-full bg-slate-700 text-xs flex items-center gap-2 border border-slate-600";
    chip.innerHTML = `<span>${r}</span><button class="hover:text-red-400"><i class="fas fa-times"></i></button>`;
    chip.querySelector("button").onclick = () => removeRoad(r);
    box.appendChild(chip);
  });
  const sel = qs("#resRoad"); if(sel) {
    sel.innerHTML = '<option value="">Road/Block</option>';
    (tamanConfig.roads || []).forEach(r => {
        const o = document.createElement("option"); o.value = r; o.textContent = r; sel.appendChild(o);
    });
  }
}

qs("#addRoadBtn").addEventListener("click", async () => {
    const v = qs("#newRoadName").value.trim(); if(!v) return;
    const roads = [...(tamanConfig.roads || []), v];
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads, updatedAt: serverTimestamp() });
    qs("#newRoadName").value = ""; toast("Road added", "success"); loadSettings();
});

async function removeRoad(r) {
    if(!confirm(`Remove ${r}?`)) return;
    const roads = (tamanConfig.roads || []).filter(x => x !== r);
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads, updatedAt: serverTimestamp() });
    loadSettings();
}

qs("#saveSettingsBtn").addEventListener("click", async () => {
    const name = qs("#tamanNameInput").value.trim(); if(!name) return;
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, name, updatedAt: serverTimestamp() });
    toast("Config updated!", "success"); loadSettings();
});

async function loadAdmins() {
  const snap = await getDocs(collection(db, "admin_accounts"));
  const tbody = qs("#adminTableBody"); tbody.innerHTML = "";
  snap.forEach(d => {
    const data = d.data(); const tr = document.createElement("tr");
    tr.innerHTML = `<td class="py-3 text-white">${data.name}</td><td class="py-3 uppercase text-[10px] text-slate-500 font-bold">${data.role}</td><td class="py-3 text-right"><button class="text-red-400 hover:text-red-300"><i class="fas fa-trash"></i></button></td>`;
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
        toast("Admin added", "success"); closeModal("adminModal"); qs("#adminForm").reset(); loadAdmins();
    } catch(e) { toast(e.message, "error"); }
    finally { setLoading(btn, false); }
});

/* NEWS */
async function loadNews() {
  const snap = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(20)));
  const box = qs("#newsList"); box.innerHTML = "";
  snap.forEach(d => {
    const card = document.createElement("div"); card.className = "glass rounded-xl p-4 border border-white/5";
    card.innerHTML = `<h4 class="font-bold text-lg">${d.data().title}</h4><p class="text-slate-300 text-sm mt-1">${d.data().content}</p>`;
    box.appendChild(card);
  });
}

/* RESIDENTS LOGIC */
function loadResidents() {
    onSnapshot(query(collection(db, "residents"), orderBy("unitNumber")), (snap) => {
        allResidents.length = 0; snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
        renderResidents();
    });
}

function renderResidents() {
    const grid = qs("#residentsGrid"); grid.innerHTML = "";
    const term = qs("#residentSearch").value.toLowerCase().trim();
    allResidents.filter(r => !term || `${r.name} ${r.unitNumber} ${r.phone}`.toLowerCase().includes(term)).forEach(r => {
        const card = document.createElement("div"); card.className = "glass rounded-xl p-4 hover:bg-slate-800/50 cursor-pointer transition-all group relative border border-slate-700/30";
        card.innerHTML = `<div class="flex justify-between items-start mb-3"><h4 class="font-bold text-white group-hover:text-emerald-400">${r.name}</h4><button class="edit-btn p-2 rounded bg-slate-800 text-slate-500 hover:text-blue-400 opacity-0 group-hover:opacity-100"><i class="fas fa-pen text-xs"></i></button></div><p class="text-[11px] text-slate-400 uppercase tracking-widest">Unit ${r.unitNumber} • ${r.road || '-'}</p><p class="text-[11px] text-slate-500 mt-1">${r.phone}</p>`;
        card.querySelector(".edit-btn").onclick = (e) => { e.stopPropagation(); openResidentModal(r.id, r); };
        card.onclick = () => showResidentProfile(r);
        grid.appendChild(card);
    });
}

async function showResidentProfile(res) {
    const modal = qs("#residentProfileModal");
    qs("#profInitial").textContent = res.name.charAt(0).toUpperCase();
    qs("#profName").textContent = res.name;
    qs("#profMeta").textContent = `UNIT ${res.unitNumber} — ${res.road || '-'}`;
    qs("#profPhone").textContent = res.phone;
    qs("#profVehicle").textContent = res.vehiclePlate || '-';
    qs("#profPin").textContent = res.pin;
    
    const tbody = qs("#profHistoryBody"); tbody.innerHTML = '<tr><td colspan="4" class="py-12 text-center text-slate-500"><span class="spinner"></span></td></tr>';
    modal.classList.remove("hidden");
    
    try {
        const snap = await getDocs(query(collection(db, "invoices"), where("unitNumber", "==", res.unitNumber)));
        const history = snap.docs.map(d => d.data()).filter(i => i.road === res.road).sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis());
        tbody.innerHTML = history.length ? "" : '<tr><td colspan="4" class="py-12 text-center text-slate-500 text-xs">No payment history.</td></tr>';
        history.forEach(inv => {
            const tr = document.createElement("tr"); tr.className = "border-b border-slate-700/20";
            const isPaid = inv.status === 'paid';
            tr.innerHTML = `<td class="py-4 px-4 text-white">${inv.month} ${inv.year}</td><td class="py-4 px-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td><td class="py-4 px-4"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isPaid?'bg-emerald-500/10 text-emerald-400':'bg-amber-500/10 text-amber-400'}">${inv.status.toUpperCase()}</span></td><td class="py-4 px-4 text-right text-[10px] font-mono text-slate-500">${inv.receiptNumber || '-'}</td>`;
            tbody.appendChild(tr);
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-red-400">Failed.</td></tr>'; }
}

qs("#residentSearch").addEventListener("input", debounce(() => renderResidents(), 100));

/* BILLING DASHBOARD */
async function loadBilling(reset = true) {
  if (reset) allInvoices = [];
  const snap = await getDocs(query(collection(db, "invoices"), orderBy("createdAt", "desc"), limit(PAGE_SIZE)));
  snap.forEach(d => allInvoices.push({ id: d.id, ...d.data() }));
  renderInvoices();
}

function renderInvoices() {
  const tbody = qs("#invoicesTableBody"); if(!tbody) return;
  const rawTerm = qs("#invoiceSearch").value.toLowerCase().trim();
  const hidePaid = qs("#hidePaidToggle").checked;
  const cleanPhoneTerm = rawTerm.replace(/[^0-9]/g, "");

  tbody.innerHTML = "";
  const filtered = allInvoices.filter(inv => {
    if (hidePaid && inv.status === "paid") return false;
    if (!rawTerm) return true;
    const res = allResidents.find(r => r.unitNumber === inv.unitNumber && r.road === inv.road);
    const matchUnit = inv.unitNumber.toLowerCase().startsWith(rawTerm);
    const matchName = (res?.name || "").toLowerCase().includes(rawTerm);
    const matchPhone = cleanPhoneTerm !== "" && (res?.phone || "").replace(/[^0-9]/g, "").includes(cleanPhoneTerm);
    return matchUnit || matchName || matchPhone;
  });

  filtered.forEach(inv => {
    const tr = document.createElement("tr"); tr.className = "hover:bg-slate-800/30 group border-b border-slate-700/30";
    const sClass = inv.status==='paid'?'bg-emerald-500/20 text-emerald-400':'bg-amber-500/20 text-amber-400';
    tr.innerHTML = `<td class="px-4 py-4 font-mono text-[10px] text-slate-500">${inv.id.substring(0,8)}</td><td class="px-4 py-4"><button class="view-h text-left hover:text-purple-400"><span class="block font-bold text-white">${inv.unitNumber}</span><span class="text-[10px] text-slate-500">${inv.road}</span></button></td><td class="px-4 py-4 text-slate-300 text-sm">${inv.month} ${inv.year}</td><td class="px-4 py-4 font-bold text-white">RM ${parseFloat(inv.amount).toFixed(2)}</td><td class="px-4 py-4"><span class="px-2 py-1 rounded-full text-[10px] font-bold ${sClass}">${inv.status.toUpperCase()}</span></td><td class="px-4 py-4 text-right"><button class="pay-b bg-emerald-600/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded text-[10px] font-bold hover:bg-emerald-600 hover:text-white transition-all ${inv.status==='paid'?'hidden':''}">PAY</button></td>`;
    tr.querySelector(".view-h").onclick = () => showHouseHistoryModal(inv.unitNumber, inv.road);
    if(tr.querySelector(".pay-b")) tr.querySelector(".pay-b").onclick = () => payInvoice(inv.id);
    tbody.appendChild(tr);
  });
}

qs("#invoiceSearch").addEventListener("input", debounce(() => renderInvoices(), 50));
qs("#hidePaidToggle").addEventListener("change", () => renderInvoices());

function showHouseHistoryModal(unit, road) {
    const tbody = qs("#historyTableBody"); qs("#historyUnitTitle").textContent = `Unit ${unit} — ${road}`;
    tbody.innerHTML = "";
    const history = allInvoices.filter(i => i.unitNumber === unit && i.road === road);
    history.forEach(inv => {
        const tr = document.createElement("tr"); tr.className = "border-b border-slate-700/20 hover:bg-slate-800/30 transition-colors";
        const isPaid = inv.status === 'paid';
        tr.innerHTML = `<td class="px-4 py-4 text-white font-medium">${inv.month} ${inv.year}</td><td class="px-4 py-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td><td class="px-4 py-4"><span class="text-[10px] font-bold ${isPaid?'text-emerald-400':'text-amber-400'}">${inv.status.toUpperCase()}</span></td><td class="px-4 py-4 text-right">${isPaid?`<span class='text-[10px] text-slate-500 font-mono'>${inv.receiptNumber}</span>`:`<button class='h-pay-btn bg-emerald-600 text-white text-[10px] font-bold px-3 py-1.5 rounded'>PAY</button>`}</td>`;
        if(tr.querySelector(".h-pay-btn")) {
            tr.querySelector(".h-pay-btn").onclick = async (e) => {
                const b = e.target;
                if(b.textContent === "PAY") { b.textContent = "CONFIRM?"; b.classList.replace("bg-emerald-600", "bg-orange-600"); setTimeout(()=> { if(b.textContent==="CONFIRM?") { b.textContent="PAY"; b.classList.replace("bg-orange-600","bg-emerald-600"); } }, 3000); }
                else { b.disabled = true; b.innerHTML = '<span class="spinner"></span>'; await payInvoice(inv.id, false); showHouseHistoryModal(unit, road); }
            };
        }
        tbody.appendChild(tr);
    });
    qs("#historyModal").classList.remove("hidden");
}

async function payInvoice(id, fullRefresh = true) {
    const rcpt = `RCP-${Date.now()}`;
    await updateDoc(doc(db, "invoices", id), { status: "paid", receiptNumber: rcpt, paidAt: serverTimestamp() });
    const local = allInvoices.find(i => i.id === id);
    if(local) { local.status = "paid"; local.receiptNumber = rcpt; }
    toast("Payment recorded", "success");
    if(fullRefresh) loadBilling(true); else renderInvoices(); 
    loadStats();
}

/* BILL GENERATION LOGIC */
qs("#generateBulkBtn").addEventListener("click", async () => {
    const m = qs("#bulkMonth").value; const y = qs("#bulkYear").value; const a = parseFloat(qs("#bulkAmount").value);
    const due = qs("#bulkDue").value; if(!m || isNaN(a)) return toast("Check month/amount", "error");
    setLoading(qs("#generateBulkBtn"), true);
    try {
        const batch = writeBatch(db);
        allResidents.forEach(r => {
            const id = `INV-${r.unitNumber}-${r.road}-${m}-${y}`.replace(/\s+/g, '');
            batch.set(doc(db, "invoices", id), { invoiceId: id, unitNumber: r.unitNumber, road: r.road, month: m, year: parseInt(y), amount: a, dueDate: due, status: "pending", createdAt: serverTimestamp() });
        });
        await batch.commit(); toast("Bills generated!", "success"); loadBilling(true);
    } catch(e) { toast(e.message, "error"); }
    finally { setLoading(qs("#generateBulkBtn"), false); }
});

qs("#invoiceForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const unit = qs("#invUnit").value; const amount = parseFloat(qs("#invAmount").value);
    if(!unit || isNaN(amount)) return toast("Fill fields", "error");
    setLoading(qs("#invoiceSubmitBtn"), true);
    try {
        await addDoc(collection(db, "invoices"), { unitNumber: unit, road: qs("#invRoad").value, amount, status: "pending", createdAt: serverTimestamp() });
        toast("Custom bill created", "success"); closeModal("invoiceModal"); loadBilling(true);
    } catch(e) { toast(e.message, "error"); }
    finally { setLoading(qs("#invoiceSubmitBtn"), false); }
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

/* STATS & MISC */
async function loadStats() {
    try {
        const resSnap = await getDocs(collection(db, "residents")); qs("#statResidents").textContent = resSnap.size;
        const billSnap = await getDocs(query(collection(db, "invoices"), where("status", "==", "pending"))); qs("#statBills").textContent = billSnap.size;
    } catch(e) {}
}

async function loadVisitors() {
    const snap = await getDocs(query(collection(db, "visits"), orderBy("entryTime", "desc"), limit(20)));
    const tbody = qs("#visitorsTableBody"); tbody.innerHTML = "";
    snap.forEach(d => {
        const data = d.data(); const tr = document.createElement("tr");
        tr.innerHTML = `<td class="px-4 py-3">${data.entryTime?.toDate().toLocaleDateString()}</td><td class="px-4 py-3">${data.carPlate}</td><td class="px-4 py-3">${data.unitNumber}</td><td class="px-4 py-3">${data.visitorName}</td><td class="px-4 py-3 text-[10px] font-bold uppercase">${data.status}</td>`;
        tbody.appendChild(tr);
    });
}

function openResidentModal(id = null, data = {}) {
  qs("#residentModal").classList.remove("hidden");
  qs("#residentId").value = id || ""; qs("#resUnit").value = data.unitNumber || ""; qs("#resRoad").value = data.road || "";
  qs("#resName").value = data.name || ""; qs("#resPhone").value = data.phone || ""; qs("#resPin").value = data.pin || ""; qs("#resVehicle").value = data.vehiclePlate || "";
}

qs("#residentForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const id = qs("#residentId").value; setLoading(qs("#residentSubmitBtn"), true);
    try {
        const payload = { unitNumber: qs("#resUnit").value.trim(), road: qs("#resRoad").value.trim(), name: qs("#resName").value.trim(), phone: qs("#resPhone").value.trim(), pin: qs("#resPin").value.trim(), vehiclePlate: qs("#resVehicle").value.toUpperCase().trim() };
        if (id) await updateDoc(doc(db, "residents", id), payload); else await addDoc(collection(db, "residents"), payload);
        toast("Saved", "success"); closeModal("residentModal");
    } catch(e) { toast("Error", "error"); }
    finally { setLoading(qs("#residentSubmitBtn"), false); }
});

qs("#addResidentBtn").addEventListener("click", () => openResidentModal());
qs("#addInvoiceBtn").addEventListener("click", () => qs("#invoiceModal").classList.remove("hidden"));
qs("#createAdminShowBtn").addEventListener("click", () => qs("#adminModal").classList.remove("hidden"));
qsa("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.closeModal)));

function init() { 
    initAuth(); const y = new Date().getFullYear();
    const opts = [y-1, y, y+1].map(v => `<option value='${v}' ${v===y?'selected':''}>${v}</option>`).join('');
    if(qs("#bulkYear")) qs("#bulkYear").innerHTML = opts;
}
init();
