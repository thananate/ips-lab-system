// =========================================================================
// IPS LAB SYSTEM - SHARED FIREBASE CORE & DYNAMIC LABS GUARD
// =========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCRotp0yrhYGc8zctl1Yo7Fknxz0AJnEZU",
  authDomain: "ips-lab-system.firebaseapp.com",
  projectId: "ips-lab-system",
  storageBucket: "ips-lab-system.firebasestorage.app",
  messagingSenderId: "475418589571",
  appId: "1:475418589571:web:ae676ffffee084c4b31eb6"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();

const DEFAULT_LABS = ['Primary', 'Physics', 'Chemistry', 'Biology', 'Mathematics Resource'];

window.IPS = {
  user: null,
  labs: [...DEFAULT_LABS],
  labDocs: [],
  equipments: [],
  requests: [],
  movements: [],
  purchases: [],
  users: []
};

// Get all active laboratory names dynamically
function getAllLabNames() {
  return (window.IPS.labs && window.IPS.labs.length > 0) ? window.IPS.labs : DEFAULT_LABS;
}

// Get allowed labs: Super Admin, Admin, and Lab Staff access all labs.
// Teachers access labs checked in User Management (supports both user[labName] and user.allowedLabs).
function getUserAllowedLabs(user) {
  const allLabs = getAllLabNames();
  if (!user) return [];
  if (['Super Admin', 'Admin', 'Lab Staff'].includes(user.role)) {
    return allLabs;
  }
  const labs = [];
  allLabs.forEach(l => {
    const inArray = Array.isArray(user.allowedLabs) && user.allowedLabs.includes(l);
    const inProp = user[l] === true || user[l] === 'true' || user[l] === 'Yes' || user[l] === '1';
    if (inArray || inProp) {
      labs.push(l);
    }
  });
  return labs;
}

// Helper: Determine if item is consumable/chemical (deducted permanently on approval)
function isConsumableOrChemical(eq) {
  if (!eq) return false;
  if (eq.expiryDate && eq.expiryDate.trim() !== '') return true;
  if (['Consumable', 'Chemical'].includes(eq.type)) return true;
  return false;
}

// Time-Slot Overlap Prevention Engine
function getAvailableForTimeSlot(eqDocId, targetDate, startTime, endTime, excludeReqId = null) {
  const eq = window.IPS.equipments.find(e => e.id === eqDocId);
  if (!eq) return 0;
  if (isConsumableOrChemical(eq)) return Number(eq.available || 0);

  const maxUsable = Number(eq.total || 0) - Number(eq.damaged || 0);
  if (!targetDate || !startTime || !endTime) return Number(eq.available || 0);

  let overlappingReserved = 0;
  window.IPS.requests.forEach(req => {
    if (req.id === excludeReqId) return;
    if (!['Approved', 'Partial'].includes(req.status)) return;
    if (req.useDate !== targetDate) return;

    if (startTime < req.endTime && endTime > req.startTime) {
      const matchedItem = (req.items || []).find(i => i.eqDocId === eqDocId);
      if (matchedItem && ['Approved', 'Partial'].includes(matchedItem.itemStatus)) {
        overlappingReserved += Number(matchedItem.approvedQty || 0);
      }
    }
  });
  return Math.max(0, maxUsable - overlappingReserved);
}

// Immutable Stock Movement Audit Log
async function addStockMovement(equipmentId, equipmentName, lab, action, qty, note) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await db.collection('movements').add({
    timestamp: Date.now(),
    date: now,
    equipmentId,
    equipmentName,
    lab,
    action,
    qty,
    staff: window.IPS.user ? window.IPS.user.name : 'System',
    note
  });
}

// Automatically set IPS.png as browser tab Favicon on every page
(function setIPSLogoFavicon() {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = 'IPS.png';
})();

// Shared Sidebar & Header Layout
function renderSharedLayout(activePage, pageTitle, pageSubtitle) {
  const user = window.IPS.user;
  const role = user.role;
  const allLabs = getAllLabNames();
  const allowedLabs = getUserAllowedLabs(user);

const menus = [
    { href: 'index.html', id: 'index', label: 'Dashboard (Home)', icon: 'layout-dashboard', roles: ['Teacher', 'Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'request.html', id: 'request', label: 'Equipment Request', icon: 'file-plus-2', roles: ['Teacher', 'Admin', 'Super Admin'] },
    { href: 'approve.html', id: 'approve', label: 'Device Borrowing Admin Section', icon: 'check-square', roles: ['Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'stock.html', id: 'stock', label: 'Inventory & Stock', icon: 'boxes', roles: ['Teacher', 'Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'purchase.html', id: 'purchase', label: 'Procurement (Purchase)', icon: 'shopping-cart', roles: ['Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'report.html', id: 'report', label: 'Analytics & Reports', icon: 'bar-chart-3', roles: ['Admin', 'Super Admin'] },
    { href: 'admin.html', id: 'admin', label: 'User & Lab Management', icon: 'users', roles: ['Super Admin'] }
  ];

  const navLinks = menus.filter(m => m.roles.includes(role)).map(m => {
    const isActive = m.id === activePage;
    return `
      <a href="${m.href}" class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${isActive ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-sm' : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'}">
        <i data-lucide="${m.icon}" class="w-4 h-4"></i>
        <span>${m.label}</span>
      </a>
    `;
  }).join('');

  const sidebarEl = document.getElementById('sharedSidebar');
  if (sidebarEl) {
    const labDisplay = allowedLabs.length === allLabs.length
      ? `Access: All ${allLabs.length} Labs`
      : (allowedLabs.length > 0 ? 'Lab: ' + allowedLabs.join(', ') : 'No Lab Assigned Yet');

    sidebarEl.innerHTML = `
      <div>
        <div class="p-5 flex items-center justify-between border-b border-slate-100">
          <a href="index.html" class="flex items-center gap-3">
            <img src="IPS.png" alt="IPS Lab Logo" class="w-10 h-10 object-contain rounded-xl bg-white p-0.5 shadow-sm border border-slate-100" />
            <div>
              <div class="font-bold text-slate-800 leading-tight">Device Borrowing IPS</div>
              <div class="text-[11px] text-emerald-600 font-medium">● Firebase Live</div>
            </div>
          </a>
          <button onclick="document.getElementById('mobileNavMenu').classList.toggle('hidden')" class="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100">
            <i data-lucide="menu" class="w-5 h-5"></i>
          </button>
        </div>
        <nav id="mobileNavMenu" class="hidden lg:block p-4 space-y-1.5">${navLinks}</nav>
      </div>
      <div class="p-4 border-t border-slate-100 hidden lg:block">
        <div class="bg-slate-50 rounded-xl p-3 mb-3">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center text-sm">${(user.name || 'U').charAt(0).toUpperCase()}</div>
            <div class="overflow-hidden">
              <div class="text-xs font-semibold text-slate-800 truncate">${user.name}</div>
              <div class="text-[11px] text-indigo-600 font-medium">${user.role}</div>
              <div class="text-[10px] ${allowedLabs.length === 0 ? 'text-rose-500 font-medium' : 'text-slate-400'} truncate">${labDisplay}</div>
            </div>
          </div>
        </div>
        <button onclick="auth.signOut().then(() => location.href='index.html')" class="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 transition">
          <i data-lucide="log-out" class="w-4 h-4"></i> Sign Out
        </button>
      </div>
    `;
  }

  const headerEl = document.getElementById('sharedHeader');
  if (headerEl) {
    headerEl.innerHTML = `
      <div>
        <h2 class="text-xl md:text-2xl font-bold text-slate-800">${pageTitle}</h2>
        <p class="text-xs md:text-sm text-slate-500">${pageSubtitle}</p>
      </div>
      <div class="flex items-center gap-2">
        <a href="index.html" class="px-3.5 py-2 rounded-xl bg-white border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 shadow-sm">
          <i data-lucide="home" class="w-3.5 h-3.5 text-indigo-600"></i> Back to Directory
        </a>
      </div>
    `;
  }
}

// Seed default labs if Firestore 'labs' collection is empty
async function ensureDefaultLabsSeeded() {
  const snap = await db.collection('labs').get();
  if (snap.empty) {
    for (let i = 0; i < DEFAULT_LABS.length; i++) {
      await db.collection('labs').add({
        name: DEFAULT_LABS[i],
        order: i + 1,
        createdAt: new Date().toISOString().slice(0, 10)
      });
    }
  }
}

// Page Bootloader & Real-time Firestore Sync
function initIPSPage({ activePage, title, subtitle, allowedRoles = null, requireLogin = true, onReady }) {
  auth.onAuthStateChanged(async (firebaseUser) => {
    if (!firebaseUser) {
      if (requireLogin) {
        window.location.href = 'index.html';
      } else if (onReady) {
        onReady(null);
      }
      return;
    }

    await ensureDefaultLabsSeeded();

    const userDoc = await db.collection('user').doc(firebaseUser.uid).get();
    let profile = {
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      name: firebaseUser.email.split('@')[0],
      role: 'Teacher',
      allowedLabs: []
    };
    if (userDoc.exists) {
      profile = { ...profile, ...userDoc.data(), uid: firebaseUser.uid };
    } else {
      await db.collection('user').doc(firebaseUser.uid).set(profile);
    }

    if (allowedRoles && !allowedRoles.includes(profile.role)) {
      Swal.fire({
        icon: 'error',
        title: 'Access Denied',
        text: `Your role (${profile.role}) does not have permission to access this page.`
      }).then(() => {
        window.location.href = 'index.html';
      });
      return;
    }

    window.IPS.user = profile;

    let loadedCount = 0;
    const checkInitialLoad = () => {
      loadedCount++;
      if (loadedCount >= 5) {
        renderSharedLayout(activePage, title, subtitle);
        if (onReady) onReady(profile);
        if (window.lucide) lucide.createIcons();
      }
    };

    db.collection('labs').orderBy('order', 'asc').onSnapshot(snap => {
      window.IPS.labDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      window.IPS.labs = window.IPS.labDocs.length > 0
        ? window.IPS.labDocs.map(l => l.name)
        : [...DEFAULT_LABS];
      checkInitialLoad();
    });

    db.collection('equipments').onSnapshot(snap => {
      window.IPS.equipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      checkInitialLoad();
    });
    db.collection('requests').onSnapshot(snap => {
      window.IPS.requests = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
      checkInitialLoad();
    });
    db.collection('movements').orderBy('timestamp', 'asc').onSnapshot(snap => {
      window.IPS.movements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      checkInitialLoad();
    });
    db.collection('purchases').onSnapshot(snap => {
      window.IPS.purchases = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
      checkInitialLoad();
    });
    db.collection('user').onSnapshot(snap => {
      window.IPS.users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      if (loadedCount >= 5 && onReady) onReady(profile);
    });
  });
}
