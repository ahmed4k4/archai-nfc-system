import { auth, db, PUBLIC_APP_URL } from './firebase.js';
import { login, logout, createBrandAccount } from './auth.js';
import { list, one, add, patch, remove, where, serverTimestamp, batch } from './data.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  getDoc,
  Timestamp,
  doc as firestoreDoc,
  collection,
  query as firestoreQuery,
  getDocs,
  where as firestoreWhere,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const $ = (selector) => document.querySelector(selector);
const DEFAULT_FIELDS = [
  { key: 'name', label: 'الاسم', type: 'text', required: true, system: true },
  { key: 'phone', label: 'رقم الهاتف', type: 'tel', required: true, system: true },
  { key: 'purchase', label: 'ما المنتج الذي اشتريته؟', type: 'text', required: false },
];

let me = null;
let profile = null;
let brands = [];
let branches = [];
let customers = [];
let customerLoadError = null;
let branchCustomerCounts = new Map();
let editingFields = false;
let selectedFieldsBrand = '';
let qrLibraryPromise = null;
let xlsxLibraryPromise = null;
let brandImageOptions = [];
let customerPage = 1;
const CUSTOMER_PAGE_SIZE = 12;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);

const safeBrandImagePath = (value) => {
  const path = String(value || '').trim();
  return /^assets\/brands\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png|jpe?g|webp)$/i.test(path) ? path : '';
};

async function loadBrandImageCatalog() {
  try {
    const response = await fetch(new URL('../assets/brands/manifest.json', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    brandImageOptions = (Array.isArray(manifest.images) ? manifest.images : [])
      .filter((item) => item && typeof item.name === 'string' && item.name.trim() && safeBrandImagePath(item.src))
      .map((item) => ({ name: item.name.trim().slice(0, 80), src: safeBrandImagePath(item.src) }));
  } catch (error) {
    brandImageOptions = [];
    console.warn('Brand image catalog could not be loaded:', error);
  }
}

function brandImageMarkup(brand, className = 'brand-mark') {
  const src = safeBrandImagePath(brand?.image);
  const fallback = esc(String(brand?.name || 'A').trim().charAt(0) || 'A');
  return `<div class="${className}">${src ? `<img src="${esc(src)}" alt="${esc(brand?.name || 'صورة البراند')}" loading="lazy">` : fallback}</div>`;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3600);
}

function isSuper() {
  return profile?.role === 'super_admin';
}

function brandScope() {
  return isSuper() ? null : profile?.brandId;
}

function setButtonBusy(button, busy, busyLabel = 'جارٍ التنفيذ...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function modal(title, body, submitLabel, handler) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-backdrop>
      <form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        ${body}
        <div class="modal-actions">
          <button type="button" class="btn subtle" data-close>إلغاء</button>
          <button class="btn primary" type="submit">${esc(submitLabel)}</button>
        </div>
      </form>
    </div>`;

  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('[data-backdrop]').onclick = (event) => {
    if (event.target.matches('[data-backdrop]')) close();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    if (!form.reportValidity()) return;
    setButtonBusy(submit, true, 'جارٍ الحفظ...');
    try {
      await handler(new FormData(form));
    } catch (error) {
      toast(error?.message || 'حدث خطأ أثناء الحفظ');
      setButtonBusy(submit, false);
      return;
    }
    close();
    toast('تم الحفظ بنجاح');
    try {
      await loadAll();
    } catch (error) {
      toast('تم الحفظ، لكن تعذر تحديث العرض. استخدم زر التحديث.');
    }
  };
  form.querySelector('input,select,textarea')?.focus();
}

function go(page) {
  document.querySelectorAll('.page').forEach((element) => element.classList.add('hidden'));
  $(`#page-${page}`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach((element) => {
    element.classList.toggle('active', element.dataset.page === page);
    if (element.dataset.page === page) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  });
  const titles = {
    overview: 'نظرة عامة',
    brands: 'البراندات',
    branches: 'الفروع وروابط التسجيل',
    customers: 'العملاء',
    fields: 'حقول التسجيل',
  };
  $('#pageTitle').textContent = titles[page] || 'لوحة التحكم';
  $('#crumb').textContent = page.toUpperCase();
  document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadAll() {
  if (!profile) return { customerError: null };

  const brandPromise = isSuper()
    ? list('brands')
    : one('brands', profile.brandId).then((brand) => brand ? [brand] : []);
  const branchPromise = list('branches', isSuper() ? [] : [where('brandId', '==', profile.brandId)]);
  const [nextBrands, nextBranches] = await Promise.all([brandPromise, branchPromise]);
  brands = nextBrands;
  branches = nextBranches;

  try {
    // Keep the customer query to a single equality filter. Combining brandId
    // with createdAt ordering requires a composite index that must be deployed
    // manually. We fetch the authorized scope and sort locally instead.
    const customerQuery = isSuper()
      ? firestoreQuery(collection(db, 'customers'))
      : firestoreQuery(collection(db, 'customers'), firestoreWhere('brandId', '==', profile.brandId));
    const snapshot = await getDocs(customerQuery);
    customers = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
    customers.sort((a, b) => customerDateMillis(b.createdAt) - customerDateMillis(a.createdAt));
    customerLoadError = null;
    branchCustomerCounts = new Map();
    for (const customer of customers) {
      if (!customer.branchId) continue;
      branchCustomerCounts.set(customer.branchId, (branchCustomerCounts.get(customer.branchId) || 0) + 1);
    }
  } catch (error) {
    customers = [];
    branchCustomerCounts = new Map();
    customerLoadError = error;
  }

  renderAll();
  return { customerError: customerLoadError };
}

function customerDateMillis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

function branchCustomerCount(branchId) {
  return customerLoadError ? null : (branchCustomerCounts.get(branchId) || 0);
}

function renderAll() {
  const ownBrand = brands.find((brand) => brand.id === profile?.brandId);
  const exportButton = $('#exportBtn');
  const exportHint = $('#page-customers .section-head p');
  if (exportButton) exportButton.textContent = isSuper() ? '⇩ تقرير Archai الشامل' : `⇩ تقرير ${ownBrand?.name || 'البراند'}`;
  if (exportHint) exportHint.textContent = isSuper()
    ? 'تقرير Archai الإداري الكامل: جميع البراندات والفروع والعملاء.'
    : `تقرير خاص ببراند ${ownBrand?.name || 'البراند'} فقط، دون بيانات أي براند آخر.`;
  const sideLogo = $('.side-brand img');
  if (sideLogo) {
    sideLogo.src = safeBrandImagePath(ownBrand?.image) || 'assets/logo.webp';
    sideLogo.alt = ownBrand?.name ? `شعار ${ownBrand.name}` : 'شعار Archai';
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  $('#statBrands').textContent = brands.length;
  $('#statBranches').textContent = branches.filter((branch) => branch.active !== false).length;
  $('#statCustomers').textContent = customerLoadError ? '—' : customers.length.toLocaleString('ar-EG');
  $('#statToday').textContent = customerLoadError ? '—' : customers.filter((customer) => customerDateMillis(customer.createdAt) >= today.getTime()).length.toLocaleString('ar-EG');
  $('#recentCustomers').innerHTML = customerLoadError
    ? customerErrorPanel()
    : customerCards(customers.slice(0, 6), { compact: true });
  renderBrands();
  fillSelectors();
  renderBranches();
  renderCustomers();
}

function fieldLabel(brandId, key) {
  const brand = brands.find((item) => item.id === brandId);
  return (brand?.fields || DEFAULT_FIELDS).find((field) => field.key === key)?.label || key;
}

function customerCards(rows, { compact = false } = {}) {
  if (!rows.length) return '<div class="empty">لا توجد بيانات لعرضها حتى الآن.</div>';
  return `<div class="customer-cards ${compact ? 'compact' : ''}">${rows.map((customer) => {
    const extraEntries = Object.entries(customer.customFields || {}).filter(([, value]) => value !== '' && value != null);
    const extra = extraEntries.map(([key, value]) => `<span class="customer-chip"><b>${esc(fieldLabel(customer.brandId, key))}</b><span>${esc(value)}</span></span>`).join('');
    const date = customerDateMillis(customer.createdAt) ? new Date(customerDateMillis(customer.createdAt)).toLocaleString('ar-EG') : '—';
    return `<article class="customer-card" data-customer-id="${esc(customer.id)}" tabindex="0" role="group" aria-label="اضغط لعرض تفاصيل ${esc(customer.name || 'العميل')}">
      <div class="customer-card-top"><div class="customer-avatar">${esc(String(customer.name || 'ع').trim().charAt(0) || 'ع')}</div><div class="customer-primary"><b>${esc(customer.name || 'بدون اسم')}</b><a href="tel:${esc(customer.phone || '')}" dir="ltr">${esc(customer.phone || '—')}</a></div><time>${esc(date)}</time></div>
      <div class="customer-card-meta"><span><small>البراند</small><b>${esc(customer.brandName || '—')}</b></span><span><small>الفرع</small><b>${esc(customer.branchName || '—')}</b></span><span><small>المنتج</small><b>${esc(customer.purchase || customer.product || '—')}</b></span><span><small>المصدر</small><b class="source-pill ${customer.source === 'nfc' ? 'nfc' : 'qr'}">${customer.source === 'nfc' ? 'NFC' : 'QR'}</b></span></div>
      ${extra ? `<div class="customer-extras">${extra}</div>` : ''}
      <div class="customer-card-footer"><span>اضغط لعرض التفاصيل</span><button type="button" class="action-btn" data-customer-details="${esc(customer.id)}">التفاصيل</button></div>
    </article>`;
  }).join('')}</div>`;
}

function customerDetailsModal(customer) {
  const root = $('#modalRoot');
  const brand = brands.find((item) => item.id === customer.brandId);
  const date = customerDateMillis(customer.createdAt)
    ? new Date(customerDateMillis(customer.createdAt)).toLocaleString('ar-EG') : '—';
  const fields = Object.entries(customer.customFields || {}).filter(([, value]) => value !== '' && value != null);
  const details = [
    ['الاسم', customer.name], ['رقم الهاتف', customer.phone],
    ['البراند', customer.brandName], ['الفرع', customer.branchName],
    ['المنتج', customer.purchase || customer.product], ['مصدر التسجيل', customer.source === 'nfc' ? 'NFC' : 'QR'],
    ['تاريخ التسجيل', date], ['موافقة العميل', customer.consent === true ? 'وافق على استخدام البيانات' : 'غير مسجلة'],
    ['وقت الموافقة', customerDateMillis(customer.consentAt) ? new Date(customerDateMillis(customer.consentAt)).toLocaleString('ar-EG') : '—'],
    ['إصدار الموافقة', customer.consentVersion || '—'],
    ...fields.map(([key, value]) => [fieldLabel(customer.brandId, key), value]),
  ];
  root.innerHTML = `<div class="modal-backdrop" data-backdrop><section class="modal customer-detail-modal" role="dialog" aria-modal="true" aria-label="تفاصيل العميل">
    <div class="modal-heading"><div><span class="eyebrow">CUSTOMER PROFILE</span><h3>${esc(customer.name || 'بيانات العميل')}</h3><p>${esc(customer.brandName || '—')} · ${esc(customer.branchName || '—')}</p></div><span class="source-pill ${customer.source === 'nfc' ? 'nfc' : 'qr'}">${customer.source === 'nfc' ? 'NFC' : 'QR'}</span></div>
    ${brand?.image && safeBrandImagePath(brand.image) ? `<img class="customer-brand-image" src="${esc(brand.image)}" alt="${esc(brand.name)}">` : ''}
    <div class="customer-detail-grid">${details.map(([label, value]) => `<div class="customer-detail-item"><small>${esc(label)}</small><b>${esc(value == null || value === '' ? '—' : value)}</b></div>`).join('')}</div>
    <div class="modal-actions customer-detail-actions"><button type="button" class="btn subtle" data-close>إغلاق</button><button type="button" class="btn danger" data-delete-customer="${esc(customer.id)}">حذف العميل</button></div>
  </section></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('[data-backdrop]').onclick = (event) => { if (event.target.matches('[data-backdrop]')) close(); };
}

async function deleteCustomer(customerId) {
  const customer = customers.find((item) => item.id === customerId);
  if (!customer) throw new Error('العميل غير موجود أو تم حذفه بالفعل.');
  if (!isSuper() && profile?.brandId !== customer.brandId) throw new Error('لا يمكنك حذف عميل تابع لبراند آخر.');
  const accepted = window.confirm(`هل أنت متأكد من حذف سجل العميل "${customer.name || 'بدون اسم'}"؟ لا يمكن التراجع عن هذا الإجراء.`);
  if (!accepted) return false;
  await remove('customers', customer.id);
  customers = customers.filter((item) => item.id !== customer.id);
  if (customer.branchId && branchCustomerCounts.has(customer.branchId)) {
    const nextCount = Math.max(0, branchCustomerCounts.get(customer.branchId) - 1);
    if (nextCount) branchCustomerCounts.set(customer.branchId, nextCount);
    else branchCustomerCounts.delete(customer.branchId);
  }
  customerPage = 1;
  $('#modalRoot').innerHTML = '';
  renderAll();
  toast('تم حذف سجل العميل بنجاح.');
  return true;
}

// Firestore write batches are limited to 500 operations. Keep cascade chunks
// smaller to leave room for security-rule document lookups and safe retries.
async function deleteDocumentsInChunks(collectionName, documents, chunkSize = 200) {
  for (let offset = 0; offset < documents.length; offset += chunkSize) {
    const write = batch();
    for (const item of documents.slice(offset, offset + chunkSize)) {
      const id = typeof item === 'string' ? item : item.id;
      write.delete(firestoreDoc(db, collectionName, id));
    }
    await write.commit();
  }
}

async function updateDocumentsInChunks(collectionName, documents, data, chunkSize = 200) {
  for (let offset = 0; offset < documents.length; offset += chunkSize) {
    const write = batch();
    for (const item of documents.slice(offset, offset + chunkSize)) {
      write.update(firestoreDoc(db, collectionName, item.id), data);
    }
    await write.commit();
  }
}

function branchTokenIds(branchList) {
  return [...new Set(branchList.flatMap((branch) => [branch.qrToken, branch.nfcToken].filter(Boolean)))];
}

async function getExistingTokenIds(tokenIds) {
  const existing = [];
  for (let offset = 0; offset < tokenIds.length; offset += 80) {
    const snapshots = await Promise.all(tokenIds.slice(offset, offset + 80).map((token) => getDoc(firestoreDoc(db, 'branchTokens', token))));
    existing.push(...snapshots.filter((snapshot) => snapshot.exists()).map((snapshot) => snapshot.id));
  }
  return existing;
}

async function deactivateTokenDocuments(tokenIds) {
  const existing = await getExistingTokenIds(tokenIds);
  await updateDocumentsInChunks('branchTokens', existing.map((id) => ({ id })), { active: false });
  return existing;
}

async function deleteBranch(branchId) {
  const branch = branches.find((item) => item.id === branchId);
  if (!branch) throw new Error('الفرع غير موجود أو تم حذفه بالفعل.');
  if (!isSuper() && profile?.brandId !== branch.brandId) throw new Error('لا يمكنك حذف فرع تابع لبراند آخر.');

  // Keep a single-field query (no composite index needed). For brand admins,
  // read only their own brand's permitted documents and narrow to this branch.
  const customerConstraint = isSuper()
    ? firestoreWhere('branchId', '==', branch.id)
    : firestoreWhere('brandId', '==', branch.brandId);
  const customerSnapshot = await getDocs(firestoreQuery(collection(db, 'customers'), customerConstraint));
  const customerDocs = customerSnapshot.docs.filter((document) => document.data().branchId === branch.id);
  const tokenIds = branchTokenIds([branch]);
  const accepted = window.confirm(
    `تأكيد حذف الفرع "${branch.name}" نهائيًا؟\n` +
    `سيتم حذف ${customerDocs.length.toLocaleString('ar-EG')} سجل عميل ورموز QR/NFC التابعة له.\n` +
    'روابط هذا الفرع المطبوعة ستتوقف نهائيًا، ولا يمكن التراجع.'
  );
  if (!accepted) return false;

  // Disable first so the public scan URL stops accepting registrations even
  // when a later cleanup step fails and the operation must be retried.
  await patch('branches', branch.id, { active: false, updatedAt: serverTimestamp() });
  const existingTokenIds = await deactivateTokenDocuments(tokenIds);
  await deleteDocumentsInChunks('customers', customerDocs);
  await deleteDocumentsInChunks('branchTokens', existingTokenIds);
  await remove('branches', branch.id);
  $('#modalRoot').innerHTML = '';
  await loadAll();
  toast('تم حذف الفرع وسجلات عملائه وروابط QR/NFC التابعة له.');
  return true;
}

async function deleteBrand(brandId) {
  if (!isSuper()) throw new Error('حذف البراندات مخصص لمدير النظام.');
  const brand = brands.find((item) => item.id === brandId);
  if (!brand) throw new Error('البراند غير موجود أو تم حذفه بالفعل.');

  const [branchSnapshot, customerSnapshot, userSnapshot] = await Promise.all([
    getDocs(firestoreQuery(collection(db, 'branches'), firestoreWhere('brandId', '==', brand.id))),
    getDocs(firestoreQuery(collection(db, 'customers'), firestoreWhere('brandId', '==', brand.id))),
    getDocs(firestoreQuery(collection(db, 'users'), firestoreWhere('brandId', '==', brand.id))),
  ]);
  const branchDocs = branchSnapshot.docs;
  const customerDocs = customerSnapshot.docs;
  const userDocs = userSnapshot.docs;
  const tokenIds = branchTokenIds(branchDocs.map((document) => ({ id: document.id, ...document.data() })));
  const accepted = window.confirm(
    `تحذير: حذف البراند "${brand.name}" نهائيًا.\n` +
    `سيتم حذف ${branchDocs.length.toLocaleString('ar-EG')} فرع، و${customerDocs.length.toLocaleString('ar-EG')} عميل، ` +
    `وكل روابط QR/NFC التابعة له.\n` +
    `سيتم تعطيل ${userDocs.length.toLocaleString('ar-EG')} حساب مدير مرتبط بالبراند داخل النظام.\n` +
    'هذا الإجراء لا يمكن التراجع عنه.'
  );
  if (!accepted) return false;

  // Keep the brand document until the end. If a chunk fails, the inactive
  // brand remains visible to the super admin and deletion can be retried.
  await patch('brands', brand.id, { active: false, updatedAt: serverTimestamp(), deletionStartedAt: serverTimestamp() });
  await updateDocumentsInChunks('branches', branchDocs, { active: false, updatedAt: serverTimestamp() });
  const existingTokenIds = await deactivateTokenDocuments(tokenIds);
  await deleteDocumentsInChunks('customers', customerDocs);
  await deleteDocumentsInChunks('branchTokens', existingTokenIds);
  await deleteDocumentsInChunks('branches', branchDocs);

  // Client SDKs cannot delete other users from Firebase Authentication.
  // Mark their profile inactive so they are immediately denied application access.
  await updateDocumentsInChunks('users', userDocs, {
    active: false,
    disabledReason: 'brand_deleted',
    disabledAt: serverTimestamp(),
  });
  await remove('brands', brand.id);
  $('#modalRoot').innerHTML = '';
  await loadAll();
  toast('تم حذف البراند وبياناته وتعطيل حساب مديره داخل النظام. احذف مستخدم Authentication يدويًا من Firebase Console عند الحاجة.');
  return true;
}

function renderBrands() {
  $('#brandsList').innerHTML = tableBrands();
  $('#addBrandBtn').classList.toggle('hidden', !isSuper());
}

function tableBrands() {
  if (!brands.length) return '<div class="empty">لا توجد براندات بعد. ابدأ بإضافة أول براند.</div>';
  return `<div class="brands-grid">${brands.map((brand) => {
    const branchCount = branches.filter((branch) => branch.brandId === brand.id).length;
    const customerCount = customerLoadError ? null : customers.filter((customer) => customer.brandId === brand.id).length;
    const fieldsCount = currentBrandFields(brand).length;
    return `<article class="brand-card">
      <div class="brand-card-top">${brandImageMarkup(brand)}<div class="brand-title"><h4>${esc(brand.name)}</h4><p dir="ltr">${esc(brand.email || '—')}</p></div><span class="badge ${brand.active === false ? 'off' : ''}">${brand.active === false ? 'متوقف' : 'نشط'}</span></div>
      <div class="brand-metrics"><span><b>${branchCount.toLocaleString('ar-EG')}</b><small>فرع</small></span><span><b>${customerCount == null ? '—' : customerCount.toLocaleString('ar-EG')}</b><small>عميل</small></span><span><b>${fieldsCount}</b><small>حقل تسجيل</small></span></div>
      <div class="brand-card-actions"><button class="action-btn" data-brand-image="${esc(brand.id)}">تغيير الصورة</button><button class="action-btn" data-brand-details="${esc(brand.id)}">التفاصيل</button><button class="action-btn" data-brand-fields="${esc(brand.id)}">إدارة الحقول</button><button class="action-btn" data-toggle-brand="${esc(brand.id)}">${brand.active === false ? 'تفعيل' : 'إيقاف'}</button><button class="action-btn destructive-action" data-delete-brand="${esc(brand.id)}">حذف البراند</button></div>
    </article>`;
  }).join('')}</div>`;
}

function showBrandImagePicker(brand) {
  if (!isSuper()) return toast('اختيار صورة البراند مخصص لمدير النظام.');
  const currentImage = safeBrandImagePath(brand.image);
  const currentImageOption = currentImage && !brandImageOptions.some((item) => item.src === currentImage)
    ? `<option value="${esc(currentImage)}" selected>الصورة الحالية (غير موجودة في القائمة)</option>` : '';
  const options = currentImageOption + brandImageOptions.map((item) => `<option value="${esc(item.src)}" ${brand.image === item.src ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
  modal(`صورة البراند: ${brand.name}`, `
    <label>اختر الصورة من مجلد assets/brands
      <select name="image">
        <option value="">بدون صورة</option>
        ${options}
      </select>
    </label>
    <div class="brand-image-picker-preview"><img data-image-preview src="${esc(safeBrandImagePath(brand.image) || 'assets/logo.webp')}" alt="معاينة صورة البراند"><span>معاينة الصورة المختارة</span></div>
    ${brandImageOptions.length ? '' : '<p class="form-hint">لا توجد صور في القائمة بعد. أضف الصور إلى assets/brands ثم سجّلها في assets/brands/manifest.json.</p>'}
    <p class="form-hint">سيتم تحديث صورة البراند في لوحة الإدارة ونموذج QR/NFC لكل فروعه دون تغيير روابط التسجيل.</p>
  `, 'حفظ الصورة', async (formData) => {
    const selected = String(formData.get('image') || '');
    if (selected && !brandImageOptions.some((item) => item.src === selected)) {
      throw new Error('الصورة المختارة غير موجودة في قائمة الصور المعتمدة. حدّث الصفحة وحاول مرة أخرى.');
    }
    const image = safeBrandImagePath(selected);
    const tokens = branches.filter((branch) => branch.brandId === brand.id)
      .flatMap((branch) => [branch.qrToken, branch.nfcToken].filter(Boolean));
    const previousImage = safeBrandImagePath(brand.image);
    const updatedTokens = [];
    // Update token documents first so public scan pages receive the same image.
    // Roll back completed batches if any later write fails.
    try {
      for (let offset = 0; offset < tokens.length; offset += 450) {
        const tokenChunk = tokens.slice(offset, offset + 450);
        const write = batch();
        for (const token of tokenChunk) {
          write.update(firestoreDoc(db, 'branchTokens', token), { brandImage: image });
        }
        await write.commit();
        updatedTokens.push(...tokenChunk);
      }
      await patch('brands', brand.id, { image, updatedAt: serverTimestamp() });
      brand.image = image;
    } catch (error) {
      try {
        for (let offset = 0; offset < updatedTokens.length; offset += 450) {
          const rollback = batch();
          for (const token of updatedTokens.slice(offset, offset + 450)) {
            rollback.update(firestoreDoc(db, 'branchTokens', token), { brandImage: previousImage });
          }
          await rollback.commit();
        }
      } catch (rollbackError) {
        console.error('Brand image rollback failed:', rollbackError);
        throw new Error('تعذر إكمال تحديث الصورة، وفشل التراجع عن بعض رموز QR/NFC. أعد اختيار الصورة نفسها من صفحة البراند لمزامنتها.');
      }
      throw error;
    }
  });
  const select = $('#modalRoot select[name="image"]');
  const preview = $('#modalRoot [data-image-preview]');
  select?.addEventListener('change', () => {
    if (preview) preview.src = safeBrandImagePath(select.value) || 'assets/logo.webp';
  });
}

function showBrandDetails(brand) {
  const root = $('#modalRoot');
  const branchList = branches.filter((branch) => branch.brandId === brand.id);
  const customerCount = customerLoadError ? 'غير متاح' : customers.filter((customer) => customer.brandId === brand.id).length.toLocaleString('ar-EG');
  const fields = currentBrandFields(brand);
  const createdAt = brand.createdAt?.toDate ? brand.createdAt.toDate().toLocaleString('ar-EG') : '—';
  root.innerHTML = `<div class="modal-backdrop" data-backdrop><section class="modal brand-detail-modal" role="dialog" aria-modal="true" aria-label="تفاصيل البراند">
    <div class="modal-heading"><div>${brand.image && safeBrandImagePath(brand.image) ? `<img class="brand-detail-image" src="${esc(brand.image)}" alt="${esc(brand.name)}">` : ''}<span class="eyebrow">BRAND PROFILE</span><h3>${esc(brand.name)}</h3><p dir="ltr">${esc(brand.email || '—')}</p></div><span class="badge ${brand.active === false ? 'off' : ''}">${brand.active === false ? 'متوقف' : 'نشط'}</span></div>
    <div class="brand-detail-stats"><div><b>${branchList.length}</b><span>الفروع</span></div><div><b>${customerCount}</b><span>العملاء</span></div><div><b>${fields.length}</b><span>حقول التسجيل</span></div></div>
    <div class="detail-section"><h4>بيانات البراند</h4><div class="detail-grid"><span><small>الحالة</small><b>${brand.active === false ? 'متوقف' : 'نشط'}</b></span><span><small>تاريخ الإنشاء</small><b>${esc(createdAt)}</b></span><span><small>صلاحية تعديل الحقول</small><b>${brand.editAccess === true && brand.editAccessUntil?.toDate?.() > new Date() ? 'مفتوحة' : 'مغلقة'}</b></span></div></div>
    <div class="detail-section"><h4>حقول نموذج التسجيل</h4><div class="detail-fields">${fields.map((field) => `<div class="detail-field"><span>${esc(field.label || field.key)}</span><small>${fieldTypeName(field.type)} · ${(field.required || ['name','phone'].includes(field.key)) ? 'مطلوب' : 'اختياري'}</small></div>`).join('')}</div></div>
    <div class="detail-section"><h4>الفروع التابعة (${branchList.length})</h4>${branchList.length ? `<div class="detail-branches">${branchList.map((branch) => `<div><span>${esc(branch.name)}</span><b>${branchCustomerCount(branch.id) == null ? '—' : branchCustomerCount(branch.id).toLocaleString('ar-EG')} عميل</b></div>`).join('')}</div>` : '<p class="muted">لا توجد فروع مرتبطة بهذا البراند.</p>'}</div>
    <div class="modal-actions"><button class="btn subtle" type="button" data-close>إغلاق</button><button class="btn secondary" type="button" data-detail-image>تغيير الصورة</button><button class="btn primary" type="button" data-detail-fields>إدارة حقول البراند</button><button class="btn danger" type="button" data-delete-brand="${esc(brand.id)}">حذف البراند نهائيًا</button></div>
  </section></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('[data-backdrop]').onclick = (event) => { if (event.target.matches('[data-backdrop]')) close(); };
  root.querySelector('[data-detail-image]').onclick = () => { close(); showBrandImagePicker(brand); };
  root.querySelector('[data-detail-fields]').onclick = () => {
    selectedFieldsBrand = brand.id;
    $('#fieldsBrandSelect').value = brand.id;
    updateFieldsAccessUI();
    close();
    go('fields');
    if (isSuper()) $('#unlockFieldsBtn').click();
  };
}

function renderBranches() {
  const selectedBrand = isSuper() ? ($('#branchBrandFilter')?.value || '') : profile?.brandId;
  const visible = branches.filter((branch) =>
    (!brandScope() || branch.brandId === brandScope()) &&
    (!selectedBrand || branch.brandId === selectedBrand)
  );
  const summary = $('#branchFilterSummary');
  if (summary) {
    const selected = brands.find((brand) => brand.id === selectedBrand);
    summary.textContent = isSuper()
      ? (selected ? `عرض فروع: ${selected.name} · ${visible.length.toLocaleString('ar-EG')} فرع` : `عرض كل البراندات · ${visible.length.toLocaleString('ar-EG')} فرع`)
      : `فروع البراند · ${visible.length.toLocaleString('ar-EG')} فرع`;
  }
  $('#branchesList').innerHTML = visible.length ? visible.map((branch) => {
    const count = branchCustomerCount(branch.id);
    return `<article class="branch-card">
      <div class="branch-card-head"><div><h4>${esc(branch.name)}</h4><p>${esc(branch.brandName || '')}</p></div><span class="badge ${branch.active === false ? 'off' : ''}">${branch.active === false ? 'متوقف' : 'نشط'}</span></div>
      <div class="branch-count"><div class="branch-count-icon">♙</div><div><b>${count == null ? '—' : count.toLocaleString('ar-EG')}</b><span>إجمالي المسجلين في الفرع</span></div></div>
      <div class="branch-meta"><span>روابط QR و NFC ثابتة</span><span>لا تتغير بعد الطباعة</span></div>
      <div class="branch-actions"><button class="action-btn" data-qr="${esc(branch.id)}">عرض QR / NFC</button><button class="action-btn" data-toggle-branch="${esc(branch.id)}">${branch.active === false ? 'تفعيل الفرع' : 'إيقاف الفرع'}</button><button class="action-btn destructive-action" data-delete-branch="${esc(branch.id)}">حذف الفرع</button></div>
    </article>`;
  }).join('') : '<div class="panel empty">لا توجد فروع لهذا البراند. أضف فرعًا لبدء التسجيل.</div>';
  $('#addBranchBtn').classList.toggle('hidden', !['super_admin', 'brand_admin'].includes(profile?.role));
  $('#branchFilters')?.classList.toggle('hidden', !isSuper());
}

function customerErrorPanel() {
  const code = customerLoadError?.code || '';
  const friendly = code.includes('permission-denied')
    ? 'ليس لديك صلاحية قراءة هذه السجلات. راجع قواعد Firestore وربط الحساب بالبراند.'
    : 'تعذر الاتصال بقاعدة البيانات حاليًا. تحقق من الإنترنت وإعدادات Firebase ثم أعد المحاولة.';
  return `<div class="empty error-state"><b>تعذر تحميل سجلات العملاء.</b><span>${esc(friendly)}</span><button class="btn subtle" type="button" data-retry-load>إعادة المحاولة</button></div>`;
}

function renderCustomers() {
  if (customerLoadError) {
    $('#customersList').innerHTML = customerErrorPanel();
    return;
  }
  const search = $('#customerSearch').value.trim().toLocaleLowerCase('ar');
  const brandId = isSuper() ? $('#brandFilter').value : profile?.brandId;
  const branchId = $('#branchFilter').value;
  const dateFrom = parseDateInput($('#customerDateFrom')?.value || '');
  const dateTo = parseDateInput($('#customerDateTo')?.value || '');
  const dateToExclusive = dateTo ? new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate() + 1).getTime() : null;
  const filtered = customers.filter((customer) => {
    const searchable = [
      customer.name, customer.phone, customer.purchase, customer.product,
      customer.brandName, customer.branchName, ...Object.values(customer.customFields || {}),
    ].join(' ').toLocaleLowerCase('ar');
    return (!search || searchable.includes(search)) &&
      (!brandId || customer.brandId === brandId) &&
      (!branchId || customer.branchId === branchId) &&
      (!dateFrom || customerDateMillis(customer.createdAt) >= dateFrom.getTime()) &&
      (!dateToExclusive || customerDateMillis(customer.createdAt) < dateToExclusive);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / CUSTOMER_PAGE_SIZE));
  customerPage = Math.min(Math.max(1, customerPage), totalPages);
  const start = (customerPage - 1) * CUSTOMER_PAGE_SIZE;
  const currentRows = filtered.slice(start, start + CUSTOMER_PAGE_SIZE);
  const pageButtons = [];
  const firstPage = Math.max(1, Math.min(customerPage - 2, totalPages - 4));
  const lastPage = Math.min(totalPages, firstPage + 4);
  for (let page = firstPage; page <= lastPage; page += 1) {
    pageButtons.push(`<button type="button" class="page-number ${page === customerPage ? 'active' : ''}" data-customer-page="${page}" ${page === customerPage ? 'aria-current="page"' : ''}>${page.toLocaleString('ar-EG')}</button>`);
  }
  const rangeStart = filtered.length ? start + 1 : 0;
  const rangeEnd = Math.min(start + CUSTOMER_PAGE_SIZE, filtered.length);
  const pagination = filtered.length ? `<nav class="customer-pagination" aria-label="صفحات العملاء">
      <span class="pagination-summary">عرض ${rangeStart.toLocaleString('ar-EG')}–${rangeEnd.toLocaleString('ar-EG')} من ${filtered.length.toLocaleString('ar-EG')}</span>
      <div class="pagination-controls"><button type="button" class="page-arrow" data-customer-page="${customerPage - 1}" ${customerPage === 1 ? 'disabled' : ''}>السابق</button>${pageButtons.join('')}<button type="button" class="page-arrow" data-customer-page="${customerPage + 1}" ${customerPage === totalPages ? 'disabled' : ''}>التالي</button></div>
    </nav>` : '';
  $('#customersList').innerHTML = `<div class="results-toolbar"><span>عدد النتائج المطابقة</span><b>${filtered.length.toLocaleString('ar-EG')} عميل</b><small>مرتبة من الأحدث إلى الأقدم · ${CUSTOMER_PAGE_SIZE} عميل في الصفحة</small></div>${customerCards(currentRows)}${pagination}`;
}

function fillSelectors() {
  const selectedBrand = $('#brandFilter').value;
  const selectedBranch = $('#branchFilter').value;
  const selectedBranchesBrand = $('#branchBrandFilter')?.value || '';
  const brandOptions = brands.map((brand) => `<option value="${esc(brand.id)}">${esc(brand.name)}</option>`).join('');

  $('#brandFilter').innerHTML = '<option value="">كل البراندات</option>' + brandOptions;
  if (brands.some((brand) => brand.id === selectedBrand)) $('#brandFilter').value = selectedBrand;
  $('#brandFilter').classList.toggle('hidden', !isSuper());
  $('#brandFilter').setAttribute('aria-hidden', String(!isSuper()));
  $('#page-customers .customer-filters')?.classList.toggle('is-brand-admin', !isSuper());

  const branchesBrandFilter = $('#branchBrandFilter');
  if (branchesBrandFilter) {
    branchesBrandFilter.innerHTML = '<option value="">كل البراندات</option>' + brandOptions;
    if (brands.some((brand) => brand.id === selectedBranchesBrand)) branchesBrandFilter.value = selectedBranchesBrand;
    $('#branchFilters')?.classList.toggle('hidden', !isSuper());
  }

  $('#fieldsBrandSelect').innerHTML = '<option value="">اختر البراند</option>' + brandOptions;
  $('#fieldsBrandSelect').disabled = !isSuper();
  $('#fieldsBrandSelect').classList.toggle('hidden', !isSuper());
  if (!isSuper()) {
    selectedFieldsBrand = profile.brandId;
    $('#fieldsBrandSelect').innerHTML = `<option value="${esc(profile.brandId)}">${esc(profile.brandName || brands[0]?.name || 'البراند')}</option>`;
    $('#fieldsBrandSelect').value = profile.brandId;
  } else {
    $('#fieldsBrandSelect').value = selectedFieldsBrand;
  }

  const selectedBranches = branches.filter((branch) => !$('#brandFilter').value || branch.brandId === $('#brandFilter').value);
  $('#branchFilter').innerHTML = '<option value="">كل الفروع</option>' + selectedBranches
    .map((branch) => `<option value="${esc(branch.id)}">${esc(branch.name)}</option>`).join('');
  if (selectedBranches.some((branch) => branch.id === selectedBranch)) $('#branchFilter').value = selectedBranch;
  updateFieldsAccessUI();
}

function renderLocalUrlWarning() {
  const warning = $('#localUrlWarning');
  try {
    const configured = new URL(PUBLIC_APP_URL);
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']).has(configured.hostname);
    warning.classList.toggle('hidden', !(loopback && configured.protocol === 'http:'));
  } catch {
    warning.classList.remove('hidden');
    warning.textContent = 'رابط PUBLIC_APP_URL غير صالح. لا تنشئ فروعًا أو تطبع بطاقات قبل تصحيح الرابط.';
  }
}

function renderAuthenticatedUser() {
  const displayName = profile?.name || me?.email || 'Administrator';
  $('#profileName').textContent = displayName;
  $('#profileRole').textContent = isSuper() ? 'مدير النظام' : 'مدير البراند';
  $('#avatar').textContent = displayName[0]?.toLocaleUpperCase('ar') || 'A';
  $('[data-page="brands"]').classList.toggle('hidden', !isSuper());
}

async function syncTokenStatuses(branchList, activeForBranch) {
  const tokenUpdates = [];
  for (const branch of branchList) {
    const active = activeForBranch(branch);
    for (const token of [branch.qrToken, branch.nfcToken]) {
      if (token) tokenUpdates.push({ token, active });
    }
  }
  for (let offset = 0; offset < tokenUpdates.length; offset += 450) {
    const write = batch();
    for (const item of tokenUpdates.slice(offset, offset + 450)) {
      write.update(firestoreDoc(db, 'branchTokens', item.token), { active: item.active });
    }
    await write.commit();
  }
}

function getPublicScanUrl(token) {
  let base;
  try {
    base = new URL(String(PUBLIC_APP_URL || '').trim());
  } catch {
    throw new Error('رابط PUBLIC_APP_URL غير صحيح. استخدم رابطًا كاملاً يبدأ بـ https://، أو رابط localhost للتجربة فقط.');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const isLoopback = loopbackHosts.has(base.hostname);
  const sameOrigin = base.origin === window.location.origin;
  const isLocalDevelopment = base.protocol === 'http:' && isLoopback && sameOrigin &&
    window.location.protocol === 'http:' && loopbackHosts.has(window.location.hostname);
  const isProduction = base.protocol === 'https:';

  if (base.username || base.password || base.search || base.hash || (!isProduction && !isLocalDevelopment)) {
    throw new Error('رابط PUBLIC_APP_URL غير آمن أو غير صالح. للتجربة استخدم http://127.0.0.1:5500/ مع فتح الموقع من العنوان نفسه، وللنشر استخدم HTTPS.');
  }

  if (!sameOrigin) {
    throw new Error(`يجب أن يطابق PUBLIC_APP_URL عنوان الصفحة المفتوحة حاليًا (${window.location.origin}/). افتح الموقع من العنوان نفسه أو عدّل القيمة في js/firebase.js.`);
  }

  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(`scan.html?token=${encodeURIComponent(token)}`, base).toString();
}

async function loadQRCodeLibrary() {
  if (window.QRCode) return window.QRCode;
  if (!qrLibraryPromise) {
    qrLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      script.onload = () => window.QRCode ? resolve(window.QRCode) : reject(new Error('مكتبة QR لم تعمل بشكل صحيح.'));
      script.onerror = () => reject(new Error('تعذر تحميل مولد QR؛ تحقق من الاتصال بالإنترنت.'));
      document.head.append(script);
    }).catch((error) => {
      qrLibraryPromise = null;
      throw error;
    });
  }
  return qrLibraryPromise;
}

async function copyText(value, label) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const temporary = document.createElement('textarea');
      temporary.value = value;
      temporary.setAttribute('readonly', '');
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand('copy');
      temporary.remove();
      if (!copied) throw new Error('copy failed');
    }
    toast(`تم نسخ ${label}`);
  } catch {
    toast('تعذر النسخ تلقائياً. حدد الرابط وانسخه يدوياً.');
  }
}

async function showQR(branch) {
  const qrUrl = branch.qrUrl;
  const nfcUrl = branch.nfcUrl;
  if (!qrUrl || !nfcUrl) {
    toast('روابط الفرع غير محفوظة؛ لا تطبع أي بطاقة قبل مراجعة بيانات الفرع.');
    return;
  }

  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal qr-modal" role="dialog" aria-modal="true" aria-label="روابط الفرع">
        <div class="panel-head"><div><h3>روابط الفرع الثابتة</h3><p>${esc(branch.name)} · ${esc(branch.brandName || '')}</p></div><span class="badge">لا تتغير</span></div>
        <div id="qrCanvas" class="qr-canvas" aria-label="رمز QR"></div>
        <label>رابط QR<input id="qrLink" value="${esc(qrUrl)}" readonly dir="ltr"></label>
        <label>رابط NFC<input id="nfcLink" value="${esc(nfcUrl)}" readonly dir="ltr"></label>
        <p class="muted small-note">احتفظ بهذه الروابط بعد الطباعة. إيقاف الفرع يعطل التسجيل مؤقتاً دون تغيير الرابط.</p>
        <div class="modal-actions qr-actions">
          <button class="btn subtle" data-copy-qr>نسخ QR</button>
          <button class="btn subtle" data-copy-nfc>نسخ NFC</button>
          <button class="btn subtle" data-download>تحميل صورة QR</button>
          <button class="btn primary" data-close>إغلاق</button>
        </div>
      </div>
    </div>`;

  root.querySelector('[data-close]').onclick = () => { root.innerHTML = ''; };
  root.querySelector('[data-backdrop]').onclick = (event) => {
    if (event.target.matches('[data-backdrop]')) root.innerHTML = '';
  };
  root.querySelector('[data-copy-qr]').onclick = () => copyText(qrUrl, 'رابط QR');
  root.querySelector('[data-copy-nfc]').onclick = () => copyText(nfcUrl, 'رابط NFC');
  root.querySelector('[data-download]').onclick = () => {
    const canvas = $('#qrCanvas')?.querySelector('canvas');
    if (!canvas) return toast('لم يتم إنشاء QR بعد.');
    const anchor = document.createElement('a');
    anchor.download = `${String(branch.name || 'branch').replace(/[\\/:*?"<>|]/g, '-')}-QR.png`;
    anchor.href = canvas.toDataURL('image/png');
    anchor.click();
  };

  try {
    const QRCode = await loadQRCodeLibrary();
    if (!$('#qrCanvas')) return;
    new QRCode($('#qrCanvas'), { text: qrUrl, width: 220, height: 220, colorDark: '#101722', colorLight: '#ffffff' });
  } catch (error) {
    toast(error.message || 'تعذر إنشاء رمز QR.');
  }
}

async function toggleBrand(brand) {
  if (!isSuper()) throw new Error('هذا الإجراء مخصص لمدير النظام.');
  const nextActive = brand.active === false;
  await patch('brands', brand.id, { active: nextActive, updatedAt: serverTimestamp() });
  const relatedBranches = branches.filter((branch) => branch.brandId === brand.id);
  await syncTokenStatuses(relatedBranches, (branch) => nextActive && branch.active !== false);
  await loadAll();
  toast(nextActive ? 'تم تفعيل البراند' : 'تم إيقاف البراند');
}

async function toggleBranch(branch) {
  const nextActive = branch.active === false;
  const parentBrand = brands.find((brand) => brand.id === branch.brandId);
  await patch('branches', branch.id, { active: nextActive, updatedAt: serverTimestamp() });
  await syncTokenStatuses([branch], () => nextActive && parentBrand?.active === true);
  await loadAll();
  toast(nextActive ? 'تم تفعيل الفرع' : 'تم إيقاف الفرع');
}

$('#loginForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (!event.currentTarget.reportValidity()) return;
  setButtonBusy(button, true, 'جارٍ تسجيل الدخول...');
  try {
    await login($('#email').value.trim(), $('#password').value);
    // The auth-state listener below completes the authenticated UI transition.
  } catch (error) {
    toast(error?.message || 'تعذر تسجيل الدخول.');
  } finally {
    setButtonBusy(button, false);
  }
};

$('#logoutBtn').onclick = async () => {
  try {
    await logout();
    location.reload();
  } catch (error) {
    toast(error?.message || 'تعذر تسجيل الخروج.');
  }
};

$('#mainNav').onclick = (event) => {
  const button = event.target.closest('[data-page]');
  if (button && !button.classList.contains('hidden')) go(button.dataset.page);
};

document.body.addEventListener('click', async (event) => {
  const retryLoadButton = event.target.closest('[data-retry-load]');
  if (retryLoadButton) {
    setButtonBusy(retryLoadButton, true, 'جارٍ التحديث...');
    try {
      const result = await loadAll();
      if (result.customerError) toast('تعذر تحميل العملاء. تحقق من الاتصال والصلاحيات.');
      else toast('تم تحميل البيانات بنجاح.');
    } catch (error) {
      toast(error?.message || 'تعذر إعادة تحميل البيانات.');
    }
    return;
  }

  const gotoButton = event.target.closest('[data-goto]');
  if (gotoButton) go(gotoButton.dataset.goto);

  const customerDetailsButton = event.target.closest('[data-customer-details]');
  if (customerDetailsButton) {
    const customer = customers.find((item) => item.id === customerDetailsButton.dataset.customerDetails);
    if (customer) customerDetailsModal(customer);
    return;
  }

  const customerDeleteButton = event.target.closest('[data-delete-customer]');
  if (customerDeleteButton) {
    setButtonBusy(customerDeleteButton, true, 'جارٍ الحذف...');
    try {
      const deleted = await deleteCustomer(customerDeleteButton.dataset.deleteCustomer);
      if (!deleted) setButtonBusy(customerDeleteButton, false);
    } catch (error) { toast(error?.message || 'تعذر حذف العميل.'); setButtonBusy(customerDeleteButton, false); }
    return;
  }

  const brandImageButton = event.target.closest('[data-brand-image]');
  if (brandImageButton) {
    const brand = brands.find((item) => item.id === brandImageButton.dataset.brandImage);
    if (brand) showBrandImagePicker(brand);
    return;
  }

  const customerCard = event.target.closest('[data-customer-id]');
  if (customerCard && !event.target.closest('a,button')) {
    const customer = customers.find((item) => item.id === customerCard.dataset.customerId);
    if (customer) customerDetailsModal(customer);
    return;
  }

  const brandDetailsButton = event.target.closest('[data-brand-details]');
  if (brandDetailsButton) {
    const brand = brands.find((item) => item.id === brandDetailsButton.dataset.brandDetails);
    if (brand) showBrandDetails(brand);
    return;
  }

  const brandFieldsButton = event.target.closest('[data-brand-fields]');
  if (brandFieldsButton) {
    const brandId = brandFieldsButton.dataset.brandFields;
    selectedFieldsBrand = brandId;
    $('#fieldsBrandSelect').value = brandId;
    updateFieldsAccessUI();
    go('fields');
    if (isSuper()) $('#unlockFieldsBtn').click();
    return;
  }

  const brandDeleteButton = event.target.closest('[data-delete-brand]');
  if (brandDeleteButton) {
    setButtonBusy(brandDeleteButton, true, 'جارٍ الحذف...');
    try {
      const deleted = await deleteBrand(brandDeleteButton.dataset.deleteBrand);
      if (!deleted) setButtonBusy(brandDeleteButton, false);
    } catch (error) {
      toast(error?.message || 'تعذر حذف البراند.');
      setButtonBusy(brandDeleteButton, false);
    }
    return;
  }

  const brandButton = event.target.closest('[data-toggle-brand]');
  if (brandButton) {
    const brand = brands.find((item) => item.id === brandButton.dataset.toggleBrand);
    if (!brand) return;
    setButtonBusy(brandButton, true);
    try { await toggleBrand(brand); } catch (error) { toast(error?.message || 'تعذر تغيير حالة البراند.'); setButtonBusy(brandButton, false); }
    return;
  }

  const branchDeleteButton = event.target.closest('[data-delete-branch]');
  if (branchDeleteButton) {
    setButtonBusy(branchDeleteButton, true, 'جارٍ الحذف...');
    try {
      const deleted = await deleteBranch(branchDeleteButton.dataset.deleteBranch);
      if (!deleted) setButtonBusy(branchDeleteButton, false);
    } catch (error) {
      toast(error?.message || 'تعذر حذف الفرع.');
      setButtonBusy(branchDeleteButton, false);
    }
    return;
  }

  const branchButton = event.target.closest('[data-toggle-branch]');
  if (branchButton) {
    const branch = branches.find((item) => item.id === branchButton.dataset.toggleBranch);
    if (!branch) return;
    setButtonBusy(branchButton, true);
    try { await toggleBranch(branch); } catch (error) { toast(error?.message || 'تعذر تغيير حالة الفرع.'); setButtonBusy(branchButton, false); }
    return;
  }

  const qrButton = event.target.closest('[data-qr]');
  if (qrButton) {
    const branch = branches.find((item) => item.id === qrButton.dataset.qr);
    if (branch) await showQR(branch);
  }
});

document.body.addEventListener('keydown', (event) => {
  const card = event.target.closest('[data-customer-id]');
  if (!card || event.target.closest('a,button') || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  const customer = customers.find((item) => item.id === card.dataset.customerId);
  if (customer) customerDetailsModal(customer);
});

$('#customersList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-customer-page]');
  if (!button || button.disabled) return;
  customerPage = Number(button.dataset.customerPage) || 1;
  renderCustomers();
});

$('#addBrandBtn').onclick = () => {
  if (!isSuper()) return toast('هذا الإجراء مخصص لمدير النظام.');
  modal('إضافة براند', `
    <label>اسم البراند<input name="name" required maxlength="100"></label>
    <label>اسم مدير البراند<input name="adminName" required maxlength="100"></label>
    <label>البريد الإلكتروني<input name="email" type="email" required autocomplete="email"></label>
    <label>كلمة مرور مؤقتة<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
  `, 'إنشاء البراند', async (formData) => {
    const name = String(formData.get('name') || '').trim();
    const adminName = String(formData.get('adminName') || '').trim();
    const email = String(formData.get('email') || '').trim().toLowerCase();
    const password = String(formData.get('password') || '');
    if (!name || !adminName || !email || password.length < 8) throw new Error('أكمل بيانات البراند وتأكد من كلمة المرور.');

    const brandRef = await add('brands', { name, email, active: true, createdBy: me.uid });
    try {
      await createBrandAccount(email, password, {
        name: adminName,
        email,
        brandId: brandRef.id,
        brandName: name,
      });
    } catch (error) {
      try { await remove('brands', brandRef.id); } catch { /* keep the original account-creation error */ }
      throw error;
    }
  });
};

$('#addBranchBtn').onclick = () => {
  modal('إضافة فرع جديد', `${isSuper() ? `
    <label>البراند<select name="brandId" required>
      <option value="">اختر البراند</option>
      ${brands.filter((brand) => brand.active !== false).map((brand) => `<option value="${esc(brand.id)}">${esc(brand.name)}</option>`).join('')}
    </select></label>` : ''}
    <label>اسم الفرع<input name="name" required maxlength="100" placeholder="مثال: فرع مدينة نصر"></label>
    <p class="form-hint">يتم إنشاء روابط QR وNFC ثابتة تلقائيًا لهذا الفرع.</p>
  `, 'إنشاء الفرع', async (formData) => {
    const brandId = isSuper() ? String(formData.get('brandId') || '') : profile.brandId;
    const brand = brands.find((item) => item.id === brandId);
    const name = String(formData.get('name') || '').trim();
    if (!brand || brand.active === false) throw new Error('البراند غير موجود أو متوقف.');
    if (name.length < 2) throw new Error('اسم الفرع يجب أن يحتوي على حرفين على الأقل.');

    const qrToken = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
    const nfcToken = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
    // A Firestore document path must have an even number of segments: collection + document ID.
    const branchRef = firestoreDoc(db, 'branches', crypto.randomUUID());
    const write = batch();
    const fields = Array.isArray(brand.fields) && brand.fields.length ? brand.fields : DEFAULT_FIELDS;
    const qrUrl = getPublicScanUrl(qrToken);
    const nfcUrl = getPublicScanUrl(nfcToken);

    write.set(branchRef, {
      name,
      brandId: brand.id,
      brandName: brand.name,
      active: true,
      qrToken,
      nfcToken,
      qrUrl,
      nfcUrl,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const tokenBase = {
      branchId: branchRef.id,
      brandId: brand.id,
      brandName: brand.name,
      brandImage: safeBrandImagePath(brand.image),
      branchName: name,
      fields,
      active: true,
      createdAt: serverTimestamp(),
    };
    write.set(firestoreDoc(db, 'branchTokens', qrToken), { ...tokenBase, source: 'qr' });
    write.set(firestoreDoc(db, 'branchTokens', nfcToken), { ...tokenBase, source: 'nfc' });
    await write.commit();
  });
};

$('#customerSearch').oninput = () => { customerPage = 1; renderCustomers(); };
$('#brandFilter').onchange = () => { customerPage = 1; fillSelectors(); renderCustomers(); };
$('#branchFilter').onchange = () => { customerPage = 1; renderCustomers(); };
function parseDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
function syncCustomerDateFilterUI(error = false) {
  const wrapper = $('.customer-date-filter');
  if (!wrapper) return;
  const from = $('#customerDateFrom').value;
  const to = $('#customerDateTo').value;
  const active = Boolean(from || to);
  wrapper.classList.toggle('is-active', active);
  wrapper.classList.toggle('has-error', error);
  wrapper.classList.toggle('date-filter-state-active', active && !error);
  const state = $('#customerDateFilterState');
  if (state) state.textContent = error ? 'راجع نطاق التاريخ' : active ? 'فلتر التاريخ مفعّل' : 'كل التواريخ';
  const clearButton = $('#customerDateClearBtn');
  if (clearButton) clearButton.disabled = !active;
}
function updateCustomerDateFilter() {
  const from = $('#customerDateFrom').value;
  const to = $('#customerDateTo').value;
  if (from && to && from > to) {
    $('#customerDateTo').setCustomValidity('تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو مساويًا له.');
    $('#customerDateTo').reportValidity();
    $('#customerDateTo').setCustomValidity('');
    syncCustomerDateFilterUI(true);
    return;
  }
  syncCustomerDateFilterUI();
  customerPage = 1;
  renderCustomers();
}
$('#customerDateFrom').onchange = updateCustomerDateFilter;
$('#customerDateTo').onchange = updateCustomerDateFilter;
$('#customerTodayBtn').onclick = () => {
  const today = new Date();
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  $('#customerDateFrom').value = localDate;
  $('#customerDateTo').value = localDate;
  syncCustomerDateFilterUI();
  customerPage = 1;
  renderCustomers();
};
$('#customerDateClearBtn').onclick = () => {
  $('#customerDateFrom').value = '';
  $('#customerDateTo').value = '';
  syncCustomerDateFilterUI();
  customerPage = 1;
  renderCustomers();
};
syncCustomerDateFilterUI();
$('#branchBrandFilter').onchange = () => renderBranches();
$('#refreshBtn').onclick = async () => {
  setButtonBusy($('#refreshBtn'), true, '...');
  try {
    const result = await loadAll();
    toast(result.customerError ? 'تم تحديث البيانات الأساسية، لكن تعذر تحميل العملاء. راجع الاتصال والصلاحيات.' : 'تم تحديث البيانات');
  } catch (error) { toast(error?.message || 'تعذر تحديث البيانات.'); }
  finally { setButtonBusy($('#refreshBtn'), false); }
};

async function loadXLSXLibrary() {
  if (window.XLSX) return window.XLSX;
  if (!xlsxLibraryPromise) {
    xlsxLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // xlsx-js-style is API-compatible with SheetJS and supports cell formatting.
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.min.js';
      script.onload = () => window.XLSX
        ? resolve(window.XLSX)
        : reject(new Error('مكتبة Excel لم تعمل بشكل صحيح.'));
      script.onerror = () => reject(new Error('تعذر تحميل مكتبة Excel الاحترافية. تحقق من الاتصال بالإنترنت.'));
      document.head.append(script);
    }).catch((error) => {
      xlsxLibraryPromise = null;
      throw error;
    });
  }
  return xlsxLibraryPromise;
}

async function loadAllCustomersForExport() {
  if (customerLoadError) throw new Error('تعذر تحميل بيانات العملاء. أعد المحاولة قبل التصدير.');
  return customers.slice();
}

function excelSafeText(value) {
  const text = String(value ?? '');
  return /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
}

function uniqueExcelSheetName(brandName, branchName, usedNames) {
  const clean = (value, fallback) => String(value || fallback)
    .replace(/[\\/?*\[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim();
  const brand = clean(brandName, 'براند');
  const branch = clean(branchName, 'فرع');
  let base;
  if (brand.length + branch.length + 3 <= 31) base = `${brand} - ${branch}`;
  else if (brand.length <= 12) base = `${brand} - ${branch.slice(0, 28 - brand.length)}`;
  else if (branch.length <= 12) base = `${brand.slice(0, 28 - branch.length)} - ${branch}`;
  else base = `${brand.slice(0, 14)} - ${branch.slice(0, 14)}`;
  base = base.slice(0, 31) || 'الفرع';
  let name = base;
  let suffix = 2;
  while (usedNames.has(name.toLocaleLowerCase())) {
    const ending = ` (${suffix})`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  usedNames.add(name.toLocaleLowerCase());
  return name;
}

function excelDate(value) {
  const millis = customerDateMillis(value);
  return millis > 0 ? new Date(millis) : '';
}

function styleExcelWorksheet(XLSX, worksheet, { headerRow = 2, lastRow, lastColumn, titleRows = [0], subtitleRows = [1], dateColumns = [] } = {}) {
  const navy = '14263D';
  const blue = '24577A';
  const pale = 'EAF0F6';
  const border = { style: 'thin', color: { rgb: 'D7E0EA' } };
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const endRow = lastRow ?? range.e.r;
  const endColumn = lastColumn ?? range.e.c;

  // Style every cell, including merged title cells, to keep the workbook consistent.
  for (let row = 0; row <= endRow; row += 1) {
    for (let column = 0; column <= endColumn; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      if (!worksheet[address]) worksheet[address] = { t: 's', v: '' };
      const cell = worksheet[address];
      cell.s = {
        font: { name: 'Arial', sz: 10, color: { rgb: '243447' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: { bottom: border },
        fill: { patternType: 'solid', fgColor: { rgb: row % 2 === 0 ? 'FFFFFF' : 'F5F8FB' } },
      };
      if (titleRows.includes(row)) {
        cell.s = {
          font: { name: 'Arial', sz: 16, bold: true, color: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          fill: { patternType: 'solid', fgColor: { rgb: navy } },
        };
      } else if (subtitleRows.includes(row)) {
        cell.s = {
          font: { name: 'Arial', sz: 10, bold: true, color: { rgb: navy } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          fill: { patternType: 'solid', fgColor: { rgb: pale } },
          border: { bottom: { style: 'thin', color: { rgb: 'C7D3E0' } } },
        };
      } else if (row === headerRow) {
        cell.s = {
          font: { name: 'Arial', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          fill: { patternType: 'solid', fgColor: { rgb: blue } },
          border: { bottom: { style: 'medium', color: { rgb: navy } } },
        };
      }
      if (dateColumns.includes(column) && row > headerRow && cell.v instanceof Date) {
        cell.z = 'dd/mm/yyyy hh:mm';
      }
    }
  }
  worksheet['!rows'] = worksheet['!rows'] || [];
  worksheet['!rows'][0] = { hpt: 30 };
  worksheet['!rows'][1] = { hpt: 24 };
  worksheet['!rows'][headerRow] = { hpt: 30 };
  worksheet['!freeze'] = {
    xSplit: 0, ySplit: headerRow + 1,
    topLeftCell: `A${headerRow + 2}`,
    activePane: 'bottomLeft', state: 'frozen',
  };
  worksheet['!sheetViews'] = [{ rightToLeft: true, showGridLines: false }];
  worksheet['!margins'] = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
}

function makeExcelReportSheet(XLSX, { title, subtitle, headers, rows, widths, dateColumns = [], usedNames, sheetName, headerRow = 2 }) {
  const data = [[excelSafeText(title)], [excelSafeText(subtitle)], headers, ...rows];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const lastColumn = Math.max(0, headers.length - 1);
  const lastRow = Math.max(headerRow, data.length - 1);
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumn } },
  ];
  worksheet['!cols'] = widths.map((wch) => ({ wch }));
  worksheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: lastRow, c: lastColumn } }),
  };
  styleExcelWorksheet(XLSX, worksheet, { headerRow, lastRow, lastColumn, dateColumns });
  XLSX.utils.book_append_sheet(usedNames.workbook, worksheet, sheetName);
}

function safeExcelFilePart(value, fallback = 'report') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 90);
  return cleaned || fallback;
}

function currentBrandExportFields(brand) {
  return (Array.isArray(brand?.fields) && brand.fields.length ? brand.fields : DEFAULT_FIELDS)
    .filter((field) => field && field.key);
}

function buildBranchCustomerSheet(XLSX, { branch, brand, branchRows, usedSheetNames, appendContext }) {
  const configuredFields = currentBrandExportFields(brand)
    .filter((field) => !['name', 'phone', 'purchase'].includes(field.key));
  const customKeys = [...new Set([
    ...configuredFields.map((field) => field.key),
    ...branchRows.flatMap((customer) => Object.keys(customer.customFields || {})),
  ])];
  const fieldLabels = new Map(configuredFields.map((field) => [field.key, field.label || field.key]));
  const baseHeaders = [
    'الاسم', 'رقم الهاتف', 'المنتج', 'مصدر التسجيل', 'موافقة العميل', 'تاريخ التسجيل',
    ...customKeys.map((key) => fieldLabels.get(key) || key),
  ];
  const headers = [];
  const headerCounts = new Map();
  for (const header of baseHeaders) {
    const count = (headerCounts.get(header) || 0) + 1;
    headerCounts.set(header, count);
    headers.push(count === 1 ? header : `${header} (${count})`);
  }
  const brandName = brand?.name || branch.brandName || 'البراند';
  const branchTitle = `تقرير عملاء ${brandName} - ${branch.name}`;
  const branchSubtitle = `البراند: ${brandName} | الفرع: ${branch.name} | عدد العملاء: ${branchRows.length} | الترتيب: الأحدث أولًا`;
  const rows = branchRows.map((customer) => [
    excelSafeText(customer.name),
    excelSafeText(customer.phone),
    excelSafeText(customer.purchase || customer.product),
    customer.source === 'nfc' ? 'NFC' : 'QR',
    customer.consent === true ? 'موافق' : 'غير مسجل',
    excelDate(customer.createdAt),
    ...customKeys.map((key) => excelSafeText(customer.customFields?.[key])),
  ]);
  const sheetName = uniqueExcelSheetName(brandName, branch.name, usedSheetNames);
  makeExcelReportSheet(XLSX, {
    title: branchTitle,
    subtitle: branchSubtitle,
    headers,
    rows,
    widths: [25, 20, 26, 16, 17, 23, ...customKeys.map(() => 24)],
    dateColumns: [5],
    usedNames: appendContext,
    sheetName,
  });
}

function exportBrandInformationSheets(XLSX, { brand, brandBranches, brandCustomers, appendContext }) {
  const activeBranches = brandBranches.filter((branch) => branch.active !== false).length;
  const createdAt = excelDate(brand.createdAt);
  const infoRows = [
    ['اسم البراند', excelSafeText(brand.name)],
    ['البريد الإلكتروني المسجل للبراند', excelSafeText(brand.email || '—')],
    ['الحالة', brand.active === false ? 'متوقف' : 'نشط'],
    ['عدد الفروع', brandBranches.length],
    ['الفروع النشطة', activeBranches],
    ['الفروع المتوقفة', brandBranches.length - activeBranches],
    ['إجمالي العملاء', brandCustomers.length],
    ['معرّف البراند', excelSafeText(brand.id)],
    ['مسار صورة البراند', excelSafeText(brand.image || 'غير محدد')],
    ['تاريخ إنشاء البراند', createdAt],
  ];
  makeExcelReportSheet(XLSX, {
    title: `تقرير ${brand.name} | بيانات البراند`,
    subtitle: `تقرير خاص ببراند ${brand.name} فقط | تاريخ الإصدار: ${new Date().toLocaleString('ar-EG')}`,
    headers: ['البيان', 'المعلومات'],
    rows: infoRows,
    widths: [34, 55],
    dateColumns: [1],
    usedNames: appendContext,
    sheetName: 'بيانات البراند',
  });

  const fields = currentBrandExportFields(brand);
  const fieldRows = fields.map((field) => [
    excelSafeText(field.label || field.key),
    excelSafeText(field.key),
    excelSafeText(fieldTypeName(field.type)),
    field.required || ['name', 'phone'].includes(field.key) ? 'نعم' : 'لا',
  ]);
  makeExcelReportSheet(XLSX, {
    title: `حقول نموذج ${brand.name}`,
    subtitle: `الحقول المفعلة في نموذج تسجيل عملاء ${brand.name}`,
    headers: ['اسم الحقل', 'المعرّف', 'نوع البيانات', 'إلزامي'],
    rows: fieldRows,
    widths: [34, 26, 22, 14],
    usedNames: appendContext,
    sheetName: 'حقول التسجيل',
  });
}

$('#exportBtn').onclick = async () => {
  const button = $('#exportBtn');
  setButtonBusy(button, true, 'جارٍ تجهيز Excel...');
  try {
    if (!profile || !['super_admin', 'brand_admin'].includes(profile.role)) {
      throw new Error('نوع الحساب غير مصرح له بتصدير التقارير.');
    }
    const all = await loadAllCustomersForExport();
    const superAdminExport = isSuper();
    const ownBrandId = superAdminExport ? null : String(profile.brandId || '');
    if (!superAdminExport && !ownBrandId) throw new Error('حساب مدير البراند غير مرتبط ببراند صحيح.');

    // Build an explicit role scope before preparing any workbook data.
    const exportBrands = brands
      .filter((brand) => superAdminExport || brand.id === ownBrandId)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
    if (!exportBrands.length) throw new Error('لا توجد بيانات براند ضمن صلاحيات حسابك.');
    if (!superAdminExport && exportBrands.length !== 1) throw new Error('تعذر تحديد براند حسابك بشكل آمن.');

    const exportBrandIds = new Set(exportBrands.map((brand) => brand.id));
    if (superAdminExport && branches.some((branch) => !exportBrandIds.has(branch.brandId))) {
      throw new Error('يوجد فرع غير مرتبط ببراند معروف. تم إيقاف التقرير الشامل حتى لا يتم إسقاط بيانات أو نسبها إلى براند خاطئ.');
    }
    const exportBranches = branches
      .filter((branch) => superAdminExport || branch.brandId === ownBrandId)
      .sort((a, b) => `${a.brandName || ''} ${a.name || ''}`.localeCompare(`${b.brandName || ''} ${b.name || ''}`, 'ar'));
    const dateFrom = parseDateInput($('#customerDateFrom')?.value || '');
    const dateTo = parseDateInput($('#customerDateTo')?.value || '');
    const dateToExclusive = dateTo ? new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate() + 1).getTime() : null;
    const exportRows = (superAdminExport ? all.slice() : all.filter((customer) => customer.brandId === ownBrandId))
      .filter((customer) => (!dateFrom || customerDateMillis(customer.createdAt) >= dateFrom.getTime()) &&
        (!dateToExclusive || customerDateMillis(customer.createdAt) < dateToExclusive));

    const branchKeys = new Set(exportBranches.map((branch) => `${branch.brandId}::${branch.id}`));
    const unmatchedCount = exportRows.filter((customer) => !branchKeys.has(`${customer.brandId}::${customer.branchId}`)).length;
    if (unmatchedCount) {
      throw new Error(`تم إيقاف التصدير لحماية فصل البيانات: يوجد ${unmatchedCount} سجل لا يتطابق مع براند وفرع معروفين. راجع بيانات هذه السجلات قبل التصدير.`);
    }

    if (exportRows.length && !exportBranches.length) {
      throw new Error('توجد سجلات عملاء لكن لا توجد فروع مطابقة لها؛ تم إيقاف التصدير لحماية البيانات.');
    }

    const XLSX = await loadXLSXLibrary();
    const workbook = XLSX.utils.book_new();
    const reportDate = new Date();
    const ownBrand = superAdminExport ? null : exportBrands[0];
    const reportTitle = superAdminExport
      ? 'Archai | التقرير الشامل للبراندات والفروع والعملاء'
      : `تقرير ${ownBrand.name} | بيانات البراند والفروع والعملاء`;
    const reportAuthor = superAdminExport ? 'Archai' : ownBrand.name;
    workbook.Props = {
      Title: reportTitle,
      Subject: superAdminExport ? 'التقرير الإداري الشامل لجميع البراندات والفروع' : `تقرير خاص ببراند ${ownBrand.name}`,
      Author: reportAuthor,
      Company: reportAuthor,
      CreatedDate: reportDate,
    };

    const usedSheetNames = new Set(superAdminExport
      ? ['ملخص التقرير', 'ملخص الفروع', 'ملخص البراندات']
      : ['بيانات البراند', 'حقول التسجيل', 'ملخص الفروع']);
    const appendContext = { workbook };
    let totalExported = 0;

    if (superAdminExport) {
      const totalActiveBranches = exportBranches.filter((branch) => branch.active !== false).length;
      const totalActiveBrands = exportBrands.filter((brand) => brand.active !== false).length;
      const overviewRows = [
        ['تاريخ إعداد التقرير', reportDate],
        ['عدد البراندات', exportBrands.length],
        ['البراندات النشطة', totalActiveBrands],
        ['البراندات المتوقفة', exportBrands.length - totalActiveBrands],
        ['إجمالي الفروع', exportBranches.length],
        ['الفروع النشطة', totalActiveBranches],
        ['الفروع المتوقفة', exportBranches.length - totalActiveBranches],
        ['إجمالي العملاء', exportRows.length],
      ];
      makeExcelReportSheet(XLSX, {
        title: 'Archai | التقرير الإداري الشامل',
        subtitle: `جميع البراندات والفروع والعملاء | تاريخ التقرير: ${reportDate.toLocaleString('ar-EG')}`,
        headers: ['المؤشر', 'القيمة'],
        rows: overviewRows,
        widths: [34, 34],
        dateColumns: [1],
        usedNames: appendContext,
        sheetName: 'ملخص التقرير',
      });

      const branchSummaryRows = exportBranches.map((branch) => {
        const branchCustomers = exportRows.filter((customer) => customer.brandId === branch.brandId && customer.branchId === branch.id);
        const branchBrand = exportBrands.find((item) => item.id === branch.brandId);
        return [
          excelSafeText(branchBrand?.name || branch.brandName || '—'),
          excelSafeText(branch.name || '—'),
          branch.active === false ? 'متوقف' : 'نشط',
          branchCustomers.length,
          branch.qrToken ? 'موجود' : 'غير موجود',
          branch.nfcToken ? 'موجود' : 'غير موجود',
          excelDate(branch.createdAt),
          excelSafeText(branch.id),
          excelSafeText(branch.brandId),
        ];
      });
      makeExcelReportSheet(XLSX, {
        title: 'Archai | الملخص الكامل للفروع',
        subtitle: `عدد الفروع: ${exportBranches.length} | إجمالي العملاء: ${exportRows.length} | جميع البراندات`,
        headers: ['البراند', 'الفرع', 'الحالة', 'عدد العملاء', 'رمز QR', 'رمز NFC', 'تاريخ إنشاء الفرع', 'معرّف الفرع', 'معرّف البراند'],
        rows: branchSummaryRows,
        widths: [25, 25, 15, 16, 15, 15, 23, 34, 34],
        dateColumns: [6],
        usedNames: appendContext,
        sheetName: 'ملخص الفروع',
      });

      const brandSummaryRows = exportBrands.map((brand) => {
        const brandBranches = exportBranches.filter((branch) => branch.brandId === brand.id);
        const brandCustomers = exportRows.filter((customer) => customer.brandId === brand.id);
        const activeCount = brandBranches.filter((branch) => branch.active !== false).length;
        const fields = currentBrandExportFields(brand).map((field) => field.label || field.key).join('، ');
        return [
          excelSafeText(brand.name || '—'),
          brand.active === false ? 'متوقف' : 'نشط',
          brandBranches.length,
          activeCount,
          brandBranches.length - activeCount,
          brandCustomers.length,
          excelSafeText(brand.email || '—'),
          excelSafeText(brand.id),
          excelSafeText(brand.image || 'غير محدد'),
          excelDate(brand.createdAt),
          excelSafeText(fields),
        ];
      });
      makeExcelReportSheet(XLSX, {
        title: 'Archai | الملخص الكامل للبراندات',
        subtitle: `عدد البراندات: ${exportBrands.length} | يشمل البراندات التي لم تنشئ فروعًا بعد`,
        headers: ['اسم البراند', 'الحالة', 'عدد الفروع', 'الفروع النشطة', 'الفروع المتوقفة', 'عدد العملاء', 'بريد مدير البراند', 'معرّف البراند', 'مسار صورة البراند', 'تاريخ الإنشاء', 'حقول نموذج التسجيل'],
        rows: brandSummaryRows,
        widths: [28, 14, 14, 16, 18, 15, 32, 34, 38, 23, 60],
        dateColumns: [9],
        usedNames: appendContext,
        sheetName: 'ملخص البراندات',
      });
    } else {
      const brandBranches = exportBranches.filter((branch) => branch.brandId === ownBrand.id);
      const brandCustomers = exportRows.filter((customer) => customer.brandId === ownBrand.id);
      exportBrandInformationSheets(XLSX, {
        brand: ownBrand,
        brandBranches,
        brandCustomers,
        appendContext,
      });

      const branchSummaryRows = brandBranches.map((branch) => {
        const branchCustomers = brandCustomers.filter((customer) => customer.branchId === branch.id);
        return [
          excelSafeText(branch.name || '—'),
          branch.active === false ? 'متوقف' : 'نشط',
          branchCustomers.length,
          branch.qrToken ? 'موجود' : 'غير موجود',
          branch.nfcToken ? 'موجود' : 'غير موجود',
          excelDate(branch.createdAt),
          excelSafeText(branch.id),
        ];
      });
      makeExcelReportSheet(XLSX, {
        title: `تقرير ${ownBrand.name} | ملخص الفروع`,
        subtitle: `بيانات ${ownBrand.name} فقط | عدد الفروع: ${brandBranches.length} | إجمالي العملاء: ${brandCustomers.length}`,
        headers: ['الفرع', 'الحالة', 'عدد العملاء', 'رمز QR', 'رمز NFC', 'تاريخ إنشاء الفرع', 'معرّف الفرع'],
        rows: branchSummaryRows,
        widths: [28, 15, 16, 15, 15, 23, 34],
        dateColumns: [5],
        usedNames: appendContext,
        sheetName: 'ملخص الفروع',
      });
    }

    for (const branch of exportBranches) {
      const brand = exportBrands.find((item) => item.id === branch.brandId);
      const branchRows = exportRows
        .filter((customer) => customer.brandId === branch.brandId && customer.branchId === branch.id)
        .sort((a, b) => customerDateMillis(b.createdAt) - customerDateMillis(a.createdAt));
      totalExported += branchRows.length;
      buildBranchCustomerSheet(XLSX, { branch, brand, branchRows, usedSheetNames, appendContext });
    }

    const datePart = reportDate.toISOString().slice(0, 10);
    const fileName = superAdminExport
      ? `Archai-Complete-Report-${datePart}.xlsx`
      : `${safeExcelFilePart(ownBrand.name, 'brand')}-Brand-Report-${datePart}.xlsx`;
    XLSX.writeFile(workbook, fileName, { compression: true });

    if (superAdminExport) {
      toast(`تم إنشاء تقرير Archai الشامل: ${exportBrands.length.toLocaleString('ar-EG')} براند، ${exportBranches.length.toLocaleString('ar-EG')} فرع، و${totalExported.toLocaleString('ar-EG')} عميل.`);
    } else {
      toast(`تم إنشاء تقرير ${ownBrand.name}: ${brandBranchesCount(exportBranches, ownBrand.id).toLocaleString('ar-EG')} فرع و${totalExported.toLocaleString('ar-EG')} عميل. لا يحتوي الملف على بيانات براندات أخرى.`);
    }
  } catch (error) {
    toast(error?.message || 'تعذر تصدير Excel. تحقق من تحميل بيانات العملاء.');
  } finally {
    setButtonBusy(button, false);
  }
};

function brandBranchesCount(branchList, brandId) {
  return branchList.filter((branch) => branch.brandId === brandId).length;
}

function fieldTypeName(type) {
  return ({ text: 'نص قصير', tel: 'رقم هاتف', email: 'بريد إلكتروني', number: 'رقم', date: 'تاريخ', textarea: 'نص طويل' })[type] || 'نص قصير';
}

function currentBrandFields(brand) {
  return Array.isArray(brand?.fields) && brand.fields.length ? brand.fields : DEFAULT_FIELDS;
}

function renderFieldsPreview(brand) {
  const rows = $('#fieldsPreviewRows');
  if (!brand) {
    $('#fieldsPreviewHint').textContent = 'اختر البراند لعرض حقول نموذج التسجيل.';
    rows.innerHTML = '<div class="empty">لا يوجد براند محدد.</div>';
    return;
  }
  const fields = currentBrandFields(brand);
  $('#fieldsPreviewHint').textContent = `${brand.name} · ${fields.length} من 15 حقلاً`;
  rows.innerHTML = fields.map((field) => `
    <article class="field-preview-item">
      <div class="field-preview-title"><b>${esc(field.label || field.key)}</b><span class="field-state ${(field.required || ['name', 'phone'].includes(field.key)) ? 'required' : ''}">${(field.required || ['name', 'phone'].includes(field.key)) ? 'مطلوب' : 'اختياري'}</span></div>
      <div class="field-preview-meta"><code>${esc(field.key)}</code><span>${fieldTypeName(field.type)}</span>${['name', 'phone'].includes(field.key) ? '<span class="field-system">أساسي</span>' : ''}</div>
    </article>`).join('');
}

function updateFieldsAccessUI() {
  const brandId = isSuper() ? $('#fieldsBrandSelect').value : profile?.brandId;
  selectedFieldsBrand = brandId || '';
  const brand = brands.find((item) => item.id === brandId);
  renderFieldsPreview(brand);
  const unlocked = brand?.editAccess === true && brand.editAccessUntil?.toDate?.() > new Date();
  if (isSuper()) {
    $('#unlockFieldsBtn').textContent = 'تعديل الحقول مباشرة';
    $('#grantFieldsAccessBtn').classList.remove('hidden');
    $('#editPermission').textContent = unlocked ? 'صلاحية مدير البراند مفتوحة' : 'يمكنك التعديل كمدير نظام';
    $('#fieldsPreviewHint').textContent = brand
      ? `${brand.name} · ${currentBrandFields(brand).length} من 15 حقلاً · يمكنك معاينة الحقول وتعديلها مباشرة أو فتح الصلاحية لمدير البراند`
      : 'اختر البراند لعرض حقول نموذج التسجيل.';
  } else {
    $('#unlockFieldsBtn').textContent = unlocked ? 'فتح محرر الحقول' : 'التحقق من صلاحية التعديل';
    $('#grantFieldsAccessBtn').classList.add('hidden');
    $('#editPermission').textContent = unlocked ? 'الصلاحية متاحة' : 'في انتظار موافقة مدير النظام';
    $('#fieldsPreviewHint').textContent = brand
      ? `${brand.name} · ${currentBrandFields(brand).length} من 15 حقلاً · ${unlocked ? 'يمكنك تعديل الحقول' : 'اطلب من مدير النظام فتح الصلاحية'}`
      : 'لا يمكن تحميل إعدادات البراند حاليًا.';
  }
}

$('#fieldsBrandSelect').onchange = () => {
  editingFields = false;
  $('#fieldsEditor').classList.add('hidden');
  updateFieldsAccessUI();
};

$('#unlockFieldsBtn').onclick = async () => {
  const brandId = isSuper() ? $('#fieldsBrandSelect').value : profile.brandId;
  selectedFieldsBrand = brandId;
  if (!brandId) return toast('اختر البراند أولاً.');
  const brand = brands.find((item) => item.id === brandId);
  if (!brand) return toast('البراند غير موجود.');

  const button = $('#unlockFieldsBtn');
  setButtonBusy(button, true, 'جارٍ فتح المحرر...');
  try {
    if (isSuper()) {
      editingFields = true;
      $('#fieldsEditor').classList.remove('hidden');
      renderFields(brand);
      $('#editPermission').textContent = 'تحرير مباشر لمدير النظام';
      $('#fieldsEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('يمكنك تعديل الحقول مباشرة وحفظها دون فتح صلاحية مؤقتة.');
      return;
    }

    if (!(brand.editAccess === true && brand.editAccessUntil?.toDate?.() > new Date())) {
      throw new Error('لم يفتح مدير النظام صلاحية التعديل لهذا البراند أو انتهت مدتها.');
    }
    editingFields = true;
    $('#editPermission').textContent = 'التحرير مفتوح';
    $('#fieldsEditor').classList.remove('hidden');
    renderFields(brand);
    $('#fieldsEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(error?.message || 'تعذر فتح محرر الحقول.');
  } finally {
    setButtonBusy(button, false);
  }
};

$('#grantFieldsAccessBtn').onclick = async () => {
  if (!isSuper()) return toast('هذا الإجراء مخصص لمدير النظام.');
  const brandId = $('#fieldsBrandSelect').value;
  const brand = brands.find((item) => item.id === brandId);
  if (!brand) return toast('اختر البراند أولاً.');
  const button = $('#grantFieldsAccessBtn');
  setButtonBusy(button, true, 'جارٍ فتح الصلاحية...');
  try {
    const editAccessUntil = Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000));
    await patch('brands', brand.id, { editAccess: true, editAccessUntil, updatedAt: serverTimestamp() });
    brand.editAccess = true;
    brand.editAccessUntil = editAccessUntil;
    updateFieldsAccessUI();
    toast('تم فتح صلاحية مدير البراند لمدة 30 دقيقة.');
  } catch (error) {
    toast(error?.message || 'تعذر فتح الصلاحية.');
  } finally {
    setButtonBusy(button, false);
  }
};

function renderFields(brand) {
  const fields = currentBrandFields(brand);
  $('#fieldsRows').innerHTML = fields.map((field, index) => fieldRow(field, index)).join('');
}

function fieldRow(field, index) {
  const fieldType = ['text', 'tel', 'email', 'number', 'date', 'textarea'].includes(field.type) ? field.type : 'text';
  const system = ['name', 'phone'].includes(field.key);
  return `
    <div class="field-row" data-index="${index}">
      <input name="label" value="${esc(field.label || field.key)}" placeholder="اسم الحقل" maxlength="60" ${system ? 'readonly' : ''} aria-label="اسم الحقل">
      <input name="key" value="${esc(field.key)}" placeholder="المعرف" readonly aria-label="معرف الحقل">
      <select name="type" aria-label="نوع الحقل" ${system ? 'disabled' : ''}>
        <option value="text" ${fieldType === 'text' ? 'selected' : ''}>نص</option>
        <option value="tel" ${fieldType === 'tel' ? 'selected' : ''}>هاتف</option>
        <option value="email" ${fieldType === 'email' ? 'selected' : ''}>بريد</option>
        <option value="number" ${fieldType === 'number' ? 'selected' : ''}>رقم</option>
        <option value="date" ${fieldType === 'date' ? 'selected' : ''}>تاريخ</option>
        <option value="textarea" ${fieldType === 'textarea' ? 'selected' : ''}>نص طويل</option>
      </select>
      <label class="required-toggle"><input type="checkbox" name="required" ${field.required || system ? 'checked' : ''} ${system ? 'disabled' : ''}> مطلوب</label>
      <button type="button" class="action-btn" data-remove-field="${index}" ${system ? 'disabled' : ''}>حذف</button>
    </div>`;
}

$('#addFieldBtn').onclick = () => {
  if (!editingFields) return toast('افتح صلاحية التعديل أولاً.');
  const rows = $('#fieldsRows');
  if (rows.children.length >= 15) return toast('الحد الأقصى 15 حقلاً شاملاً الحقول الأساسية.');
  const key = `field_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  rows.insertAdjacentHTML('beforeend', fieldRow({ key, label: 'حقل جديد', type: 'text', required: false }, rows.children.length));
};

$('#fieldsRows').onclick = (event) => {
  const button = event.target.closest('[data-remove-field]');
  if (button && !button.disabled) button.closest('.field-row')?.remove();
};

$('#saveFieldsBtn').onclick = async () => {
  const button = $('#saveFieldsBtn');
  if (!editingFields) return toast('صلاحية التعديل غير مفتوحة.');
  setButtonBusy(button, true, 'جارٍ حفظ الحقول...');

  try {
    const brand = brands.find((item) => item.id === selectedFieldsBrand);
    const accessUntil = brand?.editAccessUntil?.toDate?.();
    const managerPermissionValid = brand?.editAccess === true && accessUntil instanceof Date && accessUntil > new Date();
    if (!brand || (!isSuper() && !managerPermissionValid)) {
      throw new Error('انتهت صلاحية التعديل. اطلب من مدير النظام فتحها مرة أخرى.');
    }

    const fields = [...$('#fieldsRows').querySelectorAll('.field-row')].map((row) => {
      const key = row.querySelector('[name="key"]').value;
      return {
        key,
        label: row.querySelector('[name="label"]').value.trim(),
        type: row.querySelector('[name="type"]').value,
        required: ['name', 'phone'].includes(key) || row.querySelector('[name="required"]').checked,
        system: ['name', 'phone'].includes(key),
      };
    });

    const keys = fields.map((field) => field.key);
    if (!fields.some((field) => field.key === 'name') || !fields.some((field) => field.key === 'phone')) {
      throw new Error('يجب الاحتفاظ بحقل الاسم ورقم الهاتف.');
    }
    if (new Set(keys).size !== keys.length || fields.some((field) =>
      !field.label || field.label.length > 60 || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.key) ||
      !['text', 'tel', 'email', 'number', 'date', 'textarea'].includes(field.type)
    )) {
      throw new Error('راجع الحقول: الأسماء مطلوبة، والمعرفات يجب أن تكون إنجليزية وفريدة.');
    }
    if (fields.length > 15) throw new Error('الحد الأقصى 15 حقلاً شاملاً الاسم والهاتف.');

    // Update every QR/NFC token in safe Firestore batches. If a batch fails,
    // permission stays open so the administrator can retry without changing URLs.
    const tokenIds = branches.filter((branch) => branch.brandId === brand.id)
      .flatMap((branch) => [branch.qrToken, branch.nfcToken].filter(Boolean));
    for (let offset = 0; offset < tokenIds.length; offset += 450) {
      const write = batch();
      for (const tokenId of tokenIds.slice(offset, offset + 450)) {
        write.update(firestoreDoc(db, 'branchTokens', tokenId), { fields });
      }
      await write.commit();
    }

    await patch('brands', brand.id, {
      fields,
      editAccess: false,
      editAccessUntil: null,
      updatedAt: serverTimestamp(),
    });

    brand.fields = fields;
    brand.editAccess = false;
    brand.editAccessUntil = null;
    editingFields = false;
    $('#fieldsEditor').classList.add('hidden');
    updateFieldsAccessUI();
    await loadAll();
    toast('تم حفظ الحقول وإغلاق التعديل تلقائياً.');
  } catch (error) {
    toast(error?.message || 'تعذر حفظ الحقول.');
  } finally {
    setButtonBusy(button, false);
  }
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    me = null;
    profile = null;
    $('#appView').classList.add('hidden');
    $('#authView').classList.remove('hidden');
    return;
  }

  let nextProfile;
  try {
    const userSnapshot = await getDoc(firestoreDoc(db, 'users', user.uid));
    if (!userSnapshot.exists() || userSnapshot.data().active !== true) {
      await logout();
      toast('هذا الحساب غير مفعل أو غير معتمد.');
      return;
    }

    nextProfile = userSnapshot.data();
    if (!['super_admin', 'brand_admin'].includes(nextProfile.role)) {
      await logout();
      toast('نوع الحساب غير مصرح له بالدخول.');
      return;
    }
    if (nextProfile.role === 'brand_admin') {
      if (typeof nextProfile.brandId !== 'string' || !nextProfile.brandId) {
        await logout();
        toast('حساب مدير البراند غير مرتبط ببراند.');
        return;
      }
      const brandSnapshot = await getDoc(firestoreDoc(db, 'brands', nextProfile.brandId));
      if (!brandSnapshot.exists() || brandSnapshot.data().active !== true) {
        await logout();
        toast('البراند متوقف حالياً.');
        return;
      }
    }
  } catch (error) {
    await logout();
    toast(`تعذر التحقق من الحساب: ${error?.message || 'خطأ غير معروف'}`);
    return;
  }

  me = user;
  profile = nextProfile;
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  renderAuthenticatedUser();
  renderLocalUrlWarning();
  await loadBrandImageCatalog();
  try {
    const loadResult = await loadAll();
    go('overview');
    if (loadResult.customerError) toast('تم تسجيل الدخول وتحميل بقية البيانات، لكن تعذر تحميل العملاء. راجع الاتصال والصلاحيات.');
  } catch (error) {
    toast(`تم تسجيل الدخول، لكن تعذر تحميل البيانات: ${error?.message || 'تحقق من الاتصال وقواعد Firestore'}`);
  }
});

// Escape closes the active modal and prevents stale modal overlays on mobile.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#modalRoot').firstElementChild) $('#modalRoot').innerHTML = '';
});
