/** Bootstrap: menu -> mission -> debrief. */
import { Application } from 'pixi.js';
import { hashSeed } from './core/rng';
import { EventBus } from './core/events';
import { generateFallbackCity } from './map/fallbackCity';
import { importMfcg } from './map/mfcgImport';
import { rasterizeCity } from './map/rasterize';
import type { CityModel } from './map/cityModel';
import { MissionState } from './sim/game';
import type { QuestKind } from './sim/types';
import { Renderer, UiMode } from './render/renderer';
import { Hud } from './ui/hud';
import { attachInput } from './ui/input';

const gameEl = document.getElementById('game')!;
const menuEl = document.getElementById('menu')!;
const debriefEl = document.getElementById('debrief')!;
const debriefTitle = document.getElementById('debrief-title')!;
const debriefText = document.getElementById('debrief-text')!;
const seedInput = document.getElementById('seed-input') as HTMLInputElement;
const questSelect = document.getElementById('quest-select') as HTMLSelectElement;
const citySelect = document.getElementById('city-select') as HTMLSelectElement;
const cityStatus = document.getElementById('city-status')!;

let app: Application | null = null;
let detachInput: (() => void) | null = null;
const bundledCache = new Map<string, unknown>();

// ---- imported-city library, persisted in the browser -----------------------
const CITY_STORE_KEY = 'swatwizards.cities';
const MAX_STORED_CITIES = 8;

interface StoredCity {
  name: string;
  json: unknown;
}

function loadStoredCities(): StoredCity[] {
  try {
    const raw = localStorage.getItem(CITY_STORE_KEY);
    const list = raw ? (JSON.parse(raw) as StoredCity[]) : [];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.name === 'string') : [];
  } catch {
    return [];
  }
}

function saveStoredCities(cities: StoredCity[]): boolean {
  try {
    localStorage.setItem(CITY_STORE_KEY, JSON.stringify(cities.slice(-MAX_STORED_CITIES)));
    return true;
  } catch {
    return false; // private mode / quota — session-only import still works
  }
}

let storedCities = loadStoredCities();

function syncCityOptions(select: string | null = null): void {
  // remove old stored options, re-add current ones after the bundled entries
  for (const opt of [...citySelect.querySelectorAll('option[data-stored]')]) opt.remove();
  for (const c of storedCities) {
    const opt = document.createElement('option');
    opt.value = `stored:${c.name}`;
    opt.textContent = `${c.name} (imported)`;
    opt.dataset.stored = '1';
    citySelect.appendChild(opt);
  }
  if (select) citySelect.value = select;
}

// Bind both click and pointerup (some embedded panes deliver one but not the
// other); the guard prevents double-starting when both arrive.
let starting = false;
const startOnce = () => {
  if (starting) return;
  starting = true;
  cityStatus.textContent = 'Cutting a raid window into the city…';
  void startMission()
    .catch((err) => {
      cityStatus.textContent = `✗ Failed to start: ${(err as Error).message}`;
      menuEl.classList.remove('hidden');
    })
    .finally(() => {
      starting = false;
      if (menuEl.classList.contains('hidden')) cityStatus.textContent = '';
    });
};
document.getElementById('start-btn')!.addEventListener('pointerup', startOnce);
document.getElementById('start-btn')!.addEventListener('click', startOnce);
let debriefDismissed = false;
const backToMenu = () => {
  if (debriefDismissed || debriefEl.classList.contains('hidden')) return;
  debriefDismissed = true;
  setTimeout(() => (debriefDismissed = false), 300);
  debriefEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  // nudge the seed so "again" gives a fresh mission
  seedInput.value = seedInput.value.replace(/#\d+$/, '') + '#' + Math.floor(Math.random() * 1000);
};
document.getElementById('again-btn')!.addEventListener('pointerup', backToMenu);
document.getElementById('again-btn')!.addEventListener('click', backToMenu);

// Drag & drop a watabou MFCG export
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    try {
      const json = JSON.parse(text);
      const name = file.name.replace(/\.json$/i, '');
      // validate now so bad files fail at drop time, not at mission start
      const probe = importMfcg(json, { seed: 1, name });
      storedCities = [...storedCities.filter((c) => c.name !== name), { name, json }];
      const persisted = saveStoredCities(storedCities);
      syncCityOptions(`stored:${name}`);
      cityStatus.textContent =
        `✓ Loaded "${name}" – ${probe.buildings.length} buildings in the raid window.` +
        (persisted ? ' Saved to your city list.' : ' (Could not persist – available this session only.)');
    } catch (err) {
      cityStatus.textContent = `✗ Could not read that file: ${(err as Error).message}`;
    }
  });
});

syncCityOptions();

async function buildCityModel(seed: number): Promise<CityModel> {
  const choice = citySelect.value;
  if (choice.startsWith('stored:')) {
    const name = choice.slice('stored:'.length);
    const city = storedCities.find((c) => c.name === name);
    if (!city) throw new Error(`imported city "${name}" is gone from this browser`);
    return importMfcg(city.json, { seed, name });
  }
  if (choice !== 'procedural') {
    // bundled watabou export
    let json = bundledCache.get(choice);
    if (!json) {
      const res = await fetch(`${import.meta.env.BASE_URL}cities/${choice}.json`);
      if (!res.ok) throw new Error(`could not load bundled city "${choice}"`);
      json = await res.json();
      bundledCache.set(choice, json);
    }
    return importMfcg(json, { seed, name: choice[0].toUpperCase() + choice.slice(1) });
  }
  return generateFallbackCity(seed);
}

async function startMission(): Promise<void> {
  const seed = hashSeed(seedInput.value || 'anchor');
  const questKind = (questSelect.value || undefined) as QuestKind | undefined;

  // tear down previous mission
  if (detachInput) {
    detachInput();
    detachInput = null;
  }
  if (app) {
    app.destroy(true, { children: true });
    app = null;
  }

  let raster;
  let state: MissionState;
  const bus = new EventBus();
  try {
    const model = await buildCityModel(seed);
    raster = rasterizeCity(model, seed);
    state = new MissionState(raster, seed, bus, questKind);
  } catch (err) {
    cityStatus.textContent = `✗ This map didn't work out (${(err as Error).message}) – try another seed or city.`;
    return;
  }

  menuEl.classList.add('hidden');

  app = new Application();
  await app.init({
    background: 0x0b0b10,
    resizeTo: gameEl,
    antialias: true,
    // render at device pixels, not CSS pixels — crisp lines on retina displays
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  gameEl.appendChild(app.canvas);

  const ui: UiMode = { selectedUnitId: null, armedSpell: null };
  const renderer = new Renderer(app, state, ui);
  const hud = new Hud(state, ui);
  hud.onAction = () => {
    renderer.refreshUnits();
    renderer.drawRange();
  };
  detachInput = attachInput(app, state, renderer, ui, hud);

  // select the first wizard
  const first = state.squadUnits()[0];
  if (first) hud.select(first);

  bus.on('missionEnded', ({ victory, summary }) => {
    setTimeout(() => {
      debriefTitle.textContent = victory ? 'Contract Complete' : 'Lost to the City';
      debriefText.textContent =
        summary + ` (${state.turn} turns, alarm ${state.alarm.level}/5, ` +
        `${state.knowledge.clues.length} clues gathered.)`;
      debriefEl.classList.remove('hidden');
    }, 600);
  });

  hud.addLog('The portal snaps shut behind you. You have never seen this city before.', 'system');
  hud.addLog('Blue zone = your anchor stone (extraction). Gold outlines = possible hideouts.', 'system');

  if (import.meta.env.DEV) {
    // debug handles for playtesting
    (window as unknown as Record<string, unknown>).__game = { state, renderer, hud, ui };
  }
}
