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
const debriefScore = document.getElementById('debrief-score')!;
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

// ---- daily mode & scoring --------------------------------------------------
let dailyId: string | null = null; // e.g. "2026-08-31" while playing the daily
let lastResult: { text: string } | null = null;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function computeScore(state: MissionState, victory: boolean): number {
  const dead = state.units.filter((u) => u.faction === 'squad' && !u.alive).length;
  let score =
    1000 - (state.turn - 1) * 6 - state.alarm.level * 45 -
    state.civiliansKilled * 120 - dead * 80;
  if (state.alarm.level <= 1 && state.civiliansKilled === 0) score += 150; // ghost bonus
  if (!victory) score = Math.floor(score / 4);
  return Math.max(0, score);
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
const startFree = () => {
  dailyId = null;
  startOnce();
};
const startDaily = () => {
  dailyId = todayIso();
  citySelect.value = 'northchurch';
  seedInput.value = `daily-${dailyId}`;
  startOnce();
};
document.getElementById('start-btn')!.addEventListener('pointerup', startFree);
document.getElementById('start-btn')!.addEventListener('click', startFree);
document.getElementById('daily-btn')!.addEventListener('pointerup', startDaily);
document.getElementById('daily-btn')!.addEventListener('click', startDaily);

const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const copyResult = () => {
  if (!lastResult) return;
  navigator.clipboard.writeText(lastResult.text).then(
    () => {
      shareBtn.textContent = 'Copied!';
      setTimeout(() => (shareBtn.textContent = 'Copy result'), 1500);
    },
    () => (shareBtn.textContent = 'Copy failed'),
  );
};
shareBtn.addEventListener('pointerup', copyResult);
shareBtn.addEventListener('click', copyResult);
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
  // the daily fixes the contract type from the date so everyone plays the same job
  const questKind = dailyId
    ? ((hashSeed(seedInput.value) % 2 === 0 ? 'extract' : 'assassinate') as QuestKind)
    : ((questSelect.value || undefined) as QuestKind | undefined);

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
      const score = computeScore(state, victory);
      const alarm = state.alarm.level;
      const civ = state.civiliansKilled;
      debriefTitle.textContent = victory ? 'Contract Complete' : 'Lost to the City';
      debriefText.textContent =
        summary + ` (${state.turn} turn${state.turn === 1 ? '' : 's'} · alarm ${alarm}/5 · ` +
        `${civ} civilian${civ === 1 ? '' : 's'} harmed · ` +
        `${state.knowledge.clues.length} clues gathered.)`;
      let scoreLine = `Score: ${score}`;
      if (dailyId) {
        const key = `swatwizards.daily.${dailyId}`;
        let best = 0;
        try {
          best = Number(localStorage.getItem(key)) || 0;
        } catch { /* private mode */ }
        if (score > best) {
          best = score;
          try {
            localStorage.setItem(key, String(best));
          } catch { /* private mode */ }
        }
        scoreLine = `Daily ${dailyId} · Score: ${score} · Personal best: ${best}`;
      }
      debriefScore.textContent = scoreLine;
      const title = dailyId ? `Daily ${dailyId}` : `seed "${seedInput.value}"`;
      const pips = '▮'.repeat(alarm) + '▯'.repeat(5 - alarm);
      lastResult = {
        text:
          `Amnesiac SWAT Wizards – ${title}\n` +
          `${victory ? '✅' : '💀'} ${score} pts · ${state.turn} turns · 🔔 ${pips} · ` +
          `🕊️ ${civ === 0 ? 'clean' : `${civ} harmed`}\n` +
          `https://tanketom.github.io/amnesiacswatwizards/`,
      };
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
