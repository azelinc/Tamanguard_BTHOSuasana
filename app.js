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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const PAGE_SIZE = 100;
let userProfile = null;
let userRole = null;
let tamanConfig = { name: "", roads: [] };
const listeners = {};
const allResidents = [];
let allInvoices = []; 
let residentFilterRoad = "All";

function qs(s, p = document) { return p.querySelector(s); }
function qsa(s, p = document) { return p.querySelectorAll(s); }

function toast(msg, type = "info") {
  const el = qs("#toast");
  const map = { error: "bg-red-600", success: "bg-emerald-600", info: "bg-blue-600" };
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-opacity duration-300 pointer-events-none text-white ${map[type]}`;
  el.textContent = msg; el.classList.remove("opacity-0");
  setTimeout(() => el.classList.add("opacity-0"), 3500);
}

function setLoading(btn, on) {
  if (on) { btn.dataset.og = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>Wait…`; btn.disabled = true; } 
  else { btn.innerHTML = btn.dataset.og || btn.textContent; btn.disabled = false; }
}

function closeModal(id) { qs(`#${id}`).classList.add("hidden"); }

function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function loadStats() {
    try {
        const resSnap = await getDocs(collection(db, "residents"));
        qs("#statResidents").textContent = resSnap.size;
        const billSnap = await getDocs(query(collection(db, "invoices"), where("status", "==", "pending")));
        qs("#statBills").textContent = billSnap.size;
    } catch(e) {}
}

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
  if (name === "billing") { preloadResidentData().then(() => loadBilling(true)); updateInvoiceResidentList(); }
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
  renderRoads();
}

function renderRoads() {
  const box = qs("#roadList"); if(!box) return; box.innerHTML = "";
  (tamanConfig.roads || []).forEach(r => {
    const chip = document.createElement("div");
    chip.className = "px-3 py-1 rounded-full bg-slate-700 text-xs flex items-center gap-2";
    chip.innerHTML = `<span>${r}</span><button class="hover:text-red-400">×</button>`;
    chip.querySelector("button").onclick = () => removeRoad(r);
    box.appendChild(chip);
  });
  const sel = qs("#resRoad"); if(sel) {
    sel.innerHTML = '<option value="">Road</option>';
    (tamanConfig.roads || []).forEach(r => {
        const o = document.createElement("option"); o.value = r; o.textContent = r; sel.appendChild(o);
    });
  }
}

async function loadNews() {
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(20));
  const snap = await getDocs(q); const box = qs("#newsList"); box.innerHTML = "";
  snap.forEach(d => {
    const card = document.createElement("div"); card.className = "glass rounded-xl p-4";
    card.innerHTML = `<h4 class="font-bold">${d.data().title}</h4><p class="text-slate-300 text-sm mt-1">${d.data().content}</p>`;
    box.appendChild(card);
  });
}

function loadResidents() {
    onSnapshot(query(collection(db, "residents"), orderBy("unitNumber")), (snap) => {
        allResidents.length = 0; snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
        renderResidents();
    });
}

function renderResidents() {
    const grid = qs("#residentsGrid"); grid.innerHTML = "";
    allResidents.forEach(r => {
        const card = document.createElement("div"); card.className = "glass rounded-xl p-4";
        card.innerHTML = `<h4 class="font-bold">${r.name}</h4><p class="text-xs text-slate-400">Unit ${r.unitNumber} • ${r.road}</p>`;
        grid.appendChild(card);
    });
}

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
    const tr = document.createElement("tr"); tr.className = "hover:bg-slate-800/30 transition-colors group border-b border-slate-700/50";
    tr.innerHTML = `
      <td class="px-4 py-3 font-mono text-[10px] text-slate-500">${inv.id.substring(0,10)}</td>
      <td class="px-4 py-3"><button class="view-h text-left group-hover:text-purple-400"><span class="block font-bold text-white">${inv.unitNumber}</span><span class="text-[10px] text-slate-500">${inv.road}</span></button></td>
      <td class="px-4 py-3 text-slate-300 text-sm">${inv.month} ${inv.year}</td>
      <td class="px-4 py-3 font-bold">RM ${parseFloat(inv.amount).toFixed(2)}</td>
      <td class="px-4 py-3 text-slate-400 text-xs">${inv.dueDate || '-'}</td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-full text-[10px] font-bold ${inv.status==='paid'?'bg-emerald-500/20 text-emerald-400':'bg-amber-500/20 text-amber-400'}">${inv.status.toUpperCase()}</span></td>
      <td class="px-4 py-3 text-right"><button class="pay-b text-emerald-400 text-xs font-bold ${inv.status==='paid'?'hidden':''}">PAY</button></td>`;
    tr.querySelector(".view-h").onclick = () => showHouseHistory(inv.unitNumber, inv.road);
    if(tr.querySelector(".pay-b")) tr.querySelector(".pay-b").onclick = () => payInvoice(inv.id);
    tbody.appendChild(tr);
  });
}

qs("#invoiceSearch").addEventListener("input", debounce(() => renderInvoices(), 50));
qs("#hidePaidToggle").addEventListener("change", () => renderInvoices());

// --- Updated House History Logic ---
function showHouseHistory(unit, road) {
    const tbody = qs("#historyTableBody");
    qs("#historyUnitTitle").textContent = `Unit ${unit} (${road})`;
    tbody.innerHTML = "";
    
    // Filter from our local master list (allInvoices)
    const history = allInvoices.filter(i => i.unitNumber === unit && i.road === road);

    if (history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-slate-500">No records found.</td></tr>`;
    }

    history.forEach(inv => {
        const tr = document.createElement("tr");
        tr.className = "border-b border-slate-700/30 hover:bg-slate-800/20 transition-colors";
        const isPaid = inv.status === 'paid';
        
        tr.innerHTML = `
            <td class="px-4 py-4 text-white font-medium">${inv.month} ${inv.year}</td>
            <td class="px-4 py-4 text-slate-300">RM ${parseFloat(inv.amount).toFixed(2)}</td>
            <td class="px-4 py-4">
                <span class="text-[10px] font-bold px-2 py-1 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">
                    ${inv.status.toUpperCase()}
                </span>
            </td>
            <td class="px-4 py-4 text-right">
                ${isPaid ? 
                    `<span class='text-[10px] text-slate-500 font-mono'>${inv.receiptNumber}</span>` : 
                    `<button class='h-pay-btn bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-all shadow-lg shadow-emerald-900/20'>PAY</button>`
                }
            </td>`;
        
        const btn = tr.querySelector(".h-pay-btn");
        if(btn) {
            // "Double-Tap" in-app confirmation logic
            btn.onclick = async () => {
                if (btn.textContent === "PAY") {
                    btn.textContent = "CONFIRM?";
                    btn.classList.replace("bg-emerald-600", "bg-orange-600");
                    // Reset back to "PAY" if they don't click again within 3 seconds
                    setTimeout(() => {
                        if(btn.textContent === "CONFIRM?") {
                            btn.textContent = "PAY";
                            btn.classList.replace("bg-orange-600", "bg-emerald-600");
                        }
                    }, 3000);
                } else {
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fas fa-spinner animate-spin"></i>`;
                    await payInvoice(inv.id, false); // "false" tells it not to close modal or reload everything
                    
                    // Update local UI immediately without closing modal
                    inv.status = 'paid';
                    inv.receiptNumber = `RCP-${Date.now()}`; // Temporary visual receipt
                    showHouseHistory(unit, road); // Refresh the list inside modal
                }
            };
        }
        tbody.appendChild(tr);
    });
    qs("#historyModal").classList.remove("hidden");
}

// --- Updated Pay Function ---
// Added 'refreshAll' parameter to control UI behavior
async function payInvoice(id, refreshAll = true) {
    try {
        const rcpt = `RCP-${Date.now()}`;
        const invRef = doc(db, "invoices", id);
        
        await updateDoc(invRef, { 
            status: "paid", 
            receiptNumber: rcpt,
            paidAt: serverTimestamp() 
        });

        // Update the local data object in our master array so the background list stays synced
        const localInv = allInvoices.find(i => i.id === id);
        if (localInv) {
            localInv.status = "paid";
            localInv.receiptNumber = rcpt;
        }

        toast("Payment recorded successfully!", "success");
        
        if (refreshAll) {
            loadBilling(true); // Only refresh whole page if paid from main list
            loadStats();
        } else {
            renderInvoices(); // Just re-draw the main list in the background
            loadStats();
        }
    } catch (err) {
        console.error(err);
        toast("Failed to update payment.", "error");
    }
}

function updateInvoiceResidentList() {
    const sel = qs("#invResidentSelect"); if(!sel) return;
    sel.innerHTML = '<option value="">-- Search Resident --</option>';
    allResidents.forEach(r => {
        const o = document.createElement("option"); o.value = JSON.stringify({u: r.unitNumber, r: r.road});
        o.textContent = `Unit ${r.unitNumber} (${r.road}) - ${r.name}`; sel.appendChild(o);
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
