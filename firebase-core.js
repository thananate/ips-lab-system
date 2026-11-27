// =========================================================================
// IPS ASSET SYSTEM - SHARED FIREBASE CORE & DYNAMIC LABS GUARD
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

// Get allowed labs: Super Admin, Admin, Lab Staff, and Teachers access all labs
function getUserAllowedLabs(user) {
  const allLabs = getAllLabNames();
  if (!user) return [];
  if (['Super Admin', 'Admin', 'Lab Staff', 'Teacher'].includes(user.role)) {
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
    if (req.docId === excludeReqId || req.id === excludeReqId) return;
    if (!['Pending', 'Approved', 'Partial'].includes(req.status)) return;
    if ((req.useDate || req.date) !== targetDate) return;

    if (startTime < req.endTime && endTime > req.startTime) {
      const matched
