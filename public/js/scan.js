import { db } from './firebase.js';
import {
  doc,
  getDoc,
  addDoc,
  collection,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const $ = (selector) => document.querySelector(selector);
const token = new URLSearchParams(location.search).get('token');
const CONSENT_VERSION = '1.0';
const DEFAULT_FIELDS = [
  { key: 'name', label: 'الاسم بالكامل', type: 'text', required: true, system: true },
  { key: 'phone', label: 'رقم الهاتف', type: 'tel', required: true, system: true },
  { key: 'purchase', label: 'ما المنتج الذي اشتريته؟', type: 'text', required: false },
];

let tokenData = null;
let submitting = false;

const escapeHTML = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

function renderField(field) {
  const key = escapeHTML(field.key);
  const label = escapeHTML(field.label.trim());
  const required = field.required ? 'required' : '';
  const requiredMark = field.required ? ' *' : '';

  if (field.type === 'textarea') {
    return `<label>${label}${requiredMark}<textarea name="${key}" rows="3" maxlength="1000" ${required}></textarea></label>`;
  }

  const allowedTypes = ['text', 'tel', 'email', 'number', 'date'];
  const type = allowedTypes.includes(field.type) ? field.type : 'text';
  const maxLength = field.key === 'name' ? 100 : field.key === 'phone' ? 30 : 1000;
  const minLength = field.key === 'name' ? 'minlength="2"' : field.key === 'phone' ? 'minlength="5"' : '';
  const autocomplete = field.key === 'name' ? 'autocomplete="name"' : field.key === 'phone' ? 'autocomplete="tel"' : '';
  return `<label>${label}${requiredMark}<input name="${key}" type="${type}" maxlength="${maxLength}" ${minLength} ${autocomplete} ${required}></label>`;
}

function validateTokenData(data) {
  if (
    data.active !== true ||
    typeof data.branchId !== 'string' || !data.branchId ||
    typeof data.brandId !== 'string' || !data.brandId ||
    typeof data.branchName !== 'string' || !data.branchName ||
    typeof data.brandName !== 'string' || !data.brandName ||
    !['qr', 'nfc'].includes(data.source)
  ) {
    throw new Error('هذا الفرع غير متاح حالياً.');
  }

  const fields = Array.isArray(data.fields) && data.fields.length ? data.fields : DEFAULT_FIELDS;
  const validFields = fields.filter((field) =>
    field &&
    typeof field.key === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.key) &&
    typeof field.label === 'string' && field.label.trim().length > 0 && field.label.length <= 60 &&
    (field.type === undefined || ['text', 'tel', 'email', 'number', 'date', 'textarea'].includes(field.type)) &&
    (field.required === undefined || typeof field.required === 'boolean')
  );

  if (
    validFields.length !== fields.length ||
    validFields.length > 15 ||
    new Set(validFields.map((field) => field.key)).size !== validFields.length ||
    !validFields.some((field) => field.key === 'name') ||
    !validFields.some((field) => field.key === 'phone')
  ) {
    throw new Error('نموذج التسجيل غير مضبوط. يرجى التواصل مع إدارة الفرع.');
  }

  return validFields;
}

async function initializeForm() {
  if (!token || token.length < 60 || token.length > 80) {
    throw new Error('رابط التسجيل غير مكتمل أو غير صالح.');
  }

  const snapshot = await getDoc(doc(db, 'branchTokens', token));
  if (!snapshot.exists()) throw new Error('رابط التسجيل غير صالح أو غير متاح.');

  tokenData = snapshot.data();
  const fields = validateTokenData(tokenData);
  $('#scanBranch').textContent = `${tokenData.brandName} · ${tokenData.branchName}`;
  const brandLogo = $('#scanBrandLogo');
  const brandImage = String(tokenData.brandImage || '');
  if (/^assets\/brands\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png|jpe?g|webp)$/i.test(brandImage)) {
    brandLogo.src = brandImage;
    brandLogo.alt = `شعار ${tokenData.brandName}`;
    brandLogo.hidden = false;
    const brandFavicon = document.createElement('link');
    brandFavicon.rel = 'icon';
    brandFavicon.href = brandImage;
    brandFavicon.dataset.brandFavicon = 'true';
    document.head.appendChild(brandFavicon);
    brandLogo.onerror = () => {
      brandLogo.hidden = true;
      brandLogo.removeAttribute('src');
      brandFavicon.remove();
    };
  } else {
    // Never substitute the platform/Archai mark on a customer-facing page.
    brandLogo.hidden = true;
    brandLogo.removeAttribute('src');
  }
  $('#customerFields').innerHTML = fields.map(renderField).join('');
}

$('#customerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!tokenData || submitting) return;

  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const submitButton = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  const name = String(formData.get('name') || '').trim();
  const phone = String(formData.get('phone') || '').trim();
  const consent = $('#privacyConsent').checked;

  if (name.length < 2 || name.length > 100 || phone.length < 5 || phone.length > 30) {
    $('#scanMessage').textContent = 'يرجى إدخال اسم صحيح ورقم هاتف صالح.';
    return;
  }
  if (!consent) {
    $('#scanMessage').textContent = 'يجب الموافقة على سياسة استخدام البيانات قبل الإرسال.';
    return;
  }

  const fields = validateTokenData(tokenData);
  const customFields = {};
  const validationErrors = [];

  const purchaseField = fields.find((field) => field.key === 'purchase');
  const purchase = String(formData.get('purchase') || '').trim();
  if (purchaseField?.required && !purchase) validationErrors.push(purchaseField.label);
  if (purchase.length > 1000) validationErrors.push(purchaseField?.label || 'المنتج');

  for (const field of fields) {
    if (['name', 'phone', 'purchase'].includes(field.key)) continue;
    const value = String(formData.get(field.key) || '').trim();
    if (field.required && !value) validationErrors.push(field.label);
    if (value.length > 1000) validationErrors.push(field.label);
    if (value) customFields[field.key] = value;
  }

  if (validationErrors.length) {
    $('#scanMessage').textContent = `يرجى مراجعة الحقول التالية: ${validationErrors.join('، ')}`;
    return;
  }
  if (Object.keys(customFields).length > 15) {
    $('#scanMessage').textContent = 'عدد الحقول الإضافية أكبر من المسموح.';
    return;
  }

  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = 'جاري تسجيل البيانات...';
  $('#scanMessage').textContent = '';

  try {
    await addDoc(collection(db, 'customers'), {
      name,
      phone,
      purchase: purchase.slice(0, 1000),
      customFields,
      consent: true,
      consentVersion: CONSENT_VERSION,
      consentAt: serverTimestamp(),
      brandId: tokenData.brandId,
      brandName: tokenData.brandName,
      branchId: tokenData.branchId,
      branchName: tokenData.branchName,
      source: tokenData.source,
      token,
      createdAt: serverTimestamp(),
    });

    $('#scanMessage').textContent = 'تم تسجيل بياناتك بنجاح. شكرًا لزيارتك!';
    form.classList.add('hidden');
  } catch (error) {
    $('#scanMessage').textContent = 'تعذر إرسال التسجيل. تحقق من اتصال الإنترنت وحاول مرة أخرى.';
    submitButton.disabled = false;
    submitButton.textContent = 'إرسال التسجيل';
    console.error('Customer registration failed:', error);
  } finally {
    submitting = false;
  }
});

initializeForm().catch((error) => {
  $('#scanBranch').textContent = error.message || 'تعذر تجهيز نموذج التسجيل.';
  $('#customerForm').classList.add('hidden');
});
