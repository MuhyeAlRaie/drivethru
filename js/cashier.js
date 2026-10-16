'use strict';

/* =========================================================
   درايف ثرو — منطق لوحة الكاشير (cashier.html)
   المخطط: جلب الطلبات -> استماع فوري (Real-time) -> نغمة تنبيه
            -> فتح/إغلاق يوم العمل مع ملخص مبيعات اليوم
   ========================================================= */

const $id = (id) => document.getElementById(id);

const UI = {
  liveDot:   $id('liveDot'),
  liveText:  $id('liveText'),
  connBanner:$id('connBanner'),
  soundBtn:  $id('soundBtn'),
  refreshBtn:$id('refreshBtn'),
  dayChip:   $id('dayChip'),
  dayBtn:    $id('dayBtn'),
  statPending:  $id('statPending'),
  statPreparing:$id('statPreparing'),
  statDone:     $id('statDone'),
  statTotal:    $id('statTotal'),
  statRevenue:  $id('statRevenue'),
  filterBar: $id('filterBar'),
  ordersGrid:$id('ordersGrid'),
  emptyState:$id('emptyState'),
  closeModal:     $id('closeDayModal'),
  sumOpened:      $id('sumOpened'),
  sumOrders:      $id('sumOrders'),
  sumCompleted:   $id('sumCompleted'),
  sumNotCompleted:$id('sumNotCompleted'),
  sumRevenue:     $id('sumRevenue'),
  confirmClose:   $id('confirmClose'),
  cancelClose:    $id('cancelClose'),
  toast:     $id('toast')
};

/* تدفق الحالة: قيد الانتظار -> جاري التجهيز -> مكتمل */
const STATUS_FLOW = { pending: 'preparing', preparing: 'completed' };

const STATUS_META = {
  pending:   { label: 'قيد الانتظار', cls: 'st-pending' },
  preparing: { label: 'جاري التجهيز', cls: 'st-preparing' },
  completed: { label: 'مكتمل',        cls: 'st-completed' }
};

const NEXT_LABEL = { pending: '▶ بدء التجهيز', preparing: '✓ تم التسليم' };

let db = null;
let channel = null;
let orders = [];                 // مرتبة من الأحدث للأقدم
let filter = localStorage.getItem('drv_filter') || 'all';
let soundOn = localStorage.getItem('drv_sound') !== 'off';
let today = null;                // صف يوم العمل المفتوح الحالي (أو null)
let closing = false;             // قفل أثناء اعتماد الإغلاق
const armTimers = new Map();     // مؤقتات زر "الأرشفة" بتأكيد مزدوج

/* ---------------- أدوات محلية ---------------- */

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

/* ---------------- الإقلاع ---------------- */

document.addEventListener('DOMContentLoaded', async () => {

  KB.setToast(UI.toast);

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    renderGridError('تعذر تحميل مكتبة Supabase — تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.');
    return;
  }
  if (!isConfigured()) {
    renderGridError('أدخل مفاتيح Supabase في js/config.js للتشغيل المحلي، أو أضفها في Repository Secrets للنشر (الشرح في README.md).');
    return;
  }

  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  updateSoundBtn();
  bindStatic();

  await Promise.all([loadDay(), loadOrders()]);
  subscribeRealtime();
  setInterval(refreshTimes, 30000);
  KB.unlockAudioOnGesture();
});

/* =========================================================
   يوم العمل: فتح وإغلاق الوردية
   ========================================================= */

/** جلب يوم العمل المفتوح حالياً (إن وجد) */
async function loadDay() {
  try {
    const { data, error } = await db.from('work_days')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1);
    today = (!error && Array.isArray(data) && data[0]) || null;
  } catch {
    today = null; // الجدول غير موجود بعد — نتعامل كأن اليوم مغلق دون عرقلة العرض
  }
  renderDay();
  renderRevenue();
}

function renderDay() {
  if (today) {
    UI.dayChip.textContent = `🟢 اليوم مفتوح منذ ${KB.clockOf(today.opened_at)}`;
    UI.dayChip.className = 'day-chip open';
    UI.dayBtn.textContent = '⏹ إغلاق اليوم';
    UI.dayBtn.className = 'btn small danger-bg';
  } else {
    UI.dayChip.textContent = '🔴 يوم العمل مغلق';
    UI.dayChip.className = 'day-chip closed';
    UI.dayBtn.textContent = '▶ فتح يوم العمل';
    UI.dayBtn.className = 'btn small primary';
  }
}

/** فتح يوم عمل جديد */
async function openDay() {
  if (today) return;
  UI.dayBtn.disabled = true;
  try {
    const { data, error } = await db.from('work_days')
      .insert({ status: 'open' })
      .select()
      .single();
    if (error) throw error;
    today = data;
    KB.showToast('✅ تم فتح يوم عمل جديد — بالتوفيق!');
    renderDay();
    renderRevenue();
  } catch (err) {
    console.error('فشل فتح اليوم:', err);
    KB.showToast('⚠️ تعذر فتح يوم العمل — تحقق من تنفيذ sql/setup.sql');
  } finally {
    UI.dayBtn.disabled = false;
  }
}

/** فتح نافذة الملخص: مجموع جميع فواتير اليوم منذ بدء الوردية */
async function showCloseSummary() {
  if (!today) return;

  UI.sumOpened.textContent = KB.clockOf(today.opened_at);
  UI.sumOrders.textContent = '…';
  UI.sumCompleted.textContent = '…';
  UI.sumNotCompleted.textContent = '…';
  UI.sumRevenue.textContent = '…';
  show(UI.closeModal);

  try {
    const { data, error } = await db.from('orders')
      .select('total, status, created_at')
      .gte('created_at', today.opened_at)
      .limit(1000);

    const rows = (!error && Array.isArray(data)) ? data : [];
    const revenue = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    const completed = rows.filter((r) => r.status === 'completed').length;

    UI.sumOrders.textContent = rows.length;
    UI.sumCompleted.textContent = completed;
    UI.sumNotCompleted.textContent = rows.length - completed;
    UI.sumRevenue.textContent = KB.fmt(revenue);
    UI.closeModal.dataset.revenue = revenue.toFixed(3);
    UI.closeModal.dataset.count = rows.length;
    UI.closeModal.dataset.completed = completed;
  } catch (err) {
    console.error('فشل حساب الملخص:', err);
    KB.showToast('⚠️ تعذر حساب الملخص — تحقق من الاتصال');
    hide(UI.closeModal);
  }
}

/** اعتماد الإغلاق: حفظ الملخص في جدول work_days */
async function confirmCloseDay() {
  if (!today || closing) return;
  closing = true;
  UI.confirmClose.disabled = true;
  UI.confirmClose.textContent = '⏳ جارٍ الإغلاق…';

  try {
    const payload = {
      status: 'closed',
      closed_at: new Date().toISOString(),
      orders_count: Number(UI.closeModal.dataset.count || 0),
      revenue: Number(UI.closeModal.dataset.revenue || 0),
      summary: {
        completed: Number(UI.closeModal.dataset.completed || 0),
        not_completed: Number(UI.closeModal.dataset.count || 0) - Number(UI.closeModal.dataset.completed || 0),
        closed_by: 'cashier'
      }
    };

    const { error } = await db.from('work_days').update(payload).eq('id', today.id);
    if (error) throw error;

    today = null;
    hide(UI.closeModal);
    KB.showToast('✅ تم إغلاق يوم العمل واعتماد المبيعات');
    renderDay();
    renderRevenue();
  } catch (err) {
    console.error('فشل إغلاق اليوم:', err);
    KB.showToast('⚠️ تعذر إغلاق اليوم — حاول مجدداً');
  } finally {
    closing = false;
    UI.confirmClose.disabled = false;
    UI.confirmClose.textContent = '✅ اعتماد وإغلاق اليوم';
  }
}

/* =========================================================
   الطلبات: جلب + تحديث فوري
   ========================================================= */

async function loadOrders() {
  const { data, error } = await db.from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(200);

  if (error) {
    console.error('فشل جلب الطلبات:', error);
    renderGridError('تعذر جلب الطلبات: ' + (error.message || 'خطأ غير معروف'));
    setLive(false);
    return;
  }

  orders = data || [];
  renderAll();
}

function renderGridError(msg) {
  UI.ordersGrid.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'state-box warning';
  box.style.gridColumn = '1 / -1';
  box.innerHTML = `
    <div class="state-emoji">📡</div>
    <h2>تعذر تحميل الطلبات</h2>
    <p class="hint"></p>`;
  box.querySelector('.hint').textContent = msg;

  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = '🔄 إعادة المحاولة';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '⏳ جارٍ التحديث…';
    await Promise.all([loadDay(), loadOrders()]);
  });
  box.appendChild(btn);
  UI.ordersGrid.appendChild(box);
  hide(UI.emptyState);
}

function subscribeRealtime() {
  channel = db.channel('drive-thru-live')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      (payload) => {
        if (payload.eventType === 'INSERT') onInsert(payload.new);
        else if (payload.eventType === 'UPDATE') onUpdate(payload.new);
        else if (payload.eventType === 'DELETE') onDelete(payload.old);
      })
    .subscribe((status) => setLive(status === 'SUBSCRIBED'));
}

function onInsert(order) {
  if (orders.some((o) => o.id === order.id)) return; // تفادي التكرار
  orders.unshift(order);
  renderAll();
  flashCard(order.id);
  KB.playBeep();
  KB.flashTitle();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function onUpdate(order) {
  const i = orders.findIndex((o) => o.id === order.id);
  if (i === -1) orders.unshift(order);
  else orders[i] = order;
  renderAll();
}

function onDelete(oldRow) {
  orders = orders.filter((o) => o.id !== oldRow.id);
  renderAll();
}

function setLive(ok) {
  UI.liveDot.classList.toggle('on', ok);
  UI.liveDot.classList.toggle('off', !ok);
  UI.liveText.textContent = ok ? 'مباشر' : 'غير متصل';
  UI.connBanner.classList.toggle('hidden', ok);
}

/* ---------------- العمليات على الطلب ---------------- */

async function setStatus(id, status) {
  // تحديث متفائل لتظهر الواجهة فوراً، ثم يأكد Real-time التغيير
  const i = orders.findIndex((o) => o.id === id);
  if (i > -1) {
    orders[i] = { ...orders[i], status };
    renderAll();
  }

  const { error } = await db.from('orders').update({ status }).eq('id', id);
  if (error) {
    console.error('فشل تحديث الحالة:', error);
    KB.showToast('⚠️ تعذر تحديث حالة الطلب');
    loadOrders();
  }
}

async function deleteOrder(id) {
  const { error } = await db.from('orders').delete().eq('id', id);
  if (error) {
    console.error('فشل حذف الطلب:', error);
    KB.showToast('⚠️ تعذر أرشفة الطلب');
    return;
  }
  orders = orders.filter((o) => o.id !== id);
  renderAll();
}

/** زر أرشفة بتأكيد مزدوج: ضغطة أولى تسلّح، والثانية خلال 3 ثوانٍ تحذف */
function deleteButton(id) {
  const btn = document.createElement('button');
  btn.className = 'btn small ghost danger-text';
  btn.textContent = '🗑 أرشفة';
  btn.addEventListener('click', async () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'متأكد؟ اضغط للتأكيد';
      btn.classList.add('danger-armed');
      const t = setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = '🗑 أرشفة';
        btn.classList.remove('danger-armed');
      }, 3000);
      armTimers.set(id, t);
      return;
    }
    clearTimeout(armTimers.get(id));
    await deleteOrder(id);
  });
  return btn;
}

/* ---------------- العرض ---------------- */

function renderAll() {
  renderStats();
  renderRevenue();
  renderFilters();
  renderGrid();
}

function renderStats() {
  const todayStr = new Date().toDateString();
  const todays = orders.filter((o) => new Date(o.created_at).toDateString() === todayStr);
  UI.statPending.textContent   = todays.filter((o) => o.status === 'pending').length;
  UI.statPreparing.textContent = todays.filter((o) => o.status === 'preparing').length;
  UI.statDone.textContent      = todays.filter((o) => o.status === 'completed').length;
  UI.statTotal.textContent     = todays.length;
}

/** بطاقة مبيعات اليوم: من بدء الوردية إن كانت مفتوحة، وإلا من بداية اليوم */
function renderRevenue() {
  const since = today
    ? new Date(today.opened_at).getTime()
    : new Date().setHours(0, 0, 0, 0);
  const revenue = orders
    .filter((o) => new Date(o.created_at).getTime() >= since)
    .reduce((s, o) => s + Number(o.total || 0), 0);
  UI.statRevenue.textContent = revenue.toFixed(3);
}

function renderFilters() {
  const counts = { all: orders.length, pending: 0, preparing: 0, completed: 0 };
  orders.forEach((o) => { if (counts[o.status] !== undefined) counts[o.status]++; });

  const defs = [
    ['all', 'الكل'],
    ['pending', 'قيد الانتظار'],
    ['preparing', 'جاري التجهيز'],
    ['completed', 'مكتمل']
  ];

  UI.filterBar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (filter === id ? ' active' : '');
    btn.textContent = `${label} (${counts[id]})`;
    btn.addEventListener('click', () => {
      filter = id;
      localStorage.setItem('drv_filter', id);
      renderAll();
    });
    UI.filterBar.appendChild(btn);
  });
}

function renderGrid() {
  UI.ordersGrid.innerHTML = '';
  const list = filter === 'all' ? orders : orders.filter((o) => o.status === filter);
  UI.emptyState.classList.toggle('hidden', list.length > 0);
  list.forEach((o) => UI.ordersGrid.appendChild(orderCard(o)));
}

function orderCard(o) {
  const meta = STATUS_META[o.status] || STATUS_META.pending;

  const card = document.createElement('article');
  card.className = 'order-card ' + meta.cls;
  card.dataset.id = o.id;

  const itemsHtml = (Array.isArray(o.items) ? o.items : [])
    .map((it) => `
      <div class="oi-row">
        <span class="oi-name">${Number(it.qty)}× ${KB.esc(it.name)}</span>
        <span class="oi-price">${KB.fmt(Number(it.price) * Number(it.qty))}</span>
      </div>`)
    .join('');

  card.innerHTML = `
    <header class="oc-head">
      <b class="oc-invoice">${KB.esc(o.invoice_number)}</b>
      <span class="oc-time">${KB.timeAgo(o.created_at)} · ${KB.clockOf(o.created_at)}</span>
    </header>
    <div class="oc-items">${itemsHtml}</div>
    <div class="oc-total"><span>المجموع</span><b>${KB.fmt(o.total)}</b></div>
    <footer class="oc-foot">
      <span class="badge ${meta.cls}">${meta.label}</span>
      <div class="oc-actions"></div>
    </footer>`;

  // زر الانتقال للحالة التالية
  const actions = card.querySelector('.oc-actions');
  const next = STATUS_FLOW[o.status];
  if (next) {
    const btn = document.createElement('button');
    btn.className = 'btn small ' + (o.status === 'pending' ? 'primary' : 'success');
    btn.textContent = NEXT_LABEL[o.status];
    btn.addEventListener('click', () => setStatus(o.id, next));
    actions.appendChild(btn);
  }
  actions.appendChild(deleteButton(o.id));
  return card;
}

function flashCard(id) {
  const card = UI.ordersGrid.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 6000);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function refreshTimes() {
  document.querySelectorAll('.order-card .oc-time').forEach((el) => {
    const card = el.closest('.order-card');
    const order = orders.find((o) => o.id === Number(card?.dataset.id));
    if (order) el.textContent = `${KB.timeAgo(order.created_at)} · ${KB.clockOf(order.created_at)}`;
  });
}

/* ---------------- ربط الأحداث ---------------- */

function updateSoundBtn() {
  UI.soundBtn.textContent = soundOn ? '🔔' : '🔕';
  UI.soundBtn.title = soundOn ? 'كتم صوت التنبيه' : 'تفعيل صوت التنبيه';
  UI.soundBtn.setAttribute('aria-label', UI.soundBtn.title);
}

function bindStatic() {
  UI.refreshBtn.addEventListener('click', async () => {
    UI.refreshBtn.textContent = '⏳';
    await Promise.all([loadDay(), loadOrders()]);
    UI.refreshBtn.textContent = '🔄';
    KB.showToast('✅ تم التحديث');
  });

  UI.soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('drv_sound', soundOn ? 'on' : 'off');
    updateSoundBtn();
    if (soundOn) { KB.ensureAudio(); KB.playBeep(); }
  });

  UI.dayBtn.addEventListener('click', () => {
    if (today) showCloseSummary();
    else openDay();
  });

  UI.cancelClose.addEventListener('click', () => hide(UI.closeModal));
  UI.confirmClose.addEventListener('click', confirmCloseDay);
}
