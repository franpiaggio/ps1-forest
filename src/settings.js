// Pre-start "Settings" screen — configure the forest before entering. Identical
// on desktop and mobile (plain HTML, touch-friendly), shown over the splash.
// Edits live straight into chunk.js's CONFIG, so whichever mode you then pick
// generates the world with these values. The 🎲 button picks a new world seed
// (applied at boot via onReseed).

import { CONFIG, setForestConfig } from './chunk.js';

const SPECIES = ['oak', 'ash', 'aspen', 'pine'];

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

// Returns a handle so the value can be set programmatically (e.g. Randomize).
function slider(parent, { label, min, max, step, value, fmt, onInput }) {
  const row = el('div', 'margin:10px 0;');
  const top = el('div', 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;');
  const name = el('span', 'color:#cfd5dc;font-size:13px;letter-spacing:0.04em;', label);
  const val = el('span', 'color:#ffd482;font-size:13px;font-variant-numeric:tabular-nums;', (fmt ? fmt(value) : value));
  top.append(name, val);
  const input = el('input', 'width:100%;height:26px;accent-color:#ffd482;cursor:pointer;');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const apply = (v) => { input.value = v; val.textContent = fmt ? fmt(+v) : +v; onInput(+v); };
  input.addEventListener('input', () => apply(input.value));
  row.append(top, input);
  parent.appendChild(row);
  return {
    set: apply,
    randomize: () => {
      const steps = Math.max(1, Math.round((max - min) / step));
      apply(+(min + Math.floor(Math.random() * (steps + 1)) * step).toFixed(6));
    },
  };
}

function groupTitle(text) {
  return el('div',
    'color:#6f7a83;font-size:11px;letter-spacing:0.10em;text-transform:uppercase;' +
    'margin:18px 0 2px;border-top:1px solid rgba(255,255,255,0.07);padding-top:14px;', text);
}

const SEASON_LIST = [
  ['otono', 'Autumn'], ['invierno', 'Winter'], ['primavera', 'Spring'], ['verano', 'Summer'],
];

export function buildSettings({ onReseed, onSeason } = {}) {
  const overlay = el('div',
    'position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;' +
    'background:rgba(8,11,14,0.92);backdrop-filter:blur(5px);padding:18px;' +
    'font-family:ui-monospace,Menlo,Consolas,monospace;');

  const card = el('div',
    'width:100%;max-width:440px;max-height:88vh;overflow-y:auto;padding:22px 24px;' +
    'background:rgba(20,26,32,0.96);border:1px solid rgba(255,255,255,0.08);border-radius:14px;' +
    '-webkit-overflow-scrolling:touch;');
  overlay.appendChild(card);

  card.appendChild(el('h2', 'margin:0 0 2px;font-size:17px;letter-spacing:0.04em;color:#e8edf2;', 'Configure forest'));
  card.appendChild(el('p', 'margin:0 0 6px;color:#6f7a83;font-size:11px;letter-spacing:0.05em;',
    'applied on entry · same on desktop and mobile'));

  // ── Season ──
  card.appendChild(groupTitle('Season'));
  const seasonRow = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;');
  let current = 'verano';
  const seasonBtns = [];
  for (const [key, label] of SEASON_LIST) {
    const b = el('button', null, label);
    b.type = 'button';
    const paint = () => {
      const on = current === key;
      b.style.cssText =
        'padding:11px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;' +
        (on ? 'background:rgba(255,212,130,0.92);color:#1a1308;border:none;'
            : 'background:rgba(48,60,70,0.6);color:#cfd5dc;border:1px solid rgba(255,255,255,0.1);');
    };
    b.addEventListener('click', () => { current = key; seasonBtns.forEach((x) => x.paint()); onSeason?.(key); });
    b.paint = paint; paint();
    seasonBtns.push(b);
    seasonRow.appendChild(b);
  }
  card.appendChild(seasonRow);

  const randomizers = [];   // every slider handle, for the Randomize button

  // ── Species mix ──
  card.appendChild(groupTitle('Species mix (× weight)'));
  const SP_LABEL = { oak: 'Oak', ash: 'Ash', aspen: 'Aspen', pine: 'Pine' };
  for (const k of SPECIES) {
    randomizers.push(slider(card, {
      label: SP_LABEL[k], min: 0, max: 4, step: 0.1, value: CONFIG.speciesWeight[k],
      fmt: (v) => '×' + v.toFixed(1),
      onInput: (v) => setForestConfig({ speciesWeight: { [k]: v } }),
    }));
  }

  // ── Density ──
  card.appendChild(groupTitle('Density (objects per zone)'));
  randomizers.push(slider(card, { label: 'Clearing (min)', min: 0, max: 20, step: 1, value: CONFIG.densityMin, onInput: (v) => setForestConfig({ densityMin: v }) }));
  randomizers.push(slider(card, { label: 'Thicket (max)', min: 5, max: 40, step: 1, value: CONFIG.densityMax, onInput: (v) => setForestConfig({ densityMax: v }) }));
  randomizers.push(slider(card, { label: 'Zone size (m)', min: 30, max: 250, step: 5, value: CONFIG.densityZone, onInput: (v) => setForestConfig({ densityZone: v }) }));

  // ── Groves ──
  card.appendChild(groupTitle('Groves'));
  randomizers.push(slider(card, { label: 'Grove size (m)', min: 20, max: 200, step: 5, value: CONFIG.groveZone, onInput: (v) => setForestConfig({ groveZone: v }) }));
  randomizers.push(slider(card, { label: 'Edge mixing', min: 0, max: 0.6, step: 0.01, value: CONFIG.offSpecies, fmt: (v) => v.toFixed(2), onInput: (v) => setForestConfig({ offSpecies: v }) }));
  randomizers.push(slider(card, { label: 'Bush amount', min: 0, max: 0.6, step: 0.01, value: CONFIG.bushChance, fmt: (v) => v.toFixed(2), onInput: (v) => setForestConfig({ bushChance: v }) }));

  // ── Giants ──
  card.appendChild(groupTitle('Giant trees (rare)'));
  randomizers.push(slider(card, { label: 'Frequency', min: 0, max: 0.1, step: 0.005, value: CONFIG.giantChance, fmt: (v) => v.toFixed(3), onInput: (v) => setForestConfig({ giantChance: v }) }));

  // Pick a random season (updates the buttons + applies it).
  function randomizeSeason() {
    const [key] = SEASON_LIST[Math.floor(Math.random() * SEASON_LIST.length)];
    current = key;
    seasonBtns.forEach((x) => x.paint());
    onSeason?.(key);
  }

  // ── Buttons ──
  const btnRow = el('div', 'display:flex;gap:8px;margin-top:20px;');
  const mkBtn = (text, primary) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.style.cssText =
      'flex:1;padding:14px;border:none;border-radius:10px;font:inherit;font-size:13px;' +
      'font-weight:600;letter-spacing:0.06em;cursor:pointer;' +
      (primary
        ? 'background:rgba(255,212,130,0.92);color:#1a1308;'
        : 'background:rgba(48,60,70,0.95);color:#cfd5dc;border:1px solid rgba(255,255,255,0.10);');
    return b;
  };

  let seedN = 1;
  const reseed = () => { seedN = (seedN * 1664525 + 1013904223) & 0x7fffffff; onReseed?.(seedN); };

  // Randomize EVERYTHING: season, species mix, density, groves, giants + a new seed.
  const randomizeAll = () => {
    randomizeSeason();
    for (const r of randomizers) r.randomize();
    reseed();
  };
  const randomBtn = mkBtn('🎲 Randomize', false);
  randomBtn.addEventListener('click', randomizeAll);
  const reseedBtn = mkBtn('↻ Seed', false);
  reseedBtn.addEventListener('click', reseed);
  const doneBtn = mkBtn('Done ✓', true);
  doneBtn.addEventListener('click', () => hide());
  btnRow.append(randomBtn, reseedBtn, doneBtn);
  card.appendChild(btnRow);

  document.body.appendChild(overlay);
  function show() { overlay.style.display = 'flex'; }
  function hide() { overlay.style.display = 'none'; }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });

  return { show, hide, el: overlay };
}
