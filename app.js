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

const PAGE_SIZE = 50;

let currentUser = null;
let userProfile = null;
let userRole = null;
let tamanConfig = { name: "", roads: [] };
const listeners = {};
const allResidents = [];
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

/* UI helpers */
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

/* Listener lifecycle */
function unsub(key) {
  if (listeners[key]) { listeners[key](); delete listeners[key]; }
}
function unsubAll() {
  Object.keys(listeners).forEach(k => unsub(k));
}

/* Auth Logic */
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
        checkFirstAdmin();
        return;
      }
      const snap = await getDoc(doc(db, "admin_accounts", user.uid));
      if (!snap.exists()) {
        await signOut(auth);
        toast("Account not authorized in database.", "error");
        return;
      }
      userProfile = snap.data();
      userRole = userProfile.role;
      currentUser = user;
      qs("#adminOverlay").classList.add("hidden");
      qs("#userBadge").classList.remove("hidden");
      qs("#logoutBtn").classList.remove("hidden");
      qs("#userName").textContent = userProfile.name || user.email;
      qs("#userRole").textContent = userRole.replace("_", " ");
      applyRoleVisibility();
      showTab("news");
    } catch (err) {
      console.error("Auth callback error:", err);
      toast("Auth Error. Check console.", "error");
    }
  });
}

qs("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = qs("#loginEmail").value.trim();
  const password = qs("#loginPassword").value;
  const btn = qs("#loginBtn");
  setLoading(btn, true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast("Welcome back!", "success");
  } catch (err) {
    toast(err.message || "Login failed", "error");
  } finally {
    setLoading(btn, false);
  }
});

qs("#logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  unsubAll();
  toast("Logged out", "info");
});

async function checkFirstAdmin() {
  try {
    const snap = await getDocs(query(collection(db, "admin_accounts"), limit(1)));
    if (snap.empty) qs("#firstAdminForm").classList.remove("hidden");
  } catch (e) {
    console.log("Checking initial setup...");
  }
}

qs("#createFirstAdminBtn").addEventListener("click", async () => {
  const name = qs("#faName").value.trim();
  const email = qs("#faEmail").value.trim();
  const password = qs("#faPassword").value;
  if (!name || !email || !password || password.length < 6) {
    toast("Please fill all fields (password min 6 chars).", "error"); return;
  }
  const btn = qs("#createFirstAdminBtn");
  setLoading(btn, true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "admin_accounts", cred.user.uid), {
      name, email, role: "super_admin", createdAt: serverTimestamp()
    });
    toast("First admin created.", "success");
    qs("#firstAdminForm").classList.add("hidden");
    qs("#loginEmail").value = email;
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setLoading(btn, false);
  }
});

/* Tabs Management */
function showTab(name) {
  qsa(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  qsa(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  unsub("currentTab");
  if (name === "news") loadNews();
  if (name === "residents") loadResidents();
  if (name === "visitors") loadVisitors(true);
  if (name === "billing") { loadBilling(true); updateInvoiceResidentList(); }
  if (name === "settings") { loadSettings(); loadAdmins(); }
}

qsa(".tab-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

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
  box.innerHTML = "";
  (tamanConfig.roads || []).forEach(r => {
    const chip = document.createElement("div");
    chip.className = "px-3 py-1 rounded-full bg-slate-700 text-sm flex items-center gap-2";
    const lbl = document.createElement("span");
    lbl.textContent = r;
    const del = document.createElement("button");
    del.className = "text-slate-400 hover:text-red-400";
    del.innerHTML = '<i class="fas fa-times"></i>';
    del.onclick = () => removeRoad(r);
    chip.appendChild(lbl);
    chip.appendChild(del);
    box.appendChild(chip);
  });
  const sel = qs("#resRoad");
  sel.innerHTML = '<option value="">Select Road/Block</option>';
  (tamanConfig.roads || []).forEach(r => {
    const o = document.createElement("option");
    o.value = r; o.textContent = r;
    sel.appendChild(o);
  });
}

qs("#addRoadBtn").addEventListener("click", async () => {
  const v = qs("#newRoadName").value.trim();
  if (!v) { toast("Enter a road name.", "error"); return; }
  const roads = tamanConfig.roads || [];
  if (roads.includes(v)) { toast("Road already exists.", "error"); return; }
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads: [...roads, v], updatedAt: serverTimestamp() });
    qs("#newRoadName").value = "";
    toast("Road added.", "success");
    loadSettings();
  } catch (err) { toast(err.message, "error"); }
});

async function removeRoad(r) {
  if (!confirm(`Remove ${r}?`)) return;
  const roads = (tamanConfig.roads || []).filter(x => x !== r);
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, roads, updatedAt: serverTimestamp() });
    toast("Road removed.", "success");
    loadSettings();
  } catch (err) { toast(err.message, "error"); }
}

qs("#saveSettingsBtn").addEventListener("click", async () => {
  const name = qs("#tamanNameInput").value.trim();
  if (!name) { toast("Taman name required.", "error"); return; }
  try {
    await setDoc(doc(db, "settings", "taman_config"), { ...tamanConfig, name, updatedAt: serverTimestamp() });
    qs("#tamanNameDisplay").textContent = name;
    toast("Settings saved.", "success");
  } catch (err) { toast(err.message, "error"); }
});

/* News Management */
function loadNews() {
  unsub("currentTab");
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  listeners.currentTab = onSnapshot(q, (snap) => {
    const box = qs("#newsList");
    box.innerHTML = "";
    if (snap.empty) {
      box.innerHTML = '<p class="text-slate-400 text-center py-8">No announcements yet.</p>';
      return;
    }
    snap.forEach(d => box.appendChild(buildNewsCard(d.id, d.data())));
  }, err => toast(err.message, "error"));
}

function buildNewsCard(id, d) {
  const card = document.createElement("div");
  card.className = "glass rounded-xl p-4 flex flex-col md:flex-row gap-4";
  card.innerHTML = `
    <div class="flex-1">
      <div class="flex justify-between items-start mb-2">
        <h4 class="font-bold text-lg news-title"></h4>
        <button class="del-news text-red-400 hover:text-red-300 text-sm"><i class="fas fa-trash"></i></button>
      </div>
      <p class="text-slate-300 text-sm mb-3 news-body"></p>
      <div class="text-xs text-slate-500 flex items-center gap-2"><i class="far fa-clock"></i><span class="news-date"></span></div>
    </div>
  `;
  card.querySelector(".news-title").textContent = d.title || "Untitled";
  card.querySelector(".news-body").textContent = d.content || "";
  const dt = d.createdAt?.toDate ? d.createdAt.toDate().toLocaleString("en-MY") : "Just now";
  card.querySelector(".news-date").textContent = dt;
  card.querySelector(".del-news").onclick = async () => {
    if (!confirm("Delete this announcement?")) return;
    try { await deleteDoc(doc(db, "announcements", id)); toast("Deleted.", "success"); }
    catch (err) { toast(err.message, "error"); }
  };
  return card;
}

qs("#postNewsBtn").addEventListener("click", async () => {
  const title = qs("#newsTitle").value.trim();
  const content = qs("#newsContent").value.trim();
  const image = qs("#newsImage").value.trim();
  if (!title || !content) { toast("Title and content required.", "error"); return; }
  const btn = qs("#postNewsBtn");
  setLoading(btn, true);
  try {
    await addDoc(collection(db, "announcements"), {
      title, content, image: image || "", createdAt: serverTimestamp(), createdBy: userProfile?.name || currentUser?.email
    });
    qs("#newsTitle").value = ""; qs("#newsContent").value = ""; qs("#newsImage").value = "";
    toast("Announcement posted.", "success");
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(btn, false); }
});

/* Residents Management */
function loadResidents() {
  unsub("currentTab");
  const q = query(collection(db, "residents"), orderBy("unitNumber"));
  listeners.currentTab = onSnapshot(q, (snap) => {
    allResidents.length = 0;
    snap.forEach(d => allResidents.push({ id: d.id, ...d.data() }));
    qs("#statResidents").textContent = allResidents.length;
    buildRoadFilters();
    renderResidents();
    updateInvoiceResidentList();
  }, err => toast(err.message, "error"));
}

function buildRoadFilters() {
  const box = qs("#roadFilters");
  box.innerHTML = "";
  const mk = (label, active) => {
    const b = document.createElement("button");
    b.className = `px-3 py-1 rounded-full text-sm transition-all ${active ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
    b.textContent = label;
    b.onclick = () => { residentFilterRoad = label; buildRoadFilters(); renderResidents(); };
    return b;
  };
  box.appendChild(mk("All", residentFilterRoad === "All"));
  (tamanConfig.roads || []).forEach(r => box.appendChild(mk(r, residentFilterRoad === r)));
}

function renderResidents() {
  const term = qs("#residentSearch").value.toLowerCase();
  const grid = qs("#residentsGrid");
  grid.innerHTML = "";
  const filtered = allResidents.filter(r => {
    const okRoad = residentFilterRoad === "All" || (r.road || "") === residentFilterRoad;
    const okTerm = !term || `${r.unitNumber} ${r.name} ${r.phone}`.toLowerCase().includes(term);
    return okRoad && okTerm;
  });
  if (!filtered.length) {
    grid.innerHTML = '<p class="text-slate-400 col-span-full text-center py-8">No residents found.</p>';
    return;
  }
  filtered.forEach(r => grid.appendChild(buildResidentCard(r.id, r)));
}

qs("#residentSearch").addEventListener("input", debounce(() => renderResidents(), 300));

function buildResidentCard(id, d) {
  const card = document.createElement("div");
  card.className = "glass rounded-xl p-4 hover:bg-slate-800/50 transition-all group";
  card.innerHTML = `
    <div class="flex justify-between items-start mb-3">
      <div class="w-12 h-12 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-400 text-lg font-bold res-initial"></div>
      <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
        <button class="edit-res text-blue-400 hover:text-blue-300 w-8 h-8 rounded bg-slate-800 flex items-center justify-center"><i class="fas fa-pen"></i></button>
        <button class="del-res text-red-400 hover:text-red-300 w-8 h-8 rounded bg-slate-800 flex items-center justify-center"><i class="fas fa-trash"></i></button>
      </div>
    </div>
    <h4 class="font-bold text-lg mb-1 res-name"></h4>
    <p class="text-slate-400 text-sm mb-3 res-meta"></p>
    <div class="space-y-1 text-sm text-slate-300">
      <div class="flex items-center gap-2"><i class="fas fa-road text-slate-500 w-4"></i><span class="res-road"></span></div>
      <div class="flex items-center gap-2"><i class="fas fa-phone text-slate-500 w-4"></i><span class="res-phone"></span></div>
      <div class="flex items-center gap-2"><i class="fas fa-car text-slate-500 w-4"></i><span class="res-vehicle"></span></div>
    </div>
    <div class="mt-3 pt-3 border-t border-slate-700/50 flex justify-between items-center">
      <span class="text-xs text-slate-500 uppercase tracking-wider">PIN</span>
      <span class="font-mono text-emerald-400 font-bold tracking-widest res-pin"></span>
    </div>
  `;
  card.querySelector(".res-initial").textContent = (d.name || "?").charAt(0).toUpperCase();
  card.querySelector(".res-name").textContent = d.name || "Unknown";
  card.querySelector(".res-meta").textContent = `Unit ${d.unitNumber || "-"} • ${d.road || "-"}`;
  card.querySelector(".res-road").textContent = d.road || "-";
  card.querySelector(".res-phone").textContent = d.phone || "-";
  card.querySelector(".res-vehicle").textContent = d.vehiclePlate || "-";
  card.querySelector(".res-pin").textContent = d.pin || "----";
  card.querySelector(".edit-res").onclick = () => openResidentModal(id, d);
  card.querySelector(".del-res").onclick = () => deleteResident(id);
  return card;
}

qs("#addResidentBtn").addEventListener("click", () => {
  if (!(tamanConfig.roads || []).length) { toast("Configure roads in Settings first.", "error"); return; }
  openResidentModal();
});

function openResidentModal(id = null, data = {}) {
  qs("#residentModal").classList.remove("hidden");
  qs("#residentModalTitle").textContent = id ? "Edit Resident" : "Add Resident";
  qs("#residentId").value = id || "";
  qs("#resUnit").value = data.unitNumber || "";
  qs("#resRoad").value = data.road || "";
  qs("#resName").value = data.name || "";
  qs("#resPhone").value = data.phone || "";
  qs("#resEmail").value = data.email || "";
  qs("#resPin").value = data.pin || "";
  qs("#resVehicle").value = data.vehiclePlate || "";
}

qs("#residentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = qs("#residentId").value;
  const payload = {
    unitNumber: qs("#resUnit").value.trim(),
    road: qs("#resRoad").value,
    name: qs("#resName").value.trim(),
    phone: qs("#resPhone").value.trim(),
    email: qs("#resEmail").value.trim(),
    pin: qs("#resPin").value.trim(),
    vehiclePlate: qs("#resVehicle").value.trim().toUpperCase(),
    updatedAt: serverTimestamp()
  };
  if (!payload.unitNumber || !payload.road || !payload.name || !payload.phone || !payload.pin) {
    toast("Please fill all required fields.", "error"); return;
  }
  if (!validators.phone(payload.phone)) { toast("Invalid phone. Use 01XXXXXXXX.", "error"); return; }
  if (!validators.pin(payload.pin)) { toast("PIN must be 4–6 digits.", "error"); return; }

  const btn = qs("#residentSubmitBtn");
  setLoading(btn, true);
  try {
    if (id) {
      await updateDoc(doc(db, "residents", id), payload);
      toast("Resident updated.", "success");
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, "residents"), payload);
      toast("Resident added.", "success");
    }
    closeModal("residentModal");
    qs("#residentForm").reset();
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(btn, false); }
});

async function deleteResident(id) {
  if (!confirm("Delete this resident?")) return;
  try { await deleteDoc(doc(db, "residents", id)); toast("Resident deleted.", "success"); }
  catch (err) { toast(err.message, "error"); }
}

/* Visitors Management */
async function loadVisitors(reset = true) {
  if (reset) { visitorCursor.last = null; visitorCursor.hasMore = true; qs("#visitorsTableBody").innerHTML = ""; }
  if (!visitorCursor.hasMore) return;
  const constraints = [orderBy("entryTime", "desc"), limit(PAGE_SIZE)];
  if (visitorCursor.last) constraints.push(startAfter(visitorCursor.last));
  try {
    const snap = await getDocs(query(collection(db, "visits"), ...constraints));
    const tbody = qs("#visitorsTableBody");
    if (!snap.docs.length && reset) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">No visitor records found.</td></tr>';
    }
    snap.forEach(d => tbody.appendChild(buildVisitorRow(d.id, d.data())));
    visitorCursor.last = snap.docs[snap.docs.length - 1] || null;
    visitorCursor.hasMore = snap.docs.length === PAGE_SIZE;
    qs("#loadMoreVisitors").classList.toggle("hidden", !visitorCursor.hasMore);
    const activeSnap = await getDocs(query(collection(db, "visits"), where("status", "==", "entered")));
    qs("#statVisits").textContent = activeSnap.size;
  } catch (err) { toast(err.message, "error"); }
}

qs("#loadMoreVisitors").addEventListener("click", () => loadVisitors(false));

function buildVisitorRow(id, d) {
  const tr = document.createElement("tr");
  tr.className = "hover:bg-slate-800/30 transition-colors";
  const dt = d.entryTime?.toDate ? d.entryTime.toDate().toLocaleString("en-MY") : "-";
  
  // Status Color Logic
  let statusClass = "bg-slate-700 text-slate-300";
  let statusText = d.status || "Pending";

  if (d.status === "entered") {
    statusClass = "bg-emerald-500/20 text-emerald-400";
    statusText = "Active";
  } else if (d.status === "pending") {
    statusClass = "bg-amber-500/20 text-amber-400";
    statusText = "Pending";
  } else if (d.status === "cancelled") {
    statusClass = "bg-red-500/20 text-red-400";
    statusText = "Cancelled";
  }

  tr.innerHTML = `
    <td class="px-4 py-3 text-slate-300">${dt}</td>
    <td class="px-4 py-3 font-medium text-white v-plate"></td>
    <td class="px-4 py-3 text-slate-300 v-unit"></td>
    <td class="px-4 py-3 text-slate-300 v-name"></td>
    <td class="px-4 py-3 text-slate-300 v-phone"></td>
    <td class="px-4 py-3"><span class="px-2 py-1 rounded-full text-xs font-medium ${statusClass}">${statusText.toUpperCase()}</span></td>
    <td class="px-4 py-3 text-right">
      <button class="qr-btn text-blue-400 hover:text-blue-300 mr-2"><i class="fas fa-qrcode"></i></button>
      <button class="checkout-btn text-amber-400 hover:text-amber-300 ${d.status !== 'entered' ? 'opacity-20 pointer-events-none' : ''}"><i class="fas fa-sign-out-alt"></i></button>
    </td>
  `;
  tr.querySelector(".v-plate").textContent = d.carPlate || "-";
  // Fixed: Show Unit and Road
  tr.querySelector(".v-unit").textContent = `${d.unitNumber || "-"} (${d.road || "-"})`;
  tr.querySelector(".v-name").textContent = d.visitorName || "-";
  tr.querySelector(".v-phone").textContent = d.visitorPhone || "-";
  
  tr.querySelector(".qr-btn").onclick = () => showVisitorQR(id, d);
  tr.querySelector(".checkout-btn").onclick = () => checkoutVisitor(id);
  return tr;
}

qs("#visitorSearch").addEventListener("input", debounce(() => {
  const t = qs("#visitorSearch").value.toLowerCase();
  qsa("#visitorsTableBody tr").forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(t) ? "" : "none"; });
}, 300));

qs("#visitorForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const plate = qs("#visPlate").value.trim().toUpperCase();
  const unit = qs("#visUnit").value.trim();
  const name = qs("#visName").value.trim();
  const phone = qs("#visPhone").value.trim();
  const purpose = qs("#visPurpose").value.trim();
  if (!plate || !unit || !name || !phone) { toast("Fill required fields.", "error"); return; }
  if (!validators.plate(plate)) { toast("Invalid car plate format.", "error"); return; }
  if (!validators.phone(phone)) { toast("Invalid phone number.", "error"); return; }
  const btn = qs("#visitorSubmitBtn");
  setLoading(btn, true);
  try {
    await addDoc(collection(db, "visits"), {
      carPlate: plate, unitNumber: unit, visitorName: name, visitorPhone: phone,
      purpose, status: "entered", entryTime: serverTimestamp(),
      createdBy: userProfile?.name || currentUser?.email
    });
    toast("Visitor checked in.", "success");
    closeModal("visitorModal");
    qs("#visitorForm").reset();
    loadVisitors(true);
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(btn, false); }
});

async function checkoutVisitor(id) {
  try {
    await updateDoc(doc(db, "visits", id), { status: "exited", exitTime: serverTimestamp() });
    toast("Visitor checked out.", "success");
    loadVisitors(true);
  } catch (err) { toast(err.message, "error"); }
}

function showVisitorQR(id, d) {
  qs("#qrModal").classList.remove("hidden");
  const box = qs("#qrCodeContainer");
  box.innerHTML = "";
  new QRCode(box, { text: id, width: 200, height: 200, colorDark: "#0f172a", colorLight: "#ffffff" });
  const det = qs("#qrDetails");
  det.innerHTML = "";
  const add = (k, v) => {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = k + ": ";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(v || "-"));
    det.appendChild(p);
  };
  add("Plate", d.carPlate);
  add("Unit", d.unitNumber);
  add("Name", d.visitorName);
  add("Phone", d.visitorPhone);
}

/* Billing Management */
function updateInvoiceResidentList() {
    const sel = qs("#invResidentSelect");
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Click to Search Resident --</option>';
    allResidents.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, {numeric: true})).forEach(res => {
        const opt = document.createElement("option");
        opt.value = JSON.stringify({ unit: res.unitNumber, road: res.road });
        opt.textContent = `Unit ${res.unitNumber} (${res.road}) - ${res.name}`;
        sel.appendChild(opt);
    });
}

if (qs("#invResidentSelect")) {
  qs("#invResidentSelect").addEventListener("change", (e) => {
      if (!e.target.value) return;
      const data = JSON.parse(e.target.value);
      qs("#invUnit").value = data.unit;
      qs("#invRoad").value = data.road;
  });
}

async function loadBilling(reset = true) {
  if (reset) { invoiceCursor.last = null; invoiceCursor.hasMore = true; qs("#invoicesTableBody").innerHTML = ""; }
  if (!invoiceCursor.hasMore) return;
  const constraints = [orderBy("createdAt", "desc"), limit(PAGE_SIZE)];
  if (invoiceCursor.last) constraints.push(startAfter(invoiceCursor.last));
  try {
    const snap = await getDocs(query(collection(db, "invoices"), ...constraints));
    const tbody = qs("#invoicesTableBody");
    if (!snap.docs.length && reset) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">No invoices found.</td></tr>';
    }
    snap.forEach(d => tbody.appendChild(buildInvoiceRow(d.id, d.data())));
    invoiceCursor.last = snap.docs[snap.docs.length - 1] || null;
    invoiceCursor.hasMore = snap.docs.length === PAGE_SIZE;
    qs("#loadMoreInvoices").classList.toggle("hidden", !invoiceCursor.hasMore);
    const up = await getDocs(query(collection(db, "invoices"), where("status", "==", "pending")));
    qs("#statBills").textContent = up.size;
  } catch (err) { toast(err.message, "error"); }
}

qs("#loadMoreInvoices").addEventListener("click", () => loadBilling(false));

function buildInvoiceRow(id, d) {
  const tr = document.createElement("tr");
  tr.className = "hover:bg-slate-800/30 transition-colors";
  const sClass = d.status === "paid" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400";
  const sText = d.status === "paid" ? "Paid" : "Pending";
  tr.innerHTML = `
    <td class="px-4 py-3 font-mono text-slate-400 inv-id"></td>
    <td class="px-4 py-3 text-white inv-unit"></td>
    <td class="px-4 py-3 text-slate-300 inv-period"></td>
    <td class="px-4 py-3 font-medium text-white inv-amount"></td>
    <td class="px-4 py-3 text-slate-300 inv-due"></td>
    <td class="px-4 py-3"><span class="px-2 py-1 rounded-full text-xs font-medium ${sClass}">${sText}</span></td>
    <td class="px-4 py-3 text-right space-x-2">
      ${d.status !== "paid" ? `<button class="pay-btn text-emerald-400 hover:text-emerald-300 text-sm font-medium">Pay</button>` : `<span class="text-xs text-slate-500">Receipt: <span class="rcpt-num"></span></span>`}
      <button class="del-inv text-red-400 hover:text-red-300"><i class="fas fa-trash"></i></button>
    </td>
  `;
  tr.querySelector(".inv-id").textContent = d.invoiceId || id;
  tr.querySelector(".inv-unit").textContent = `${d.unitNumber || "-"} (${d.road || "-"})`;
  tr.querySelector(".inv-period").textContent = `${d.month || "-"} ${d.year || ""}`;
  tr.querySelector(".inv-amount").textContent = `RM ${parseFloat(d.amount || 0).toFixed(2)}`;
  tr.querySelector(".inv-due").textContent = d.dueDate || "-";
  const rcpt = tr.querySelector(".rcpt-num");
  if (rcpt) rcpt.textContent = d.receiptNumber || "-";
  const pb = tr.querySelector(".pay-btn");
  if (pb) pb.onclick = () => payInvoice(id);
  tr.querySelector(".del-inv").onclick = () => deleteInvoice(id);
  return tr;
}

function setupYearDropdowns() {
    const currentYear = new Date().getFullYear();
    const years = [currentYear - 1, currentYear, currentYear + 1];
    const targets = ["#bulkYear", "#invYear"];
    
    targets.forEach(selector => {
        const el = qs(selector);
        if(!el) return;
        el.innerHTML = years.map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`).join('');
    });
}

qs("#generateBulkBtn").addEventListener("click", async () => {
  const month = qs("#bulkMonth").value;
  const year = qs("#bulkYear").value;
  const amount = parseFloat(qs("#bulkAmount").value);
  const due = qs("#bulkDue").value;
  const remark = qs("#bulkRemark").value.trim() || "Security Fee";

  if (!month || isNaN(amount)) { 
    toast("Check Month/Amount", "error"); 
    return; 
  }
  
  const resSnap = await getDocs(collection(db, "residents"));
  if (resSnap.empty) {
    toast("No residents found to bill.", "error");
    return;
  }

  const btn = qs("#generateBulkBtn");
  setLoading(btn, true);

  try {
    const batch = writeBatch(db);
    let count = 0;

    resSnap.forEach(d => {
      const r = d.data();
      
      // FIX: Check for BOTH camelCase and underscore naming to prevent 'undefined'
      const unit = r.unitNumber || r.unit_number;
      const road = r.road;

      // Skip this resident if the critical data is missing
      if (!unit || !road) {
        console.warn(`Skipping invalid resident document: ${d.id}`);
        return; 
      }

      // Sanitize for the document ID path
      const cleanRoad = road.replace(/\//g, '-').replace(/\s+/g, '');
      const cleanUnit = unit.replace(/\s+/g, '');
      
      const invId = `INV-${cleanUnit}-${cleanRoad}-${month}-${year}`;
      const ref = doc(db, "invoices", invId);
      
      batch.set(ref, {
        invoiceId: invId,
        unitNumber: unit, // Use the detected unit value
        road: road,
        month,
        year: parseInt(year),
        amount,
        dueDate: due,
        description: remark,
        status: "pending",
        createdAt: serverTimestamp(),
        createdBy: userProfile?.name || currentUser?.email
      });
      count++;
    });
    
    if (count === 0) {
      toast("No valid residents found to bill (check for missing unit/road).", "error");
    } else {
      await batch.commit();
      toast(`Successfully generated ${count} bills!`, "success");
      loadBilling(true);
    }
  } catch (err) {
    console.error(err);
    toast("Error: " + err.message, "error");
  } finally {
    setLoading(btn, false);
  }
});

qs("#invoiceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unit = qs("#invUnit").value;
  const road = qs("#invRoad").value;
  const amount = parseFloat(qs("#invAmount").value);
  const month = qs("#invMonth").value;
  const year = qs("#invYear").value;
  const due = qs("#invDue").value || "-";

  if (!unit || !road || isNaN(amount)) { toast("Select a resident and enter amount.", "error"); return; }
  
  // Also sanitize road/unit for custom bills to prevent path errors
  const cleanRoad = road.replace(/\//g, '-').replace(/\s+/g, '');
  const cleanUnit = unit.replace(/\s+/g, '');
  const invId = `INV-${cleanUnit}-${cleanRoad}-${month}-${year}-${Date.now()}`;
  
  setLoading(qs("#invoiceSubmitBtn"), true);
  try {
    await setDoc(doc(db, "invoices", invId), {
      invoiceId: invId, unitNumber: unit, road: road, amount: amount, month, year: parseInt(year),
      dueDate: due, description: qs("#invDesc").value.trim() || "Custom Bill", status: "pending",
      createdAt: serverTimestamp(), createdBy: userProfile?.name || currentUser?.email
    });
    toast("Bill created successfully.", "success");
    closeModal("invoiceModal");
    qs("#invoiceForm").reset();
    qs("#invResidentSelect").value = "";
    loadBilling(true);
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(qs("#invoiceSubmitBtn"), false); }
});

async function payInvoice(id) {
  if (!confirm("Mark this invoice as paid?")) return;
  try {
    const receipt = `RCP-${Date.now()}`;
    await updateDoc(doc(db, "invoices", id), {
      status: "paid", receiptNumber: receipt,
      paidAt: serverTimestamp(), paidBy: userProfile?.name || currentUser?.email
    });
    toast(`Payment recorded. Receipt: ${receipt}`, "success");
    loadBilling(true);
  } catch (err) { toast(err.message, "error"); }
}

async function deleteInvoice(id) {
  if (!confirm("Delete this invoice?")) return;
  try { await deleteDoc(doc(db, "invoices", id)); toast("Invoice deleted.", "success"); loadBilling(true); }
  catch (err) { toast(err.message, "error"); }
}

/* Admins Management */
async function loadAdmins() {
  const snap = await getDocs(collection(db, "admin_accounts"));
  const tbody = qs("#adminTableBody");
  tbody.innerHTML = "";
  snap.forEach(d => {
    const data = d.data();
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-800/30 transition-colors";
    tr.innerHTML = `
      <td class="px-4 py-3 text-white a-name"></td>
      <td class="px-4 py-3 text-slate-300 a-email"></td>
      <td class="px-4 py-3"><span class="px-2 py-1 rounded-full text-xs font-medium bg-slate-700 text-slate-300 a-role"></span></td>
      <td class="px-4 py-3 text-right"><button class="del-adm text-red-400 hover:text-red-300"><i class="fas fa-trash"></i></button></td>
    `;
    tr.querySelector(".a-name").textContent = data.name || "-";
    tr.querySelector(".a-email").textContent = data.email || "-";
    tr.querySelector(".a-role").textContent = (data.role || "").replace("_", " ");
    tr.querySelector(".del-adm").onclick = () => deleteAdmin(d.id);
    tbody.appendChild(tr);
  });
}

async function deleteAdmin(uid) {
  if (!confirm("Remove this admin profile?")) return;
  try { await deleteDoc(doc(db, "admin_accounts", uid)); toast("Admin profile removed.", "success"); loadAdmins(); }
  catch (err) { toast(err.message, "error"); }
}

qs("#adminForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = qs("#admName").value.trim();
  const email = qs("#admEmail").value.trim();
  const password = qs("#admPassword").value;
  const role = qs("#admRole").value;
  if (!name || !email || !password || password.length < 6) { toast("Fill all fields correctly.", "error"); return; }
  const btn = qs("#adminSubmitBtn");
  setLoading(btn, true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "admin_accounts", cred.user.uid), {
      name, email, role, createdAt: serverTimestamp()
    });
    toast("Admin created.", "success");
    closeModal("adminModal");
    qs("#adminForm").reset();
    loadAdmins();
  } catch (err) { toast(err.message, "error"); }
  finally { setLoading(btn, false); }
});

/* Modal & Init Lifecycle */
qsa("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
});
qsa(".fixed.inset-0").forEach(el => {
  el.addEventListener("click", (e) => { if (e.target === el) el.classList.add("hidden"); });
});

qs("#addVisitorBtn").addEventListener("click", () => qs("#visitorModal").classList.remove("hidden"));
qs("#addInvoiceBtn").addEventListener("click", () => qs("#invoiceModal").classList.remove("hidden"));
qs("#createAdminShowBtn").addEventListener("click", () => qs("#adminModal").classList.remove("hidden"));

async function init() {
  initAuth();
  setupYearDropdowns();
}

init();
