import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ShoppingCart, Plus, Minus, Trash2, Bell, Package, Edit3, Check, X,
  Lock, Store, ClipboardList, TrendingUp, Phone, MapPin, User,
  MessageSquare, Search, Download, AlertTriangle, History,
  BellRing, Volume2, VolumeX, Image as ImageIcon,
  RefreshCw, Users, LogOut, Save, Pencil, Upload, FileDown,
  Copy, ArrowRight, Clock, DollarSign,
  PieChart, Home, Calendar,
  Truck, UserPlus, Repeat, BarChart3, ShieldCheck,
} from 'lucide-react';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* ============================================================
   TILAPIA SHOP v4-SUPABASE — JSX (Vercel deploy)
   Built on v3. Major additions:
   - Buyer status lookup via ?track=ORD-XXXX URL (public)
   - Sequential human-readable order numbers (ORD-0001)
   - Cost field + margin analytics + profit tracking
   - Stock ledger (movements: restock, sale, adjust, cancel-release)
   - Quick restock button on products
   - Reservation TTL: auto-cancel 'new' orders >24h on admin load
   - WA status message templates (confirmed/ready/delivered/remind)
   - Order search + filter by date range, status, text
   - Delivery zone pricing
   - PDPA consent checkbox + privacy notice
   - Manual order entry (admin creates for walk-in)
   - Repeat order from CustomersTab
   - Receipt download (text + copy to WA)
   - OrderCard: edit customer info (fix typos)
   - Daily revenue sparkline in Stats
   - Dashboard home tab (today's summary)
   - Error boundary for graceful crash handling
   - Input sanitization (basic XSS protection)
   - Enhanced validation
   Preserves v3 storage keys for data continuity.
   Migrated: window.storage → Supabase KV (tilapia_kv table).
   Bug fix: auto-cancel TTL now logs ledger cancel-release entries.
   ============================================================ */

/* ============================================================
   STORAGE LAYER — Supabase KV (migrated from window.storage v3/v4)
   ============================================================ */

// Supabase client — env vars injected by Vercel
const SUPABASE_URL      = import.meta.env?.VITE_SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Storage key constants (unchanged from v3/v4 for data continuity)
const K = {
  PRODUCTS: 'tilapia:v3:products',
  ORDERS:   'tilapia:v3:orders',
  SHOP:     'tilapia:v3:shop',
  ADMIN:    'tilapia:v3:admin',
  CART:     'tilapia:v3:cart',
  SEEN:     'tilapia:v3:seen',
  AUDIT:    'tilapia:v3:audit',
  PREFS:    'tilapia:v3:prefs',
  LEDGER:   'tilapia:v4:ledger',
  SEQ:      'tilapia:v4:seq',
  ZONES:    'tilapia:v4:zones',
};

// Supabase KV helpers — replaces window.storage
// Table: tilapia_kv (key text PK, value jsonb, updated_at timestamptz)
// Note: 'shared' param retained for API compatibility but all data lives in Supabase
const sGet = async (key, fallback, shared = false) => {
  try {
    const { data, error } = await supabase
      .from('tilapia_kv')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return fallback;
    return data.value ?? fallback;
  } catch { return fallback; }
};

const sSet = async (key, val, shared = false) => {
  try {
    const { error } = await supabase
      .from('tilapia_kv')
      .upsert({ key, value: val, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    return !error;
  } catch { return false; }
};

/* ============================================================
   CRYPTO-LIGHT — PIN hash + PII obfuscation (preserved from v3)
   ============================================================ */

const hashPin = (pin) => {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) h = ((h << 5) + h) ^ pin.charCodeAt(i);
  return (h >>> 0).toString(36);
};

const OBFUS_KEY = 'TiLaPiAiZzAtFaRmTeRn2026';
const obfus = (str) => {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++)
    out += String.fromCharCode(str.charCodeAt(i) ^ OBFUS_KEY.charCodeAt(i % OBFUS_KEY.length));
  try { return btoa(unescape(encodeURIComponent(out))); } catch { return ''; }
};
const deobfus = (enc) => {
  if (!enc) return '';
  try {
    const raw = decodeURIComponent(escape(atob(enc)));
    let out = '';
    for (let i = 0; i < raw.length; i++)
      out += String.fromCharCode(raw.charCodeAt(i) ^ OBFUS_KEY.charCodeAt(i % OBFUS_KEY.length));
    return out;
  } catch { return ''; }
};

const encryptOrder = (order) => ({
  ...order,
  customer: {
    _n: obfus(order.customer.name),
    _p: obfus(order.customer.phone),
    _a: obfus(order.customer.address || ''),
    _o: obfus(order.customer.notes || ''),
    delivery: order.customer.delivery,
    zone: order.customer.zone || '',
    pdpa: order.customer.pdpa || false,
  },
});
const decryptOrder = (o) => {
  if (!o.customer) return o;
  if (o.customer._n) {
    return {
      ...o,
      customer: {
        name: deobfus(o.customer._n),
        phone: deobfus(o.customer._p),
        address: deobfus(o.customer._a),
        notes: deobfus(o.customer._o),
        delivery: o.customer.delivery,
        zone: o.customer.zone || '',
        pdpa: o.customer.pdpa || false,
      },
    };
  }
  return o;
};

/* ============================================================
   UNIQUE ID — crypto.randomUUID + sequential order numbers
   ============================================================ */

const uid = (prefix = '') => {
  try {
    const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    return prefix ? `${prefix}-${raw}` : raw;
  } catch {
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6).toUpperCase();
  }
};

// Generate sequential ORD-0001 style number
const genOrderNum = async () => {
  const seq = await sGet(K.SEQ, { counter: 0 }, true);
  const next = (seq.counter || 0) + 1;
  await sSet(K.SEQ, { counter: next }, true);
  return `ORD-${String(next).padStart(4, '0')}`;
};

/* ============================================================
   INPUT SANITIZATION — basic XSS protection
   ============================================================ */

// Strip HTML tags and limit length (prevents script injection in displayed text)
const sanitizeText = (str, maxLen = 500) => {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .slice(0, maxLen)
    .trim();
};

/* ============================================================
   NOTIFICATION LAYER (preserved from v3)
   ============================================================ */

let _audioCtx = null;
const getCtx = () => {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  return _audioCtx;
};

const beep = (freq = 880, dur = 180, vol = 0.25) => {
  const ctx = getCtx(); if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = vol;
    osc.connect(g); g.connect(ctx.destination);
    osc.start();
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur / 1000);
    osc.stop(ctx.currentTime + dur / 1000);
  } catch {}
};

const playOrderChime = () => {
  beep(880, 140, 0.28);
  setTimeout(() => beep(1175, 140, 0.28), 160);
  setTimeout(() => beep(1568, 260, 0.28), 320);
};

const playLowStockChime = () => {
  beep(440, 180, 0.22);
  setTimeout(() => beep(330, 260, 0.22), 200);
};

const vibr = (pattern = [200, 100, 200, 100, 400]) => {
  try { navigator.vibrate?.(pattern); } catch {}
};

const requestNotifPerm = async () => {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
};

const pushNotif = (title, body) => {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'tilapia-' + Date.now(), requireInteraction: false });
    setTimeout(() => { try { n.close(); } catch {} }, 8000);
  } catch {}
};

let titleInterval = null;
let titleOrig = '';
const startTitleFlash = (msg) => {
  if (titleInterval) return;
  titleOrig = document.title || 'Tilapia Farm';
  let flip = false;
  titleInterval = setInterval(() => {
    document.title = flip ? titleOrig : msg;
    flip = !flip;
  }, 1000);
};
const stopTitleFlash = () => {
  if (titleInterval) {
    clearInterval(titleInterval);
    titleInterval = null;
    document.title = titleOrig || 'Tilapia Farm';
  }
};

/* ============================================================
   UTILITIES
   ============================================================ */

const normalizePhone = (input) => {
  if (!input) return { valid: false, normalized: '', wa: '' };
  const digits = String(input).replace(/[^\d]/g, '');
  let clean = digits.replace(/^60/, '').replace(/^0/, '');
  if (!/^\d{9,10}$/.test(clean)) return { valid: false, normalized: input, wa: '' };
  return { valid: true, normalized: '0' + clean, wa: '60' + clean };
};

const fmtRM = (n) => 'RM ' + Number(n || 0).toFixed(2);
const fmtQty = (n, unit = '') => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2)) + unit;
const fmtDateTime = (iso) => {
  try {
    return new Date(iso).toLocaleString('ms-MY', {
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
};
const shortDate = (iso) => {
  try { return new Date(iso).toLocaleDateString('ms-MY', { day: '2-digit', month: 'short' }); }
  catch { return iso; }
};
const daysAgo = (iso) => {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Hari ni';
    if (days === 1) return 'Semalam';
    if (days < 7) return `${days}h lepas`;
    return shortDate(iso);
  } catch { return iso; }
};

const exportCSV = (filename, rows) => {
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  try {
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { console.error('CSV export failed', e); }
};

const downloadJSON = (filename, obj) => {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { console.error('JSON export failed', e); }
};

const downloadText = (filename, text) => {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { console.error('Text export failed', e); }
};

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch { return false; }
  }
};

/* ============================================================
   WHATSAPP TRANSPORT + STATUS TEMPLATES
   ============================================================ */

const buildOrderWAMessage = (order, shop) => {
  const lines = [
    `*PESANAN BARU* - ${shop.name}`,
    `No. Order: ${order.id}`,
    `Tarikh: ${fmtDateTime(order.createdAt)}`,
    ``,
    `*Pelanggan:*`,
    `Nama: ${order.customer.name}`,
    `Telefon: ${order.customer.phone}`,
    `Kaedah: ${order.customer.delivery === 'pickup' ? 'Self Pickup' : 'Delivery'}`,
  ];
  if (order.customer.delivery === 'delivery' && order.customer.address) {
    lines.push(`Alamat: ${order.customer.address}`);
    if (order.customer.zone) lines.push(`Zone: ${order.customer.zone}`);
  }
  if (order.customer.notes) lines.push(`Nota: ${order.customer.notes}`);
  lines.push('', '*Item:*');
  order.items.forEach(i => {
    lines.push(`- ${i.name} x ${fmtQty(i.qty, i.unit || '')} = ${fmtRM(i.subtotal)}`);
  });
  lines.push('');
  lines.push(`Subtotal: ${fmtRM(order.subtotal)}`);
  if (order.deliveryFee > 0) lines.push(`Delivery: ${fmtRM(order.deliveryFee)}`);
  lines.push(`*TOTAL: ${fmtRM(order.total)}*`);
  lines.push('');
  lines.push('_Mohon sahkan pesanan. Terima kasih!_');
  return lines.join('\n');
};

const waUrlToShop = (shopPhone, text) => {
  const ph = normalizePhone(shopPhone);
  if (!ph.valid) return null;
  return `https://wa.me/${ph.wa}?text=${encodeURIComponent(text)}`;
};

// Build shareable tracking URL
const buildTrackUrl = (orderId) => {
  try {
    const base = window.location.origin + window.location.pathname;
    return `${base}?track=${encodeURIComponent(orderId)}`;
  } catch {
    return `?track=${encodeURIComponent(orderId)}`;
  }
};

// WA status templates - sent FROM admin TO buyer
const WA_TEMPLATES = {
  confirmed: (o, shop) => [
    `Salam ${o.customer.name} 👋`,
    ``,
    `Pesanan *${o.id}* (${fmtRM(o.total)}) dari *${shop.name}* telah kami terima dan sedang diproses.`,
    ``,
    `Kami akan maklumkan bila ikan dah siap. Terima kasih!`,
    ``,
    `🔗 Semak status: ${buildTrackUrl(o.id)}`,
  ].join('\n'),

  ready_pickup: (o, shop) => [
    `Salam ${o.customer.name} ✅`,
    ``,
    `Pesanan *${o.id}* anda dah *SIAP untuk pickup*.`,
    ``,
    `📍 Lokasi: ${shop.location}`,
    `💰 Total: ${fmtRM(o.total)}`,
    ``,
    `Sila datang ambil pada waktu operasi. Terima kasih!`,
  ].join('\n'),

  ready_delivery: (o, shop) => [
    `Salam ${o.customer.name} 🛵`,
    ``,
    `Pesanan *${o.id}* anda dah *SIAP untuk penghantaran*.`,
    ``,
    `📍 Alamat: ${o.customer.address}`,
    `💰 Total: ${fmtRM(o.total)} (termasuk delivery)`,
    ``,
    `Kami akan hantar dalam masa terdekat. Standby ya!`,
  ].join('\n'),

  delivered: (o, shop) => [
    `Salam ${o.customer.name} 🎉`,
    ``,
    `Pesanan *${o.id}* telah siap! Terima kasih sudi bersama *${shop.name}*.`,
    ``,
    `Jangan lupa review atau recommend kat kawan-kawan ya 🐟`,
    ``,
    `Order lagi bila-bila: ${typeof window !== 'undefined' ? window.location.origin + window.location.pathname : ''}`,
  ].join('\n'),

  remind_payment: (o, shop) => [
    `Salam ${o.customer.name} 💰`,
    ``,
    `Peringatan mesra tentang pesanan *${o.id}*:`,
    `Total: ${fmtRM(o.total)}`,
    ``,
    `Mohon buat pembayaran untuk kami proses pesanan. Tq!`,
  ].join('\n'),

  cancelled: (o, shop) => [
    `Salam ${o.customer.name}`,
    ``,
    `Pesanan *${o.id}* telah dibatalkan.`,
    ``,
    `Sebarang pertanyaan, sila hubungi kami. Terima kasih atas kefahaman.`,
  ].join('\n'),
};

const waUrlToCustomer = (customerPhone, text) => {
  const ph = normalizePhone(customerPhone);
  if (!ph.valid) return null;
  return `https://wa.me/${ph.wa}?text=${encodeURIComponent(text)}`;
};

/* ============================================================
   RECEIPT TEXT BUILDER
   ============================================================ */

const buildReceiptText = (order, shop) => {
  const sep = '========================';
  const lines = [
    sep,
    `     ${shop.name.toUpperCase()}`,
    `     RESIT PESANAN`,
    sep,
    ``,
    `No. Order : ${order.id}`,
    `Tarikh    : ${fmtDateTime(order.createdAt)}`,
    `Status    : ${order.status.toUpperCase()}`,
    ``,
    `Pelanggan : ${order.customer.name}`,
    `Telefon   : ${order.customer.phone}`,
    `Kaedah    : ${order.customer.delivery === 'pickup' ? 'Self Pickup' : 'Delivery'}`,
  ];
  if (order.customer.delivery === 'delivery' && order.customer.address) {
    lines.push(`Alamat    : ${order.customer.address}`);
  }
  lines.push('', sep, 'ITEM', sep);
  order.items.forEach(i => {
    lines.push(`${i.name}`);
    lines.push(`  ${fmtQty(i.qty, i.unit || '')} x ${fmtRM(i.price)} = ${fmtRM(i.subtotal)}`);
  });
  lines.push(sep);
  lines.push(`Subtotal         : ${fmtRM(order.subtotal)}`);
  if (order.deliveryFee > 0) {
    lines.push(`Delivery Fee     : ${fmtRM(order.deliveryFee)}`);
  }
  lines.push(`TOTAL            : ${fmtRM(order.total)}`);
  lines.push(sep);
  if (order.customer.notes) {
    lines.push(`Nota: ${order.customer.notes}`);
    lines.push('');
  }
  lines.push(`Hubungi: ${shop.phone}`);
  lines.push(`Lokasi: ${shop.location}`);
  lines.push('');
  lines.push(`Terima kasih! 🐟`);
  lines.push(sep);
  return lines.join('\n');
};

/* ============================================================
   DEFAULTS
   ============================================================ */

const DEFAULT_PRODUCTS = [
  { id: 'p1', name: 'Tilapia Segar Hidup', desc: 'Tangkap terus dari kolam, masih hidup', price: 18, cost: 10, unit: 'kg', stock: 50, emoji: '🐟', image: '', category: 'segar', active: true },
  { id: 'p2', name: 'Tilapia Bersih Siap', desc: 'Dah buang sisik & perut, sedia masak', price: 22, cost: 12, unit: 'kg', stock: 30, emoji: '🍽️', image: '', category: 'segar', active: true },
  { id: 'p3', name: 'Tilapia Salai', desc: 'Salai kayu getah, aroma kampung', price: 35, cost: 20, unit: 'kg', stock: 15, emoji: '🔥', image: '', category: 'proses', active: true },
  { id: 'p4', name: 'Fillet Tilapia', desc: 'Fillet bersih tanpa tulang', price: 38, cost: 22, unit: 'kg', stock: 20, emoji: '🥩', image: '', category: 'proses', active: true },
];

const DEFAULT_SHOP = {
  name: 'Tilapia Izzat Farm',
  phone: '0111234567',
  location: 'Terengganu',
  deliveryFee: 5,
  minOrder: 10,
  lowStockThreshold: 10,
  welcomeMsg: 'Tilapia segar terus dari kolam. Order online, kami hubungi untuk pengesahan.',
  halalCert: true,
  autoCancelHours: 24,
  pdpaText: 'Saya bersetuju data peribadi saya (nama, no. telefon, alamat) digunakan oleh kedai ini untuk memproses pesanan ini sahaja, mengikut Akta Perlindungan Data Peribadi 2010.',
};

const DEFAULT_PREFS = { sound: true, notif: true, vibrate: true };
const DEFAULT_ADMIN = { pinHash: hashPin('1234'), sessionUntil: 0, failedAttempts: 0, lockedUntil: 0 };
const DEFAULT_ZONES = [
  { id: 'z1', name: 'Dalam Bandar (<5km)', fee: 5 },
  { id: 'z2', name: 'Kawasan Tengah (5-15km)', fee: 10 },
  { id: 'z3', name: 'Jauh (>15km)', fee: 20 },
];
const SESSION_HOURS = 24;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 15;

const CATEGORIES = [
  { k: 'all', l: 'Semua' },
  { k: 'segar', l: '🐟 Segar' },
  { k: 'proses', l: '🔥 Diproses' },
];

/* ============================================================
   ERROR BOUNDARY
   ============================================================ */

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[Tilapia ErrorBoundary]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <div className="text-6xl mb-4">🐟💔</div>
            <h1 className="text-xl font-bold text-red-300 mb-2">Ada masalah berlaku</h1>
            <p className="text-sm text-slate-300 mb-4">App crash — tapi data ko selamat. Cuba reload page.</p>
            <div className="bg-slate-800 rounded-lg p-3 text-left text-xs text-slate-400 mb-4 overflow-auto max-h-40">
              <code>{String(this.state.error?.message || this.state.error)}</code>
            </div>
            <button
              onClick={() => { try { window.location.reload(); } catch {} }}
              className="w-full bg-teal-600 hover:bg-teal-500 py-3 rounded-lg font-semibold"
            >
              🔄 Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}


/* ============================================================
   MAIN APP COMPONENT
   ============================================================ */

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  // Check URL for tracking mode (public, no PIN needed)
  const trackingOrderId = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('track');
    } catch { return null; }
  }, []);

  const [mode, setMode] = useState(trackingOrderId ? 'tracking' : 'buyer');
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [shop, setShop] = useState(DEFAULT_SHOP);
  const [admin, setAdmin] = useState(DEFAULT_ADMIN);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [auditLog, setAuditLog] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [loading, setLoading] = useState(true);
  const [adminUnlocked, setAdminUnlocked] = useState(false);

  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);

  const seenRef = useRef(new Set());
  const prefsRef = useRef(DEFAULT_PREFS);
  const ordersRef = useRef([]);
  const mountedRef = useRef(true);

  useEffect(() => { ordersRef.current = orders; }, [orders]);

  const showAlert = useCallback((message, title = null) =>
    setModal({ type: 'alert', title, message }), []);
  const showConfirm = useCallback((message, onConfirm, title = 'Sahkan') =>
    setModal({ type: 'confirm', title, message, onConfirm, confirmLabel: 'Ya, Teruskan' }), []);
  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => mountedRef.current && setToast(null), 2500);
  }, []);

  /* --- initial load --- */
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      const [p, oEnc, sh, ad, pr, seen, au, le, zn] = await Promise.all([
        sGet(K.PRODUCTS, DEFAULT_PRODUCTS, true),
        sGet(K.ORDERS, [], true),
        sGet(K.SHOP, DEFAULT_SHOP, true),
        sGet(K.ADMIN, DEFAULT_ADMIN, false),
        sGet(K.PREFS, DEFAULT_PREFS, false),
        sGet(K.SEEN, [], false),
        sGet(K.AUDIT, [], false),
        sGet(K.LEDGER, [], true),
        sGet(K.ZONES, DEFAULT_ZONES, true),
      ]);
      if (!mountedRef.current) return;

      // Backfill cost field for legacy products
      const productsWithCost = p.map(prod => ({ ...prod, cost: Number(prod.cost) || 0 }));

      setProducts(productsWithCost);
      setOrders(oEnc.map(decryptOrder));
      setShop({ ...DEFAULT_SHOP, ...sh });
      setAdmin({ ...DEFAULT_ADMIN, ...ad });
      setPrefs({ ...DEFAULT_PREFS, ...pr });
      prefsRef.current = { ...DEFAULT_PREFS, ...pr };
      seenRef.current = new Set(seen);
      setAuditLog(au);
      setLedger(le);
      setZones(zn.length > 0 ? zn : DEFAULT_ZONES);

      // Auto-resume admin session if still valid (skip in tracking mode)
      if (!trackingOrderId && ad?.sessionUntil && ad.sessionUntil > Date.now()) {
        setMode('admin');
        setAdminUnlocked(true);
      }
      setLoading(false);
    })();
    return () => { mountedRef.current = false; stopTitleFlash(); };
  }, [trackingOrderId]);

  /* --- save helpers --- */
  const saveProducts = useCallback(async (next) => {
    setProducts(next);
    await sSet(K.PRODUCTS, next, true);
  }, []);
  const saveOrders = useCallback(async (next) => {
    setOrders(next);
    await sSet(K.ORDERS, next.map(encryptOrder), true);
  }, []);
  const saveShop = useCallback(async (next) => {
    setShop(next);
    await sSet(K.SHOP, next, true);
  }, []);
  const saveAdmin = useCallback(async (next) => {
    setAdmin(next);
    await sSet(K.ADMIN, next, false);
  }, []);
  const savePrefs = useCallback(async (next) => {
    setPrefs(next);
    prefsRef.current = next;
    await sSet(K.PREFS, next, false);
  }, []);
  const saveZones = useCallback(async (next) => {
    setZones(next);
    await sSet(K.ZONES, next, true);
  }, []);
  const saveSeen = useCallback(async () => {
    await sSet(K.SEEN, Array.from(seenRef.current), false);
  }, []);
  const addAudit = useCallback(async (action, detail) => {
    const entry = { id: uid(), at: new Date().toISOString(), action, detail };
    setAuditLog(prev => {
      const next = [entry, ...prev].slice(0, 200);
      sSet(K.AUDIT, next, false);
      return next;
    });
  }, []);

  const addLedger = useCallback(async (type, productId, productName, qty, note = '') => {
    const entry = {
      id: uid(),
      at: new Date().toISOString(),
      type,               // 'restock' | 'sale' | 'adjust' | 'cancel-release' | 'initial'
      productId,
      productName,
      qty,                // positive = in, negative = out
      note,
    };
    setLedger(prev => {
      const next = [entry, ...prev].slice(0, 500);
      sSet(K.LEDGER, next, true);
      return next;
    });
  }, []);

  /* --- polling (preserved from v3, uses ordersRef to fix stale closure) --- */
  useEffect(() => {
    if (mode !== 'admin' || !adminUnlocked) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const latestEnc = await sGet(K.ORDERS, [], true);
      const latest = latestEnc.map(decryptOrder);
      if (cancelled) return;

      const fresh = latest.filter(o => !seenRef.current.has(o.id));
      if (fresh.length > 0) {
        fresh.forEach(o => seenRef.current.add(o.id));
        await saveSeen();

        const notifiable = fresh.filter(o => o.status === 'new');
        if (notifiable.length > 0) {
          if (prefsRef.current.sound) playOrderChime();
          if (prefsRef.current.vibrate) vibr();
          if (prefsRef.current.notif) {
            notifiable.forEach(o => {
              const custName = o.customer?.name || 'Customer';
              pushNotif(`🔔 Order Baru ${o.id}`,
                `${custName} • ${fmtRM(o.total)} • ${o.items.length} item`);
            });
          }
          startTitleFlash(`🔔 (${notifiable.length}) Order Baru!`);
        }
      }

      const cur = ordersRef.current;
      const curIds = cur.map(o => o.id).sort().join('|');
      const newIds = latest.map(o => o.id).sort().join('|');
      if (curIds !== newIds || JSON.stringify(cur) !== JSON.stringify(latest)) {
        if (!cancelled) setOrders(latest);
      }
    };

    let iv;
    const schedule = () => {
      clearInterval(iv);
      const delay = document.hidden ? 10000 : 3000;
      iv = setInterval(tick, delay);
    };
    schedule();
    const onVis = () => schedule();
    document.addEventListener('visibilitychange', onVis);
    tick();

    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [mode, adminUnlocked, saveSeen]);

  /* --- Reservation TTL: auto-cancel stale 'new' orders on admin load --- */
  useEffect(() => {
    if (mode !== 'admin' || !adminUnlocked) return;
    const ttlMs = (shop.autoCancelHours || 24) * 3600 * 1000;
    const now = Date.now();
    const stale = orders.filter(o =>
      o.status === 'new' && (now - new Date(o.createdAt).getTime()) > ttlMs
    );
    if (stale.length > 0) {
      (async () => {
        const latestEnc = await sGet(K.ORDERS, [], true);
        const latest = latestEnc.map(decryptOrder);
        const next = latest.map(o =>
          stale.find(s => s.id === o.id)
            ? { ...o, status: 'cancelled', autoCancelledAt: new Date().toISOString() }
            : o
        );
        await sSet(K.ORDERS, next.map(encryptOrder), true);
        setOrders(next);
        // BUG FIX: log cancel-release ledger entry for each item in auto-cancelled orders
        for (const o of stale) {
          for (const item of o.items) {
            await addLedger('cancel-release', item.id, item.name, item.qty, `Auto-cancel ${o.id}`);
          }
        }
        await addAudit('AUTO_CANCEL', `${stale.length} order 'new' >24h`);
        showToast(`${stale.length} order lama (>${shop.autoCancelHours || 24}j) auto-dibatalkan. Stok direlease.`, 'info');
      })();
    }
  }, [mode, adminUnlocked, shop.autoCancelHours]);

  const ackNewOrders = useCallback(() => { stopTitleFlash(); }, []);
  const newOrdersCount = orders.filter(o => o.status === 'new').length;

  const reservedByProduct = {};
  orders.forEach(o => {
    if (o.status === 'new' || o.status === 'processing') {
      o.items.forEach(i => {
        reservedByProduct[i.id] = (reservedByProduct[i.id] || 0) + i.qty;
      });
    }
  });
  const availableStock = (pid) => {
    const p = products.find(x => x.id === pid);
    if (!p) return 0;
    return Math.max(0, p.stock - (reservedByProduct[pid] || 0));
  };

  const tryUnlock = async (pin) => {
    // Lockout check
    if (admin.lockedUntil && admin.lockedUntil > Date.now()) {
      const mins = Math.ceil((admin.lockedUntil - Date.now()) / 60000);
      showAlert(`Terlalu banyak PIN salah. Cuba lagi dalam ${mins} minit.`);
      return false;
    }

    if (hashPin(pin) !== admin.pinHash) {
      const attempts = (admin.failedAttempts || 0) + 1;
      const patch = { ...admin, failedAttempts: attempts };
      if (attempts >= MAX_PIN_ATTEMPTS) {
        patch.lockedUntil = Date.now() + PIN_LOCKOUT_MINUTES * 60000;
        patch.failedAttempts = 0;
        await saveAdmin(patch);
        showAlert(`PIN salah ${MAX_PIN_ATTEMPTS}x. Dikunci ${PIN_LOCKOUT_MINUTES} minit.`);
      } else {
        await saveAdmin(patch);
        showAlert(`PIN salah. Cuba ${MAX_PIN_ATTEMPTS - attempts} kali lagi sebelum dikunci.`);
      }
      return false;
    }

    const sessionUntil = Date.now() + SESSION_HOURS * 3600 * 1000;
    await saveAdmin({ ...admin, sessionUntil, failedAttempts: 0, lockedUntil: 0 });
    setAdminUnlocked(true);
    const perm = await requestNotifPerm();
    if (perm === 'granted') showToast('🔔 Notifikasi diaktifkan', 'success');
    else if (perm === 'denied') showToast('⚠️ Notifikasi blocked', 'error');
    if (seenRef.current.size === 0) {
      orders.forEach(o => seenRef.current.add(o.id));
      await saveSeen();
    }
    await addAudit('LOGIN', 'Admin unlocked');
    return true;
  };

  const logoutAdmin = async () => {
    await saveAdmin({ ...admin, sessionUntil: 0 });
    setAdminUnlocked(false);
    setMode('buyer');
    stopTitleFlash();
    await addAudit('LOGOUT', 'Admin logged out');
    showToast('Logged out', 'info');
  };

  const placeOrder = async (order) => {
    // Generate sequential order number
    const orderNum = await genOrderNum();
    const finalOrder = { ...order, id: orderNum };

    const latestEnc = await sGet(K.ORDERS, [], true);
    const latest = latestEnc.map(decryptOrder);
    const next = [finalOrder, ...latest];
    await sSet(K.ORDERS, next.map(encryptOrder), true);
    setOrders(next);
    return finalOrder;
  };

  const updateOrder = async (id, patch) => {
    const latestEnc = await sGet(K.ORDERS, [], true);
    const latest = latestEnc.map(decryptOrder);
    const prev = latest.find(o => o.id === id);
    if (!prev) return;
    const updated = { ...prev, ...patch };
    const next = latest.map(o => o.id === id ? updated : o);

    // On status change to 'done': decrement stock + ledger 'sale'
    if (patch.status === 'done' && prev.status !== 'done') {
      const updatedProducts = products.map(p => {
        const item = updated.items.find(i => i.id === p.id);
        if (item) return { ...p, stock: Math.max(0, p.stock - item.qty) };
        return p;
      });
      await saveProducts(updatedProducts);
      // Log sale movements
      for (const item of updated.items) {
        await addLedger('sale', item.id, item.name, -item.qty, `Order ${id}`);
      }
      updatedProducts.forEach(p => {
        if (p.stock > 0 && p.stock <= shop.lowStockThreshold) {
          pushNotif('⚠️ Stok Rendah', `${p.name}: tinggal ${fmtQty(p.stock, p.unit)}`);
          if (prefsRef.current.sound) playLowStockChime();
        }
      });
    }

    // Log reservation release when order cancelled from 'new'/'processing'
    if (patch.status === 'cancelled' && (prev.status === 'new' || prev.status === 'processing')) {
      for (const item of updated.items) {
        await addLedger('cancel-release', item.id, item.name, item.qty, `Cancel ${id}`);
      }
    }

    await sSet(K.ORDERS, next.map(encryptOrder), true);
    setOrders(next);
    await addAudit('ORDER_UPDATE', `${id} → ${patch.status || 'edit'}`);
  };

  const deleteOrder = (id) => {
    showConfirm(`Padam order ${id}? Tindakan ini tidak boleh undo.`, async () => {
      const latestEnc = await sGet(K.ORDERS, [], true);
      const next = latestEnc.map(decryptOrder).filter(o => o.id !== id);
      await sSet(K.ORDERS, next.map(encryptOrder), true);
      setOrders(next);
      await addAudit('ORDER_DELETE', id);
      showToast('Order dipadam', 'info');
    });
  };

  const saveProduct = async (prod) => {
    // Sanitize inputs
    const clean = {
      ...prod,
      name: sanitizeText(prod.name, 100),
      desc: sanitizeText(prod.desc, 300),
    };
    const exists = products.find(p => p.id === clean.id);
    const next = exists
      ? products.map(p => p.id === clean.id ? clean : p)
      : [...products, clean];
    await saveProducts(next);

    if (!exists && clean.stock > 0) {
      await addLedger('initial', clean.id, clean.name, clean.stock, 'Produk baru');
    }

    await addAudit(exists ? 'PRODUCT_EDIT' : 'PRODUCT_NEW', `${clean.name} (RM${clean.price})`);
    showToast(exists ? 'Produk dikemaskini' : 'Produk baru ditambah', 'success');
  };

  const deleteProduct = (id) => {
    const p = products.find(x => x.id === id);
    showConfirm(`Padam produk "${p?.name}"?`, async () => {
      await saveProducts(products.filter(x => x.id !== id));
      await addAudit('PRODUCT_DELETE', p?.name || id);
      showToast('Produk dipadam', 'info');
    });
  };

  const restockProduct = async (id, addQty, note = '') => {
    const q = Math.max(0, parseFloat(addQty) || 0);
    if (q <= 0) return;
    const p = products.find(x => x.id === id);
    if (!p) return;
    const next = products.map(x => x.id === id ? { ...x, stock: x.stock + q } : x);
    await saveProducts(next);
    await addLedger('restock', id, p.name, q, note || 'Manual restock');
    await addAudit('PRODUCT_RESTOCK', `${p.name} +${fmtQty(q, p.unit)}`);
    showToast(`+${fmtQty(q, p.unit)} ${p.name} direstock`, 'success');
  };

  const adjustStock = async (id, newStock, note = '') => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const delta = newStock - p.stock;
    const next = products.map(x => x.id === id ? { ...x, stock: newStock } : x);
    await saveProducts(next);
    await addLedger('adjust', id, p.name, delta, note || 'Manual adjust');
    await addAudit('PRODUCT_ADJUST', `${p.name}: ${p.stock} → ${newStock}`);
    showToast(`Stok ${p.name} diadjust`, 'success');
  };

  const changePin = async (newPin) => {
    if (!newPin || newPin.length < 4) {
      showAlert('PIN mesti sekurang-kurangnya 4 digit');
      return;
    }
    await saveAdmin({ ...admin, pinHash: hashPin(newPin) });
    await addAudit('PIN_CHANGE', 'Admin PIN changed');
    showToast('PIN ditukar', 'success');
  };

  /* --- Backup / Restore --- */
  const exportBackup = async () => {
    const dump = {
      version: 'v4',
      exportedAt: new Date().toISOString(),
      products: await sGet(K.PRODUCTS, [], true),
      orders:   await sGet(K.ORDERS, [], true),
      shop:     await sGet(K.SHOP, DEFAULT_SHOP, true),
      prefs:    await sGet(K.PREFS, DEFAULT_PREFS, false),
      audit:    await sGet(K.AUDIT, [], false),
      ledger:   await sGet(K.LEDGER, [], true),
      zones:    await sGet(K.ZONES, DEFAULT_ZONES, true),
      seq:      await sGet(K.SEQ, { counter: 0 }, true),
    };
    downloadJSON(`tilapia-backup-${Date.now()}.json`, dump);
    await addAudit('BACKUP_EXPORT', 'Full JSON backup');
    showToast('Backup dimuat turun', 'success');
  };

  const importBackup = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('invalid');
      showConfirm(
        `Replace semua data sekarang dengan backup bertarikh ${data.exportedAt ? fmtDateTime(data.exportedAt) : 'tidak diketahui'}? Data sedia ada akan hilang.`,
        async () => {
          if (Array.isArray(data.products)) await sSet(K.PRODUCTS, data.products, true);
          if (Array.isArray(data.orders))   await sSet(K.ORDERS, data.orders, true);
          if (data.shop)   await sSet(K.SHOP, data.shop, true);
          if (data.prefs)  await sSet(K.PREFS, data.prefs, false);
          if (Array.isArray(data.audit))  await sSet(K.AUDIT, data.audit, false);
          if (Array.isArray(data.ledger)) await sSet(K.LEDGER, data.ledger, true);
          if (Array.isArray(data.zones))  await sSet(K.ZONES, data.zones, true);
          if (data.seq)   await sSet(K.SEQ, data.seq, true);
          await addAudit('BACKUP_IMPORT', 'Restored from backup');
          showToast('Restore berjaya. Reload...', 'success');
          setTimeout(() => window.location.reload(), 1200);
        }
      );
    } catch (e) {
      showAlert('Fail backup tak valid: ' + e.message);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-2 animate-pulse">🐟</div>
          <div className="text-sm text-slate-400">Memuatkan kedai...</div>
        </div>
      </div>
    );
  }

  // TRACKING MODE — public view, no PIN required
  if (mode === 'tracking' || trackingOrderId) {
    const order = orders.find(o => o.id === trackingOrderId);
    return (
      <ErrorBoundary>
        <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-white" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          <TrackOrderView
            order={order}
            trackingId={trackingOrderId}
            shop={shop}
            onBackToShop={() => {
              try {
                window.history.replaceState({}, '', window.location.pathname);
              } catch {}
              setMode('buyer');
            }}
          />
          <Modal modal={modal} onClose={() => setModal(null)} />
          <Toast toast={toast} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-white" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-teal-900/50 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl">🐟</span>
          <div className="min-w-0">
            <div className="font-bold text-teal-300 leading-tight truncate">{shop.name}</div>
            <div className="text-[10px] text-slate-400">
              {mode === 'buyer' ? 'Kedai Online' : 'Admin Panel'}
              {mode === 'admin' && adminUnlocked && <span className="ml-1 text-teal-400">● LIVE</span>}
              <span className="ml-1 text-slate-600">v4</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {mode === 'admin' && adminUnlocked && (
            <button onClick={logoutAdmin} aria-label="Logout" className="bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" title="Logout admin">
              <LogOut size={13} />
            </button>
          )}
          <button
            onClick={() => {
              if (mode === 'admin') { setMode('buyer'); stopTitleFlash(); }
              else setMode('admin');
            }}
            aria-label={mode === 'buyer' ? 'Admin login' : 'Back to shop'}
            className="relative bg-teal-600 hover:bg-teal-500 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
          >
            {mode === 'buyer' ? <><Lock size={14} /> Admin</> : <><Store size={14} /> Kedai</>}
            {mode === 'buyer' && newOrdersCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-bold animate-pulse" aria-label={`${newOrdersCount} order baru`}>
                {newOrdersCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="pb-24">
        {mode === 'buyer' && (
          <BuyerView
            products={products}
            shop={shop}
            zones={zones}
            availableStock={availableStock}
            onPlaceOrder={placeOrder}
            showAlert={showAlert}
            showToast={showToast}
          />
        )}
        {mode === 'admin' && !adminUnlocked && <PinGate admin={admin} onUnlock={tryUnlock} />}
        {mode === 'admin' && adminUnlocked && (
          <AdminView
            products={products}
            orders={orders}
            shop={shop}
            zones={zones}
            prefs={prefs}
            auditLog={auditLog}
            ledger={ledger}
            availableStock={availableStock}
            reservedByProduct={reservedByProduct}
            onAckNewOrders={ackNewOrders}
            onUpdateOrder={updateOrder}
            onDeleteOrder={deleteOrder}
            onPlaceOrder={placeOrder}
            onSaveProduct={saveProduct}
            onDeleteProduct={deleteProduct}
            onRestockProduct={restockProduct}
            onAdjustStock={adjustStock}
            onSaveShop={saveShop}
            onSavePrefs={savePrefs}
            onSaveZones={saveZones}
            onChangePin={changePin}
            onExportBackup={exportBackup}
            onImportBackup={importBackup}
            showAlert={showAlert}
            showConfirm={showConfirm}
            showToast={showToast}
          />
        )}
      </main>

      <Modal modal={modal} onClose={() => setModal(null)} />
      <Toast toast={toast} />
    </div>
  );
}


/* ============================================================
   MODAL + TOAST + PIN GATE
   ============================================================ */

function Modal({ modal, onClose }) {
  if (!modal) return null;
  const { type, title, message, onConfirm, confirmLabel = 'OK', cancelLabel = 'Batal' } = modal;
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={type === 'alert' ? onClose : undefined} role="dialog" aria-modal="true">
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-teal-500/30 shadow-2xl" onClick={e => e.stopPropagation()}>
        {title && <h3 className="font-bold text-teal-300 mb-2">{title}</h3>}
        <p className="text-slate-200 text-sm mb-4 whitespace-pre-wrap">{message}</p>
        <div className="flex gap-2">
          {type === 'confirm' && (
            <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">
              {cancelLabel}
            </button>
          )}
          <button
            onClick={() => { onConfirm?.(); onClose(); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold ${type === 'confirm' ? 'bg-red-600 hover:bg-red-500' : 'bg-teal-600 hover:bg-teal-500'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const colors = {
    success: 'bg-green-600 border-green-400',
    error: 'bg-red-600 border-red-400',
    info: 'bg-teal-600 border-teal-400',
  };
  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 pointer-events-none" role="status" aria-live="polite">
      <div className={`${colors[toast.type] || colors.info} border px-4 py-2.5 rounded-xl shadow-2xl text-white text-sm font-semibold`}>
        {toast.message}
      </div>
    </div>
  );
}

function PinGate({ admin, onUnlock }) {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const locked = admin?.lockedUntil && admin.lockedUntil > Date.now();
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!locked) return;
    const iv = setInterval(() => {
      const left = Math.max(0, admin.lockedUntil - Date.now());
      setRemaining(left);
      if (left === 0) clearInterval(iv);
    }, 1000);
    return () => clearInterval(iv);
  }, [locked, admin?.lockedUntil]);

  const submit = async () => {
    if (submitting || locked) return;
    setSubmitting(true);
    await onUnlock(pin);
    setPin('');
    setSubmitting(false);
  };

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);

  return (
    <div className="p-6 max-w-sm mx-auto mt-12">
      <div className="bg-slate-800 rounded-2xl p-6 border border-teal-900/50 text-center">
        <Lock className="mx-auto text-teal-400 mb-3" size={40} />
        <h2 className="font-bold text-lg mb-1">Admin Login</h2>
        <p className="text-slate-400 text-xs mb-4">Masukkan PIN untuk akses panel admin</p>

        {locked ? (
          <div className="bg-red-900/30 border border-red-500/40 rounded-lg p-4 mb-3">
            <AlertTriangle className="mx-auto text-red-300 mb-2" size={28} />
            <p className="text-red-300 font-bold text-sm">🔒 Dikunci</p>
            <p className="text-red-200 text-xs mt-1">Tunggu {mins}:{String(secs).padStart(2, '0')}</p>
          </div>
        ) : (
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={e => setPin(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="••••"
            maxLength={10}
            aria-label="Admin PIN"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-center text-xl tracking-widest mb-3 focus:border-teal-500 outline-none"
          />
        )}
        <button
          onClick={submit}
          disabled={submitting || !pin || locked}
          className="w-full bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 py-3 rounded-lg font-semibold"
        >
          {submitting ? 'Memproses...' : locked ? 'Dikunci' : 'Buka'}
        </button>
        <p className="text-[10px] text-slate-500 mt-3">Default PIN: 1234 — tukar di Settings selepas login</p>
        {admin.failedAttempts > 0 && !locked && (
          <p className="text-[10px] text-amber-300 mt-1">{admin.failedAttempts}/{MAX_PIN_ATTEMPTS} percubaan salah</p>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   TRACK ORDER VIEW — public, no PIN (backlog #2)
   ============================================================ */

function TrackOrderView({ order, trackingId, shop, onBackToShop }) {
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    const ok = await copyToClipboard(buildTrackUrl(trackingId));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  if (!order) {
    return (
      <div className="p-6 max-w-md mx-auto mt-8">
        <div className="bg-slate-800 rounded-2xl p-6 text-center border border-slate-700">
          <div className="text-5xl mb-3">🔍</div>
          <h2 className="text-xl font-bold mb-2">Order Tidak Dijumpai</h2>
          <p className="text-sm text-slate-400 mb-2">No. order: <span className="font-mono text-amber-300">{trackingId || '(tiada)'}</span></p>
          <p className="text-xs text-slate-500 mb-4">
            Order mungkin dah dipadam atau ID salah. Hubungi kedai untuk bantuan.
          </p>
          <a
            href={`tel:${shop.phone}`}
            className="block w-full bg-blue-600 hover:bg-blue-500 py-2.5 rounded-lg text-sm font-semibold mb-2"
          >
            📞 Hubungi {shop.name}
          </a>
          <button
            onClick={onBackToShop}
            className="w-full bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold"
          >
            ← Kembali ke Kedai
          </button>
        </div>
      </div>
    );
  }

  const statusDisplay = {
    new: { label: 'Order Diterima', color: 'amber', icon: '🔔', desc: 'Kedai akan sahkan pesanan anda tak lama lagi.' },
    processing: { label: 'Sedang Diproses', color: 'blue', icon: '⚙️', desc: 'Ikan sedang disediakan / dipacking.' },
    done: { label: 'Siap!', color: 'green', icon: '✅', desc: order.customer.delivery === 'pickup' ? 'Sila datang ambil.' : 'Sedang / dah dihantar.' },
    cancelled: { label: 'Dibatalkan', color: 'red', icon: '❌', desc: 'Order ini telah dibatalkan.' },
  }[order.status] || { label: order.status, color: 'slate', icon: '❓', desc: '' };

  const statusBg = {
    amber: 'from-amber-900 to-slate-800 border-amber-500/50',
    blue: 'from-blue-900 to-slate-800 border-blue-500/50',
    green: 'from-green-900 to-slate-800 border-green-500/50',
    red: 'from-red-900 to-slate-800 border-red-500/50',
    slate: 'from-slate-800 to-slate-900 border-slate-600',
  }[statusDisplay.color];

  return (
    <div className="p-4 max-w-md mx-auto">
      <div className="text-center mb-4">
        <div className="text-3xl mb-1">🐟</div>
        <div className="text-xs text-slate-400">{shop.name}</div>
      </div>

      <div className={`bg-gradient-to-br ${statusBg} rounded-2xl p-5 text-center border mb-3`}>
        <div className="text-5xl mb-2">{statusDisplay.icon}</div>
        <div className="text-[10px] uppercase opacity-80 font-semibold">Status Order</div>
        <h2 className="text-2xl font-bold mt-1 mb-2">{statusDisplay.label}</h2>
        <p className="text-xs opacity-90 mb-3">{statusDisplay.desc}</p>
        <div className="bg-black/20 rounded-lg p-3 text-left text-xs space-y-1">
          <div className="flex justify-between">
            <span className="opacity-70">No. Order:</span>
            <span className="font-mono font-bold">{order.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">Tarikh:</span>
            <span>{fmtDateTime(order.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">Nama:</span>
            <span>{order.customer.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">Kaedah:</span>
            <span>{order.customer.delivery === 'pickup' ? '🏪 Self Pickup' : '🛵 Delivery'}</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700 mb-3">
        <h3 className="font-bold text-teal-300 text-sm mb-2">📦 Item</h3>
        {order.items.map((i, idx) => (
          <div key={idx} className="flex justify-between py-1.5 border-b border-slate-700/50 last:border-0 text-sm">
            <span>• {i.name} × {fmtQty(i.qty, i.unit || '')}</span>
            <span className="font-mono text-slate-300">{fmtRM(i.subtotal)}</span>
          </div>
        ))}
        <div className="pt-2 mt-2 border-t border-slate-600 text-sm space-y-1">
          <div className="flex justify-between text-slate-300">
            <span>Subtotal</span><span>{fmtRM(order.subtotal)}</span>
          </div>
          {order.deliveryFee > 0 && (
            <div className="flex justify-between text-slate-300">
              <span>Delivery</span><span>{fmtRM(order.deliveryFee)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-teal-300 text-base pt-1 border-t border-slate-700">
            <span>Total</span><span>{fmtRM(order.total)}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <a
          href={`tel:${shop.phone}`}
          className="w-full block bg-blue-600 hover:bg-blue-500 py-3 rounded-xl text-sm font-semibold text-center text-white"
        >
          📞 Hubungi {shop.name}
        </a>
        {(() => {
          const waUrl = waUrlToShop(shop.phone, `Salam, saya nak tanya status order *${order.id}* saya.`);
          if (!waUrl) return null;
          return (
            <a
              href={waUrl}
              target="_blank"
              rel="noreferrer"
              className="w-full block bg-green-600 hover:bg-green-500 py-3 rounded-xl text-sm font-semibold text-center text-white"
            >
              💬 WhatsApp Kedai
            </a>
          );
        })()}
        <button
          onClick={copyUrl}
          className="w-full bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
        >
          {copied ? <><Check size={12} /> URL Disalin!</> : <><Copy size={12} /> Copy URL Tracking</>}
        </button>
        <button
          onClick={onBackToShop}
          className="w-full bg-slate-800 hover:bg-slate-700 py-2.5 rounded-lg text-xs font-semibold"
        >
          ← Kembali ke Kedai
        </button>
      </div>

      <p className="text-[10px] text-slate-500 text-center mt-4">
        Page ini auto-update setiap kali dibuka. Bookmark untuk akses pantas.
      </p>
    </div>
  );
}


/* ============================================================
   BUYER VIEW (shop + cart + checkout + success with receipt/track)
   ============================================================ */

function BuyerView({ products, shop, zones, availableStock, onPlaceOrder, showAlert, showToast }) {
  const [cart, setCart] = useState({});
  const [showCheckout, setShowCheckout] = useState(false);
  const [orderPlaced, setOrderPlaced] = useState(null);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');

  useEffect(() => {
    (async () => {
      const c = await sGet(K.CART, {}, false);
      setCart(c);
      setCartLoaded(true);
    })();
  }, []);
  useEffect(() => {
    if (cartLoaded) sSet(K.CART, cart, false);
  }, [cart, cartLoaded]);

  const activeProducts = products.filter(p => p.active);
  const filtered = activeProducts.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const addQty = (id, delta) => {
    const avail = availableStock(id);
    const cur = cart[id] || 0;
    const next = Math.max(0, Math.min(avail, +(cur + delta).toFixed(2)));
    const n = { ...cart };
    if (next <= 0) delete n[id]; else n[id] = next;
    setCart(n);
  };
  const setQty = (id, qty) => {
    const avail = availableStock(id);
    const q = Math.max(0, Math.min(avail, +qty || 0));
    const n = { ...cart };
    if (q <= 0) delete n[id]; else n[id] = q;
    setCart(n);
  };

  const cartItems = Object.entries(cart).map(([id, qty]) => {
    const p = products.find(x => x.id === id);
    return p ? { ...p, qty, subtotal: p.price * qty } : null;
  }).filter(Boolean);
  const subtotal = cartItems.reduce((s, i) => s + i.subtotal, 0);
  const totalQty = cartItems.reduce((s, i) => s + i.qty, 0);

  if (orderPlaced) {
    return <OrderSuccessScreen order={orderPlaced} shop={shop} onBackToShop={() => { setOrderPlaced(null); setCart({}); sSet(K.CART, {}, false); }} />;
  }

  if (showCheckout) {
    return (
      <Checkout
        cartItems={cartItems}
        subtotal={subtotal}
        shop={shop}
        zones={zones}
        onBack={() => setShowCheckout(false)}
        showAlert={showAlert}
        onSubmit={async (customer, deliveryFee) => {
          const total = subtotal + deliveryFee;
          if (total < shop.minOrder) {
            showAlert(`Jumlah minimum order: ${fmtRM(shop.minOrder)}`);
            return false;
          }
          const orderDraft = {
            createdAt: new Date().toISOString(),
            items: cartItems.map(i => ({
              id: i.id, name: i.name, price: i.price,
              qty: i.qty, unit: i.unit, subtotal: i.subtotal,
            })),
            subtotal,
            deliveryFee,
            total,
            customer,
            status: 'new',
          };
          const saved = await onPlaceOrder(orderDraft);
          if (saved) {
            setOrderPlaced(saved);
            setShowCheckout(false);
            showToast('Order direkod!', 'success');
          }
          return !!saved;
        }}
      />
    );
  }

  return (
    <>
      <div className="p-4">
        <div className="bg-gradient-to-r from-teal-900/50 to-slate-800/50 rounded-2xl p-4 mb-4 border border-teal-900/30">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <h2 className="font-bold text-teal-300 mb-1">Selamat Datang! 👋</h2>
              <p className="text-xs text-slate-300">{shop.welcomeMsg}</p>
            </div>
            {shop.halalCert && (
              <div className="bg-green-900/50 border border-green-500/40 rounded-lg px-2 py-1 text-[10px] text-green-300 font-bold flex items-center gap-1 flex-shrink-0">
                <ShieldCheck size={10} /> HALAL
              </div>
            )}
          </div>
          <div className="text-[10px] text-slate-400 mt-2 flex gap-3 flex-wrap">
            <span>📍 {shop.location}</span>
            <span>💰 Min: {fmtRM(shop.minOrder)}</span>
            <span>🛵 Delivery bermula: {fmtRM(Math.min(...zones.map(z => z.fee)))}</span>
          </div>
        </div>

        <div className="mb-3">
          <div className="relative mb-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Cari produk..."
              aria-label="Cari produk"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-teal-500"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {CATEGORIES.map(c => (
              <button
                key={c.k}
                onClick={() => setCat(c.k)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${cat === c.k ? 'bg-teal-600' : 'bg-slate-800 text-slate-400'}`}
              >
                {c.l}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-12 col-span-full">
              <div className="text-4xl mb-2 opacity-50">🔍</div>
              <p>Tiada produk {search ? `untuk "${search}"` : 'tersedia'}.</p>
            </div>
          )}
          {filtered.map(p => {
            const avail = availableStock(p.id);
            const inCart = cart[p.id] || 0;
            return (
              <div key={p.id} className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                <div className="flex items-start gap-3 mb-2">
                  {p.image
                    ? <img src={p.image} alt={p.name} className="w-14 h-14 rounded-lg object-cover bg-slate-900" onError={e => { e.target.style.display = 'none'; }} />
                    : <div className="text-4xl" aria-hidden>{p.emoji}</div>
                  }
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-sm leading-tight">{p.name}</h3>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">{p.desc}</p>
                  </div>
                </div>
                <div className="flex items-baseline justify-between mb-2">
                  <div>
                    <span className="text-teal-300 font-bold text-lg">RM{p.price}</span>
                    <span className="text-xs text-slate-400">/{p.unit}</span>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${avail > 10 ? 'bg-green-900/50 text-green-300' : avail > 0 ? 'bg-amber-900/50 text-amber-300' : 'bg-red-900/50 text-red-300'}`}>
                    Stok: {fmtQty(avail, p.unit)}
                  </span>
                </div>
                {inCart > 0 ? (
                  <div className="flex items-center gap-1 bg-slate-900 rounded-lg p-1">
                    <button onClick={() => addQty(p.id, -0.5)} aria-label="Kurang 0.5" className="bg-slate-700 hover:bg-slate-600 w-8 h-8 rounded flex items-center justify-center text-xs">-½</button>
                    <button onClick={() => addQty(p.id, -1)} aria-label="Kurang 1" className="bg-slate-700 hover:bg-slate-600 w-8 h-8 rounded flex items-center justify-center"><Minus size={14} /></button>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={inCart}
                      onChange={e => setQty(p.id, parseFloat(e.target.value))}
                      aria-label={`Kuantiti ${p.name}`}
                      className="flex-1 text-center bg-transparent font-bold text-sm w-full min-w-0 outline-none"
                    />
                    <button onClick={() => addQty(p.id, 1)} disabled={inCart >= avail} aria-label="Tambah 1" className="bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 w-8 h-8 rounded flex items-center justify-center"><Plus size={14} /></button>
                    <button onClick={() => addQty(p.id, 0.5)} disabled={inCart >= avail} aria-label="Tambah 0.5" className="bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 w-8 h-8 rounded flex items-center justify-center text-xs">+½</button>
                  </div>
                ) : (
                  <button
                    onClick={() => addQty(p.id, 1)}
                    disabled={avail === 0}
                    className="w-full bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-500 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1"
                  >
                    <ShoppingCart size={14} /> {avail === 0 ? 'Habis Stok' : 'Tambah'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {totalQty > 0 && (
        <div className="fixed bottom-4 left-4 right-4 max-w-md mx-auto z-30">
          <button
            onClick={() => setShowCheckout(true)}
            className="w-full bg-gradient-to-r from-teal-600 to-teal-500 hover:from-teal-500 hover:to-teal-400 py-4 rounded-xl shadow-2xl shadow-teal-900/50 flex items-center justify-between px-5"
          >
            <div className="flex items-center gap-2">
              <div className="relative">
                <ShoppingCart size={22} />
                <span className="absolute -top-2 -right-2 bg-amber-400 text-slate-900 text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-bold">
                  {cartItems.length}
                </span>
              </div>
              <span className="font-semibold">Lihat Cart ({fmtQty(totalQty)} item)</span>
            </div>
            <span className="font-bold text-lg">{fmtRM(subtotal)}</span>
          </button>
        </div>
      )}
    </>
  );
}

/* ============================================================
   CHECKOUT (with delivery zones + PDPA consent)
   ============================================================ */

function Checkout({ cartItems, subtotal, shop, zones, onBack, onSubmit, showAlert }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [delivery, setDelivery] = useState('pickup');
  const [zoneId, setZoneId] = useState(zones[0]?.id || '');
  const [pdpaAgreed, setPdpaAgreed] = useState(false);
  const [showPdpa, setShowPdpa] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedZone = zones.find(z => z.id === zoneId);
  const deliveryFee = delivery === 'delivery' ? (selectedZone?.fee || 0) : 0;
  const total = subtotal + deliveryFee;

  const submit = async () => {
    if (submitting) return;
    if (!name.trim()) { showAlert('Sila isi nama penuh'); return; }
    const ph = normalizePhone(phone);
    if (!ph.valid) { showAlert('No. telefon tidak sah. Format: 01X-XXXXXXX'); return; }
    if (delivery === 'delivery' && !address.trim()) {
      showAlert('Sila isi alamat untuk delivery'); return;
    }
    if (!pdpaAgreed) {
      showAlert('Sila baca dan persetujui notis PDPA sebelum teruskan'); return;
    }
    setSubmitting(true);
    const ok = await onSubmit({
      name: sanitizeText(name.trim(), 100),
      phone: ph.normalized,
      address: sanitizeText(address.trim(), 300),
      notes: sanitizeText(notes.trim(), 300),
      delivery,
      zone: delivery === 'delivery' ? selectedZone?.name || '' : '',
      pdpa: true,
    }, deliveryFee);
    if (!ok) setSubmitting(false);
  };

  return (
    <div className="p-4 max-w-md mx-auto">
      <button onClick={onBack} aria-label="Kembali" className="text-teal-300 text-sm mb-3 flex items-center gap-1">← Kembali ke kedai</button>
      <h2 className="text-xl font-bold mb-3">Checkout</h2>

      <div className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
        <h3 className="font-semibold text-teal-300 text-sm mb-2">Ringkasan Order</h3>
        {cartItems.map(i => (
          <div key={i.id} className="flex justify-between text-sm py-1 border-b border-slate-700/50 last:border-0">
            <span>{i.emoji} {i.name} × {fmtQty(i.qty, i.unit)}</span>
            <span className="font-mono">{fmtRM(i.subtotal)}</span>
          </div>
        ))}
        <div className="pt-2 mt-2 border-t border-slate-600 text-sm space-y-1">
          <div className="flex justify-between text-slate-300"><span>Subtotal</span><span>{fmtRM(subtotal)}</span></div>
          {delivery === 'delivery' && (
            <div className="flex justify-between text-slate-300"><span>Delivery ({selectedZone?.name || '—'})</span><span>{fmtRM(deliveryFee)}</span></div>
          )}
          <div className="flex justify-between font-bold text-teal-300 text-base pt-1">
            <span>Total</span><span>{fmtRM(total)}</span>
          </div>
        </div>
        {total < shop.minOrder && (
          <div className="mt-2 bg-amber-900/30 border border-amber-700/50 text-amber-300 rounded-lg p-2 text-[11px]">
            ⚠️ Min order: {fmtRM(shop.minOrder)}. Kurang {fmtRM(shop.minOrder - total)}.
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Field icon={<User size={14} />} label="Nama Penuh *">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Cth: Ahmad bin Ali" maxLength={100} className="tilapia-input" />
        </Field>
        <Field icon={<Phone size={14} />} label="No. Telefon *">
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="01X-XXXXXXX" type="tel" inputMode="tel" maxLength={20} className="tilapia-input" />
        </Field>

        <div>
          <label className="text-xs text-slate-400 mb-1 block">Kaedah Pengambilan</label>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setDelivery('pickup')} className={`py-2 rounded-lg text-sm font-semibold border ${delivery === 'pickup' ? 'bg-teal-600 border-teal-400' : 'bg-slate-800 border-slate-700'}`}>🏪 Self Pickup</button>
            <button onClick={() => setDelivery('delivery')} className={`py-2 rounded-lg text-sm font-semibold border ${delivery === 'delivery' ? 'bg-teal-600 border-teal-400' : 'bg-slate-800 border-slate-700'}`}>🛵 Delivery</button>
          </div>
        </div>

        {delivery === 'delivery' && (
          <>
            <div>
              <label className="text-xs text-slate-400 mb-1 block flex items-center gap-1"><Truck size={12} /> Zon Penghantaran</label>
              <select value={zoneId} onChange={e => setZoneId(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm">
                {zones.map(z => (
                  <option key={z.id} value={z.id}>{z.name} — {fmtRM(z.fee)}</option>
                ))}
              </select>
              <p className="text-[10px] text-slate-500 mt-1">Kadar ditentukan oleh zon. Pengesahan dengan kedai bila dapat order.</p>
            </div>
            <Field icon={<MapPin size={14} />} label="Alamat Penghantaran *">
              <textarea value={address} onChange={e => setAddress(e.target.value)} placeholder="Alamat penuh termasuk poskod..." rows={3} maxLength={300} className="tilapia-input" />
            </Field>
          </>
        )}

        <Field icon={<MessageSquare size={14} />} label="Nota (Optional)">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Cth: nak yang besar, masa pickup..." rows={2} maxLength={300} className="tilapia-input" />
        </Field>

        {/* PDPA Consent */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-3">
          <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={pdpaAgreed}
              onChange={e => setPdpaAgreed(e.target.checked)}
              className="mt-0.5 flex-shrink-0"
              aria-label="Persetujuan PDPA"
            />
            <span className="leading-snug">
              Saya bersetuju dengan{' '}
              <button
                type="button"
                onClick={() => setShowPdpa(!showPdpa)}
                className="text-teal-300 underline"
              >
                notis PDPA
              </button>
              {' '}untuk proses pesanan ini. *
            </span>
          </label>
          {showPdpa && (
            <div className="mt-2 text-[10px] text-slate-400 bg-slate-900/50 rounded p-2 leading-relaxed border border-slate-700/50">
              {shop.pdpaText}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={submit}
        disabled={submitting || total < shop.minOrder || !pdpaAgreed}
        className="w-full bg-gradient-to-r from-teal-600 to-teal-500 disabled:from-slate-700 disabled:to-slate-700 py-4 rounded-xl font-bold mt-4 shadow-lg shadow-teal-900/50 flex items-center justify-center gap-2"
      >
        {submitting ? <><RefreshCw size={16} className="animate-spin" /> Memproses...</> : `Hantar Order — ${fmtRM(total)}`}
      </button>
      <p className="text-[11px] text-slate-400 text-center mt-2">
        Selepas hantar, anda akan dibawa ke skrin WhatsApp untuk hantar pesanan ke kedai.
      </p>

      <style>{`.tilapia-input { width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: white; outline: none; } .tilapia-input:focus { border-color: #14b8a6; }`}</style>
    </div>
  );
}

function Field({ icon, label, children }) {
  return (
    <div>
      <label className="text-xs text-slate-400 mb-1 flex items-center gap-1">{icon}{label}</label>
      {children}
    </div>
  );
}

/* ============================================================
   ORDER SUCCESS SCREEN (with WA send, track URL, receipt)
   ============================================================ */

function OrderSuccessScreen({ order, shop, onBackToShop }) {
  const [copied, setCopied] = useState(false);
  const [trackCopied, setTrackCopied] = useState(false);
  const waText = buildOrderWAMessage(order, shop);
  const waUrl = waUrlToShop(shop.phone, waText);
  const trackUrl = buildTrackUrl(order.id);
  const receiptText = buildReceiptText(order, shop);

  const doCopyReceipt = async () => {
    const ok = await copyToClipboard(receiptText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const doCopyTrack = async () => {
    const ok = await copyToClipboard(trackUrl);
    if (ok) {
      setTrackCopied(true);
      setTimeout(() => setTrackCopied(false), 1500);
    }
  };

  const doDownloadReceipt = () => {
    downloadText(`resit-${order.id}.txt`, receiptText);
  };

  return (
    <div className="p-6 max-w-md mx-auto mt-6">
      <div className="bg-gradient-to-br from-teal-900 to-slate-800 rounded-2xl p-6 text-center border border-teal-500/50">
        <div className="text-6xl mb-3">✅</div>
        <h2 className="text-2xl font-bold mb-2">Order Berjaya!</h2>
        <p className="text-slate-300 text-sm mb-4">No. Order: <span className="font-mono text-teal-300">{order.id}</span></p>
        <div className="bg-slate-900/50 rounded-lg p-4 text-left text-sm space-y-1 mb-4">
          <div className="flex justify-between"><span className="text-slate-400">Nama:</span><span>{order.customer.name}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">No. Tel:</span><span>{order.customer.phone}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Kaedah:</span><span>{order.customer.delivery === 'pickup' ? 'Self Pickup' : 'Delivery'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Subtotal:</span><span>{fmtRM(order.subtotal)}</span></div>
          {order.deliveryFee > 0 && (
            <div className="flex justify-between"><span className="text-slate-400">Delivery:</span><span>{fmtRM(order.deliveryFee)}</span></div>
          )}
          <div className="flex justify-between font-bold text-teal-300 pt-2 border-t border-slate-700 mt-2">
            <span>Total:</span><span>{fmtRM(order.total)}</span>
          </div>
        </div>

        {waUrl ? (
          <>
            <p className="text-xs text-amber-300 mb-3 bg-amber-900/20 border border-amber-700/40 rounded-lg p-2">
              ⚠️ <b>Penting:</b> Klik butang bawah untuk hantar pesanan ke WhatsApp kedai. Pesanan <u>belum</u> sampai ke penjual sampai anda hantar mesej WhatsApp.
            </p>
            <a
              href={waUrl}
              target="_blank"
              rel="noreferrer"
              className="w-full block bg-green-600 hover:bg-green-500 py-4 rounded-xl font-bold text-white mb-2 shadow-lg shadow-green-900/50"
            >
              💬 Hantar ke WhatsApp Kedai
            </a>
          </>
        ) : (
          <p className="text-xs text-amber-300 mb-3 bg-amber-900/20 border border-amber-700/40 rounded-lg p-2">
            ⚠️ No. telefon kedai tidak sah. Hubungi penjual terus: {shop.phone}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 mb-2">
          <button
            onClick={doCopyTrack}
            className="bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
          >
            {trackCopied ? <><Check size={12} /> Tersalin</> : <><Copy size={12} /> Track URL</>}
          </button>
          <button
            onClick={doDownloadReceipt}
            className="bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
          >
            <FileDown size={12} /> Resit .txt
          </button>
        </div>
        <button
          onClick={doCopyReceipt}
          className="w-full bg-slate-800 hover:bg-slate-700 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 mb-2"
        >
          {copied ? <><Check size={12} /> Resit disalin!</> : <><Copy size={12} /> Copy Resit (share WA)</>}
        </button>

        <p className="text-[10px] text-slate-500 mb-2">
          💡 Simpan URL tracking di atas untuk semak status order bila-bila masa.
        </p>

        <button
          onClick={onBackToShop}
          className="w-full bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg font-semibold text-sm"
        >
          Kembali ke Kedai
        </button>
      </div>
    </div>
  );
}


/* ============================================================
   ADMIN VIEW — with Dashboard + Ledger tabs
   ============================================================ */

function AdminView(props) {
  const { orders, onAckNewOrders } = props;
  const [tab, setTab] = useState('dashboard');
  const newCount = orders.filter(o => o.status === 'new').length;

  useEffect(() => {
    if (tab === 'orders' || tab === 'dashboard') onAckNewOrders();
  }, [tab, onAckNewOrders]);

  return (
    <div className="pb-20">
      <div className="flex border-b border-slate-800 sticky top-[57px] bg-slate-900/95 backdrop-blur z-10 overflow-x-auto">
        <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')} icon={<Home size={16} />} label="Home" badge={newCount} />
        <TabBtn active={tab === 'orders'} onClick={() => setTab('orders')} icon={<ClipboardList size={16} />} label="Orders" />
        <TabBtn active={tab === 'products'} onClick={() => setTab('products')} icon={<Package size={16} />} label="Produk" />
        <TabBtn active={tab === 'stats'} onClick={() => setTab('stats')} icon={<TrendingUp size={16} />} label="Stats" />
        <TabBtn active={tab === 'customers'} onClick={() => setTab('customers')} icon={<Users size={16} />} label="Pelanggan" />
        <TabBtn active={tab === 'ledger'} onClick={() => setTab('ledger')} icon={<BarChart3 size={16} />} label="Ledger" />
        <TabBtn active={tab === 'audit'} onClick={() => setTab('audit')} icon={<History size={16} />} label="Log" />
        <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Edit3 size={16} />} label="Set" />
      </div>

      {tab === 'dashboard' && <DashboardTab {...props} onGoTo={setTab} />}
      {tab === 'orders' && <OrdersTab {...props} />}
      {tab === 'products' && <ProductsTab {...props} />}
      {tab === 'stats' && <StatsTab {...props} />}
      {tab === 'customers' && <CustomersTab {...props} onGoToOrders={() => setTab('orders')} />}
      {tab === 'ledger' && <LedgerTab {...props} />}
      {tab === 'audit' && <AuditTab {...props} />}
      {tab === 'settings' && <SettingsTab {...props} />}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label, badge }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex-shrink-0 px-3 py-3 text-xs font-semibold flex items-center justify-center gap-1 relative ${active ? 'text-teal-300 border-b-2 border-teal-400' : 'text-slate-400'}`}
    >
      {icon}{label}
      {badge > 0 && (
        <span className="absolute top-1 right-0 bg-red-500 text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-bold animate-pulse">
          {badge}
        </span>
      )}
    </button>
  );
}

/* ============================================================
   DASHBOARD TAB (home) — today's snapshot
   ============================================================ */

function DashboardTab({ orders, products, shop, reservedByProduct, onGoTo }) {
  const now = new Date();
  const todayOrders = orders.filter(o => {
    const d = new Date(o.createdAt);
    return d.toDateString() === now.toDateString();
  });
  const newOrders = orders.filter(o => o.status === 'new');
  const processingOrders = orders.filter(o => o.status === 'processing');
  const todayRevenue = todayOrders.filter(o => o.status === 'done').reduce((s, o) => s + o.total, 0);
  const todayPending = todayOrders.filter(o => o.status === 'new' || o.status === 'processing').reduce((s, o) => s + o.total, 0);

  const lowStock = products.filter(p => p.active && p.stock <= shop.lowStockThreshold && p.stock > 0);
  const outOfStock = products.filter(p => p.active && p.stock === 0);

  return (
    <div className="p-4 space-y-3">
      <div>
        <h3 className="font-bold text-teal-300 text-sm mb-2 flex items-center gap-1">
          <Calendar size={14} /> Snapshot {now.toLocaleDateString('ms-MY', { weekday: 'long', day: 'numeric', month: 'long' })}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <StatCard label="Revenue Hari Ni" value={fmtRM(todayRevenue)} color="green" />
          <StatCard label="Pending Hari Ni" value={fmtRM(todayPending)} color="amber" />
          <StatCard label="Order Baru" value={newOrders.length} color="red" />
          <StatCard label="Sedang Proses" value={processingOrders.length} color="amber" />
        </div>
      </div>

      {newOrders.length > 0 && (
        <div className="bg-gradient-to-br from-red-900/40 to-slate-800 rounded-xl p-4 border border-red-500/50">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-red-300 text-sm flex items-center gap-1">
              🔔 {newOrders.length} Order Tunggu Pengesahan
            </h4>
            <button onClick={() => onGoTo('orders')} className="text-red-300 text-xs flex items-center gap-0.5">
              Lihat <ArrowRight size={12} />
            </button>
          </div>
          <div className="space-y-1.5">
            {newOrders.slice(0, 3).map(o => (
              <div key={o.id} className="bg-slate-900/50 rounded-lg px-3 py-2 text-xs flex justify-between items-center">
                <span>
                  <span className="font-mono text-teal-300">{o.id}</span> • {o.customer.name}
                </span>
                <span className="font-bold text-teal-300">{fmtRM(o.total)}</span>
              </div>
            ))}
            {newOrders.length > 3 && (
              <p className="text-[11px] text-red-300 text-center">+{newOrders.length - 3} lagi...</p>
            )}
          </div>
        </div>
      )}

      {(lowStock.length > 0 || outOfStock.length > 0) && (
        <div className="bg-slate-800 rounded-xl p-4 border border-amber-700/50">
          <h4 className="font-bold text-amber-300 text-sm mb-2 flex items-center gap-1">
            <AlertTriangle size={14} /> Perhatian Stok
          </h4>
          {outOfStock.map(p => (
            <div key={p.id} className="bg-red-900/30 rounded px-2 py-1.5 text-xs flex justify-between mb-1 border border-red-700/40">
              <span>{p.emoji} {p.name}</span>
              <span className="text-red-300 font-bold">HABIS</span>
            </div>
          ))}
          {lowStock.map(p => (
            <div key={p.id} className="bg-amber-900/20 rounded px-2 py-1.5 text-xs flex justify-between mb-1 border border-amber-700/30">
              <span>{p.emoji} {p.name}</span>
              <span className="text-amber-300 font-semibold">{fmtQty(p.stock, p.unit)}</span>
            </div>
          ))}
          <button onClick={() => onGoTo('products')} className="w-full mt-2 bg-amber-600 hover:bg-amber-500 py-2 rounded-lg text-xs font-semibold">
            Restock Sekarang →
          </button>
        </div>
      )}

      {processingOrders.length > 0 && (
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-amber-300 text-sm flex items-center gap-1">
              ⚙️ {processingOrders.length} Order Sedang Diproses
            </h4>
            <button onClick={() => onGoTo('orders')} className="text-amber-300 text-xs flex items-center gap-0.5">
              Lihat <ArrowRight size={12} />
            </button>
          </div>
          {processingOrders.slice(0, 3).map(o => (
            <div key={o.id} className="bg-slate-900/50 rounded-lg px-3 py-2 text-xs flex justify-between items-center mb-1">
              <span>
                <span className="font-mono text-teal-300">{o.id}</span> • {o.customer.name}
              </span>
              <span className="text-slate-400">{daysAgo(o.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
        <h4 className="font-bold text-teal-300 text-sm mb-2">🎯 Shortcut</h4>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => onGoTo('orders')} className="bg-slate-900 hover:bg-slate-700 p-3 rounded-lg text-xs flex flex-col items-center gap-1 border border-slate-700">
            <UserPlus size={18} className="text-teal-300" />
            <span>Order Manual</span>
          </button>
          <button onClick={() => onGoTo('products')} className="bg-slate-900 hover:bg-slate-700 p-3 rounded-lg text-xs flex flex-col items-center gap-1 border border-slate-700">
            <Plus size={18} className="text-teal-300" />
            <span>Restock</span>
          </button>
          <button onClick={() => onGoTo('stats')} className="bg-slate-900 hover:bg-slate-700 p-3 rounded-lg text-xs flex flex-col items-center gap-1 border border-slate-700">
            <PieChart size={18} className="text-teal-300" />
            <span>Margin Profit</span>
          </button>
          <button onClick={() => onGoTo('customers')} className="bg-slate-900 hover:bg-slate-700 p-3 rounded-lg text-xs flex flex-col items-center gap-1 border border-slate-700">
            <Users size={18} className="text-teal-300" />
            <span>Pelanggan</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ORDERS TAB (with search + manual order + filter)
   ============================================================ */

function OrdersTab({ orders, products, shop, onUpdateOrder, onDeleteOrder, onPlaceOrder, availableStock, showAlert, showToast }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [editing, setEditing] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [showCustEdit, setShowCustEdit] = useState(null);
  const [waTemplate, setWaTemplate] = useState(null);

  const filtered = orders.filter(o => {
    if (filter !== 'all' && o.status !== filter) return false;
    if (search) {
      const s = search.toLowerCase();
      const matches = (
        o.id.toLowerCase().includes(s) ||
        o.customer.name.toLowerCase().includes(s) ||
        o.customer.phone.includes(s)
      );
      if (!matches) return false;
    }
    if (dateFrom) {
      if (new Date(o.createdAt) < new Date(dateFrom)) return false;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      if (new Date(o.createdAt) > end) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const doExport = () => {
    const rows = [
      ['Order ID', 'Date', 'Customer', 'Phone', 'Method', 'Address', 'Items', 'Subtotal', 'Delivery', 'Total', 'Status', 'Notes'],
      ...sorted.map(o => [
        o.id, fmtDateTime(o.createdAt), o.customer.name, o.customer.phone,
        o.customer.delivery, o.customer.address || '',
        o.items.map(i => `${i.name}×${i.qty}`).join('; '),
        o.subtotal || o.total, o.deliveryFee || 0, o.total, o.status, o.customer.notes || '',
      ]),
    ];
    exportCSV(`tilapia-orders-${Date.now()}.csv`, rows);
  };

  const clearFilters = () => {
    setSearch(''); setDateFrom(''); setDateTo(''); setFilter('all');
  };

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setShowManual(true)}
          className="flex-1 bg-teal-600 hover:bg-teal-500 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
        >
          <UserPlus size={14} /> Order Manual (Walk-in)
        </button>
        <button onClick={doExport} className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-800 text-teal-300 flex items-center gap-1">
          <Download size={12} /> CSV
        </button>
      </div>

      <div className="relative mb-2">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Cari ID, nama, phone..."
          aria-label="Cari order"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-teal-500"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
          aria-label="Tarikh dari"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
          aria-label="Tarikh hingga"
        />
      </div>
      <div className="flex gap-2 mb-3 overflow-x-auto">
        {[
          { k: 'all', l: 'Semua', c: filtered.length },
          { k: 'new', l: '🔔 Baru', c: orders.filter(o => o.status === 'new').length },
          { k: 'processing', l: '⚙️ Proses', c: orders.filter(o => o.status === 'processing').length },
          { k: 'done', l: '✅ Siap', c: orders.filter(o => o.status === 'done').length },
          { k: 'cancelled', l: '❌ Batal', c: orders.filter(o => o.status === 'cancelled').length },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${filter === f.k ? 'bg-teal-600' : 'bg-slate-800 text-slate-400'}`}
          >
            {f.l} ({f.c})
          </button>
        ))}
        {(search || dateFrom || dateTo || filter !== 'all') && (
          <button onClick={clearFilters} className="ml-auto flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-800 text-amber-300 flex items-center gap-1">
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {sorted.length === 0 && (
        <div className="text-center text-slate-400 py-12">
          <div className="text-4xl mb-2 opacity-50">📋</div>
          <p className="text-sm">Tiada order dalam carian ini.</p>
        </div>
      )}

      <div className="space-y-3">
        {sorted.map(o => (
          <OrderCard
            key={o.id}
            order={o}
            shop={shop}
            onUpdate={onUpdateOrder}
            onDelete={onDeleteOrder}
            onEdit={() => setEditing(o)}
            onEditCustomer={() => setShowCustEdit(o)}
            onWaTemplate={() => setWaTemplate(o)}
          />
        ))}
      </div>

      {editing && (
        <OrderEditor
          order={editing}
          onClose={() => setEditing(null)}
          onSave={async (updated) => {
            await onUpdateOrder(updated.id, {
              items: updated.items,
              subtotal: updated.subtotal,
              total: updated.total,
            });
            setEditing(null);
          }}
        />
      )}

      {showCustEdit && (
        <CustomerEditModal
          order={showCustEdit}
          onClose={() => setShowCustEdit(null)}
          onSave={async (patch) => {
            await onUpdateOrder(showCustEdit.id, { customer: { ...showCustEdit.customer, ...patch } });
            setShowCustEdit(null);
            showToast('Info pelanggan dikemaskini', 'success');
          }}
        />
      )}

      {waTemplate && (
        <WATemplateModal
          order={waTemplate}
          shop={shop}
          onClose={() => setWaTemplate(null)}
        />
      )}

      {showManual && (
        <ManualOrderModal
          products={products}
          shop={shop}
          availableStock={availableStock}
          onClose={() => setShowManual(false)}
          onSubmit={async (orderDraft) => {
            const saved = await onPlaceOrder(orderDraft);
            if (saved) {
              setShowManual(false);
              showToast(`Order ${saved.id} dicipta`, 'success');
            }
          }}
        />
      )}
    </div>
  );
}


/* ============================================================
   ORDER CARD (with WA templates button, receipt, edit customer)
   ============================================================ */

function OrderCard({ order, shop, onUpdate, onDelete, onEdit, onEditCustomer, onWaTemplate }) {
  const [expanded, setExpanded] = useState(order.status === 'new');
  const statusColors = {
    new: 'bg-red-900/30 border-red-500/50',
    processing: 'bg-amber-900/30 border-amber-500/50',
    done: 'bg-green-900/30 border-green-500/50',
    cancelled: 'bg-slate-800/50 border-slate-600/50',
  };
  const statusLabels = {
    new: '🔔 BARU', processing: '⚙️ PROSES', done: '✅ SIAP', cancelled: '❌ BATAL',
  };
  const ph = normalizePhone(order.customer.phone);

  const doCopyReceipt = async () => {
    await copyToClipboard(buildReceiptText(order, shop));
  };

  const doDownloadReceipt = () => {
    downloadText(`resit-${order.id}.txt`, buildReceiptText(order, shop));
  };

  const doCopyTrackUrl = async () => {
    await copyToClipboard(buildTrackUrl(order.id));
  };

  return (
    <div className={`rounded-xl border ${statusColors[order.status]} overflow-hidden`}>
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="w-full p-3 text-left">
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="font-bold text-sm">{order.id}</div>
            <div className="text-[11px] opacity-70">{fmtDateTime(order.createdAt)} • {daysAgo(order.createdAt)}</div>
          </div>
          <div className="text-right">
            <div className="font-bold">{fmtRM(order.total)}</div>
            <div className="text-[10px] uppercase font-semibold">{statusLabels[order.status]}</div>
          </div>
        </div>
        <div className="text-xs text-white/90 flex items-center justify-between gap-2">
          <span>{order.customer.name} • {order.customer.phone}</span>
          {order.source === 'manual' && <span className="text-[9px] bg-slate-700 px-1.5 py-0.5 rounded">WALK-IN</span>}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-white/10 pt-3">
          <div className="bg-slate-900/50 rounded-lg p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span><span className="opacity-60">Kaedah:</span> <span className="font-semibold">{order.customer.delivery === 'pickup' ? '🏪 Self Pickup' : '🛵 Delivery'}</span></span>
              <button onClick={onEditCustomer} className="text-teal-300 flex items-center gap-0.5 text-[11px]" aria-label="Edit info pelanggan">
                <Pencil size={10} /> Info
              </button>
            </div>
            {order.customer.delivery === 'delivery' && order.customer.address && (
              <div><span className="opacity-60">Alamat:</span> {order.customer.address}</div>
            )}
            {order.customer.zone && (
              <div><span className="opacity-60">Zone:</span> {order.customer.zone}</div>
            )}
            {order.customer.notes && <div><span className="opacity-60">Nota:</span> {order.customer.notes}</div>}
            {order.autoCancelledAt && (
              <div className="text-red-300 text-[10px] mt-1">
                ⚠️ Auto-dibatalkan ({fmtDateTime(order.autoCancelledAt)}) — order {'>'}24j tiada tindakan
              </div>
            )}
          </div>

          <div className="bg-slate-900/50 rounded-lg p-2.5 text-xs">
            <div className="flex justify-between items-center mb-1">
              <span className="font-semibold opacity-70">Item:</span>
              {order.status !== 'done' && order.status !== 'cancelled' && (
                <button onClick={onEdit} className="text-teal-300 flex items-center gap-1 text-[11px]">
                  <Pencil size={10} /> Edit Berat
                </button>
              )}
            </div>
            {order.items.map((i, idx) => (
              <div key={idx} className="flex justify-between py-0.5">
                <span>• {i.name} × {fmtQty(i.qty, i.unit || '')}</span>
                <span className="font-mono">{fmtRM(i.subtotal)}</span>
              </div>
            ))}
            {order.deliveryFee > 0 && (
              <div className="flex justify-between py-0.5 opacity-70">
                <span>• Delivery</span>
                <span className="font-mono">{fmtRM(order.deliveryFee)}</span>
              </div>
            )}
            <div className="flex justify-between py-1 mt-1 border-t border-slate-700 font-bold">
              <span>Total</span><span className="font-mono">{fmtRM(order.total)}</span>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            {ph.valid && (
              <>
                <a href={`tel:${ph.normalized}`} className="flex-1 bg-blue-600 hover:bg-blue-500 py-2 rounded-lg text-xs font-semibold text-center text-white">
                  📞 Call
                </a>
                <button
                  onClick={onWaTemplate}
                  className="flex-1 bg-green-600 hover:bg-green-500 py-2 rounded-lg text-xs font-semibold text-white flex items-center justify-center gap-1"
                >
                  💬 WA Template
                </button>
              </>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={doCopyTrackUrl}
              className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1"
              title="Copy URL tracking untuk buyer"
            >
              <Copy size={11} /> Copy Track URL
            </button>
            <button
              onClick={doCopyReceipt}
              className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1"
            >
              <Copy size={11} /> Copy Resit
            </button>
            <button
              onClick={doDownloadReceipt}
              className="bg-slate-700 hover:bg-slate-600 px-2 py-2 rounded-lg text-[11px]"
              title="Download resit .txt"
              aria-label="Download resit"
            >
              <FileDown size={11} />
            </button>
          </div>

          <div className="flex gap-2 flex-wrap">
            {order.status === 'new' && (
              <>
                <button onClick={() => onUpdate(order.id, { status: 'processing' })} className="flex-1 bg-amber-600 hover:bg-amber-500 py-2 rounded-lg text-xs font-semibold text-white">⚙️ Proses</button>
                <button onClick={() => onUpdate(order.id, { status: 'cancelled' })} className="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-lg text-xs" aria-label="Batal order">❌</button>
              </>
            )}
            {order.status === 'processing' && (
              <button onClick={() => onUpdate(order.id, { status: 'done' })} className="flex-1 bg-green-600 hover:bg-green-500 py-2 rounded-lg text-xs font-semibold text-white">✅ Tandakan Siap (decrement stok)</button>
            )}
            {order.status === 'done' && (
              <button onClick={() => onUpdate(order.id, { status: 'processing' })} className="flex-1 bg-slate-700 py-2 rounded-lg text-xs">↩️ Buka Semula</button>
            )}
            {order.status === 'cancelled' && (
              <button onClick={() => onUpdate(order.id, { status: 'new' })} className="flex-1 bg-slate-700 py-2 rounded-lg text-xs">↩️ Aktifkan Semula</button>
            )}
            <button onClick={() => onDelete(order.id)} className="bg-red-900/50 hover:bg-red-900 px-3 py-2 rounded-lg" aria-label="Padam order"><Trash2 size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   WA TEMPLATE MODAL
   ============================================================ */

function WATemplateModal({ order, shop, onClose }) {
  const ph = normalizePhone(order.customer.phone);
  const templates = [
    { k: 'confirmed', l: '✅ Sahkan Order', icon: '✅' },
    { k: order.customer.delivery === 'pickup' ? 'ready_pickup' : 'ready_delivery', l: order.customer.delivery === 'pickup' ? '🏪 Siap Pickup' : '🛵 Siap Delivery', icon: order.customer.delivery === 'pickup' ? '🏪' : '🛵' },
    { k: 'delivered', l: '🎉 Sudah Diterima', icon: '🎉' },
    { k: 'remind_payment', l: '💰 Ingatkan Bayar', icon: '💰' },
    { k: 'cancelled', l: '❌ Batal Order', icon: '❌' },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-teal-500/30 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-teal-300 mb-1">💬 Hantar WhatsApp ke Pelanggan</h3>
        <p className="text-xs text-slate-400 mb-3">
          Pilih template untuk <span className="font-semibold">{order.customer.name}</span>. Mesej akan dibuka di WhatsApp dengan teks sudah disediakan.
        </p>

        {!ph.valid && (
          <div className="bg-red-900/30 border border-red-500/40 rounded-lg p-2 text-xs text-red-300 mb-3">
            ⚠️ Nombor pelanggan tidak sah.
          </div>
        )}

        <div className="space-y-2">
          {templates.map(t => {
            const text = WA_TEMPLATES[t.k]?.(order, shop) || '';
            const url = waUrlToCustomer(order.customer.phone, text);
            return (
              <a
                key={t.k}
                href={url || '#'}
                target="_blank"
                rel="noreferrer"
                onClick={url ? onClose : (e) => e.preventDefault()}
                className={`block w-full p-3 rounded-lg border text-left transition-colors ${url ? 'bg-slate-900 hover:bg-slate-700 border-slate-700' : 'bg-slate-900/50 border-slate-800 opacity-50'}`}
              >
                <div className="text-sm font-semibold text-teal-300 mb-1">{t.l}</div>
                <div className="text-[10px] text-slate-400 line-clamp-2 whitespace-pre-wrap">{text.split('\n').slice(0, 2).join(' • ').slice(0, 100)}...</div>
              </a>
            );
          })}
        </div>

        <button onClick={onClose} className="w-full mt-3 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">
          Tutup
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   CUSTOMER EDIT MODAL (fix typos in order customer info)
   ============================================================ */

function CustomerEditModal({ order, onClose, onSave }) {
  const [name, setName] = useState(order.customer.name);
  const [phone, setPhone] = useState(order.customer.phone);
  const [address, setAddress] = useState(order.customer.address || '');
  const [notes, setNotes] = useState(order.customer.notes || '');

  const submit = () => {
    const ph = normalizePhone(phone);
    onSave({
      name: sanitizeText(name.trim(), 100),
      phone: ph.valid ? ph.normalized : phone,
      address: sanitizeText(address.trim(), 300),
      notes: sanitizeText(notes.trim(), 300),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-teal-500/30 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-teal-300 mb-3">Edit Info Pelanggan — {order.id}</h3>
        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-slate-400">Nama</label>
            <input value={name} onChange={e => setName(e.target.value)} maxLength={100} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Telefon</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" maxLength={20} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Alamat</label>
            <textarea value={address} onChange={e => setAddress(e.target.value)} rows={3} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Nota</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">Batal</button>
          <button onClick={submit} className="flex-1 bg-teal-600 hover:bg-teal-500 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1">
            <Save size={14} /> Simpan
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MANUAL ORDER MODAL (admin create for walk-in)
   ============================================================ */

function ManualOrderModal({ products, shop, availableStock, onClose, onSubmit, prefillCustomer = null, prefillItems = null }) {
  const [cart, setCart] = useState(prefillItems || {});
  const [name, setName] = useState(prefillCustomer?.name || '');
  const [phone, setPhone] = useState(prefillCustomer?.phone || '');
  const [address, setAddress] = useState(prefillCustomer?.address || '');
  const [notes, setNotes] = useState('');
  const [delivery, setDelivery] = useState(prefillCustomer?.delivery || 'pickup');
  const [deliveryFee, setDeliveryFee] = useState(0);

  const activeProducts = products.filter(p => p.active);

  const addQty = (id, delta) => {
    const cur = cart[id] || 0;
    const next = Math.max(0, +(cur + delta).toFixed(2));
    const n = { ...cart };
    if (next <= 0) delete n[id]; else n[id] = next;
    setCart(n);
  };

  const cartItems = Object.entries(cart).map(([id, qty]) => {
    const p = products.find(x => x.id === id);
    return p ? { ...p, qty, subtotal: +(p.price * qty).toFixed(2) } : null;
  }).filter(Boolean);
  const subtotal = cartItems.reduce((s, i) => s + i.subtotal, 0);
  const total = subtotal + deliveryFee;

  const submit = () => {
    if (cartItems.length === 0) return;
    const ph = normalizePhone(phone);
    const finalPhone = ph.valid ? ph.normalized : (phone || 'walk-in');
    onSubmit({
      createdAt: new Date().toISOString(),
      items: cartItems.map(i => ({
        id: i.id, name: i.name, price: i.price,
        qty: i.qty, unit: i.unit, subtotal: i.subtotal,
      })),
      subtotal,
      deliveryFee,
      total,
      customer: {
        name: sanitizeText(name.trim() || 'Walk-in Customer', 100),
        phone: finalPhone,
        address: sanitizeText(address.trim(), 300),
        notes: sanitizeText(notes.trim(), 300),
        delivery,
        zone: '',
        pdpa: true, // admin creates = assumed consent via direct interaction
      },
      status: 'new',
      source: 'manual',
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-md w-full border border-teal-500/30 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-teal-300 mb-1">📝 Order Manual</h3>
        <p className="text-xs text-slate-400 mb-3">Cipta order untuk walk-in / phone order.</p>

        <div className="mb-3">
          <h4 className="text-xs font-semibold text-slate-300 mb-1">Pilih Item</h4>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {activeProducts.map(p => {
              const avail = availableStock(p.id);
              const inCart = cart[p.id] || 0;
              return (
                <div key={p.id} className="bg-slate-900 rounded-lg p-2 flex items-center gap-2">
                  <span className="text-xl" aria-hidden>{p.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{p.name}</div>
                    <div className="text-[10px] text-slate-400">RM{p.price}/{p.unit} • Avail: {fmtQty(avail, p.unit)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => addQty(p.id, -0.5)} disabled={inCart === 0} className="bg-slate-700 hover:bg-slate-600 w-6 h-6 rounded text-xs disabled:opacity-30">-½</button>
                    <input
                      type="number"
                      step="0.5"
                      value={inCart}
                      onChange={e => {
                        const q = Math.max(0, parseFloat(e.target.value) || 0);
                        const n = { ...cart };
                        if (q <= 0) delete n[p.id]; else n[p.id] = q;
                        setCart(n);
                      }}
                      className="w-14 text-center bg-slate-700 rounded text-xs py-1"
                      aria-label={`Kuantiti ${p.name}`}
                    />
                    <button onClick={() => addQty(p.id, 0.5)} className="bg-teal-600 hover:bg-teal-500 w-6 h-6 rounded text-xs">+½</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2 mb-3">
          <div>
            <label className="text-[10px] text-slate-400">Nama Pelanggan</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Walk-in Customer" maxLength={100} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Telefon (optional)</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" maxLength={20} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => { setDelivery('pickup'); setDeliveryFee(0); }} className={`py-1.5 rounded-lg text-xs border ${delivery === 'pickup' ? 'bg-teal-600 border-teal-400' : 'bg-slate-900 border-slate-700'}`}>🏪 Pickup</button>
            <button onClick={() => { setDelivery('delivery'); setDeliveryFee(shop.deliveryFee); }} className={`py-1.5 rounded-lg text-xs border ${delivery === 'delivery' ? 'bg-teal-600 border-teal-400' : 'bg-slate-900 border-slate-700'}`}>🛵 Delivery</button>
          </div>
          {delivery === 'delivery' && (
            <>
              <div>
                <label className="text-[10px] text-slate-400">Alamat</label>
                <textarea value={address} onChange={e => setAddress(e.target.value)} rows={2} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm mt-1" />
              </div>
              <div>
                <label className="text-[10px] text-slate-400">Delivery Fee</label>
                <input type="number" step="0.5" value={deliveryFee} onChange={e => setDeliveryFee(parseFloat(e.target.value) || 0)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm mt-1" />
              </div>
            </>
          )}
          <div>
            <label className="text-[10px] text-slate-400">Nota (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={1} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm mt-1" />
          </div>
        </div>

        <div className="bg-slate-900 rounded-lg p-2 text-xs mb-3">
          <div className="flex justify-between"><span>Subtotal:</span><span>{fmtRM(subtotal)}</span></div>
          {deliveryFee > 0 && <div className="flex justify-between"><span>Delivery:</span><span>{fmtRM(deliveryFee)}</span></div>}
          <div className="flex justify-between font-bold text-teal-300 pt-1 mt-1 border-t border-slate-700">
            <span>Total:</span><span>{fmtRM(total)}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">Batal</button>
          <button
            onClick={submit}
            disabled={cartItems.length === 0}
            className="flex-1 bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 py-2.5 rounded-lg text-sm font-semibold"
          >
            Cipta Order
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ORDER EDITOR (same as v3)
   ============================================================ */

function OrderEditor({ order, onClose, onSave }) {
  const [items, setItems] = useState(order.items);
  const updateQty = (idx, qty) => {
    const q = Math.max(0, parseFloat(qty) || 0);
    setItems(items.map((it, i) => i === idx ? { ...it, qty: q, subtotal: +(q * it.price).toFixed(2) } : it));
  };
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const total = subtotal + (order.deliveryFee || 0);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-teal-500/30 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-teal-300 mb-2">Edit Berat Sebenar — {order.id}</h3>
        <p className="text-xs text-slate-400 mb-3">Adjust qty mengikut berat sebenar selepas timbang.</p>
        <div className="space-y-2 mb-3">
          {items.map((i, idx) => (
            <div key={idx} className="bg-slate-900 rounded-lg p-3">
              <div className="text-sm font-semibold mb-1">{i.name}</div>
              <div className="text-[11px] text-slate-400 mb-2">RM{i.price}/{i.unit || 'kg'}</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={i.qty}
                  onChange={e => updateQty(idx, e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm outline-none focus:border-teal-500"
                />
                <span className="text-xs text-slate-400">{i.unit || 'kg'}</span>
                <span className="font-mono text-sm text-teal-300">{fmtRM(i.subtotal)}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3 text-sm space-y-1 mb-3">
          <div className="flex justify-between text-slate-300"><span>Subtotal</span><span>{fmtRM(subtotal)}</span></div>
          {order.deliveryFee > 0 && (
            <div className="flex justify-between text-slate-300"><span>Delivery</span><span>{fmtRM(order.deliveryFee)}</span></div>
          )}
          <div className="flex justify-between font-bold text-teal-300 pt-1 border-t border-slate-700">
            <span>Total Baru</span><span>{fmtRM(total)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">Batal</button>
          <button
            onClick={() => onSave({ ...order, items, subtotal, total })}
            className="flex-1 bg-teal-600 hover:bg-teal-500 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1"
          >
            <Save size={14} /> Simpan
          </button>
        </div>
      </div>
    </div>
  );
}


/* ============================================================
   PRODUCTS TAB (with cost display, quick restock, margin)
   ============================================================ */

function ProductsTab({ products, onSaveProduct, onDeleteProduct, onRestockProduct, onAdjustStock, reservedByProduct, shop }) {
  const [editing, setEditing] = useState(null);
  const [restocking, setRestocking] = useState(null);
  const [adjusting, setAdjusting] = useState(null);
  const newBlank = () => ({ id: uid('p'), name: '', desc: '', price: 0, cost: 0, unit: 'kg', stock: 0, emoji: '🐟', image: '', category: 'segar', active: true });

  return (
    <div className="p-4">
      <button
        onClick={() => setEditing(newBlank())}
        className="w-full bg-teal-600 hover:bg-teal-500 py-2.5 rounded-lg text-sm font-semibold mb-4 flex items-center justify-center gap-2"
      >
        <Plus size={16} /> Tambah Produk Baru
      </button>

      {editing && <ProductEditor product={editing} onSave={(p) => { onSaveProduct(p); setEditing(null); }} onCancel={() => setEditing(null)} />}

      {restocking && (
        <RestockModal
          product={restocking}
          onClose={() => setRestocking(null)}
          onConfirm={async (qty, note) => {
            await onRestockProduct(restocking.id, qty, note);
            setRestocking(null);
          }}
        />
      )}

      {adjusting && (
        <AdjustStockModal
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onConfirm={async (newStock, note) => {
            await onAdjustStock(adjusting.id, newStock, note);
            setAdjusting(null);
          }}
        />
      )}

      <div className="space-y-2">
        {products.length === 0 && (
          <div className="text-center text-slate-400 py-12">
            <div className="text-4xl mb-2 opacity-50">📦</div>
            <p className="text-sm">Belum ada produk. Klik "Tambah Produk Baru" untuk mula.</p>
          </div>
        )}
        {products.map(p => {
          const reserved = reservedByProduct[p.id] || 0;
          const available = Math.max(0, p.stock - reserved);
          const lowStock = p.stock <= shop.lowStockThreshold;
          const margin = p.cost > 0 ? ((p.price - p.cost) / p.price * 100) : 0;
          const profitPerUnit = p.price - (p.cost || 0);
          return (
            <div key={p.id} className={`bg-slate-800 rounded-xl p-3 border ${p.active ? 'border-slate-700' : 'border-slate-800 opacity-50'}`}>
              <div className="flex items-start gap-3">
                {p.image
                  ? <img src={p.image} alt={p.name} className="w-12 h-12 rounded-lg object-cover bg-slate-900" onError={e => { e.target.style.display = 'none'; }} />
                  : <div className="text-3xl" aria-hidden>{p.emoji}</div>
                }
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm flex items-center gap-2">
                    {p.name}
                    {lowStock && <AlertTriangle size={12} className="text-amber-400" aria-label="Stok rendah" />}
                  </div>
                  <div className="text-[11px] text-slate-400">{p.desc}</div>
                  <div className="flex gap-2 text-[11px] mt-1 flex-wrap">
                    <span className="text-teal-300 font-semibold">RM{p.price}/{p.unit}</span>
                    {p.cost > 0 && (
                      <span className="text-slate-500">Cost: RM{p.cost}</span>
                    )}
                    {p.cost > 0 && (
                      <span className={`font-semibold ${margin > 40 ? 'text-green-300' : margin > 20 ? 'text-amber-300' : 'text-red-300'}`}>
                        Margin: {margin.toFixed(0)}% ({fmtRM(profitPerUnit)}/{p.unit})
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 text-[11px] mt-0.5 flex-wrap">
                    <span className={lowStock ? 'text-amber-300' : 'text-slate-400'}>Stok: {fmtQty(p.stock, p.unit)}</span>
                    {reserved > 0 && <span className="text-amber-300">• Reserved: {fmtQty(reserved, p.unit)}</span>}
                    <span className="text-slate-400">• Avail: {fmtQty(available, p.unit)}</span>
                    <span className={p.active ? 'text-green-400' : 'text-slate-500'}>{p.active ? '● Aktif' : '○ Tidak Aktif'}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-1.5 mt-3">
                <button
                  onClick={() => setRestocking(p)}
                  className="bg-green-700 hover:bg-green-600 py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
                  title="Restock"
                >
                  <Plus size={11} /> Stok
                </button>
                <button
                  onClick={() => setAdjusting(p)}
                  className="bg-slate-700 hover:bg-slate-600 py-1.5 rounded text-[11px] font-semibold"
                  title="Adjust stok"
                >
                  Adjust
                </button>
                <button
                  onClick={() => setEditing(p)}
                  className="bg-slate-700 hover:bg-slate-600 py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
                >
                  <Edit3 size={11} /> Edit
                </button>
                <button
                  onClick={() => onDeleteProduct(p.id)}
                  className="bg-red-900/50 hover:bg-red-900 py-1.5 rounded text-[11px] flex items-center justify-center"
                  aria-label="Padam produk"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   PRODUCT EDITOR (with cost field)
   ============================================================ */

function ProductEditor({ product, onSave, onCancel }) {
  const [p, setP] = useState(product);
  const upd = (k, v) => setP({ ...p, [k]: v });
  const margin = p.cost > 0 && p.price > 0 ? ((p.price - p.cost) / p.price * 100) : 0;

  return (
    <div className="bg-slate-800 rounded-xl p-4 mb-4 border border-teal-500/50">
      <h3 className="font-bold text-teal-300 mb-3 text-sm">{product.name ? 'Edit Produk' : 'Produk Baru'}</h3>
      <div className="space-y-2">
        <div className="flex gap-2">
          <input value={p.emoji} onChange={e => upd('emoji', e.target.value)} maxLength={2} className="w-14 text-center text-2xl bg-slate-900 border border-slate-700 rounded-lg p-2" aria-label="Emoji" />
          <input value={p.name} onChange={e => upd('name', e.target.value)} placeholder="Nama produk" maxLength={100} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm" />
        </div>
        <textarea value={p.desc} onChange={e => upd('desc', e.target.value)} placeholder="Deskripsi" rows={2} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm" />
        <div>
          <label className="text-[10px] text-slate-400 flex items-center gap-1"><ImageIcon size={10} /> Image URL (optional)</label>
          <input value={p.image} onChange={e => upd('image', e.target.value)} placeholder="https://..." className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-slate-400">Harga Jual (RM)</label>
            <input type="number" step="0.01" value={p.price} onChange={e => upd('price', parseFloat(e.target.value) || 0)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Cost (RM)</label>
            <input type="number" step="0.01" value={p.cost} onChange={e => upd('cost', parseFloat(e.target.value) || 0)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" title="Kos produksi" />
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Unit</label>
            <input value={p.unit} onChange={e => upd('unit', e.target.value)} maxLength={10} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
          </div>
        </div>
        {p.cost > 0 && p.price > 0 && (
          <div className={`rounded-lg p-2 text-[11px] border ${margin > 40 ? 'bg-green-900/30 border-green-700/40 text-green-300' : margin > 20 ? 'bg-amber-900/30 border-amber-700/40 text-amber-300' : 'bg-red-900/30 border-red-700/40 text-red-300'}`}>
            💰 Margin: <b>{margin.toFixed(1)}%</b> • Untung: <b>{fmtRM(p.price - p.cost)}</b>/{p.unit}
            {margin < 20 && <span className="block mt-0.5 text-[10px]">⚠️ Margin rendah — consider naik harga atau turun kos</span>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-slate-400">Stok Sedia Ada</label>
            <input type="number" step="0.1" value={p.stock} onChange={e => upd('stock', parseFloat(e.target.value) || 0)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
            <p className="text-[9px] text-slate-500 mt-0.5">Guna butang Stok/Adjust untuk restock produk sedia ada (auto log ke ledger)</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400">Kategori</label>
            <select value={p.category} onChange={e => upd('category', e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm">
              <option value="segar">Segar</option>
              <option value="proses">Diproses</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={p.active} onChange={e => upd('active', e.target.checked)} />
          Aktif (papar di kedai)
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={() => onSave(p)} disabled={!p.name.trim()} className="flex-1 bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1"><Check size={14} /> Simpan</button>
          <button onClick={onCancel} className="flex-1 bg-slate-700 py-2 rounded-lg text-sm flex items-center justify-center gap-1"><X size={14} /> Batal</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   RESTOCK MODAL (with quick buttons)
   ============================================================ */

function RestockModal({ product, onClose, onConfirm }) {
  const [qty, setQty] = useState(10);
  const [note, setNote] = useState('');

  const newTotal = product.stock + (parseFloat(qty) || 0);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-green-500/30 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-green-300 mb-1 flex items-center gap-2">
          <Plus size={16} /> Restock — {product.emoji} {product.name}
        </h3>
        <p className="text-xs text-slate-400 mb-3">
          Stok semasa: <span className="font-semibold text-white">{fmtQty(product.stock, product.unit)}</span>
        </p>

        <div className="grid grid-cols-4 gap-2 mb-3">
          {[5, 10, 25, 50].map(amt => (
            <button
              key={amt}
              onClick={() => setQty(amt)}
              className={`py-2 rounded-lg text-xs font-semibold border ${qty === amt ? 'bg-green-600 border-green-400' : 'bg-slate-900 border-slate-700 hover:bg-slate-700'}`}
            >
              +{amt}
            </button>
          ))}
        </div>

        <div className="mb-3">
          <label className="text-[10px] text-slate-400">Atau masuk custom:</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number"
              step="0.1"
              min="0"
              value={qty}
              onChange={e => setQty(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              aria-label="Kuantiti restock"
            />
            <span className="text-sm text-slate-400">{product.unit}</span>
          </div>
        </div>

        <div className="mb-3">
          <label className="text-[10px] text-slate-400">Nota (optional)</label>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Cth: Harvest pond A, beli dari supplier X"
            maxLength={200}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1"
          />
        </div>

        <div className="bg-green-900/20 border border-green-700/40 rounded-lg p-3 text-sm mb-3">
          <div className="flex justify-between text-xs text-slate-300">
            <span>Stok Baru:</span>
            <span className="font-bold text-green-300">{fmtQty(newTotal, product.unit)}</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1">
            ✅ Akan direkod ke Stock Ledger
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">Batal</button>
          <button
            onClick={() => onConfirm(qty, note)}
            disabled={qty <= 0}
            className="flex-1 bg-green-600 hover:bg-green-500 disabled:bg-slate-700 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1"
          >
            <Check size={14} /> Restock
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ADJUST STOCK MODAL (manual correction, e.g. kena curi, mati)
   ============================================================ */

function AdjustStockModal({ product, onClose, onConfirm }) {
  const [newStock, setNewStock] = useState(product.stock);
  const [note, setNote] = useState('');

  const delta = newStock - product.stock;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full border border-amber-500/30 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-amber-300 mb-1 flex items-center gap-2">
          <Edit3 size={16} /> Adjust Stok — {product.emoji} {product.name}
        </h3>
        <p className="text-xs text-slate-400 mb-3">
          Guna untuk pembetulan manual (ikan mati, kena curi, silap kira).
        </p>
        <p className="text-xs text-slate-300 mb-3">
          Stok semasa: <span className="font-bold">{fmtQty(product.stock, product.unit)}</span>
        </p>

        <div className="mb-3">
          <label className="text-[10px] text-slate-400">Stok Sebenar:</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number"
              step="0.1"
              min="0"
              value={newStock}
              onChange={e => setNewStock(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              aria-label="Stok sebenar"
            />
            <span className="text-sm text-slate-400">{product.unit}</span>
          </div>
        </div>

        <div className="mb-3">
          <label className="text-[10px] text-slate-400">Sebab (recommended)</label>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Cth: 3 ekor mati, silap kira minggu lepas"
            maxLength={200}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1"
          />
        </div>

        <div className={`rounded-lg p-3 text-sm mb-3 ${delta >= 0 ? 'bg-green-900/20 border border-green-700/40' : 'bg-red-900/20 border border-red-700/40'}`}>
          <div className="flex justify-between text-xs">
            <span className="text-slate-300">Perubahan:</span>
            <span className={`font-bold ${delta >= 0 ? 'text-green-300' : 'text-red-300'}`}>
              {delta >= 0 ? '+' : ''}{fmtQty(delta, product.unit)}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2.5 rounded-lg text-sm font-semibold">Batal</button>
          <button
            onClick={() => onConfirm(newStock, note)}
            className="flex-1 bg-amber-600 hover:bg-amber-500 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1"
          >
            <Check size={14} /> Adjust
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   STATS TAB (with profit, margin, daily trend)
   ============================================================ */

function StatsTab({ orders, products }) {
  const [period, setPeriod] = useState('all');
  const now = new Date();
  const filterFn = (o) => {
    const d = new Date(o.createdAt);
    if (period === 'today') return d.toDateString() === now.toDateString();
    if (period === 'week') return (now - d) / 86400000 < 7;
    if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    return true;
  };
  const scoped = orders.filter(filterFn);
  const doneOrders = scoped.filter(o => o.status === 'done');
  const totalRevenue = doneOrders.reduce((s, o) => s + o.total, 0);
  const pendingRevenue = scoped.filter(o => o.status === 'new' || o.status === 'processing').reduce((s, o) => s + o.total, 0);

  // COGS + Profit calculation
  const costMap = {};
  products.forEach(p => { costMap[p.id] = p.cost || 0; });
  let totalCOGS = 0;
  let totalDeliveryRev = 0;
  doneOrders.forEach(o => {
    o.items.forEach(i => {
      totalCOGS += (costMap[i.id] || 0) * i.qty;
    });
    totalDeliveryRev += o.deliveryFee || 0;
  });
  const grossProfit = totalRevenue - totalCOGS;
  const overallMargin = totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0;

  const totalOrders = scoped.length;
  const newOrders = scoped.filter(o => o.status === 'new').length;
  const avgOrder = doneOrders.length > 0 ? totalRevenue / doneOrders.length : 0;

  // Product sales + margin per product
  const productSales = {};
  scoped.forEach(o => {
    if (o.status === 'done') {
      o.items.forEach(i => {
        if (!productSales[i.name]) {
          productSales[i.name] = { qty: 0, revenue: 0, cost: 0, id: i.id };
        }
        productSales[i.name].qty += i.qty;
        productSales[i.name].revenue += i.subtotal;
        productSales[i.name].cost += (costMap[i.id] || 0) * i.qty;
      });
    }
  });
  const topProducts = Object.entries(productSales)
    .map(([name, data]) => ({
      name, ...data,
      profit: data.revenue - data.cost,
      margin: data.revenue > 0 ? ((data.revenue - data.cost) / data.revenue * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Daily revenue trend (last 7 days)
  const dailyRev = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const end = new Date(d); end.setHours(23, 59, 59, 999);
    const rev = orders.filter(o =>
      o.status === 'done' &&
      new Date(o.createdAt) >= d &&
      new Date(o.createdAt) <= end
    ).reduce((s, o) => s + o.total, 0);
    dailyRev.push({
      label: d.toLocaleDateString('ms-MY', { weekday: 'short', day: 'numeric' }),
      rev,
    });
  }
  const maxDaily = Math.max(...dailyRev.map(d => d.rev), 1);

  return (
    <div className="p-4 space-y-3">
      <div className="flex gap-2 overflow-x-auto">
        {[
          { k: 'today', l: 'Hari Ni' },
          { k: 'week', l: '7 Hari' },
          { k: 'month', l: 'Bulan Ni' },
          { k: 'all', l: 'Semua' },
        ].map(p => (
          <button
            key={p.k}
            onClick={() => setPeriod(p.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${period === p.k ? 'bg-teal-600' : 'bg-slate-800 text-slate-400'}`}
          >
            {p.l}
          </button>
        ))}
      </div>

      {/* Profit Card — NEW v4 */}
      <div className="bg-gradient-to-br from-green-900/60 to-slate-800 rounded-xl p-4 border border-green-500/50">
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-bold text-green-300 text-sm flex items-center gap-1">
            <DollarSign size={14} /> Keuntungan Kasar (Gross Profit)
          </h4>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${overallMargin > 40 ? 'bg-green-500/30 text-green-200' : overallMargin > 20 ? 'bg-amber-500/30 text-amber-200' : 'bg-red-500/30 text-red-200'}`}>
            {overallMargin.toFixed(1)}% margin
          </span>
        </div>
        <div className="text-3xl font-bold text-white">{fmtRM(grossProfit)}</div>
        <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
          <div>
            <div className="text-slate-400">Revenue</div>
            <div className="font-semibold text-white">{fmtRM(totalRevenue)}</div>
          </div>
          <div>
            <div className="text-slate-400">COGS (Kos)</div>
            <div className="font-semibold text-red-300">-{fmtRM(totalCOGS)}</div>
          </div>
        </div>
        {totalDeliveryRev > 0 && (
          <div className="text-[10px] text-slate-400 mt-2">
            Termasuk delivery fee: {fmtRM(totalDeliveryRev)}
          </div>
        )}
        {totalCOGS === 0 && totalRevenue > 0 && (
          <div className="text-[10px] text-amber-300 mt-2 bg-amber-900/20 rounded px-2 py-1 border border-amber-700/30">
            ⚠️ Isi field "Cost" pada produk untuk dapat margin sebenar
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Revenue (Siap)" value={fmtRM(totalRevenue)} color="green" />
        <StatCard label="Pending" value={fmtRM(pendingRevenue)} color="amber" />
        <StatCard label="Jumlah Order" value={totalOrders} color="teal" />
        <StatCard label="Order Baru" value={newOrders} color="red" />
        <StatCard label="Avg Order Value" value={fmtRM(avgOrder)} color="teal" />
        <StatCard label="Completion Rate" value={totalOrders ? Math.round(doneOrders.length / totalOrders * 100) + '%' : '0%'} color="green" />
      </div>

      {/* 7-day revenue trend */}
      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
        <h3 className="font-bold text-teal-300 text-sm mb-3 flex items-center gap-1">
          <BarChart3 size={14} /> Revenue 7 Hari (Done)
        </h3>
        <div className="flex items-end justify-between gap-1 h-24">
          {dailyRev.map((d, i) => {
            const heightPct = (d.rev / maxDaily) * 100;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                <div className="text-[9px] text-slate-400 opacity-0 group-hover:opacity-100 transition">
                  {d.rev > 0 ? fmtRM(d.rev) : ''}
                </div>
                <div
                  className={`w-full rounded-t ${d.rev > 0 ? 'bg-teal-500' : 'bg-slate-700'}`}
                  style={{ height: `${Math.max(heightPct, 2)}%` }}
                  title={`${d.label}: ${fmtRM(d.rev)}`}
                />
                <div className="text-[9px] text-slate-400 whitespace-nowrap">{d.label}</div>
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-slate-500 text-center mt-2">
          Tap bar untuk nampak nilai
        </div>
      </div>

      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
        <h3 className="font-bold text-teal-300 text-sm mb-2">📊 Top Produk (dengan Margin)</h3>
        {topProducts.length === 0 && <p className="text-xs text-slate-400">Belum ada jualan untuk tempoh ni.</p>}
        {topProducts.map((prod, i) => (
          <div key={prod.name} className="py-2 border-b border-slate-700/50 last:border-0">
            <div className="flex justify-between items-start text-xs">
              <span className="font-semibold">{i + 1}. {prod.name}</span>
              <span className="text-teal-300 font-bold">{fmtRM(prod.revenue)}</span>
            </div>
            <div className="flex justify-between items-center text-[10px] text-slate-400 mt-0.5">
              <span>{fmtQty(prod.qty)} unit</span>
              {prod.cost > 0 ? (
                <span>
                  Profit: <span className="text-green-300 font-semibold">{fmtRM(prod.profit)}</span>
                  {' '}({prod.margin.toFixed(0)}%)
                </span>
              ) : (
                <span className="text-slate-500">Cost belum diisi</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
        <h3 className="font-bold text-teal-300 text-sm mb-2">📦 Status Stok</h3>
        {products.map(p => (
          <div key={p.id} className="flex justify-between items-center py-1.5 border-b border-slate-700/50 last:border-0 text-xs">
            <span>{p.emoji} {p.name}</span>
            <span className={p.stock > 10 ? 'text-green-300' : p.stock > 0 ? 'text-amber-300' : 'text-red-300'}>
              {fmtQty(p.stock, p.unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  const colors = {
    green: 'from-green-900/40 to-slate-800 border-green-700/50 text-green-300',
    amber: 'from-amber-900/40 to-slate-800 border-amber-700/50 text-amber-300',
    teal: 'from-teal-900/40 to-slate-800 border-teal-700/50 text-teal-300',
    red: 'from-red-900/40 to-slate-800 border-red-700/50 text-red-300',
  };
  return (
    <div className={`bg-gradient-to-br ${colors[color]} rounded-xl p-3 border`}>
      <div className="text-[10px] uppercase opacity-70 font-semibold">{label}</div>
      <div className="text-lg font-bold mt-1">{value}</div>
    </div>
  );
}


/* ============================================================
   CUSTOMERS TAB (with Repeat Order shortcut)
   ============================================================ */

function CustomersTab({ orders, products, shop, availableStock, onPlaceOrder, onGoToOrders, showToast }) {
  const [repeating, setRepeating] = useState(null);

  const byPhone = {};
  orders.forEach(o => {
    const ph = o.customer.phone;
    if (!byPhone[ph]) byPhone[ph] = {
      phone: ph,
      name: o.customer.name,
      address: o.customer.address || '',
      delivery: o.customer.delivery,
      orderCount: 0,
      totalSpent: 0,
      lastOrder: null,
      lastOrderObj: null,
    };
    byPhone[ph].orderCount++;
    if (o.status === 'done') byPhone[ph].totalSpent += o.total;
    if (!byPhone[ph].lastOrder || new Date(o.createdAt) > new Date(byPhone[ph].lastOrder)) {
      byPhone[ph].lastOrder = o.createdAt;
      byPhone[ph].lastOrderObj = o;
      byPhone[ph].name = o.customer.name;
      byPhone[ph].address = o.customer.address || '';
      byPhone[ph].delivery = o.customer.delivery;
    }
  });
  const customers = Object.values(byPhone).sort((a, b) => b.totalSpent - a.totalSpent);

  const doExport = () => {
    const rows = [
      ['Name', 'Phone', 'Orders', 'Total Spent', 'Last Order'],
      ...customers.map(c => [c.name, c.phone, c.orderCount, c.totalSpent.toFixed(2), fmtDateTime(c.lastOrder)]),
    ];
    exportCSV(`tilapia-customers-${Date.now()}.csv`, rows);
  };

  const startRepeat = (customer) => {
    // Rebuild prefill cart from last order items (only products that still exist)
    const prefillItems = {};
    customer.lastOrderObj?.items.forEach(i => {
      if (products.find(p => p.id === i.id)) {
        prefillItems[i.id] = i.qty;
      }
    });
    setRepeating({
      customer: {
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        delivery: customer.delivery,
      },
      items: prefillItems,
    });
  };

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-bold text-teal-300 text-sm">Pelanggan ({customers.length})</h3>
        <button onClick={doExport} className="px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-800 text-teal-300 flex items-center gap-1">
          <Download size={12} /> CSV
        </button>
      </div>
      {customers.length === 0 && (
        <div className="text-center text-slate-400 py-12">
          <div className="text-4xl mb-2 opacity-50">👥</div>
          <p className="text-sm">Belum ada pelanggan.</p>
        </div>
      )}
      <div className="space-y-2">
        {customers.map((c, i) => {
          const ph = normalizePhone(c.phone);
          return (
            <div key={c.phone} className="bg-slate-800 rounded-xl p-3 border border-slate-700">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm flex items-center gap-2">
                    {i < 3 && ['🥇', '🥈', '🥉'][i]} {c.name}
                  </div>
                  <div className="text-[11px] text-slate-400">{c.phone}</div>
                  <div className="flex gap-3 text-[11px] mt-1 flex-wrap">
                    <span className="text-teal-300">{c.orderCount} order</span>
                    <span className="text-green-300">{fmtRM(c.totalSpent)}</span>
                    <span className="text-slate-400">Last: {shortDate(c.lastOrder)}</span>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5 mt-2">
                <button
                  onClick={() => startRepeat(c)}
                  className="bg-teal-700 hover:bg-teal-600 py-1.5 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
                  title="Cipta order baru dengan item sama"
                >
                  <Repeat size={11} /> Repeat
                </button>
                {ph.valid ? (
                  <a
                    href={`https://wa.me/${ph.wa}`}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-green-600 hover:bg-green-500 py-1.5 rounded text-[11px] font-semibold text-center text-white flex items-center justify-center gap-1"
                  >
                    💬 WA
                  </a>
                ) : (
                  <button disabled className="bg-slate-700 opacity-50 py-1.5 rounded text-[11px]">No WA</button>
                )}
                {ph.valid ? (
                  <a
                    href={`tel:${ph.normalized}`}
                    className="bg-blue-600 hover:bg-blue-500 py-1.5 rounded text-[11px] font-semibold text-center text-white flex items-center justify-center gap-1"
                  >
                    📞 Call
                  </a>
                ) : (
                  <button disabled className="bg-slate-700 opacity-50 py-1.5 rounded text-[11px]">No Call</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {repeating && (
        <ManualOrderModal
          products={products}
          shop={shop}
          availableStock={availableStock}
          prefillCustomer={repeating.customer}
          prefillItems={repeating.items}
          onClose={() => setRepeating(null)}
          onSubmit={async (orderDraft) => {
            const saved = await onPlaceOrder(orderDraft);
            if (saved) {
              setRepeating(null);
              showToast(`Repeat order ${saved.id} dicipta`, 'success');
              if (onGoToOrders) onGoToOrders();
            }
          }}
        />
      )}
    </div>
  );
}

/* ============================================================
   LEDGER TAB — Stock movements (NEW v4)
   ============================================================ */

function LedgerTab({ ledger, products }) {
  const [filterType, setFilterType] = useState('all');
  const [filterProduct, setFilterProduct] = useState('all');

  const filtered = ledger.filter(l => {
    if (filterType !== 'all' && l.type !== filterType) return false;
    if (filterProduct !== 'all' && l.productId !== filterProduct) return false;
    return true;
  });

  const typeLabels = {
    restock: { l: '📦 Restock', color: 'text-green-300' },
    sale: { l: '💰 Jualan', color: 'text-teal-300' },
    adjust: { l: '⚙️ Adjust', color: 'text-amber-300' },
    'cancel-release': { l: '↩️ Release', color: 'text-slate-300' },
    initial: { l: '🆕 Awal', color: 'text-blue-300' },
  };

  const doExport = () => {
    const rows = [
      ['Date', 'Type', 'Product', 'Quantity', 'Note'],
      ...filtered.map(l => [
        fmtDateTime(l.at), l.type, l.productName, l.qty, l.note,
      ]),
    ];
    exportCSV(`tilapia-ledger-${Date.now()}.csv`, rows);
  };

  // Summary cards
  const totalRestocked = ledger.filter(l => l.type === 'restock').reduce((s, l) => s + l.qty, 0);
  const totalSold = Math.abs(ledger.filter(l => l.type === 'sale').reduce((s, l) => s + l.qty, 0));

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-bold text-teal-300 text-sm flex items-center gap-1">
          <BarChart3 size={14} /> Stock Ledger ({filtered.length})
        </h3>
        <button onClick={doExport} className="px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-800 text-teal-300 flex items-center gap-1">
          <Download size={12} /> CSV
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-green-900/30 border border-green-700/40 rounded-lg p-2 text-xs">
          <div className="text-[10px] text-green-300">Total Restock (all-time)</div>
          <div className="font-bold text-white">{fmtQty(totalRestocked)} unit</div>
        </div>
        <div className="bg-teal-900/30 border border-teal-700/40 rounded-lg p-2 text-xs">
          <div className="text-[10px] text-teal-300">Total Sold (all-time)</div>
          <div className="font-bold text-white">{fmtQty(totalSold)} unit</div>
        </div>
      </div>

      <div className="flex gap-2 mb-3 overflow-x-auto">
        {[
          { k: 'all', l: 'Semua' },
          { k: 'restock', l: '📦 Restock' },
          { k: 'sale', l: '💰 Jualan' },
          { k: 'adjust', l: '⚙️ Adjust' },
          { k: 'cancel-release', l: '↩️ Release' },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setFilterType(f.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${filterType === f.k ? 'bg-teal-600' : 'bg-slate-800 text-slate-400'}`}
          >
            {f.l}
          </button>
        ))}
      </div>

      <select
        value={filterProduct}
        onChange={e => setFilterProduct(e.target.value)}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs mb-3"
        aria-label="Filter produk"
      >
        <option value="all">Semua produk</option>
        {products.map(p => (
          <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>
        ))}
      </select>

      {filtered.length === 0 ? (
        <div className="text-center text-slate-400 py-12">
          <div className="text-4xl mb-2 opacity-50">📋</div>
          <p className="text-sm">Tiada pergerakan stok.</p>
          <p className="text-[11px] mt-1 text-slate-500">Ledger akan auto-rekod bila restock, jual, atau adjust stok.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(l => {
            const tl = typeLabels[l.type] || { l: l.type, color: 'text-slate-300' };
            return (
              <div key={l.id} className="bg-slate-800 rounded-lg px-3 py-2 border border-slate-700/50 text-xs">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className={`font-semibold ${tl.color}`}>{tl.l}</div>
                    <div className="text-slate-300 truncate">{l.productName}</div>
                    {l.note && <div className="text-slate-500 text-[10px] mt-0.5 italic">"{l.note}"</div>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`font-bold ${l.qty >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                      {l.qty >= 0 ? '+' : ''}{fmtQty(l.qty)}
                    </div>
                    <div className="text-[10px] text-slate-500">{fmtDateTime(l.at)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   AUDIT LOG TAB (preserved from v3)
   ============================================================ */

function AuditTab({ auditLog }) {
  return (
    <div className="p-4">
      <h3 className="font-bold text-teal-300 text-sm mb-3">Log Aktiviti Admin</h3>
      {auditLog.length === 0 ? (
        <div className="text-center text-slate-400 py-12">
          <div className="text-4xl mb-2 opacity-50">📜</div>
          <p className="text-sm">Tiada log aktiviti.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {auditLog.map(e => (
            <div key={e.id} className="bg-slate-800 rounded-lg px-3 py-2 border border-slate-700/50 text-xs">
              <div className="flex justify-between items-start">
                <span className="font-semibold text-teal-300">{e.action}</span>
                <span className="text-[10px] text-slate-400">{fmtDateTime(e.at)}</span>
              </div>
              <div className="text-slate-300 text-[11px] mt-0.5">{e.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SETTINGS TAB (with delivery zones, autoCancel, halal, PDPA)
   ============================================================ */

function SettingsTab({ shop, prefs, zones, onSaveShop, onSavePrefs, onSaveZones, onChangePin, onExportBackup, onImportBackup, showToast, showConfirm }) {
  const [s, setS] = useState(shop);
  const [newPin, setNewPin] = useState('');
  const [savedShop, setSavedShop] = useState(false);
  const [zonesList, setZonesList] = useState(zones);
  const fileInputRef = useRef(null);

  useEffect(() => { setS(shop); }, [shop]);
  useEffect(() => { setZonesList(zones); }, [zones]);

  const saveShopSettings = async () => {
    await onSaveShop(s);
    setSavedShop(true);
    setTimeout(() => setSavedShop(false), 1500);
    showToast('Tetapan disimpan', 'success');
  };

  const togglePref = (k) => {
    const next = { ...prefs, [k]: !prefs[k] };
    onSavePrefs(next);
  };

  const testNotif = async () => {
    const perm = await requestNotifPerm();
    if (perm !== 'granted') {
      showToast('Izinkan notifikasi dulu dalam browser', 'error');
      return;
    }
    if (prefs.sound) playOrderChime();
    if (prefs.vibrate) vibr();
    pushNotif('🔔 Test Notification', 'Notifikasi berjaya!');
    showToast('Test dihantar', 'success');
  };

  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    if (file) onImportBackup(file);
    e.target.value = '';
  };

  const addZone = () => {
    setZonesList([...zonesList, { id: uid('z'), name: 'Zon Baru', fee: 5 }]);
  };
  const updateZone = (id, patch) => {
    setZonesList(zonesList.map(z => z.id === id ? { ...z, ...patch } : z));
  };
  const deleteZone = (id) => {
    if (zonesList.length <= 1) {
      showToast('Mesti ada sekurang-kurangnya 1 zon', 'error');
      return;
    }
    setZonesList(zonesList.filter(z => z.id !== id));
  };
  const saveZoneList = async () => {
    await onSaveZones(zonesList);
    showToast('Zon disimpan', 'success');
  };

  return (
    <div className="p-4 space-y-4">
      {/* Notification */}
      <div>
        <h3 className="font-bold text-teal-300 mb-3 text-sm flex items-center gap-2"><BellRing size={14} /> Notifikasi</h3>
        <div className="space-y-2 bg-slate-800 rounded-xl p-4 border border-slate-700">
          <PrefToggle label="Browser Notification" icon={<Bell size={14} />} on={prefs.notif} onToggle={() => togglePref('notif')} />
          <PrefToggle label="Bunyi Beep" icon={prefs.sound ? <Volume2 size={14} /> : <VolumeX size={14} />} on={prefs.sound} onToggle={() => togglePref('sound')} />
          <PrefToggle label="Getaran Phone" icon={<Phone size={14} />} on={prefs.vibrate} onToggle={() => togglePref('vibrate')} />
          <button onClick={testNotif} className="w-full bg-teal-600 hover:bg-teal-500 py-2 rounded-lg text-xs font-semibold mt-2 flex items-center justify-center gap-1">
            <BellRing size={12} /> Test Notification
          </button>
          <p className="text-[10px] text-slate-500 mt-1">
            Notifikasi berjalan bila tab Claude dibuka sahaja.
          </p>
        </div>
      </div>

      {/* Shop Info */}
      <div>
        <h3 className="font-bold text-teal-300 mb-3 text-sm flex items-center gap-2"><Store size={14} /> Tetapan Kedai</h3>
        <div className="space-y-3 bg-slate-800 rounded-xl p-4 border border-slate-700">
          <div>
            <label className="text-xs text-slate-400">Nama Kedai</label>
            <input value={s.name} onChange={e => setS({ ...s, name: e.target.value })} maxLength={80} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-xs text-slate-400">No. Telefon Kedai (WA)</label>
            <input value={s.phone} onChange={e => setS({ ...s, phone: e.target.value })} placeholder="01X-XXXXXXX" maxLength={20} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
            <p className="text-[10px] text-slate-500 mt-1">⚠️ Ini no. WhatsApp kedai. Pesanan buyer akan dihantar ke sini.</p>
          </div>
          <div>
            <label className="text-xs text-slate-400">Lokasi</label>
            <input value={s.location} onChange={e => setS({ ...s, location: e.target.value })} maxLength={100} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-xs text-slate-400">Welcome Message</label>
            <textarea value={s.welcomeMsg} onChange={e => setS({ ...s, welcomeMsg: e.target.value })} rows={2} maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-slate-400">Default Delivery Fee</label>
              <input type="number" step="0.5" value={s.deliveryFee} onChange={e => setS({ ...s, deliveryFee: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400">Min Order (RM)</label>
              <input type="number" value={s.minOrder} onChange={e => setS({ ...s, minOrder: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[10px] text-slate-400">Low Stock</label>
              <input type="number" value={s.lowStockThreshold} onChange={e => setS({ ...s, lowStockThreshold: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-sm" />
            </div>
          </div>

          {/* Auto-cancel hours */}
          <div>
            <label className="text-xs text-slate-400 flex items-center gap-1">
              <Clock size={11} /> Auto-cancel order 'new' selepas (jam)
            </label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="range"
                min="1"
                max="72"
                value={s.autoCancelHours || 24}
                onChange={e => setS({ ...s, autoCancelHours: parseInt(e.target.value) || 24 })}
                className="flex-1"
              />
              <span className="font-mono text-sm text-teal-300 w-12 text-center">{s.autoCancelHours || 24}j</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              Order yang tiada tindakan dalam {s.autoCancelHours || 24} jam akan auto-dibatalkan, stok direlease.
            </p>
          </div>

          {/* Halal toggle */}
          <label className="flex items-center justify-between py-2 px-1 text-sm cursor-pointer">
            <span className="flex items-center gap-2 text-slate-200">
              <ShieldCheck size={14} className="text-green-400" /> Papar Badge HALAL
            </span>
            <div className={`w-10 h-6 rounded-full relative transition-colors ${s.halalCert ? 'bg-green-500' : 'bg-slate-700'}`}>
              <input
                type="checkbox"
                checked={s.halalCert}
                onChange={e => setS({ ...s, halalCert: e.target.checked })}
                className="sr-only"
              />
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${s.halalCert ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </div>
          </label>

          {/* PDPA text */}
          <div>
            <label className="text-xs text-slate-400">Teks Notis PDPA</label>
            <textarea
              value={s.pdpaText || DEFAULT_SHOP.pdpaText}
              onChange={e => setS({ ...s, pdpaText: e.target.value })}
              rows={3}
              maxLength={1000}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs mt-1"
            />
            <p className="text-[10px] text-slate-500 mt-1">Dipaparkan di checkout bila pelanggan klik "notis PDPA".</p>
          </div>

          <button onClick={saveShopSettings} className="w-full bg-teal-600 hover:bg-teal-500 py-2.5 rounded-lg font-semibold text-sm">
            {savedShop ? '✅ Disimpan' : 'Simpan Tetapan'}
          </button>
        </div>
      </div>

      {/* Delivery Zones (NEW v4) */}
      <div>
        <h3 className="font-bold text-teal-300 mb-3 text-sm flex items-center gap-2">
          <Truck size={14} /> Zon Penghantaran
        </h3>
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 space-y-2">
          <p className="text-[11px] text-slate-400 mb-2">
            Set harga delivery mengikut jarak/zon. Pelanggan akan pilih di checkout.
          </p>
          {zonesList.map((z) => (
            <div key={z.id} className="bg-slate-900 rounded-lg p-2 flex items-center gap-2">
              <input
                value={z.name}
                onChange={e => updateZone(z.id, { name: e.target.value })}
                placeholder="Nama zon"
                maxLength={80}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs"
                aria-label="Nama zon"
              />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-400">RM</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={z.fee}
                  onChange={e => updateZone(z.id, { fee: parseFloat(e.target.value) || 0 })}
                  className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-center"
                  aria-label="Harga delivery"
                />
              </div>
              <button
                onClick={() => deleteZone(z.id)}
                className="bg-red-900/50 hover:bg-red-900 p-1.5 rounded"
                aria-label="Padam zon"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <button onClick={addZone} className="w-full bg-slate-700 hover:bg-slate-600 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1">
            <Plus size={12} /> Tambah Zon
          </button>
          <button onClick={saveZoneList} className="w-full bg-teal-600 hover:bg-teal-500 py-2 rounded-lg text-xs font-semibold">
            Simpan Zon
          </button>
        </div>
      </div>

      {/* Backup & Restore */}
      <div>
        <h3 className="font-bold text-teal-300 mb-3 text-sm flex items-center gap-2"><FileDown size={14} /> Backup & Restore</h3>
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 space-y-2">
          <p className="text-[11px] text-slate-400">
            Export semua data (produk, order, zon, ledger) ke fail JSON. Simpan di Google Drive untuk selamat.
          </p>
          <button
            onClick={onExportBackup}
            className="w-full bg-teal-600 hover:bg-teal-500 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
          >
            <FileDown size={12} /> Export Backup JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full bg-amber-700 hover:bg-amber-600 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
          >
            <Upload size={12} /> Import Backup JSON
          </button>
          <p className="text-[10px] text-amber-300/70">
            ⚠️ Import akan replace semua data sedia ada. Export dulu sebelum import!
          </p>
        </div>
      </div>

      {/* Change PIN */}
      <div>
        <h3 className="font-bold text-teal-300 mb-3 text-sm flex items-center gap-2"><Lock size={14} /> Tukar Admin PIN</h3>
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 space-y-2">
          <input
            type="password"
            inputMode="numeric"
            value={newPin}
            onChange={e => setNewPin(e.target.value)}
            placeholder="PIN baru (min 4 digit)"
            maxLength={10}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={() => {
              if (!newPin) return;
              showConfirm('Tukar PIN admin?', async () => {
                await onChangePin(newPin);
                setNewPin('');
              });
            }}
            disabled={!newPin || newPin.length < 4}
            className="w-full bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 py-2 rounded-lg text-sm font-semibold"
          >
            Tukar PIN
          </button>
          <p className="text-[10px] text-slate-500">PIN disimpan sebagai hash dalam personal storage device ini sahaja. Setelah 5x salah, dikunci 15 minit.</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700 text-xs text-slate-400 space-y-2">
        <p className="font-semibold text-slate-300">ℹ️ Nota Teknikal v4:</p>
        <p>• <b>Buyer status tracking</b>: pelanggan boleh semak order via URL <code className="text-teal-300">?track=ORD-0001</code>.</p>
        <p>• <b>Order ID</b>: format ORD-XXXX bernombor berurutan (senang bagi pada phone).</p>
        <p>• <b>Stock Ledger</b>: auto-rekod setiap pergerakan stok (restock/sale/adjust/release).</p>
        <p>• <b>Margin tracking</b>: isi field "Cost" pada produk untuk dapat profit analytics.</p>
        <p>• <b>Auto-cancel TTL</b>: order 'new' yang lebih {s.autoCancelHours || 24}j auto-batal, stok direlease.</p>
        <p>• <b>WA templates</b>: 5 mesej pre-written untuk blast ke pelanggan (confirm, siap, delivered, dsb).</p>
        <p>• <b>PDPA consent</b>: pelanggan mesti setuju sebelum order (Akta PDPA 2010).</p>
        <p>• <b>PIN security</b>: 5x salah → kunci 15 minit.</p>
        <p>• <b>Shared storage</b>: products/orders/ledger/zones dikongsi semua device via Supabase cloud.</p>
        <p>• <b>Session</b>: admin unlock 24 jam per device.</p>
      </div>
    </div>
  );
}

function PrefToggle({ label, icon, on, onToggle }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between py-2 px-1 text-sm">
      <span className="flex items-center gap-2 text-slate-200">{icon} {label}</span>
      <div className={`w-10 h-6 rounded-full relative transition-colors ${on ? 'bg-teal-500' : 'bg-slate-700'}`}>
        <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </div>
    </button>
  );
}
