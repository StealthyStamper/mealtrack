/* MealTrack — scan barcodes, track nutrition. All data stays on-device. */
'use strict';

// ---------- Constants ----------
const STORE_KEY = 'mealtrack.v1';
const OFF_BASE = 'https://world.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,generic_name,brands,image_front_small_url,serving_size,serving_quantity,nutriments';
const MEALS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snacks', label: 'Snacks' },
];
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'sugar', 'fiber', 'salt'];
const MACROS = [
  { key: 'protein', label: 'Protein', color: 'var(--protein)' },
  { key: 'carbs', label: 'Carbs', color: 'var(--carbs)' },
  { key: 'fat', label: 'Fat', color: 'var(--fat)' },
];
const DEFAULT_GOALS = { kcal: 2000, protein: 120, carbs: 220, fat: 70 };

// ---------- State & persistence ----------
let state = load();
let currentDate = todayKey();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { goals: { ...DEFAULT_GOALS, ...s.goals }, log: s.log || {}, foods: s.foods || {} };
    }
  } catch (e) { console.warn('Failed to load data', e); }
  return { goals: { ...DEFAULT_GOALS }, log: {}, foods: {} };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage may be full.'); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayKey() { return dateKey(new Date()); }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftDay(k, delta) { const d = parseKey(k); d.setDate(d.getDate() + delta); return dateKey(d); }
function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '–';
  const p = 10 ** digits;
  return String(Math.round(n * p) / p);
}
function num(v) { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
function emptyN() { return Object.fromEntries(NUTRIENTS.map((k) => [k, 0])); }
function addN(a, b) { for (const k of NUTRIENTS) a[k] += b[k] || 0; return a; }
function scaleN(n, f) { return Object.fromEntries(NUTRIENTS.map((k) => [k, n[k] == null ? null : n[k] * f])); }
function defaultMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snacks';
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Food model ----------
// food: { id, barcode, name, brand, image, per100?, perServing?, servingGrams?, servingLabel?, source, lastUsed, uses }
function unitsFor(food) {
  const units = [];
  if (food.per100) units.push({ id: 'g', label: 'grams' });
  if (food.perServing || (food.per100 && food.servingGrams)) {
    const lbl = food.servingLabel || (food.servingGrams ? `${fmt(food.servingGrams)} g` : '');
    units.unshift({ id: 'serving', label: lbl ? `serving (${lbl})` : 'serving' });
  }
  return units;
}
function nutrientsFor(food, amount, unit) {
  if (!(amount > 0)) return emptyN();
  if (unit === 'serving') {
    if (food.per100 && food.servingGrams) return scaleN(food.per100, (food.servingGrams * amount) / 100);
    if (food.perServing) return scaleN(food.perServing, amount);
  }
  if (food.per100) return scaleN(food.per100, amount / 100);
  return emptyN();
}
function foodSummary(food) {
  if (food.per100) return `${fmt(food.per100.kcal)} kcal / 100 g`;
  if (food.perServing) return `${fmt(food.perServing.kcal)} kcal / serving`;
  return '';
}
function upsertFood(food) {
  state.foods[food.id] = { ...state.foods[food.id], ...food };
  save();
  return state.foods[food.id];
}
function findFoodByBarcode(code) {
  return Object.values(state.foods).find((f) => f.barcode && barcodeVariants(code).includes(f.barcode));
}
function barcodeVariants(code) {
  const c = String(code).replace(/\D/g, '');
  const v = [c];
  if (c.length === 12) v.push('0' + c);           // UPC-A -> EAN-13
  if (c.length === 13 && c[0] === '0') v.push(c.slice(1));
  return [...new Set(v)];
}

// ---------- Open Food Facts ----------
function offNutrients(nm, suffix) {
  const g = (k) => num(nm[`${k}_${suffix}`]);
  let kcal = g('energy-kcal');
  if (kcal == null) { const kj = g('energy-kj') ?? g('energy'); if (kj != null) kcal = kj / 4.184; }
  const out = {
    kcal, protein: g('proteins'), carbs: g('carbohydrates'), fat: g('fat'),
    sugar: g('sugars'), fiber: g('fiber'), salt: g('salt'),
  };
  if (out.salt == null) { const na = g('sodium'); if (na != null) out.salt = na * 2.5; }
  return Object.values(out).some((v) => v != null) ? out : null;
}
function offToFood(p) {
  const nm = p.nutriments || {};
  const per100 = offNutrients(nm, '100g');
  const perServing = per100 ? null : offNutrients(nm, 'serving');
  const sq = num(p.serving_quantity);
  return {
    id: 'off:' + p.code,
    barcode: p.code,
    name: (p.product_name || p.generic_name || 'Unnamed product').trim(),
    brand: (p.brands || '').split(',')[0].trim(),
    image: p.image_front_small_url || '',
    per100: per100 || undefined,
    perServing: perServing || undefined,
    servingGrams: sq > 0 ? sq : undefined,
    servingLabel: p.serving_size || undefined,
    source: 'off',
  };
}
async function offFetch(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}
async function lookupBarcode(code) {
  for (const c of barcodeVariants(code)) {
    const data = await offFetch(`${OFF_BASE}/api/v2/product/${encodeURIComponent(c)}.json?fields=${OFF_FIELDS}`);
    if (data && data.status === 1 && data.product) {
      data.product.code = data.product.code || c;
      return offToFood(data.product);
    }
  }
  return null;
}
async function searchOFF(q) {
  const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}`;
  const data = await offFetch(url, 20000);
  return (data.products || []).filter((p) => p.code && p.nutriments).map(offToFood).filter((f) => f.per100 || f.perServing);
}

// ---------- Barcode flow ----------
async function handleBarcode(code) {
  code = String(code).replace(/\D/g, '');
  if (code.length < 6) { toast('That doesn’t look like a barcode.'); return; }
  const cached = findFoodByBarcode(code);
  if (cached) { openAddSheet(cached); return; }
  setScanStatus(`Looking up ${code}…`);
  try {
    const food = await lookupBarcode(code);
    if (food && (food.per100 || food.perServing)) {
      setScanStatus('Point your camera at a barcode.');
      openAddSheet(upsertFood(food));
    } else {
      setScanStatus('Product not found.');
      openFoodSheet({ barcode: code, name: food ? food.name : '', brand: food ? food.brand : '' },
        food ? 'This product has no nutrition data yet. Enter it from the label and it’ll be remembered.'
             : 'Not in the database. Enter it from the label and it’ll be remembered next time.');
    }
  } catch (e) {
    console.error(e);
    setScanStatus('Lookup failed. Check your connection.');
    toast('Couldn’t reach Open Food Facts. You can add it as a custom food.');
  }
}

// ---------- Scanner ----------
let scanner = null;
let scanning = false;
function setScanStatus(t) { $('#scan-status').textContent = t; }
async function startScanner() {
  if (scanning) return;
  if (!window.Html5Qrcode) { setScanStatus('Scanner failed to load.'); return; }
  if (!window.isSecureContext) { setScanStatus('Camera needs HTTPS. Open the app from its https:// address.'); return; }
  const F = window.Html5QrcodeSupportedFormats;
  scanner = scanner || new Html5Qrcode('reader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  $('#scan-toggle').disabled = true;
  try {
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        qrbox: (w, h) => ({ width: Math.min(w * 0.85, 320), height: Math.min(h * 0.45, 160) }),
        aspectRatio: 1.333,
      },
      async (text) => {
        if (!scanning) return;
        await stopScanner();
        if (navigator.vibrate) navigator.vibrate(80);
        handleBarcode(text);
      },
      () => {},
    );
    scanning = true;
    setScanStatus('Point your camera at a barcode.');
    $('#scan-toggle').textContent = 'Stop camera';
  } catch (e) {
    console.error(e);
    setScanStatus('Camera unavailable. Allow camera access, or type the barcode below.');
  } finally { $('#scan-toggle').disabled = false; }
}
async function stopScanner() {
  if (!scanner || !scanning) return;
  scanning = false;
  try { await scanner.stop(); scanner.clear(); } catch (e) { console.warn(e); }
  $('#scan-toggle').textContent = 'Start camera';
}

function resumeScannerIfIdle(committed) {
  setTimeout(() => {
    if (!committed && $('#view-scan').classList.contains('active') && !$('#add-sheet').open && !$('#food-sheet').open) startScanner();
  }, 0);
}

// ---------- Views ----------
const TITLES = { today: 'Today', scan: 'Scan', foods: 'My foods', settings: 'Settings' };
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#view-title').textContent = TITLES[name];
  if (name === 'scan') startScanner(); else stopScanner();
  if (name === 'today') renderToday();
  if (name === 'foods') renderFoods();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function dayEntries(k = currentDate) { return state.log[k] || []; }

function renderToday() {
  const t = todayKey();
  const d = parseKey(currentDate);
  const rel = currentDate === t ? 'Today' : currentDate === shiftDay(t, -1) ? 'Yesterday' : currentDate === shiftDay(t, 1) ? 'Tomorrow' : null;
  const long = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#date-label').textContent = rel ? `${rel} · ${long}` : long;
  $('#view-title').textContent = rel === 'Today' ? 'Today' : 'Diary';

  const entries = dayEntries();
  const total = entries.reduce((acc, e) => addN(acc, e.n), emptyN());
  const g = state.goals;

  // Calorie ring
  const C = 2 * Math.PI * 52;
  const ratio = g.kcal ? total.kcal / g.kcal : 0;
  const ring = $('#kcal-ring');
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(ratio, 1));
  ring.classList.toggle('over', ratio > 1);
  const left = g.kcal - total.kcal;
  $('#kcal-left').textContent = fmt(Math.abs(left));
  $('#kcal-left-label').textContent = left >= 0 ? `kcal left of ${g.kcal}` : 'kcal over';

  // Macro bars
  $('#macro-bars').replaceChildren(...MACROS.map((m) => {
    const v = total[m.key]; const goal = g[m.key];
    const pct = goal ? Math.min(100, (v / goal) * 100) : 0;
    return el('div', { class: 'macro' },
      el('div', { class: 'label' }, el('span', {}, m.label), el('span', {}, `${fmt(v)} / ${goal} g`)),
      el('div', { class: 'bar' }, el('div', { style: `width:${pct}%;background:${v > goal ? 'var(--over)' : m.color}` })));
  }));

  // Meals
  $('#meals').replaceChildren(...MEALS.map((meal) => {
    const list = entries.filter((e) => e.meal === meal.id);
    const kcal = list.reduce((s, e) => s + (e.n.kcal || 0), 0);
    return el('div', { class: 'card' },
      el('div', { class: 'meal-head' }, el('h2', {}, meal.label), el('span', { class: 'kcal' }, `${fmt(kcal)} kcal`)),
      list.length ? el('ul', { class: 'entries' }, list.map((e) => el('li', {},
        el('div', { class: 'info', onclick: () => editEntry(e) },
          el('div', { class: 'name' }, e.name),
          el('div', { class: 'sub' }, [entryAmountLabel(e), `P ${fmt(e.n.protein)} · C ${fmt(e.n.carbs)} · F ${fmt(e.n.fat)}`].join(' · '))),
        el('span', { class: 'kcal' }, fmt(e.n.kcal)),
        el('button', { class: 'del-btn', 'aria-label': `Remove ${e.name}`, onclick: () => deleteEntry(e) }, '×'),
      ))) : null,
      el('button', { class: 'meal-add', onclick: () => { pendingMeal = meal.id; showView('scan'); } }, '+ Add food'));
  }));
}
function entryAmountLabel(e) {
  return e.unit === 'serving' ? `${fmt(e.amount, 2)} serving${e.amount === 1 ? '' : 's'}` : `${fmt(e.amount)} g`;
}
function deleteEntry(e) {
  const list = dayEntries(e.date);
  const idx = list.findIndex((x) => x.id === e.id);
  if (idx < 0) return;
  const [removed] = list.splice(idx, 1);
  save(); renderToday();
  toastUndo(`Removed ${removed.name}`, () => { list.splice(idx, 0, removed); state.log[e.date] = list; save(); renderToday(); });
}
function toastUndo(msg, undo) {
  const t = $('#toast');
  t.replaceChildren(msg + ' ', el('button', {
    class: 'link-btn', style: 'display:inline;width:auto;padding:0 0 0 8px;color:inherit;text-decoration:underline;pointer-events:auto',
    onclick: () => { undo(); t.classList.remove('show'); },
  }, 'Undo'));
  t.style.pointerEvents = 'auto';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.style.pointerEvents = ''; }, 4500);
}

function foodListItem(food, onclick) {
  return el('li', { onclick },
    food.image ? el('img', { src: food.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('div', { class: 'ph' }),
    el('div', { class: 'info' },
      el('div', { class: 'name' }, food.name),
      el('div', { class: 'sub' }, [food.brand, foodSummary(food)].filter(Boolean).join(' · '))));
}
function renderFoods() {
  const q = $('#foods-filter').value.trim().toLowerCase();
  const foods = Object.values(state.foods)
    .filter((f) => !q || `${f.name} ${f.brand || ''} ${f.barcode || ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || (b.uses || 0) - (a.uses || 0));
  $('#foods-list').replaceChildren(...foods.map((f) => foodListItem(f, () => openAddSheet(f))));
  $('#foods-empty').hidden = foods.length > 0;
  if (!foods.length && q) $('#foods-empty').hidden = false;
}

function renderSettings() {
  const f = $('#goals-form');
  for (const k of Object.keys(DEFAULT_GOALS)) f.elements[k].value = state.goals[k];
}

// ---------- Add / edit entry sheet ----------
let addCtx = null; // { food, entry? }
let pendingMeal = null;

function openAddSheet(food, entry = null) {
  addCtx = { food, entry };
  $('#add-name').textContent = food.name;
  $('#add-brand').textContent = [food.brand, food.barcode].filter(Boolean).join(' · ');
  const img = $('#add-img');
  if (food.image) { img.src = food.image; img.referrerPolicy = 'no-referrer'; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }

  const units = unitsFor(food);
  $('#add-unit').replaceChildren(...units.map((u) => el('option', { value: u.id }, u.label)));
  $('#add-meal').replaceChildren(...MEALS.map((m) => el('option', { value: m.id }, m.label)));

  if (entry) {
    $('#add-unit').value = units.some((u) => u.id === entry.unit) ? entry.unit : units[0].id;
    $('#add-amount').value = entry.amount;
    $('#add-meal').value = entry.meal;
    $('#add-submit').textContent = 'Update';
  } else {
    const last = food.lastAmount && units.some((u) => u.id === food.lastAmount.unit) ? food.lastAmount : null;
    $('#add-unit').value = last ? last.unit : units[0].id;
    $('#add-amount').value = last ? last.amount : ($('#add-unit').value === 'serving' ? 1 : 100);
    $('#add-meal').value = pendingMeal || defaultMeal();
    $('#add-submit').textContent = 'Add';
  }
  const missing = food.per100 ? NUTRIENTS.filter((k) => food.per100[k] == null) : [];
  $('#add-note').textContent = missing.length && missing.length < NUTRIENTS.length
    ? `Missing data: ${missing.join(', ')}.` : '';
  updateAddPreview();
  $('#add-sheet').showModal();
}
function updateAddPreview() {
  if (!addCtx) return;
  const n = nutrientsFor(addCtx.food, num($('#add-amount').value), $('#add-unit').value);
  const cells = [['kcal', 'kcal', 0], ['protein', 'protein', 1], ['carbs', 'carbs', 1], ['fat', 'fat', 1]];
  $('#add-nutri').replaceChildren(...cells.map(([k, label, dg]) =>
    el('div', {}, el('strong', {}, fmt(n[k], dg)), el('span', {}, label === 'kcal' ? 'kcal' : `${label} g`))));
}
function editEntry(e) {
  const food = state.foods[e.foodId] || entryAsFood(e);
  openAddSheet(food, e);
}
function entryAsFood(e) {
  // Food was deleted — rebuild a minimal food from the entry so it can still be edited.
  const per = e.unit === 'serving' ? { perServing: scaleN(e.n, 1 / e.amount) } : { per100: scaleN(e.n, 100 / e.amount) };
  return { id: e.foodId || 'tmp:' + e.id, name: e.name, brand: e.brand, ...per };
}
$('#add-amount').addEventListener('input', updateAddPreview);
$('#add-unit').addEventListener('change', () => {
  $('#add-amount').value = $('#add-unit').value === 'serving' ? 1 : (addCtx.food.servingGrams || 100);
  updateAddPreview();
});
$('#add-sheet').addEventListener('close', () => {
  const sheet = $('#add-sheet');
  if (sheet.returnValue === 'add' && addCtx) commitEntry();
  const committed = sheet.returnValue === 'add';
  sheet.returnValue = '';
  addCtx = null;
  resumeScannerIfIdle(committed);
});
$('#add-edit-food').addEventListener('click', () => {
  const food = addCtx.food;
  addCtx = null;
  $('#add-sheet').close();
  openFoodSheet(food, 'Edits apply to future entries.');
});
function commitEntry() {
  const { food, entry } = addCtx;
  const amount = num($('#add-amount').value);
  if (!(amount > 0)) { toast('Enter an amount.'); return; }
  const unit = $('#add-unit').value;
  const meal = $('#add-meal').value;
  const n = nutrientsFor(food, amount, unit);
  const date = entry ? entry.date : currentDate;
  const list = state.log[date] || (state.log[date] = []);
  if (entry) {
    Object.assign(list.find((x) => x.id === entry.id) || {}, { amount, unit, meal, n });
  } else {
    list.push({ id: uid(), date, foodId: food.id, name: food.name, brand: food.brand || '', amount, unit, meal, n, t: Date.now() });
  }
  if (state.foods[food.id]) {
    Object.assign(state.foods[food.id], { lastUsed: Date.now(), uses: (food.uses || 0) + (entry ? 0 : 1), lastAmount: { amount, unit } });
  }
  save();
  pendingMeal = null;
  toast(entry ? 'Entry updated' : `Added ${food.name} · ${fmt(n.kcal)} kcal`);
  showView('today');
}

// ---------- Custom / edit food sheet ----------
let foodCtx = null;
function openFoodSheet(food = {}, hint = '') {
  foodCtx = food;
  const f = $('#food-form');
  f.reset();
  $('#food-sheet-title').textContent = food.id ? 'Edit food' : 'Custom food';
  $('#food-sheet-hint').textContent = hint;
  f.elements.name.value = food.name || '';
  f.elements.brand.value = food.brand || '';
  f.elements.barcode.value = food.barcode || '';
  f.elements.servingGrams.value = food.servingGrams || '';
  const basis = food.per100 ? '100' : food.perServing ? 'serving' : '100';
  f.elements.basis.value = basis;
  const n = food.per100 || food.perServing || {};
  for (const k of NUTRIENTS) f.elements[k].value = n[k] != null ? fmt(n[k], 2) : '';
  $('#food-sheet').showModal();
}
$('#food-sheet').addEventListener('close', () => {
  const sheet = $('#food-sheet');
  const ok = sheet.returnValue === 'save';
  sheet.returnValue = '';
  if (!ok) { foodCtx = null; resumeScannerIfIdle(false); return; }
  const f = $('#food-form').elements;
  const n = Object.fromEntries(NUTRIENTS.map((k) => [k, num(f[k].value)]));
  const servingGrams = num(f.servingGrams.value);
  const barcode = f.barcode.value.replace(/\D/g, '');
  const prev = foodCtx || {};
  const food = {
    id: prev.id || (barcode ? 'custom:' + barcode : 'custom:' + uid()),
    barcode: barcode || undefined,
    name: f.name.value.trim() || 'Custom food',
    brand: f.brand.value.trim(),
    image: prev.image || '',
    servingGrams: servingGrams > 0 ? servingGrams : undefined,
    servingLabel: servingGrams > 0 ? `${fmt(servingGrams)} g` : undefined,
    source: prev.source || 'custom',
    per100: undefined, perServing: undefined,
  };
  if (f.basis.value === 'serving') {
    if (servingGrams > 0) food.per100 = scaleN(n, 100 / servingGrams);
    else food.perServing = n;
  } else food.per100 = n;
  foodCtx = null;
  const saved = upsertFood(food);
  // Clean up keys explicitly cleared above
  if (!food.per100) delete saved.per100;
  if (!food.perServing) delete saved.perServing;
  if (!food.servingGrams) { delete saved.servingGrams; delete saved.servingLabel; }
  save();
  openAddSheet(saved);
});

// ---------- Event wiring ----------
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view !== 'scan') pendingMeal = null;
  showView(b.dataset.view);
}));
$('#prev-day').addEventListener('click', () => { currentDate = shiftDay(currentDate, -1); renderToday(); });
$('#next-day').addEventListener('click', () => { currentDate = shiftDay(currentDate, 1); renderToday(); });
$('#date-label').addEventListener('click', () => { currentDate = todayKey(); renderToday(); });

$('#scan-toggle').addEventListener('click', () => (scanning ? stopScanner() : startScanner()));
$('#manual-code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#manual-code').value;
  $('#manual-code').value = '';
  $('#manual-code').blur();
  handleBarcode(code);
});
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-q').value.trim();
  if (!q) return;
  $('#search-q').blur();
  const out = $('#search-results');
  const ql = q.toLowerCase();
  const local = Object.values(state.foods).filter((f) => `${f.name} ${f.brand || ''}`.toLowerCase().includes(ql)).slice(0, 5);
  const render = (remote, msg) => {
    const seen = new Set(local.map((f) => f.id));
    const items = [...local, ...remote.filter((f) => !seen.has(f.id))];
    out.replaceChildren(...items.map((f) => foodListItem(f, () => openAddSheet(state.foods[f.id] || upsertFood(f)))),
      msg ? el('p', { class: 'muted small center' }, msg) : null);
  };
  render([], 'Searching Open Food Facts…');
  try {
    const remote = await searchOFF(q);
    render(remote, remote.length || local.length ? '' : 'No results. Try a different name or create a custom food.');
  } catch (err) {
    console.error(err);
    render([], 'Search failed. Check your connection.');
  }
});
$('#custom-food-btn').addEventListener('click', () => openFoodSheet({}, ''));
$('#foods-filter').addEventListener('input', renderFoods);

$('#goals-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  for (const k of Object.keys(DEFAULT_GOALS)) { const v = num(f[k].value); if (v != null && v >= 0) state.goals[k] = Math.round(v); }
  save(); toast('Goals saved');
});
$('#export-btn').addEventListener('click', () => {
  download(`mealtrack-backup-${todayKey()}.json`, JSON.stringify({ app: 'mealtrack', version: 1, ...state }, null, 2), 'application/json');
});
$('#export-csv-btn').addEventListener('click', () => {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['date', 'meal', 'name', 'brand', 'amount', 'unit', ...NUTRIENTS]];
  for (const date of Object.keys(state.log).sort()) {
    for (const e of state.log[date]) rows.push([date, e.meal, e.name, e.brand, e.amount, e.unit, ...NUTRIENTS.map((k) => fmt(e.n[k], 2))]);
  }
  download(`mealtrack-log-${todayKey()}.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'), 'text/csv');
});
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.log !== 'object' || typeof data.foods !== 'object') throw new Error('bad file');
    if (!confirm('Replace all current data with this backup?')) return;
    state = { goals: { ...DEFAULT_GOALS, ...data.goals }, log: data.log, foods: data.foods };
    save(); toast('Backup imported'); renderSettings();
  } catch { toast('That file isn’t a MealTrack backup.'); }
});
$('#reset-btn').addEventListener('click', () => {
  if (!confirm('Erase all foods, diary entries and goals from this device? This cannot be undone.')) return;
  state = { goals: { ...DEFAULT_GOALS }, log: {}, foods: {} };
  save(); renderSettings(); toast('All data erased');
});

// Close sheets when tapping the backdrop
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
}
// Pause the camera when the app goes to the background
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopScanner();
  else if ($('#view-scan').classList.contains('active') && !$('#add-sheet').open && !$('#food-sheet').open) startScanner();
});
// Roll the diary over to the new day if the app is left open past midnight
let lastToday = todayKey();
setInterval(() => {
  const t = todayKey();
  if (t !== lastToday) { if (currentDate === lastToday) currentDate = t; lastToday = t; if ($('#view-today').classList.contains('active')) renderToday(); }
}, 60000);

// ---------- Boot ----------
renderToday();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
