// Outils — conversions aéronautiques et calculatrice générale.
// Aucun appel réseau ; virgule décimale acceptée partout.

const CONVERTERS = [
  { id: 'avgas', label: 'Avgas — gallons US ↔ litres', from: 'gal US', to: 'L', fwd: (v) => v * 3.78541, rev: (v) => v / 3.78541 },
  { id: 'avgaslb', label: 'Avgas — gallons US ↔ livres (6 lb/gal)', from: 'gal US', to: 'lb', fwd: (v) => v * 6, rev: (v) => v / 6 },
  { id: 'lbkg', label: 'Livres ↔ kilogrammes', from: 'lb', to: 'kg', fwd: (v) => v * 0.45359237, rev: (v) => v / 0.45359237 },
  { id: 'ftm', label: 'Pieds ↔ mètres', from: 'ft', to: 'm', fwd: (v) => v * 0.3048, rev: (v) => v / 0.3048 },
  { id: 'incm', label: 'Pouces ↔ centimètres', from: 'in', to: 'cm', fwd: (v) => v * 2.54, rev: (v) => v / 2.54 },
  { id: 'nmkm', label: 'Milles nautiques ↔ kilomètres', from: 'NM', to: 'km', fwd: (v) => v * 1.852, rev: (v) => v / 1.852 },
  { id: 'ktkmh', label: 'Nœuds ↔ km/h', from: 'kt', to: 'km/h', fwd: (v) => v * 1.852, rev: (v) => v / 1.852 },
  { id: 'cf', label: 'Degrés Celsius ↔ Fahrenheit', from: '°C', to: '°F', fwd: (v) => v * 9 / 5 + 32, rev: (v) => (v - 32) * 5 / 9 },
  { id: 'inhg', label: 'Pouces de mercure ↔ hectopascals', from: 'inHg', to: 'hPa', fwd: (v) => v * 33.8639, rev: (v) => v / 33.8639 },
];

function parseNumber(s) {
  if (typeof s === 'number') return s;
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function fmt(n, decimals = 2) {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Conversion dans le sens direct (utilisée par l'auto-test).
export function convertValue(kind, value) {
  const c = CONVERTERS.find((x) => x.id === kind);
  if (!c) return 'Convertisseur inconnu';
  const v = parseNumber(value);
  if (!Number.isFinite(v)) return 'Valeur invalide';
  return fmt(c.fwd(v)) + ' ' + c.to;
}

// Conversion dans le sens inverse (utilisée par l'auto-test).
export function convertValueReverse(kind, value) {
  const c = CONVERTERS.find((x) => x.id === kind);
  if (!c) return 'Convertisseur inconnu';
  const v = parseNumber(value);
  if (!Number.isFinite(v)) return 'Valeur invalide';
  return fmt(c.rev(v)) + ' ' + c.from;
}

export function initTools() {
  const wrap = document.getElementById('converters');
  wrap.innerHTML = '';
  for (const c of CONVERTERS) {
    const row = document.createElement('div');
    row.className = 'converter-row';
    row.innerHTML =
      `<label for="conv-${c.id}">${c.label}</label>` +
      `<input id="conv-${c.id}" type="text" inputmode="decimal" placeholder="0" aria-label="${c.label} (${c.from})">` +
      `<span class="conv-unit">${c.from}</span>` +
      `<input id="conv-${c.id}-2" type="text" inputmode="decimal" placeholder="0" aria-label="${c.label} (${c.to})">` +
      `<span class="conv-unit">${c.to}</span>` +
      `<span class="conv-error" role="alert"></span>`;
    const inputA = row.querySelector('#conv-' + c.id);
    const inputB = row.querySelector('#conv-' + c.id + '-2');
    const error = row.querySelector('.conv-error');
    // Drapeau de mise à jour programmatique : écrire dans un champ ne doit
    // pas redéclencher l'autre en boucle.
    let updating = false;
    const convert = (fromInput, toInput, fn) => {
      if (updating) return;
      if (fromInput.value.trim() === '') {
        updating = true;
        toInput.value = '';
        updating = false;
        error.textContent = '';
        return;
      }
      const v = parseNumber(fromInput.value);
      if (!Number.isFinite(v)) {
        updating = true;
        toInput.value = '';
        updating = false;
        error.textContent = 'Valeur invalide — entrez un nombre.';
        return;
      }
      error.textContent = '';
      updating = true;
      toInput.value = fmt(fn(v));
      updating = false;
    };
    inputA.addEventListener('input', () => convert(inputA, inputB, c.fwd));
    inputB.addEventListener('input', () => convert(inputB, inputA, c.rev));
    wrap.appendChild(row);
  }

  // Calculatrice générale.
  const display = document.getElementById('calcDisplay');
  const buttons = document.getElementById('calcButtons');
  const error = document.getElementById('calcError');
  const keys = ['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', ',', '.', '+', '(', ')', '%', 'C', '⌫', '='];
  buttons.innerHTML = '';
  for (const k of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k === '*' ? '×' : k === '/' ? '÷' : k === '-' ? '−' : k;
    if (['/', '*', '-', '+', '%'].includes(k)) b.classList.add('op');
    if (k === '=') b.classList.add('eq');
    b.addEventListener('click', (e) => {
      error.textContent = '';
      if (k === 'C') display.value = '';
      else if (k === '⌫') display.value = display.value.slice(0, -1);
      else if (k === '=') {
        try { display.value = evaluateExpression(display.value); }
        catch { error.textContent = 'Expression invalide.'; }
      } else display.value += k;
      e.currentTarget.blur();
    });
    buttons.appendChild(b);
  }
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      try { display.value = evaluateExpression(display.value); }
      catch { error.textContent = 'Expression invalide.'; }
    }
  });
}

// Évalue une expression arithmétique simple, caractères autorisés seulement.
export function evaluateExpression(expr) {
  const clean = String(expr).replace(',', '.').replace(/\s+/g, '');
  if (!/^[0-9+\-*/().%]+$/.test(clean) || clean === '') throw new Error('Expression invalide');
  const withPercent = clean.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  const value = Function('"use strict"; return (' + withPercent + ')')();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Résultat invalide');
  return value.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
}
