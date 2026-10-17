/* =========================================================
   درايف ثرو — قالب ملف الإعدادات (config.template.js)
   -----------------------------------------------------------
   هذا القالب هو مصدر الحقيقة عند النشر:
   - GitHub Actions (deploy.yml) يستبدل __SUPABASE_URL__ و
     __SUPABASE_ANON_KEY__ من Repository Secrets وقت البناء،
     فلا تُكتب المفاتيح في المستودع إطلاقاً.

   للتشغيل المحلي:
     cp js/config.template.js js/config.js
   ثم الصق مفاتيحك في js/config.js (المستثنى في .gitignore).
   ========================================================= */

const CONFIG = {

  // (1) بيانات مشروعك في Supabase
  //     من لوحة التحكم: Settings -> API
  //     أ) للنشر: ضعها في Repository Secrets باسمي
  //        SUPABASE_URL و SUPABASE_ANON_KEY
  //     ب) للتشغيل المحلي: الصقها هنا في js/config.js
  SUPABASE_URL: '__SUPABASE_URL__',
  SUPABASE_ANON_KEY: '__SUPABASE_ANON_KEY__',

  // (2) بيانات المطعم
  RESTAURANT: {
    name: 'درايف ثرو',
    lat: 32.09695381830468,          // إحداثيات الشباك (الزرقاء - البتراوي)
    lon:  36.10151867710208,
    radiusMeters: 999999       // نطاق السماح بالطلب (متر)
  },

  // (3) العملة وبادئة رقم الفاتورة
  CURRENCY: 'د.أ',
  ORDER_PREFIX: 'DRV'
};

/* التحقق من أن المفاتيح أُدخلت (محلياً أو عبر Secrets) قبل التشغيل
   ملاحظة: الفحص لا يعتمد على نص العنصر النائب حتى لا يتأثر
   بأمر الاستبدال في deploy.yml — بل بسلامة شكل القيمة نفسها */
function isConfigured() {
  return (
    typeof CONFIG !== 'undefined' &&
    typeof CONFIG.SUPABASE_URL === 'string' &&
    CONFIG.SUPABASE_URL.startsWith('https://') &&
    typeof CONFIG.SUPABASE_ANON_KEY === 'string' &&
    CONFIG.SUPABASE_ANON_KEY.length > 30
  );
}
