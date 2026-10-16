'use strict';

/* =========================================================
   درايف ثرو — أدوات مشتركة بين لوحة الكاشير وشاشة المطبخ
   (التنسيق، حماية HTML، الوقت، التوست، نغمة التنبيه)
   ========================================================= */

const KB = {

  toastEl: null,
  toastTimer: null,
  audioCtx: null,
  titleTimer: null,

  /* ربط عنصر التوست الخاص بالصفحة */
  setToast(el) { KB.toastEl = el; },

  /* تنسيق المبلغ بالدينار (3 خانات عشرية - فلس) */
  fmt(n) { return `${Number(n).toFixed(3)} ${CONFIG.CURRENCY}`; },

  /* حماية من إدخال HTML داخل بيانات الطلبات */
  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  /* الوقت النسبي بالعربية: الآن / منذ 5 دقيقة / منذ ساعتين */
  timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'الآن';
    const m = Math.floor(s / 60);
    if (m < 60) return `منذ ${m} دقيقة`;
    const h = Math.floor(m / 60);
    if (h < 24) return `منذ ${h} ساعة`;
    return new Date(iso).toLocaleDateString('ar-JO', { day: 'numeric', month: 'numeric' });
  },

  /* الساعة والدقائق فقط */
  clockOf(iso) {
    return new Date(iso).toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' });
  },

  /* ---------------- التوست ---------------- */

  showToast(msg, ms = 3000) {
    if (!KB.toastEl) return;
    KB.toastEl.textContent = msg;
    KB.toastEl.classList.remove('hidden');
    clearTimeout(KB.toastTimer);
    KB.toastTimer = setTimeout(() => KB.toastEl.classList.add('hidden'), ms);
  },

  /* ---------------- نغمة التنبيه (Beep) ----------------
     نغمة مزدوجة بسيطة عبر Web Audio — بدون ملفات صوت = تحميل أسرع */

  ensureAudio() {
    if (!KB.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      KB.audioCtx = new AC();
    }
    if (KB.audioCtx.state === 'suspended') KB.audioCtx.resume();
    return KB.audioCtx;
  },

  playBeep() {
    const ctx = KB.ensureAudio();
    if (!ctx || ctx.state !== 'running') return; // سياسة المتصفح: يحتاج أول تفاعل

    const now = ctx.currentTime;
    [[880, 0], [1174.66, 0.22]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.32);
    });
  },

  /* المتصفحات تمنع الصوت قبل أول تفاعل — فك القفل عند أول لمسة */
  unlockAudioOnGesture() {
    const unlock = () => KB.ensureAudio();
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  },

  /* وميض عنوان التبويب عند وصول طلب جديد */
  flashTitle() {
    if (KB.titleTimer) return;
    const base = document.title;
    let on = false;
    KB.titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '🔔 طلب جديد!' : base;
    }, 900);
    setTimeout(() => {
      clearInterval(KB.titleTimer);
      KB.titleTimer = null;
      document.title = base;
    }, 5500);
  }
};
