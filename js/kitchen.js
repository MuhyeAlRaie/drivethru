'use strict';

/* =========================================================
   درايف ثرو — شاشة المطبخ (kitchen.html)
   عرض فوري للطلبات الموجهة لعمّال المطبخ:
   - عمودان: قيد الانتظار / قيد التجهيز
   - الأقدم أولاً (FIFO) مع مؤقت منقضٍ لكل طلب
   - نغمة تنبيه عند كل طلب جديد
   ========================================================= */

const $id = (id) => document.getElementById(id);

const UI = {
  clock:     $id('kclock'),
  liveDot:   $id('liveDot'),
  liveText:  $id('liveText'),
  connBanner:$id('connBanner'),
  soundBtn:  $id('soundBtn'),
  refreshBtn:$id('refreshBtn'),
  errorWrap: $id('errorWrap'),
  pendingList:   $id('pendingList'),
  preparingList: $id('preparingList'),
  pendingCount:  $id('pendingCount'),
  preparingCount:$id('preparingCount'),
  pendingEmpty:  $id('pendingEmpty'),
  preparingEmpty:$id('preparingEmpty'),
  toast: $id('toast')
};

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

let db = null;
let orders = [];                 // مرتبة من الأقدم للأحدث (FIFO)
let soundOn = localStorage.getItem('drv_kitchen_sound') !== 'off';

/* ---------------- الإقلاع ---------------- */

document.addEventListener('DOMContentLoaded', async () => {

  KB.setToast(UI.toast);

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    renderError('تعذر تحميل مكتبة Supabase — تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.');
    return;
  }
  if (!isConfigured()) {
    renderError('أدخل مفاتيح Supabase في js/config.js للتشغيل المحلي، أو أضفها في Repository Secrets للنشر (الشرح في README.md).');
    return;
  }

  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  updateSoundBtn();
  bindStatic();

  await loadOrders();
  subscribeRealtime();

  setInterval(tick, 1000);       // ساعة الشاشة + مؤقتات الطلبات
  KB.unlockAudioOnGesture();
});

/* ---------------- جلب الطلبات ---------------- */

async function loadOrders() {
  const { data, error } = await db.from('orders')
    .select('*')
    .in('status', ['pending', 'preparing'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(100);

  if (error) {
    console.error('فشل جلب الطلبات:', error);
    renderError(KB.dbErrorHint(error) || 'تعذر جلب الطلبات: ' + (error.message || 'خطأ غير معروف'));
    setLive(false);
    return;
  }

  orders = data || [];
  UI.errorWrap.innerHTML = '';
  renderAll();
}

function renderError(msg) {
  UI.errorWrap.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'state-box warning';
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
    await loadOrders();
  });
  box.appendChild(btn);
  UI.errorWrap.appendChild(box);
}

/* ---------------- التحديث الفوري (Real-time) ---------------- */

function subscribeRealtime() {
  db.channel('drive-thru-live')
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
  if (order.status === 'completed') return;    // لا يخص المطبخ
  if (orders.some((o) => o.id === order.id)) return;

  orders.push(order);                          // الأقدم أولاً: الجديدة في النهاية
  renderAll();
  flashCard(order.id);
  KB.playBeep();
  KB.flashTitle();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function onUpdate(order) {
  const i = orders.findIndex((o) => o.id === order.id);

  // اكتمل الطلب (سُلّم) -> اخرج من شاشة المطبخ
  if (order.status === 'completed') {
    if (i > -1) { orders.splice(i, 1); renderAll(); }
    return;
  }

  if (i === -1) orders.push(order);
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

/* ---------------- العمليات ---------------- */

async function setStatus(id, status) {
  const i = orders.findIndex((o) => o.id === id);

  if (status === 'completed') {
    if (i > -1) { orders.splice(i, 1); renderAll(); }   // خروج فوري من الشاشة
  } else if (i > -1) {
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

/* ---------------- العرض ---------------- */

function renderAll() {
  const pending = orders.filter((o) => o.status === 'pending');
  const preparing = orders.filter((o) => o.status === 'preparing');

  UI.pendingCount.textContent = pending.length;
  UI.preparingCount.textContent = preparing.length;
  UI.pendingEmpty.classList.toggle('hidden', pending.length > 0);
  UI.preparingEmpty.classList.toggle('hidden', preparing.length > 0);

  UI.pendingList.innerHTML = '';
  UI.preparingList.innerHTML = '';
  pending.forEach((o) => UI.pendingList.appendChild(card(o)));
  preparing.forEach((o) => UI.preparingList.appendChild(card(o)));
}

function card(o) {
  const isPrep = o.status === 'preparing';

  const cardEl = document.createElement('article');
  cardEl.className = 'kds-card' + (isPrep ? ' prep' : '');
  cardEl.dataset.id = o.id;

  const itemsHtml = (Array.isArray(o.items) ? o.items : [])
    .map((it) => `
      <div class="kc-item">
        <span>${Number(it.qty)}× ${KB.esc(it.name)}</span>
        <span class="oi-price">${KB.fmt(Number(it.price) * Number(it.qty))}</span>
      </div>`)
    .join('');

  cardEl.innerHTML = `
    <header class="kc-head">
      <b class="kc-invoice">${KB.esc(o.invoice_number)}</b>
      <span class="kc-elapsed" data-ts="${new Date(o.created_at).getTime()}">00:00</span>
    </header>
    <div class="kc-items">${itemsHtml}</div>
    <div class="kc-total"><span>المجموع</span><span>${KB.fmt(o.total)}</span></div>`;

  const btn = document.createElement('button');
  btn.className = 'btn ' + (isPrep ? 'success' : 'primary');
  btn.textContent = isPrep ? '✓ جاهز للتسليم' : '▶ بدء التجهيز';
  btn.addEventListener('click', () => setStatus(o.id, isPrep ? 'completed' : 'preparing'));
  cardEl.appendChild(btn);

  return cardEl;
}

function flashCard(id) {
  const cardEl = document.querySelector(`.kds-card[data-id="${id}"]`);
  if (!cardEl) return;
  cardEl.classList.add('flash');
  setTimeout(() => cardEl.classList.remove('flash'), 6000);
}

/* ---------------- الساعة ومؤقتات الطلبات ---------------- */

function tick() {
  // ساعة الشاشة الكبيرة
  UI.clock.textContent = new Date().toLocaleTimeString('ar-JO', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // مؤقت كل طلب: دقائق:ثوانٍ منذ لحظة الطلب
  document.querySelectorAll('.kc-elapsed').forEach((el) => {
    const s = Math.max(0, Math.floor((Date.now() - Number(el.dataset.ts)) / 1000));
    el.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    el.classList.toggle('warn', s > 300 && s <= 600);   // تجاوز 5 دقائق
    el.classList.toggle('late', s > 600);               // تجاوز 10 دقائق
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
    await loadOrders();
    UI.refreshBtn.textContent = '🔄';
    KB.showToast('✅ تم التحديث');
  });

  UI.soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('drv_kitchen_sound', soundOn ? 'on' : 'off');
    updateSoundBtn();
    if (soundOn) { KB.ensureAudio(); KB.playBeep(); }
  });
}
