/** Canvas input: selection, move, targeting, camera pan/zoom, hotkeys. */
import type { Application } from 'pixi.js';
import type { MissionState } from '../sim/game';
import type { Renderer, UiMode } from '../render/renderer';
import type { Hud } from './hud';

export function attachInput(
  app: Application,
  state: MissionState,
  renderer: Renderer,
  ui: UiMode,
  hud: Hud,
): () => void {
  const canvas = app.canvas as HTMLCanvasElement;
  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2 || e.button === 1) {
      ui.armedSpell = null;
      hud.refresh();
      renderer.drawRange();
      if (e.button === 2) return;
    }
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      if (dragMoved) {
        renderer.world.position.x += dx;
        renderer.world.position.y += dy;
        lastX = e.clientX;
        lastY = e.clientY;
      }
      return;
    }
    // hover previews (path + AP cost, hit chance)
    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX >= rect.right ||
      e.clientY < rect.top || e.clientY >= rect.bottom
    ) {
      renderer.setHover(null);
      return;
    }
    const tile = renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
    renderer.setHover(state.grid.inBounds(tile.x, tile.y) ? tile : null);
  };

  const onPointerUp = (e: PointerEvent) => {
    const wasDrag = dragMoved;
    dragging = false;
    dragMoved = false;
    if (wasDrag || e.button !== 0) return;
    if (state.phase !== 'player') return;

    const rect = canvas.getBoundingClientRect();
    const tile = renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
    if (!state.grid.inBounds(tile.x, tile.y)) return;

    const sel = hud.selectedUnit();

    if (ui.armedSpell && sel) {
      const ok = state.castSpell(sel, ui.armedSpell, tile);
      if (ok) ui.armedSpell = null;
      else hud.addLog('The spell fizzles – bad target, range, or sight line.', 'info');
      hud.maybeAdvance();
      hud.refresh();
      renderer.refreshUnits();
      return;
    }

    // click own wizard -> select
    const clicked = state.unitAt(tile.x, tile.y);
    if (clicked && clicked.faction === 'squad' && clicked.alive) {
      hud.select(clicked);
      return;
    }

    // click an adjacent closed door or intact window -> ease it open (free action)
    if (sel && sel.alive && state.openAdjacentPortal(sel, tile)) {
      hud.refresh();
      renderer.refreshUnits();
      return;
    }

    // click ground -> move selected
    if (sel && sel.alive) {
      const moved = state.tryMove(sel, tile);
      if (!moved && clicked && clicked.faction === 'civilian') {
        hud.addLog('Get adjacent and use Question (or Charm) to talk.', 'info');
      }
      if (moved) hud.maybeAdvance();
      hud.refresh();
      renderer.refreshUnits();
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const before = renderer.world.toLocal({ x: mx, y: my });
    const next = Math.max(0.4, Math.min(3.2, renderer.world.scale.x * factor));
    renderer.world.scale.set(next);
    const after = renderer.world.toLocal({ x: mx, y: my });
    renderer.world.position.x += (after.x - before.x) * next;
    renderer.world.position.y += (after.y - before.y) * next;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const pan = 40;
    switch (e.key) {
      case '1': case '2': case '3': case '4': {
        const idx = Number(e.key) - 1;
        const wiz = state.units.filter((u) => u.faction === 'squad')[idx];
        if (wiz?.alive) hud.select(wiz);
        break;
      }
      case 'e': case 'E':
        if (state.phase === 'player') {
          ui.armedSpell = null;
          state.endTurn();
          hud.refresh();
          renderer.refreshUnits();
        }
        break;
      case 'Escape':
        ui.armedSpell = null;
        hud.refresh();
        renderer.drawRange();
        break;
      case 'f': case 'F':
        renderer.debugReveal = !renderer.debugReveal;
        renderer.drawFog();
        renderer.refreshUnits();
        break;
      case 'c': case 'C': {
        const sel = hud.selectedUnit();
        if (sel) renderer.centerOn(sel.x, sel.y, true);
        break;
      }
      case 'q': case 'Q':
        hud.questionAdjacent();
        renderer.refreshUnits();
        break;
      case 'g': case 'G':
        hud.pickupOrDrop();
        renderer.refreshUnits();
        break;
      case 'p': case 'P':
        hud.peekAdjacent();
        renderer.refreshUnits();
        break;
      case 'b': case 'B':
        hud.breachAdjacent();
        renderer.refreshUnits();
        break;
      case 'v': case 'V':
        hud.searchOrStash();
        renderer.refreshUnits();
        break;
      case 'w': case 'ArrowUp': renderer.world.position.y += pan; break;
      case 's': case 'ArrowDown': renderer.world.position.y -= pan; break;
      case 'a': case 'ArrowLeft': renderer.world.position.x += pan; break;
      case 'd': case 'ArrowRight': renderer.world.position.x -= pan; break;
    }
  };

  const onContext = (e: Event) => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKey);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
    window.removeEventListener('keydown', onKey);
  };
}
