'use strict';

/* =========================================================
   درايف ثرو — منطق صفحة العميل (index.html)
   المخطط: التحقق من الموقع (GPS + Haversine) -> المنيو
            -> السلة -> إرسال الطلب إلى Supabase -> تأكيد
   ========================================================= */

const $id = (id) => document.getElementById(id);

const UI = {
  locating:      $id('locating'),
  blocked:       $id('blocked'),
  gpsError:      $id('gpsError'),
  configError:   $id('configError'),
  configErrorMsg:$id('configErrorMsg'),
  closedDay:     $id('closedDay'),
  menuSection:   $id('menuSection'),
  locationChip:  $id('locationChip'),
  catBar:        $id('catBar'),
  menuGrid:      $id('menuGrid'),
  cartBar:       $id('cartBar'),
  cartCount:     $id('cartCount'),
  cartTotalMini: $id('cartTotalMini'),
  cartModal:     $id('cartModal'),
  cartItems:     $id('cartItems'),
  cartTotal:     $id('cartTotal'),
  submitBtn:     $id('submitOrder'),
  successModal:  $id('successModal'),
  successInvoice:$id('successInvoice'),
  successTotal:  $id('successTotal'),
  saveInvoice:   $id('saveInvoice'),
  shareInvoice:  $id('shareInvoice'),
  blockedDist:   $id('blockedDist'),
  gpsErrorMsg:   $id('gpsErrorMsg'),
  toast:         $id('toast')
};

let db = null;            // عميل Supabase
let cart = new Map();     // { معرّف الصنف: الكمية }
let activeCat = 'all';    // القسم المعروض حالياً
let submitting = false;   // قفل يمنع الإرسال المزدوج
let dayClosed = false;    // هل يوم العمل مغلق؟
let lastOrder = null;     // آخر طلب ناجح { invoice, items, total, at } لصورة الفاتورة
let toastTimer = null;

/* ---------------- أدوات عامة ---------------- */

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

const fmt = (n) => `${Number(n).toFixed(3)} ${CONFIG.CURRENCY}`;

const toRad = (deg) => (deg * Math.PI) / 180;

/** معادلة Haversine — تعيد المسافة بالأمتار بين نقطتين إحداثيتين */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // نصف قطر الأرض بالمتر
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showToast(msg, ms = 3200) {
  UI.toast.textContent = msg;
  show(UI.toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(UI.toast), ms);
}

/** رسالة خاصة عند نقص صلاحيات قاعدة البيانات (خطأ 42501 في Supabase) */
function dbErrorHint(err) {
  const msg = String((err && (err.message || err.error_description)) || '');
  if ((err && err.code === '42501') || /permission denied/i.test(msg)) {
    return '⚠️ صلاحيات قاعدة البيانات ناقصة — الحل: نفّذ ملف sql/fix_permissions.sql في SQL Editor ثم أعد المحاولة (الشرح في README.md)';
  }
  return null;
}

/* ---------------- الإقلاع ---------------- */

document.addEventListener('DOMContentLoaded', () => {

  // التحقق من تحميل مكتبة Supabase من الـ CDN
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    showConfigError('تعذر تحميل مكتبة Supabase — تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.');
    return;
  }

  // التحقق من إدخال المفاتيح
  if (!isConfigured()) { showConfigError(); return; }

  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  loadSavedCart();
  buildCatBar();
  renderMenu();
  bindEvents();
  updateCartUI();

  refreshAccess();          // فحص يوم العمل ثم الموقع
});

function showConfigError(extra) {
  hide(UI.locating);
  UI.configErrorMsg.textContent = extra || '';
  show(UI.configError);
}

/* ---------------- فحص يوم العمل ---------------- */

/**
 * هل فتح الموظف يوم العمل؟ (جدول work_days)
 * عند أي خطأ نتعامل كأن اليوم مفتوح (fail-open)
 * حتى لا تتعطل الصفحة إذا لم يُنفّذ جزء الإعداد بعد.
 */
async function checkDayOpen() {
  try {
    const { data, error } = await db.from('work_days')
      .select('id, status')
      .eq('status', 'open')
      .limit(1);
    dayClosed = !error && Array.isArray(data) && data.length === 0;
  } catch {
    dayClosed = false;
  }
}

/** نقطة الدخول الموحّدة: تُقيّم حالة اليوم ثم الموقع وتعرض المناسب */
async function refreshAccess() {
  await checkDayOpen();

  if (dayClosed) {
    // المطعم مغلق: بلوك كامل يمنع رؤية المنيو
    hide(UI.locating);
    hide(UI.blocked);
    hide(UI.gpsError);
    hide(UI.menuSection);
    show(UI.closedDay);
    UI.locationChip.textContent = '🛑 المطعم مغلق حالياً';
    UI.locationChip.className = 'loc-chip bad';
    updateCartUI();
    return;
  }

  hide(UI.closedDay);
  askLocation();   // يعيد تقييم الموقع ويعرض المناسب (منيو/بلوك/خطأ)
}

/* ---------------- الموقع الجغرافي ---------------- */

const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 };

function askLocation() {
  hide(UI.menuSection);
  hide(UI.blocked);
  hide(UI.gpsError);
  UI.locationChip.textContent = '📍 جارٍ التحقق من موقعك…';
  UI.locationChip.className = 'loc-chip';
  show(UI.locating);
  updateCartUI();

  if (!navigator.geolocation) {
    gpsFailed({ code: 0, message: 'متصفحك لا يدعم تحديد الموقع الجغرافي.' });
    return;
  }

  navigator.geolocation.getCurrentPosition(onLocationReady, gpsFailed, GEO_OPTIONS);
}

/** نجح تحديد الموقع: قارن المسافة بالنطاق المسموح */
function onLocationReady(pos) {
  const c = pos.coords;
  const distance = haversine(
    c.latitude, c.longitude,
    CONFIG.RESTAURANT.lat, CONFIG.RESTAURANT.lon
  );
  hide(UI.locating);

  if (distance <= CONFIG.RESTAURANT.radiusMeters) {
    // ✓ داخل النطاق: افتح المنيو
    show(UI.menuSection);
    UI.locationChip.textContent = '✓ أنت داخل مسار السيارات — تفضل بالطلب';
    UI.locationChip.className = 'loc-chip ok';
  } else {
    // ✗ خارج النطاق: بلوك كامل يمنع رؤية المنيو
    show(UI.blocked);
    UI.locationChip.textContent = '✗ أنت خارج نطاق الطلب';
    UI.locationChip.className = 'loc-chip bad';
    UI.blockedDist.textContent =
      `تبعد الآن حوالي ${Math.round(distance)} متراً عن الشباك ` +
      `(النطاق المسموح: ${CONFIG.RESTAURANT.radiusMeters} متر).`;

    // دقة GPS ضعيفة؟ نبّه المستخدم بدل ما يظن أن النظام خطأ
    if (c.accuracy > 75) {
      UI.blockedDist.textContent +=
        ` ⚠️ دقة الإشارة الحالية منخفضة (±${Math.round(c.accuracy)} م) — أعد المحاولة بعد ثوانٍ.`;
    }
  }
  updateCartUI();
}

function gpsFailed(err) {
  hide(UI.locating);
  hide(UI.menuSection);
  UI.locationChip.textContent = '✗ تعذر التحقق من الموقع';
  UI.locationChip.className = 'loc-chip bad';
  UI.gpsErrorMsg.textContent =
    err.code === 1
      ? 'تم رفض إذن الموقع. اسمح بالوصول إلى الموقع من إعدادات المتصفح ثم أعد المحاولة.'
      : err.code === 3
        ? 'انتهت مهلة تحديد الموقع. تأكد من تشغيل الـ GPS ثم أعد المحاولة.'
        : (err.message || 'حدث خطأ غير متوقع أثناء تحديد الموقع.');
  show(UI.gpsError);
  updateCartUI();
}

/* ---------------- المنيو ---------------- */

/**
 * صورة الصنف: المسار الافتراضي assets/images/<id>.webp
 * ويمكن تخصيصه بإضافة حقل img في تعريف الصنف داخل js/menu.js.
 * عند غياب الملف يعود الكرت تلقائياً لعرض الإيموجي (fallback) دون كسر الواجهة.
 */
function itemImageSrc(item) {
  return item.img || `assets/images/${item.id}.webp`;
}

/** يُدخل صورة الصنف داخل الحاوية مع بديل إيموجي عند فشل تحميل الملف */
function mountItemMedia(container, item, imgCls) {
  const img = new Image();
  img.className = imgCls;
  img.src = itemImageSrc(item);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    container.textContent = item.emoji || '🍽️';
    container.classList.add('is-fallback');
  }, { once: true });
  container.appendChild(img);
}

function buildCatBar() {
  const cats = [{ id: 'all', name: 'الكل'}, ...CATEGORIES];
  UI.catBar.innerHTML = '';
  cats.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (c.id === activeCat ? ' active' : '');
    btn.textContent = `${c.name}`;
    btn.addEventListener('click', () => {
      activeCat = c.id;
      buildCatBar();
      renderMenu();
    });
    UI.catBar.appendChild(btn);
  });
}

function renderMenu() {
  UI.menuGrid.innerHTML = '';
  const items = activeCat === 'all' ? MENU : MENU.filter((m) => m.cat === activeCat);
  items.forEach((item) => UI.menuGrid.appendChild(itemCard(item)));
}

function itemCard(item) {
  const card = document.createElement('article');
  card.className = 'item-card';
  card.dataset.id = item.id;
  card.innerHTML = `
    <div class="item-media"></div>
    <div class="item-info">
      <h3 class="item-name"></h3>
      <p class="item-desc"></p>
      <div class="item-foot">
        <b class="item-price">${fmt(item.price)}</b>
        <div class="stepper">
          <button class="step-btn minus" aria-label="إنقاص الكمية">−</button>
          <span class="qty-num">0</span>
          <button class="step-btn plus" aria-label="زيادة الكمية">+</button>
        </div>
      </div>
    </div>`;
  mountItemMedia(card.querySelector('.item-media'), item, 'item-img');
  card.querySelector('.item-name').textContent = item.name;
  card.querySelector('.item-desc').textContent = item.desc;
  card.querySelector('.plus').addEventListener('click', () => changeQty(item.id, +1));
  card.querySelector('.minus').addEventListener('click', () => changeQty(item.id, -1));
  return card;
}

/* ---------------- السلة ---------------- */

function changeQty(id, delta) {
  const next = (cart.get(id) || 0) + delta;
  if (next <= 0) cart.delete(id); else cart.set(id, next);
  saveCart();
  updateCartUI();
}

function saveCart() {
  localStorage.setItem('drv_cart', JSON.stringify([...cart]));
}

function loadSavedCart() {
  try {
    cart = new Map(JSON.parse(localStorage.getItem('drv_cart') || '[]'));
  } catch {
    cart = new Map();
  }
}

function cartCount() {
  let n = 0;
  cart.forEach((q) => { n += q; });
  return n;
}

function cartTotal() {
  let total = 0;
  cart.forEach((qty, id) => {
    const item = MENU.find((x) => x.id === id);
    if (item) total += item.price * qty;
  });
  return Number(total.toFixed(3));
}

/** مزامنة شريط السلة وعدادات الكميات في كروت المنيو */
function updateCartUI() {
  document.querySelectorAll('.item-card').forEach((card) => {
    const qty = cart.get(card.dataset.id) || 0;
    card.querySelector('.qty-num').textContent = qty;
    card.classList.toggle('in-cart', qty > 0);
  });

  const count = cartCount();
  const menuVisible = !UI.menuSection.classList.contains('hidden');
  UI.cartCount.textContent = count;
  UI.cartTotalMini.textContent = fmt(cartTotal());
  UI.cartBar.classList.toggle('hidden', count === 0 || !menuVisible);
}

function renderCartItems() {
  UI.cartItems.innerHTML = '';

  if (cart.size === 0) {
    UI.cartItems.innerHTML = '<p class="empty-cart">سلتك فارغة — أضف أصنافاً من المنيو 🍔</p>';
  }

  cart.forEach((qty, id) => {
    const item = MENU.find((x) => x.id === id);
    if (!item) return;

    const row = document.createElement('div');
    row.className = 'cart-row';
    row.innerHTML = `
      <span class="cr-media"></span>
      <div class="cr-info">
        <b class="cr-name"></b>
        <span class="cr-price">${fmt(item.price)}</span>
      </div>
      <div class="stepper">
        <button class="step-btn minus" aria-label="إنقاص الكمية">−</button>
        <span class="qty-num">${qty}</span>
        <button class="step-btn plus" aria-label="زيادة الكمية">+</button>
      </div>
      <b class="cr-subtotal">${fmt(item.price * qty)}</b>`;
    mountItemMedia(row.querySelector('.cr-media'), item, 'cr-img');
    row.querySelector('.cr-name').textContent = item.name;
    row.querySelector('.plus').addEventListener('click', () => { changeQty(id, +1); renderCartItems(); });
    row.querySelector('.minus').addEventListener('click', () => { changeQty(id, -1); renderCartItems(); });
    UI.cartItems.appendChild(row);
  });

  UI.cartTotal.textContent = fmt(cartTotal());
  UI.submitBtn.disabled = cart.size === 0;
}

/* ---------------- نافذة السلة ---------------- */

function openCart() {
  renderCartItems();
  show(UI.cartModal);
  document.body.classList.add('no-scroll');
}

function closeCart() {
  hide(UI.cartModal);
  document.body.classList.remove('no-scroll');
}

/* ---------------- إرسال الطلب ---------------- */

async function submitOrder() {
  if (submitting || cart.size === 0) return;
  submitting = true;
  UI.submitBtn.disabled = true;
  UI.submitBtn.textContent = '⏳ جارٍ إرسال الطلب…';

  // تجهيز أصناف الطلب
  const items = [];
  cart.forEach((qty, id) => {
    const item = MENU.find((x) => x.id === id);
    if (item) items.push({ id: item.id, name: item.name, price: item.price, qty });
  });
  const total = Number(items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(3));

  // رقم فاتورة عشوائي مثل: #DRV-1024
  const invoice = `#${CONFIG.ORDER_PREFIX}-${Math.floor(1000 + Math.random() * 9000)}`;

  try {
    const { error } = await db.from('orders').insert({
      invoice_number: invoice,
      items,
      total,
      status: 'pending'
    });
    if (error) throw error;

    // نجاح: اعرض شاشة التأكيد
    cart.clear();
    localStorage.removeItem('drv_cart');
    updateCartUI();
    closeCart();
    UI.successInvoice.textContent = invoice;
    UI.successTotal.textContent = fmt(total);
    lastOrder = { invoice, items, total, at: new Date() };  // لصورة الفاتورة
    show(UI.successModal);
    document.body.classList.add('no-scroll');

  } catch (err) {
    console.error('فشل إرسال الطلب:', err);
    showToast(dbErrorHint(err) || '⚠️ تعذر إرسال الطلب — تحقق من اتصال الإنترنت ثم أعد المحاولة');
  } finally {
    submitting = false;
    UI.submitBtn.disabled = false;
    UI.submitBtn.textContent = '🚗 إرسال إلى الشباك';
  }
}

/* ---------------- صورة الفاتورة (Canvas) ---------------- */

/** مسار مستطيل مستدير الزوايا (بديل متوافق عن ctx.roundRect) */
function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** خط منقط أفقّي — شبيه بفواصل إيصالات الكاشير */
function dashedLine(ctx, x1, x2, y, color, width = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

/** «باركود» زخرفي ثابت مشتق من رقم الفاتورة (لمسة إيصال) */
function drawBarcode(ctx, cx, y, w, h, seedStr, color) {
  let seed = 0;
  for (const ch of String(seedStr)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  ctx.save();
  ctx.fillStyle = color;
  const n = 46, bw = w / n;
  let x = cx - w / 2;
  for (let i = 0; i < n; i++) {
    const bar = bw * (0.25 + rand() * 0.5);
    if (rand() > 0.28) ctx.fillRect(x, y, bar, h);
    x += bw;
  }
  ctx.restore();
}

/** يقصّ النص الطويل مع علامة … لي لا يتجاوز العرض المتاح */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

/**
 * يرسم بطاقة فاتورة بهوية UNO BUN ويعيد عنصر Canvas.
 * كل نص يُرسم كقطعة مستقلة باتجاه واحد (اسم عربي / أرقام / عملة)
 * لتجنّب اختلاف ترتيب المزج بين المتصفحات، والتموضع يدوي RTL.
 */
async function buildInvoiceCanvas(order) {
  // جهّز الخطوط المستعملة قبل الرسم (يُتجاهل بصمت إن تعذّر)
  try {
    await Promise.all([
      document.fonts.load('800 72px "Baloo 2"'),
      document.fonts.load('600 21px Oswald'),
      document.fonts.load('400 22px Cairo'),
      document.fonts.load('600 24px Cairo'),
      document.fonts.load('700 23px Cairo'),
      document.fonts.load('900 28px Cairo')
    ]);
  } catch { /* يُرسم بخط النظام البديل */ }

  const GREEN = '#012621', GREEN2 = '#0a352e', TAN = '#d2b48c',
        TAN_SOFT = '#f4ead7', CREAM = '#faf6ee', INK = '#13221d',
        MUTED = '#5c6b63', PILL = '#ecd9ba';

  const W = 800, pad = 60;
  const cardX = pad, cardW = W - pad * 2, cardPad = 28;
  const rows = Array.isArray(order.items) ? order.items : [];

  const cardTop = 470;
  const cardH = 96 + rows.length * 46 + 106;
  const cardBottom = cardTop + cardH;
  const barY = cardBottom + 48;
  const invY = barY + 54 + 38;
  const noteY = invY + 64;
  const note2Y = noteY + 36;
  const H = note2Y + 88;

  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;      // ×2 لدقة شاشات الجوال العالية
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  ctx.textBaseline = 'alphabetic';

  const center = (text, y, font, color) => {
    ctx.font = font; ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, y);
  };
  const right = (text, x, y, font, color) => {
    ctx.font = font; ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(text, x, y);
  };
  const left = (text, x, y, font, color) => {
    ctx.font = font; ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
  };

  // (1) خلفية الخضرة الرسمية بتدرج شعاعي مثل ترويسة التطبيق
  const bg = ctx.createRadialGradient(W / 2, -80, 60, W / 2, -80, 1000);
  bg.addColorStop(0, GREEN2);
  bg.addColorStop(1, GREEN);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // (2) الترويسة: الشعار النصي + سطر الفرع
  center('UNO BUN', 128, '800 76px "Baloo 2", Cairo, sans-serif', TAN);
  center('B U R G E R S   A N D   F R I E S', 166, '600 21px Oswald, sans-serif', TAN_SOFT);
  dashedLine(ctx, W / 2 - 150, W / 2 + 150, 192, 'rgba(210,180,140,.55)', 2);

  // (3) صندوق رقم الفاتورة (إطار رملي متقطع مثل الشاشة)
  const bx = W / 2 - 220, by = 228, bw2 = 440, bh = 150;
  ctx.save();
  ctx.strokeStyle = TAN; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
  rrPath(ctx, bx, by, bw2, bh, 20);
  ctx.stroke();
  ctx.restore();
  center('رقم فاتورتك', by + 52, '700 24px Cairo, sans-serif', TAN_SOFT);
  center(order.invoice, by + 116, '800 60px "Baloo 2", Cairo, sans-serif', '#ffffff');

  // (4) تاريخ ووقت الطلب
  let when = '';
  try {
    when = new Intl.DateTimeFormat('ar-JO', { dateStyle: 'medium', timeStyle: 'short' }).format(order.at || new Date());
  } catch { when = (order.at || new Date()).toLocaleString(); }
  center(when, 424, '400 22px Cairo, sans-serif', TAN_SOFT);

  // (5) بطاقة الإيصال الكريمية: تفاصيل الأصناف والمجموع
  ctx.fillStyle = CREAM;
  rrPath(ctx, cardX, cardTop, cardW, cardH, 24);
  ctx.fill();
  ctx.strokeStyle = 'rgba(210,180,140,.5)'; ctx.lineWidth = 2;
  rrPath(ctx, cardX, cardTop, cardW, cardH, 24);
  ctx.stroke();

  right('🧾 تفاصيل الطلب', cardX + cardW - cardPad, cardTop + 58, '900 28px Cairo, sans-serif', GREEN);

  const nameRight = cardX + cardW - cardPad - 48;   // مسار اسم الصنف (بعد شارة الكمية)
  rows.forEach((it, i) => {
    const y = cardTop + 104 + i * 46;
    const qty = Number(it.qty) || 1;
    const lineTotal = Number(it.price) * qty;

    // شارة الكمية (رقم فقط داخل دائرة رملية)
    const pillCx = cardX + cardW - cardPad - 20;
    ctx.fillStyle = PILL;
    ctx.beginPath();
    ctx.arc(pillCx, y - 8, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '800 18px Cairo, sans-serif';
    ctx.fillStyle = GREEN; ctx.textAlign = 'center';
    ctx.fillText(String(qty), pillCx, y - 1);

    // اسم الصنف (عربي فقط) بعرض محدود
    ctx.font = '700 23px Cairo, sans-serif';
    right(fitText(ctx, it.name, nameRight - (cardX + 170)), nameRight, y, '700 23px Cairo, sans-serif', INK);

    // السعر (أرقام) + العملة (عربي) في الجهة المقابلة
    const digits = lineTotal.toFixed(3);
    left(digits, cardX + cardPad, y, '700 23px Cairo, sans-serif', INK);
    const dw = ctx.measureText(digits).width;   // ملاحظة: الخط ما زال خط الصنف
    left('د.أ', cardX + cardPad + dw + 10, y, '600 16px Cairo, sans-serif', MUTED);
  });

  dashedLine(ctx, cardX + cardPad, cardX + cardW - cardPad, cardTop + cardH - 92, 'rgba(19,34,29,.25)', 2);
  right('المجموع', cardX + cardW - cardPad, cardTop + cardH - 40, '900 28px Cairo, sans-serif', GREEN);
  const totalDigits = Number(order.total).toFixed(3);
  left(totalDigits, cardX + cardPad, cardTop + cardH - 40, '900 30px Cairo, sans-serif', GREEN);
  left('د.أ', cardX + cardPad + ctx.measureText(totalDigits).width + 10, cardTop + cardH - 40, '700 19px Cairo, sans-serif', GREEN);

  // (6) باركود زخرفي + رقم الفاتورة تحته
  drawBarcode(ctx, W / 2, barY, 300, 54, order.invoice, 'rgba(244,234,215,.92)');
  center(order.invoice, invY, '600 24px Oswald, sans-serif', TAN);

  // (7) ملاحظات الاستلام
  center('💡 أبرز رقم الفاتورة عند الشباك للدفع والاستلام', noteY, '700 23px Cairo, sans-serif', CREAM);
  center('الدفع عند الشباك — نقداً أو بالبطاقة', note2Y, '400 19px Cairo, sans-serif', TAN_SOFT);

  // (8) ختم العلامة أسفل البطاقة
  center('UNO BUN · Burgers and Fries', H - 34, '500 18px Oswald, sans-serif', TAN);

  return c;
}

function invoiceFileName() {
  return 'UNOBUN-' + String((lastOrder && lastOrder.invoice) || '').replace('#', '') + '.png';
}

/** حفظ صورة الفاتورة في تنزيلات الجهاز */
async function saveInvoiceImage() {
  if (!lastOrder) return;
  try {
    const canvas = await buildInvoiceCanvas(lastOrder);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob returned null');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = invoiceFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('✅ تم حفظ صورة الفاتورة في التنزيلات');
  } catch (err) {
    console.error('فشل إنشاء صورة الفاتورة:', err);
    showToast('⚠️ تعذر إنشاء صورة الفاتورة — أعد المحاولة');
  }
}

/** مشاركة صورة الفاتورة عبر واجهة المشاركة في الجوال */
async function shareInvoiceImage() {
  if (!lastOrder) return;
  try {
    const canvas = await buildInvoiceCanvas(lastOrder);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob returned null');
    const file = new File([blob], invoiceFileName(), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'فاتورة طلبك — UNO BUN' });
      return;   // واجهة المشاركة للنظام تُظهر حالتها بنفسها
    }
    await saveInvoiceImage();   // لا دعم للمشاركة (غالباً سطح المكتب) → حفظ
  } catch (err) {
    if (err && err.name === 'AbortError') return;   // أغلق المستخدم نافذة المشاركة
    console.error('فشل مشاركة الفاتورة:', err);
    showToast('⚠️ تعذر مشاركة الصورة — جرّب زر الحفظ');
  }
}

/* ---------------- ربط الأحداث ---------------- */

function bindEvents() {
  $id('openCart').addEventListener('click', openCart);
  $id('closeCart').addEventListener('click', closeCart);
  UI.cartModal.addEventListener('click', (e) => {
    if (e.target === UI.cartModal) closeCart();
  });
  UI.submitBtn.addEventListener('click', submitOrder);
  UI.saveInvoice.addEventListener('click', saveInvoiceImage);
  UI.shareInvoice.addEventListener('click', shareInvoiceImage);

  // زر المشاركة يظهر فقط في المتصفحات التي تدعم مشاركة الملفات (غالباً الجوال)
  try {
    const probe = new File([new Blob(['x'])], 'p.png', { type: 'image/png' });
    if (!(navigator.canShare && navigator.canShare({ files: [probe] }))) hide(UI.shareInvoice);
  } catch { hide(UI.shareInvoice); }

  $id('newOrder').addEventListener('click', () => {
    hide(UI.successModal);
    document.body.classList.remove('no-scroll');
  });
  $id('retryLoc').addEventListener('click', refreshAccess);
  $id('retryLoc2').addEventListener('click', refreshAccess);
  $id('retryDay').addEventListener('click', refreshAccess);
}
