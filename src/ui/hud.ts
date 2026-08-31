/** DOM sidebar: quest, alarm, squad cards, spell buttons, log. */
import { Terrain } from '../core/grid';
import type { MissionState } from '../sim/game';
import type { UiMode } from '../render/renderer';
import { SPELLS } from '../sim/spells';
import { ALARM_LABELS } from '../sim/alarm';
import type { SpellId, Unit } from '../sim/types';

export class Hud {
  private el = {
    brief: document.getElementById('quest-brief')!,
    candidates: document.getElementById('candidates')!,
    pips: document.getElementById('alarm-pips')!,
    alarmLabel: document.getElementById('alarm-label')!,
    turnInd: document.getElementById('turn-ind')!,
    squad: document.getElementById('squad')!,
    log: document.getElementById('log')!,
    questionBtn: document.getElementById('question-btn') as HTMLButtonElement,
    pickupBtn: document.getElementById('pickup-btn') as HTMLButtonElement,
    searchBtn: document.getElementById('search-btn') as HTMLButtonElement,
    peekBtn: document.getElementById('peek-btn') as HTMLButtonElement,
    breachBtn: document.getElementById('breach-btn') as HTMLButtonElement,
    endTurn: document.getElementById('end-turn') as HTMLButtonElement,
  };

  onAction: () => void = () => {};

  constructor(
    private state: MissionState,
    private ui: UiMode,
  ) {
    const bus = state.bus;
    bus.on('log', ({ text, kind }) => this.addLog(text, kind ?? 'info'));
    bus.on('alarmChanged', () => this.refresh());
    bus.on('candidatesNarrowed', () => this.refresh());
    bus.on('turnStarted', ({ faction, turn }) => {
      if (faction === 'player') this.addLog(`– Turn ${turn} –`, 'system');
      this.refresh();
    });
    bus.on('unitDamaged', () => this.refresh());
    bus.on('unitDied', () => this.refresh());
    bus.on('questUpdated', ({ text }) => {
      this.el.brief.textContent = text;
    });

    this.el.endTurn.onpointerup = () => {
      if (this.state.phase !== 'player') return;
      this.ui.armedSpell = null;
      this.state.endTurn();
      this.onAction();
    };
    this.el.questionBtn.onpointerup = () => this.questionAdjacent();
    this.el.pickupBtn.onpointerup = () => this.pickupOrDrop();
    this.el.searchBtn.onpointerup = () => this.searchOrStash();
    this.el.peekBtn.onpointerup = () => this.peekAdjacent();
    this.el.breachBtn.onpointerup = () => this.breachAdjacent();

    this.el.brief.textContent = state.quest.briefing;
    this.refresh();
  }

  selectedUnit(): Unit | null {
    return this.ui.selectedUnitId !== null
      ? this.state.unitById(this.ui.selectedUnitId) ?? null
      : null;
  }

  select(u: Unit | null): void {
    this.ui.selectedUnitId = u?.id ?? null;
    this.ui.armedSpell = null;
    this.refresh();
    this.onAction();
  }

  /** After an action: if the current wizard is spent, hand off to the next one with AP. */
  maybeAdvance(): void {
    if (this.ui.armedSpell) return;
    const sel = this.selectedUnit();
    if (sel && sel.alive && !sel.subdued && sel.ap > 0) return;
    const next = this.state
      .squadUnits()
      .find((u) => u.ap > 0 && u.id !== this.ui.selectedUnitId);
    if (next) this.select(next);
  }

  armSpell(spell: SpellId): void {
    const u = this.selectedUnit();
    if (!u) return;
    if (this.ui.armedSpell === spell) {
      this.ui.armedSpell = null;
    } else if (this.state.canCast(u, spell) === null) {
      this.ui.armedSpell = spell;
      if (spell === 'scry' || spell === 'counterspell') {
        // self-cast immediately
        this.ui.armedSpell = null;
        this.state.castSpell(u, spell, u);
        this.maybeAdvance();
      }
    }
    this.refresh();
    this.onAction();
  }

  questionAdjacent(): void {
    const u = this.selectedUnit();
    if (!u) return;
    const civ = this.state.units.find(
      (c) =>
        c.faction === 'civilian' && c.alive && !c.subdued && c.carriedBy === null &&
        Math.max(Math.abs(c.x - u.x), Math.abs(c.y - u.y)) === 1,
    );
    if (!civ) {
      this.addLog('No one within arm\'s reach to question.', 'info');
      return;
    }
    this.state.question(u, civ);
    this.maybeAdvance();
    this.refresh();
    this.onAction();
  }

  /** First adjacent tile (8-way) satisfying the predicate, for context actions. */
  private adjacentTile(pred: (x: number, y: number) => boolean): { x: number; y: number } | null {
    const u = this.selectedUnit();
    if (!u) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (pred(u.x + dx, u.y + dy)) return { x: u.x + dx, y: u.y + dy };
    }
    return null;
  }

  private adjacentClosedDoor(): { x: number; y: number } | null {
    const grid = this.state.grid;
    return this.adjacentTile(
      (x, y) => grid.get(x, y) === Terrain.Door && !grid.isDoorOpen(x, y),
    );
  }

  peekAdjacent(): void {
    const u = this.selectedUnit();
    const door = this.adjacentClosedDoor();
    if (!u || !door) {
      this.addLog('No closed door within reach to peek under.', 'info');
      return;
    }
    this.state.peekDoor(u, door);
    this.onAction();
  }

  breachAdjacent(): void {
    const u = this.selectedUnit();
    const door = this.adjacentClosedDoor();
    if (!u || !door) {
      this.addLog('No closed door within reach to breach.', 'info');
      return;
    }
    this.state.breach(u, door);
    this.maybeAdvance();
    this.refresh();
    this.onAction();
  }

  searchOrStash(): void {
    const u = this.selectedUnit();
    const chest = this.adjacentTile((x, y) => this.state.grid.get(x, y) === Terrain.Container);
    if (!u || !chest) {
      this.addLog('No chest or cupboard within reach.', 'info');
      return;
    }
    if (u.carrying !== null) this.state.stashBody(u, chest);
    else this.state.searchContainer(u, chest);
    this.maybeAdvance();
    this.refresh();
    this.onAction();
  }

  pickupOrDrop(): void {
    const u = this.selectedUnit();
    if (!u) return;
    if (u.carrying !== null) {
      this.state.dropCarried(u);
    } else {
      const t = this.state.units.find(
        (c) => ((c.subdued && c.alive) || !c.alive) && !c.stashed && c.carriedBy === null &&
          c.faction !== 'squad' &&
          Math.max(Math.abs(c.x - u.x), Math.abs(c.y - u.y)) <= 1,
      );
      if (!t) {
        this.addLog('No sleeping body or corpse nearby to carry.', 'info');
        return;
      }
      this.state.pickup(u, t);
    }
    this.refresh();
    this.onAction();
  }

  refresh(): void {
    // alarm
    this.el.pips.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip' + (this.state.alarm.level >= i ? ' lit' : '');
      this.el.pips.appendChild(pip);
    }
    this.el.alarmLabel.textContent = ALARM_LABELS[this.state.alarm.level];
    this.el.turnInd.textContent = `Turn ${this.state.turn}`;

    // candidates
    const n = this.state.knowledge.candidates.size;
    this.el.candidates.textContent =
      n === 1
        ? '◈ Hideout identified – circled in gold on the map.'
        : n > 24
          ? `◈ ${n} possible hideouts – too many. Gather intel to mark suspects on the map.`
          : `◈ ${n} suspect buildings circled on the map.`;

    // squad cards
    this.el.squad.innerHTML = '';
    for (const u of this.state.units.filter((x) => x.faction === 'squad')) {
      const card = document.createElement('div');
      card.className = 'wiz' + (u.id === this.ui.selectedUnitId ? ' selected' : '') + (!u.alive ? ' dead' : '');
      const spellsHtml = u.spells
        .map((sid) => {
          const s = SPELLS[sid];
          const err = this.state.canCast(u, sid);
          const armed = this.ui.selectedUnitId === u.id && this.ui.armedSpell === sid;
          return `<button class="spell-btn${armed ? ' armed' : ''}" data-u="${u.id}" data-s="${sid}"
            title="${s.desc} – ${s.mana} mana${s.endsTurn ? ', ends turn' : ''}${s.loud ? ', LOUD' : ''}"
            ${err && u.alive ? 'disabled' : ''}>${s.icon} ${s.name}</button>`;
        })
        .join('');
      card.innerHTML = `
        <div class="wiz-head">
          <span class="wiz-name">${u.name}</span>
          <span class="wiz-title">${title(u.name)}</span>
        </div>
        <div class="bars">
          <span class="hp">♥ ${Math.max(0, u.hp)}/${u.maxHp}</span>
          <span class="mp">✦ ${u.mana}/${u.maxMana}</span>
          <span class="apv">AP ${u.ap}</span>
          ${u.carrying !== null ? '<span>👜 carrying</span>' : ''}
          ${u.overwatch ? '<span style="color:#e8e05a">⚡ watching</span>' : ''}
        </div>
        <div class="spellbar">${u.alive ? spellsHtml : '<span style="color:#666">down</span>'}</div>`;
      // pointerup, not click: some embedded browsers deliver pointer events to
      // these buttons without synthesizing a click.
      card.onpointerup = (e) => {
        const btn = (e.target as HTMLElement).closest('.spell-btn') as HTMLButtonElement | null;
        if (btn) {
          e.stopPropagation();
          if (btn.disabled) return;
          if (this.ui.selectedUnitId !== u.id) this.ui.selectedUnitId = u.id;
          this.armSpell(btn.dataset.s as SpellId);
          return;
        }
        if (u.alive) this.select(u);
      };
      this.el.squad.appendChild(card);
    }

    const sel = this.selectedUnit();
    this.el.pickupBtn.textContent = sel?.carrying !== null && sel ? 'Put down' : 'Pick up';
    this.el.searchBtn.textContent = sel && sel.carrying !== null ? 'Stash' : 'Search';
  }

  addLog(text: string, kind: string): void {
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    line.textContent = text;
    this.el.log.prepend(line);
    while (this.el.log.children.length > 120) this.el.log.lastChild?.remove();
  }
}

function title(name: string): string {
  switch (name) {
    case 'Vex': return 'Warcaster';
    case 'Issra': return 'Diviner';
    case 'Bram': return 'Shaper';
    case 'Nyx': return 'Whisper';
    default: return '';
  }
}
