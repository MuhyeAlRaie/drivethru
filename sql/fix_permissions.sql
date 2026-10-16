-- ============================================================
-- درايف ثرو | إصلاح خطأ 401 / permission denied (كود 42501)
-- ------------------------------------------------------------
-- متى تستخدم هذا الملف؟
--   إذا ظهر في لوحة الكاشير أو المطبخ أو صفحة العميل خطأ مثل:
--     "فشل جلب الطلبات: permission denied for table orders"
--     "فشل فتح اليوم: permission denied for table work_days"
--   أو في Console: 401 مع كود 42501.
--
-- السبب:
--   سياسات RLS وحدها لا تكفي! يجب أيضاً منح دور anon
--   صلاحيات على مستوى الجداول نفسها (GRANT)، وهذا لا يُطبَّق
--   تلقائياً في بعض مشاريع Supabase الجديدة عند إنشاء
--   الجداول من SQL Editor.
--
-- طريقة التنفيذ:
--   1) لوحة Supabase -> SQL Editor -> New query
--   2) الصق محتوى هذا الملف بالكامل واضغط Run
--   3) يجب أن تظهر في النهاية جدولة قيمها كلها true
--   4) أعد تحميل صفحات التطبيق (Ctrl+Shift+R)
--
-- آمن تماماً: يمكن تنفيذه عدة مرات، ولا يحذف أو يعدّل أي بيانات.
-- ============================================================

-- 1) صلاحية استخدام المخطط public (أساس الوصول لأي جدول)
grant usage on schema public to anon, authenticated;

-- 2) منح دور anon (الدور الذي يستخدمه التطبيق) الصلاحيات الكاملة
--    على جدولَي الطلبات وأيام العمل
grant select, insert, update, delete
  on public.orders, public.work_days
  to anon, authenticated;

-- 3) صلاحيات التسلسلات (تُستخدم عند توليد رقم id تلقائياً)
grant usage, select on all sequences in schema public
  to anon, authenticated;

-- 4) ضبط الصلاحيات الافتراضية لأي جداول تُنشأ مستقبلاً
--    (غير حرج إذا فشل — الخطوة 2 هي الأساس)
do $$
begin
  alter default privileges in schema public
    grant select, insert, update, delete on tables to anon, authenticated;
  alter default privileges in schema public
    grant usage, select on sequences to anon, authenticated;
exception when others then
  raise notice 'default privileges skipped (not critical): %', sqlerrm;
end $$;

-- 5) التأكد من تفعيل RLS مع سياسات مفتوحة (نفس سياسات setup.sql)
--    RLS يحدّد "أي صفوف تُرى" — وGRANT أعلاه يمنح "حق الوصول للجدول"
alter table public.orders enable row level security;
alter table public.work_days enable row level security;

drop policy if exists "orders_select" on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_update" on public.orders;
drop policy if exists "orders_delete" on public.orders;

create policy "orders_select" on public.orders
  for select to anon, authenticated using (true);

create policy "orders_insert" on public.orders
  for insert to anon, authenticated with check (true);

create policy "orders_update" on public.orders
  for update to anon, authenticated using (true) with check (true);

create policy "orders_delete" on public.orders
  for delete to anon, authenticated using (true);

drop policy if exists "work_days_select" on public.work_days;
drop policy if exists "work_days_insert" on public.work_days;
drop policy if exists "work_days_update" on public.work_days;
drop policy if exists "work_days_delete" on public.work_days;

create policy "work_days_select" on public.work_days
  for select to anon, authenticated using (true);

create policy "work_days_insert" on public.work_days
  for insert to anon, authenticated with check (true);

create policy "work_days_update" on public.work_days
  for update to anon, authenticated using (true) with check (true);

create policy "work_days_delete" on public.work_days
  for delete to anon, authenticated using (true);

-- 6) التأكد من بقاء Real-time مفعّلاً على جدول الطلبات
alter table public.orders replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

-- ============================================================
-- 7) الفحص النهائي — النتيجة يجب أن تكون كلها true
--    إذا ظهرت كل القيم true فقد نجح الإصلاح
-- ============================================================
select
  t.table_name,
  has_table_privilege('anon', 'public.' || t.table_name, 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.' || t.table_name, 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.' || t.table_name, 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.' || t.table_name, 'DELETE') as anon_delete
from information_schema.tables t
where t.table_schema = 'public'
  and t.table_name in ('orders', 'work_days')
order by t.table_name;
