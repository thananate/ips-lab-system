// =========================================================================
// IPS ASSET SYSTEM - SHARED FIREBASE CORE & RESTRICTED ROOMS GUARD (V3)
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

// Optional: Paste your Google Apps Script Web App URL here to activate automated email notifications
const IPS_EMAIL_WEBHOOK_URL = "";

const DEFAULT_LABS = ['Primary', 'Physics', 'Chemistry', 'Biology', 'Mathematics Resource'];

window.IPS = {
  user: null,
  labs: [...DEFAULT_LABS],
  labDocs: [],
  equipments: [],
  requests: [],
  movements: [],
  purchases: [],
  repairs: [],
  maSchedules: [],
  users: []
};

// Check if a room is marked as Restricted / Private (e.g., ICT Assets)
function isRoomRestricted(roomName) {
  const doc = (window.IPS.labDocs || []).find(l => l.name === roomName);
  return Boolean(doc && doc.isRestricted === true);
}

// Get allowed rooms for current user (automatically hides Restricted rooms unless Super Admin or explicitly granted)
function getUserAllowedLabs(user) {
  const allDocs = window.IPS.labDocs || [];
  const allNames = allDocs.length > 0 ? allDocs.map(l => l.name) : [...DEFAULT_LABS];
  if (!user) return [];

  // Super Admin always sees every room including Restricted/Secret rooms
  if (user.role === 'Super Admin') {
    return allNames;
  }

  const explicitAccess = Array.isArray(user.allowedLabs) ? user.allowedLabs : [];
  const standardRoles = ['Admin', 'Lab Staff', 'Teacher', 'Staff', 'Office Staff'];

  return allNames.filter(roomName => {
    if (isRoomRestricted(roomName)) {
      return explicitAccess.includes(roomName) || user[roomName] === true || user[roomName] === 'true';
    }
    if (standardRoles.includes(user.role)) {
      return true;
    }
    return explicitAccess.includes(roomName) || user[roomName] === true || user[roomName] === 'true';
  });
}

// Get all room names visible to the current user (used by dropdowns across all pages)
function getAllLabNames() {
  if (window.IPS.user) {
    return getUserAllowedLabs(window.IPS.user);
  }
  const allDocs = window.IPS.labDocs || [];
  if (allDocs.length > 0) {
    return allDocs.filter(l => !l.isRestricted).map(l => l.name);
  }
  return [...DEFAULT_LABS];
}

// Helper: Determine if item is consumable/chemical (deducted permanently on approval)
function isConsumableOrChemical(eq) {
  if (!eq) return false;
  if (eq.expiryDate && eq.expiryDate.trim() !== '') return true;
  if (['Consumable', 'Chemical'].includes(eq.type)) return true;
  return false;
}

// Helper: Calculate days elapsed from a YYYY-MM-DD date string until today
function getDaysElapsed(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24)));
}

// Helper: Calculate days remaining until a YYYY-MM-DD future date (negative if overdue)
function getDaysRemaining(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

// Helper: Lookup employee email by name from 'user' collection
function getUserEmailByName(userName) {
  if (!userName || !Array.isArray(window.IPS.users)) return '';
  const target = String(userName).trim().toLowerCase();
  const found = window.IPS.users.find(u =>
    String(u.name || '').trim().toLowerCase() === target ||
    String(u.email || '').trim().toLowerCase() === target
  );
  return found ? (found.email || '') : '';
}

// Helper: Send automated email notification via Google Apps Script Webhook (and log queue in Firestore)
async function sendIPSEmailNotification({ toEmail, toName, subject, message, refId = '', category = 'General' }) {
  const resolvedEmail = toEmail || getUserEmailByName(toName);
  if (!resolvedEmail) return false;

  try {
    await db.collection('email_logs').add({
      timestamp: Date.now(),
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      toEmail: resolvedEmail,
      toName: toName || resolvedEmail,
      subject,
      message,
      refId,
      category,
      triggeredBy: window.IPS.user ? window.IPS.user.name : 'System',
      deliveryStatus: IPS_EMAIL_WEBHOOK_URL ? 'Sent' : 'Logged (Webhook Not Set)'
    });

    if (IPS_EMAIL_WEBHOOK_URL) {
      await fetch(IPS_EMAIL_WEBHOOK_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: resolvedEmail, subject, body: message, refId, category })
      });
    }
    return true;
  } catch (err) {
    console.warn('Email notification skipped:', err);
    return false;
  }
}

// Helper: Export any array of objects to Excel-compatible UTF-8 CSV file
function exportDataToCSV(filename, headers, rows) {
  const escapeCSV = (val) => {
    const str = String(val === null || val === undefined ? '' : val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent = '\uFEFF' + [
    headers.map(escapeCSV).join(','),
    ...rows.map(r => r.map(escapeCSV).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Time-Slot Overlap Prevention Engine
function getAvailableForTimeSlot(eqDocId, targetDate, startTime, endTime, excludeReqId = null) {
  const eq = window.IPS.equipments.find(e => e.id === eqDocId);
  if (!eq) return 0;
  if (isConsumableOrChemical(eq)) return Number(eq.available || 0);

  const maxUsable = Number(eq.total || 0) - Number(eq.damaged || 0) - Number(eq.inRepair || 0);
  if (!targetDate || !startTime || !endTime) return Number(eq.available || 0);

  let overlappingReserved = 0;
  window.IPS.requests.forEach(req => {
    if (req.docId === excludeReqId || req.id === excludeReqId) return;
    if (!['Pending', 'Approved', 'Partial'].includes(req.status)) return;
    if ((req.useDate || req.date) !== targetDate) return;

    if (startTime < req.endTime && endTime > req.startTime) {
      const matchedItem = (req.items || []).find(i => i.eqDocId === eqDocId);
      if (matchedItem) {
        const qty = Number(matchedItem.approvedQty || matchedItem.requestedQty || 0);
        overlappingReserved += qty;
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
  const allowedLabs = getUserAllowedLabs(user);
  const restrictedCount = allowedLabs.filter(r => isRoomRestricted(r)).length;

  let menus = [
    { href: 'index.html', id: 'index', label: 'Dashboard (Home)', icon: 'layout-dashboard', roles: ['Teacher', 'Staff', 'Office Staff', 'Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'request.html', id: 'request', label: 'Equipment Request', icon: 'file-plus-2', roles: ['Teacher', 'Staff', 'Office Staff', 'Admin', 'Super Admin'] },
    { href: 'approve.html', id: 'approve', label: 'Asset Admin Section', icon: 'check-square', roles: ['Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'stock.html', id: 'stock', label: 'Inventory & Stock', icon: 'boxes', roles: ['Teacher', 'Staff', 'Office Staff', 'Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'purchase.html', id: 'purchase', label: 'Procurement (Purchase)', icon: 'shopping-cart', roles: ['Lab Staff', 'Admin', 'Super Admin'] },
    { href: 'repair.html', id: 'repair', label: 'Repair & MA', icon: 'wrench', roles: ['Lab Staff', 'Staff', 'Admin', 'Super Admin'] },
    { href: 'report.html', id: 'report', label: 'Analytics & Reports', icon: 'bar-chart-3', roles: ['Admin', 'Super Admin'] },
    { href: 'admin.html', id: 'admin', label: 'User & Rooms Management', icon: 'users', roles: ['Super Admin'] }
  ];

  // Custom menu ordering specifically for Lab Staff: 1. Stock -> 2. Purchase -> 3. Asset Admin Section -> 4. Repair & MA -> 5. Home
  if (role === 'Lab Staff') {
    menus = [
      { href: 'stock.html', id: 'stock', label: 'Inventory & Stock', icon: 'boxes', roles: ['Lab Staff'] },
      { href: 'purchase.html', id: 'purchase', label: 'Procurement (Purchase)', icon: 'shopping-cart', roles: ['Lab Staff'] },
      { href: 'approve.html', id: 'approve', label: 'Asset Admin Section', icon: 'check-square', roles: ['Lab Staff'] },
      { href: 'repair.html', id: 'repair', label: 'Repair & MA', icon: 'wrench', roles: ['Lab Staff'] },
      { href: 'index.html', id: 'index', label: 'Dashboard (Home)', icon: 'layout-dashboard', roles: ['Lab Staff'] }
    ];
  }

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
    const labDisplay = allowedLabs.length > 0
      ? `Rooms: ${allowedLabs.length} Accessible${restrictedCount > 0 ? ` (🔒 ${restrictedCount} Secret)` : ''}`
      : 'No Room Assigned';

    sidebarEl.innerHTML = `
      <div>
        <div class="p-5 flex items-center justify-between border-b border-slate-100">
          <a href="index.html" class="flex items-center gap-3">
            <img src="IPS.png" alt="IPS Lab Logo" class="w-10 h-10 object-contain rounded-xl bg-white p-0.5 shadow-sm border border-slate-100" />
            <div>
              <div class="font-bold text-slate-800 leading-tight">IPS Asset System</div>
              <div class="text-[11px] text-emerald-600 font-medium">● Admin Panel (Firebase Live)</div>
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
        isRestricted: false,
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

    let loadedCollections = new Set();
    const triggerReady = (colName) => {
      loadedCollections.add(colName);
      if (loadedCollections.size >= 7) {
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
      triggerReady('labs');
    });

    db.collection('equipments').onSnapshot(snap => {
      window.IPS.equipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      triggerReady('equipments');
    });

    db.collection('requests').onSnapshot(snap => {
      window.IPS.requests = snap.docs.map(d => ({ docId: d.id, id: d.id, ...d.data() }));
      triggerReady('requests');
    });

    db.collection('movements').orderBy('timestamp', 'asc').onSnapshot(snap => {
      window.IPS.movements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      triggerReady('movements');
    });

    db.collection('purchases').onSnapshot(snap => {
      window.IPS.purchases = snap.docs.map(d => ({ docId: d.id, id: d.id, ...d.data() }));
      triggerReady('purchases');
    });

    db.collection('repairs').onSnapshot(snap => {
      window.IPS.repairs = snap.docs.map(d => ({ docId: d.id, id: d.id, ...d.data() }));
      triggerReady('repairs');
    });

    db.collection('ma_schedules').onSnapshot(snap => {
      window.IPS.maSchedules = snap.docs.map(d => ({ docId: d.id, id: d.id, ...d.data() }));
      triggerReady('ma_schedules');
    });

    db.collection('user').onSnapshot(snap => {
      window.IPS.users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      if (loadedCollections.size >= 7 && onReady) onReady(profile);
    });
  });
}
