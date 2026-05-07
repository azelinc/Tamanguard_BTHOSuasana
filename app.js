import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, getDocs, writeBatch, serverTimestamp, addDoc } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const PAGE_SIZE = 150; 
let userProfile = null;
let tamanConfig = { name: "", roads: [] };
const allResidents = [];
let allInvoices = []; 

function qs(s, p = document) { return p.querySelector(s); }
function qsa(s, p = document) { return p.querySelectorAll(s); }

function toast(msg, type = "info") {
  const el = qs("#toast");
  const map = { error: "bg-red-600", success: "bg-emerald-600", info: "bg-blue-600" };
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-opacity duration-300 pointer-events-none text-white ${map[type]}`;
  el.textContent = msg; el.classList.remove("opacity-0");
  setTimeout(() => el.classList.add("opacity-0"), 3000);
}

function setLoading(btn, on) {
  if (on) { btn.dataset.og = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>`; btn.disabled = true; } 
  else { btn.innerHTML = btn.dataset.og || btn.textContent; btn.disabled = false; }
}

function closeModal(id) { qs(`#${id}`).classList.add("hidden"); }

function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { qs("#adminOverlay").classList.remove("hidden"); return; }
    const snap = await getDoc(doc(db, "admin_accounts", user.uid));
    if (!snap.exists()) { await signOut(auth); return; }
    userProfile = snap.data();
    qs("#adminOverlay").classList.add("hidden");
    qs("#userBadge").classList.remove("hidden");
    qs("#logoutBtn").classList.remove("hidden");
    qs("#userName").textContent = userProfile.name;
    qs("#userRole").textContent = userProfile.role.replace("_", " ");
    loadSettings(); showTab("news"); loadStats();
  });
}

qs("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = qs("#loginBtn"); setLoading(btn, true);
  try { await signInWithEmailAndPassword(auth, qs("#loginEmail").value.trim(), qs("#loginPassword").value); }
  catch (err) { toast("Login failed", "error"); }
  finally { setLoading(btn, false); }
});

qs("#logoutBtn").addEventListener("click", () => signOut(auth));

function showTab(name) {
  qsa(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  qsa(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  if (name === "news") loadNews();
  if (name === "residents") loadResidents();
  if (name === "visitors") loadVisitors();
  if (name === "billing") { preloadResidentData().then(() => loadBilling(true)); }
  if (name === "settings") loadSettings();
}

qsa(".tab-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

async function preloadResidentData() {
    const snap = await getDocs(collection(db, "residents"));
    allResidents.length = 0; snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
}

async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "taman_config"));
  if (snap.exists()) tamanConfig = snap.data();
  qs("#tamanNameDisplay").textContent = tamanConfig.name || "TamanGuard";
  if(qs("#tamanNameInput")) qs("#tamanNameInput").value = tamanConfig.name || "";
}

qs("#saveSettingsBtn").addEventListener("click", async () => {
    const name = qs("#tamanNameInput").value.trim();
    if(!name) return;
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, name, updatedAt: serverTimestamp() });
    toast("Settings saved!", "success");
    loadSettings();
});

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
  const cleanSearchTerm = rawTerm.replace(/[^0-9a-z]/g, "");

  tbody.innerHTML = "";
  const filtered = allInvoices.filter(inv => {
    if (hidePaid && inv.status === "paid") return false;
    if (!rawTerm) return true;
    const res = allResidents.find(r => r.unitNumber === inv.unitNumber && r.road === inv.road);
    const matchUnit = inv.unitNumber.toLowerCase().startsWith(rawTerm);
    const matchName = (res?.name || "").toLowerCase().includes(rawTerm);
    const resPhoneClean = (res?.phone || "").replace(/[^0-9]/g, "");
    const matchPhone = cleanSearchTerm !== "" && resPhoneClean.includes(cleanSearchTerm);
    return matchUnit || matchName || matchPhone;
  });

  filtered.forEach(inv => {
    const tr = document.createElement("tr"); 
    tr.className = "hover:bg-slate-800/30 transition-colors group border-b border-slate-700/30";
    const sClass = inv.status==='paid'?'bg-emerald-500/20 text-emerald-400':'bg-amber-500/20 text-amber-400';
    tr.innerHTML = `
      <td class="px-4 py-4 font-mono text-[10px] text-slate-500">${inv.id.substring(0,8)}</td>
      <td class="px-4 py-4"><button class="view-h text-left hover:text-purple-400"><span class="block font-bold text-white">${inv.unitNumber}</span><span class="text-[10px] text-slate-500">${inv.road}</span></button></td>
      <td class="px-4 py-4 text-slate-300 text-sm">${inv.month} ${inv.year}</td>
      <td class="px-4 py-4 font-bold text-white">RM ${parseFloat(inv.amount).toFixed(2)}</td>
      <td class="px-4 py-4"><span class="px-2 py-1 rounded-full text-[10px] font-bold ${sClass}">${inv.status.toUpperCase()}</span></td>
      <td class="px-4 py-4 text-right"><button class="pay-b bg-emerald-600/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded text-[10px] font-bold hover:bg-emerald-600 hover:text-white transition-all ${inv.status==='paid'?'hidden':''}">PAY</button></td>`;
    tr.querySelector(".view-h").onclick = () => showHouseHistory(inv.unitNumber, inv.road);
    if(tr.querySelector(".pay-b")) tr.querySelector(".pay-b").onclick = () => payInvoice(inv.id);
    tbody.appendChild(tr);
  });
}

qs("#invoiceSearch").addEventListener("input", debounce(() => renderInvoices(), 50));
qs("#hidePaidToggle").addEventListener("change", () => renderInvoices());

function showHouseHistory(unit, road) {
    const tbody = qs("#historyTableBody"); 
    qs("#historyUnitTitle").textContent = `Unit ${unit} — ${road}`;
    tbody.innerHTML = "";
    const history = allInvoices.filter(i => i.unitNumber === unit && i.road === road);
    history.forEach(inv => {
        const tr = document.createElement("tr"); 
        tr.className = "border-b border-slate-700/20 hover:bg-slate-800/30 transition-colors";
        const isPaid = inv.status === 'paid';
        tr.innerHTML = `
            <td class="px-4 py-4 text-white font-medium">${inv.month} ${inv.year}</td>
            <td class="px-4 py-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td>
            <td class="px-4 py-4"><span class="text-[10px] font-bold ${isPaid?'text-emerald-400':'text-amber-400'}">${inv.status.toUpperCase()}</span></td>
            <td class="px-4 py-4 text-right">${isPaid ? `<span class='text-[10px] text-slate-500 font-mono'>${inv.receiptNumber}</span>` : `<button class='h-pay bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-all'>PAY</button>`}</td>`;
        const btn = tr.querySelector(".h-pay");
        if(btn) {
            btn.onclick = async () => {
                if (btn.textContent === "PAY") { btn.textContent = "CONFIRM?"; btn.classList.replace("bg-emerald-600", "bg-orange-600"); setTimeout(() => { if(btn.textContent === "CONFIRM?") { btn.textContent = "PAY"; btn.classList.replace("bg-orange-600", "bg-emerald-600"); } }, 3000); } 
                else { btn.disabled = true; btn.innerHTML = `<span class='spinner'></span>`; await payInvoice(inv.id, false); showHouseHistory(unit, road); }
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
    toast("Payment recorded!");
    if(fullRefresh) loadBilling(true);
    else renderInvoices(); 
    loadStats();
}

async function loadStats() {
    try {
        const resSnap = await getDocs(collection(db, "residents"));
        qs("#statResidents").textContent = resSnap.size;
        const billSnap = await getDocs(query(collection(db, "invoices"), where("status", "==", "pending")));
        qs("#statBills").textContent = billSnap.size;
    } catch(e) {}
}

function loadNews() {
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(10));
  onSnapshot(q, (snap) => {
    const box = qs("#newsList"); box.innerHTML = "";
    snap.forEach(d => {
        const card = document.createElement("div"); card.className = "glass rounded-xl p-4";
        card.innerHTML = `<h4 class="font-bold">${d.data().title}</h4><p class="text-slate-300 text-sm mt-1">${d.data().content}</p>`;
        box.appendChild(card);
    });
  });
}

/* --- RESTORED RESIDENT LOGIC --- */
function loadResidents() {
    onSnapshot(query(collection(db, "residents"), orderBy("unitNumber")), (snap) => {
        allResidents.length = 0; snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
        renderResidents();
    });
}

function renderResidents() {
    const grid = qs("#residentsGrid"); grid.innerHTML = "";
    const term = qs("#residentSearch").value.toLowerCase().trim();
    
    allResidents.filter(r => {
        return !term || `${r.name} ${r.unitNumber} ${r.phone}`.toLowerCase().includes(term);
    }).forEach(r => {
        const card = document.createElement("div"); 
        card.className = "glass rounded-xl p-4 hover:bg-slate-800/50 cursor-pointer transition-all group relative border border-slate-700/30";
        
        card.innerHTML = `
            <div class="flex justify-between items-start mb-3">
                <h4 class="font-bold text-white group-hover:text-emerald-400 transition-colors">${r.name}</h4>
                <button class="edit-res-btn p-2 rounded bg-slate-800 text-slate-500 hover:text-blue-400 hover:bg-slate-700 transition-all opacity-0 group-hover:opacity-100">
                    <i class="fas fa-pen text-xs"></i>
                </button>
            </div>
            <div class="space-y-1">
                <p class="text-[11px] text-slate-400 font-medium uppercase tracking-wider">Unit ${r.unitNumber} • ${r.road || '-'}</p>
                <p class="text-[11px] text-slate-500"><i class="fas fa-phone mr-1.5 opacity-50"></i>${r.phone}</p>
            </div>
        `;
        
        card.querySelector(".edit-res-btn").onclick = (e) => { e.stopPropagation(); openResidentModal(r.id, r); };
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
    
    const tbody = qs("#profHistoryBody");
    tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-slate-500">Loading history...</td></tr>';
    modal.classList.remove("hidden");
    
    try {
        const q = query(collection(db, "invoices"), where("unitNumber", "==", res.unitNumber), where("road", "==", res.road || ""), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        tbody.innerHTML = snap.empty ? '<tr><td colspan="4" class="py-8 text-center text-slate-500">No history found.</td></tr>' : "";
        snap.forEach(d => {
            const inv = d.data();
            const tr = document.createElement("tr"); tr.className = "border-b border-slate-700/20";
            const isPaid = inv.status === 'paid';
            tr.innerHTML = `
                <td class="py-4 text-white">${inv.month} ${inv.year}</td>
                <td class="py-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td>
                <td class="py-4"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">${inv.status.toUpperCase()}</span></td>
                <td class="py-4 text-right text-[10px] font-mono text-slate-500">${inv.receiptNumber || '-'}</td>`;
            tbody.appendChild(tr);
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-red-400 text-xs">Error loading history. Verify unit/road names match.</td></tr>'; }
}

qs("#residentSearch").addEventListener("input", debounce(() => renderResidents()));
qs("#addResidentBtn").addEventListener("click", () => openResidentModal());

function openResidentModal(id = null, data = {}) {
  qs("#residentModal").classList.remove("hidden");
  qs("#residentModalTitle").textContent = id ? "Edit Resident" : "New Resident Registration";
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
    unitNumber: qs("#resUnit").value.trim(), road: qs("#resRoad").value.trim(), name: qs("#resName").value.trim(),
    phone: qs("#resPhone").value.trim(), pin: qs("#resPin").value.trim(), vehiclePlate: qs("#resVehicle").value.toUpperCase().trim()
  };
  setLoading(qs("#residentSubmitBtn"), true);
  try {
    if (id) await updateDoc(doc(db, "residents", id), payload);
    else await addDoc(collection(db, "residents"), payload);
    closeModal("residentModal");
    toast("Resident saved successfully!", "success");
  } catch(e) { toast("Error saving resident.", "error"); }
  finally { setLoading(qs("#residentSubmitBtn"), false); }
});

async function loadVisitors() {
  const q = query(collection(db, "visits"), orderBy("entryTime", "desc"), limit(20));
  const snap = await getDocs(q); const tbody = qs("#visitorsTableBody"); tbody.innerHTML = "";
  snap.forEach(d => {
    const tr = document.createElement("tr"); const data = d.data();
    tr.innerHTML = `<td class="px-4 py-3">${data.entryTime?.toDate().toLocaleDateString()}</td><td class="px-4 py-3">${data.carPlate}</td><td class="px-4 py-3">${data.unitNumber}</td><td class="px-4 py-3">${data.visitorName}</td><td class="px-4 py-3">${data.status}</td>`;
    tbody.appendChild(tr);
  });
}

qsa("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.closeModal)));

function init() { 
    initAuth(); 
    const y = new Date().getFullYear();
    const opts = [y-1, y, y+1].map(v => `<option value='${v}' ${v===y?'selected':''}>${v}</option>`).join('');
    if(qs("#bulkYear")) qs("#bulkYear").innerHTML = opts;
}
init();
