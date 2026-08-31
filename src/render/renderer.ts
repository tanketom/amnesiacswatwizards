/**
 * PixiJS rendering, watabou-style: the map is drawn from the CityModel's
 * organic polygons (parchment ground, stroked building shapes, wobbly road
 * ribbons, ink fog) — the tile grid stays purely a simulation concept and only
 * whispers through as dots and rings when you're choosing where to act.
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { Terrain, Pt, CoverLevel } from '../core/grid';
import { findPath } from '../core/pathfind';
import type { MissionState } from '../sim/game';
import type { Unit, SpellId } from '../sim/types';
import { SPELLS } from '../sim/spells';

export const TILE = 12;

// Parchment palette, watabou-flavored.
const INK = 0x39332a;
const PAPER = 0xd8d2c0;
const ROAD = 0xe4dfd0;
const BUILDING_FILL = 0xc9c1a9;
const FLOOR_FILL = 0xd2cab2;
const GREEN = 0xaeb28c;
const WATER = 0x9fb0b5;
const TREE = 0x76825a;
const DOOR = 0x8a6134;

const FACTION_COLORS: Record<string, number> = {
  squad: 0x2f6fae,
  guard: 0xa4622d,
  hostile: 0xb03a2e,
  civilian: 0x6d6752,
};

export interface UiMode {
  selectedUnitId: number | null;
  armedSpell: SpellId | null;
}

/** Little XCOM-style shield: filled = full cover, half-filled = half cover. */
function drawShield(g: Graphics, x: number, y: number, lvl: CoverLevel): void {
  const w = 5.6;
  const h = 6.4;
  const top = y - h / 2;
  const shieldPath = () => {
    g.moveTo(x - w / 2, top);
    g.lineTo(x + w / 2, top);
    g.lineTo(x + w / 2, top + h * 0.55);
    g.lineTo(x, top + h);
    g.lineTo(x - w / 2, top + h * 0.55);
    g.closePath();
  };
  shieldPath();
  g.fill({ color: 0xf2ede0, alpha: 0.95 }).stroke({ width: 1, color: INK });
  if (lvl === 2) {
    shieldPath();
    g.fill({ color: 0x2b4d6f, alpha: 0.95 });
  } else {
    // half cover: bottom half filled
    g.moveTo(x - w / 2, top + h * 0.45);
    g.lineTo(x + w / 2, top + h * 0.45);
    g.lineTo(x + w / 2, top + h * 0.55);
    g.lineTo(x, top + h);
    g.lineTo(x - w / 2, top + h * 0.55);
    g.closePath();
    g.fill({ color: 0x2b4d6f, alpha: 0.95 });
  }
}

function describeUnit(u: Unit): string {
  if (!u.alive) return `${u.name} (dead)`;
  if (u.subdued || u.sleepTurns > 0) return `${u.name} (asleep)`;
  if (u.charmedTurns > 0) return `${u.name} (charmed)`;
  if (u.faction !== 'squad' && u.aiState === 'combat') return `${u.name} – hunting you!`;
  if (u.faction !== 'squad' && u.aiState === 'suspicious') return `${u.name} – investigating`;
  if (u.suppressedTurns > 0) return `${u.name} (pinned)`;
  return u.name;
}

/** Distance from point to line segment (all in tile coordinates). */
function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Angular distance between two LINE directions (mod π). */
function lineAngleDist(a: number, b: number): number {
  const d = (((a - b) % Math.PI) + Math.PI) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export class Renderer {
  world = new Container();
  private terrainG = new Graphics();
  private roofsG = new Graphics();
  private portalsG = new Graphics();
  private doorAnimG = new Graphics();
  private effectsG = new Graphics();
  private projG = new Graphics();
  private unitLayer = new Container();
  private fogCanvas!: HTMLCanvasElement;
  private fogCtx!: CanvasRenderingContext2D;
  private fogTexture!: Texture;
  private fogSprite!: Sprite;
  private ringsG = new Graphics();
  private floatsLayer = new Container();
  private intelG = new Graphics();
  private rangeG = new Graphics();
  private unitNodes = new Map<number, Container>();
  private hoverLabel!: Text;
  private hoverTile: Pt | null = null;
  /** In-flight movement tweens: unitId -> waypoints in pixels. */
  private anims = new Map<number, { points: Pt[]; seg: number; t: number; pathVisible: boolean }>();
  /** Door-leaf swing tweens by tile index. */
  private doorAnims = new Map<number, { x: number; y: number; t: number }>();
  /** Short-lived particles (glass shards, …). */
  private particles: {
    x: number; y: number; vx: number; vy: number; size: number; color: number;
    t: number; life: number;
  }[] = [];
  /** Expanding noise rings: how far that sound just carried. */
  private rings: { x: number; y: number; maxR: number; t: number; life: number; points: number }[] = [];
  /** In-flight bolts and embers. */
  private projectiles: {
    fx: number; fy: number; tx: number; ty: number; t: number; life: number; color: number;
  }[] = [];
  /** Floating combat numbers. */
  private floats: {
    node: Text; x: number; y: number; t: number; life: number; delay: number;
  }[] = [];
  /** Roofs: model polygon + which building's exploration lifts it. */
  private roofPolys: { points: Pt[]; buildingId: number; orientation: number | null }[] = [];
  private liftedRoofs = new Set<number>();
  /** Building footprint polygons by id, for exact facade angles. */
  private polyByBuilding = new Map<number, { points: Pt[]; orientation: number }>();
  /** Door tiles whose opening we have already witnessed (no re-swing on redraw). */
  private knownOpen = new Set<number>();
  debugReveal = false;

  private static readonly MS_PER_TILE = 55;
  private static readonly DOOR_SWING_MS = 260;

  constructor(
    private app: Application,
    private state: MissionState,
    private ui: UiMode,
  ) {
    // low-res fog canvas sampled with bilinear filtering: smooth at any zoom
    const B = 4; // dark border tiles around the map
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = state.grid.width + 2 * B;
    this.fogCanvas.height = state.grid.height + 2 * B;
    this.fogCtx = this.fogCanvas.getContext('2d')!;
    this.fogTexture = Texture.from(this.fogCanvas);
    this.fogSprite = new Sprite(this.fogTexture);
    this.fogSprite.position.set(-B * TILE, -B * TILE);
    this.fogSprite.scale.set(TILE);

    this.world.addChild(this.terrainG);
    this.world.addChild(this.roofsG);
    this.world.addChild(this.portalsG); // shell doors & windows sit on top of roofs
    this.world.addChild(this.doorAnimG);
    this.world.addChild(this.rangeG);
    this.world.addChild(this.unitLayer);
    this.world.addChild(this.effectsG);
    this.world.addChild(this.projG);
    this.world.addChild(this.fogSprite);
    this.world.addChild(this.ringsG); // sound carries through fog — your noise, your knowledge
    this.world.addChild(this.floatsLayer);
    this.world.addChild(this.intelG);
    app.stage.addChild(this.world);

    // clip everything to the raid window (imported roads/water can run far past it)
    const grid = state.grid;
    const mask = new Graphics()
      .rect(-TILE * 4, -TILE * 4, (grid.width + 8) * TILE, (grid.height + 8) * TILE)
      .fill(0xffffff);
    this.world.addChild(mask);
    this.world.mask = mask;

    // roofs: map each drawn building polygon to the building whose exploration lifts it
    for (const poly of state.raster.model.buildings) {
      let cx = 0;
      let cy = 0;
      for (const p of poly.points) { cx += p.x; cy += p.y; }
      cx = Math.floor(cx / poly.points.length);
      cy = Math.floor(cy / poly.points.length);
      const t = state.grid.get(cx, cy);
      if (t !== Terrain.Wall && t !== Terrain.Floor && t !== Terrain.Door) continue;
      const bid = state.grid.buildingId[cy * state.grid.width + cx];
      const info = state.raster.buildings.find((b) => b.id === bid);
      this.roofPolys.push({ points: poly.points, buildingId: info ? bid : -1, orientation: info?.orientation ?? null });
      if (info) this.polyByBuilding.set(bid, { points: poly.points, orientation: info.orientation });
    }

    this.hoverLabel = new Text({
      text: '',
      style: {
        fontSize: 11,
        fill: 0x2b2620,
        fontFamily: 'Georgia',
        fontWeight: 'bold',
        stroke: { color: 0xf2ede0, width: 3 },
      },
      // rasterize the glyphs well above max camera zoom so they stay crisp
      resolution: 8,
    });
    this.hoverLabel.anchor.set(0.5, 1);
    this.hoverLabel.visible = false;
    this.world.addChild(this.hoverLabel);

    const bus = state.bus;
    bus.on('fovChanged', () => {
      this.checkRoofReveals();
      this.drawFog();
      this.refreshUnits();
    });
    bus.on('attackResolved', (e) => this.onAttackResolved(e));
    // note doors already open at construction so they don't swing on first draw
    for (let i = 0; i < state.grid.terrain.length; i++) {
      if (state.grid.terrain[i] === Terrain.Door && state.grid.doorOpen[i] === 1) this.knownOpen.add(i);
    }
    bus.on('terrainChanged', ({ tiles }) => {
      const grid = this.state.grid;
      for (const p of tiles) {
        const idx = p.y * grid.width + p.x;
        if (grid.get(p.x, p.y) === Terrain.Door && grid.opened(p.x, p.y) && !this.knownOpen.has(idx)) {
          this.knownOpen.add(idx);
          this.doorAnims.set(idx, { x: p.x, y: p.y, t: 0 });
        }
      }
      this.drawTerrain();
    });
    bus.on('unitMoved', ({ unitId, path }) => {
      this.startAnim(unitId, path);
      this.refreshUnits();
    });
    bus.on('windowSmashed', ({ x, y }) => this.spawnGlassBurst(x, y));
    bus.on('noiseMade', ({ x, y, radius, points }) => {
      this.rings.push({
        x: x * TILE + TILE / 2,
        y: y * TILE + TILE / 2,
        maxR: radius * TILE,
        t: 0,
        life: 750,
        points,
      });
    });
    app.ticker.add(() => this.tickAnims(app.ticker.deltaMS));
    bus.on('unitDied', () => this.refreshUnits());
    bus.on('unitSubdued', () => this.refreshUnits());
    bus.on('unitDamaged', () => this.refreshUnits());
    bus.on('candidatesNarrowed', () => this.drawIntel());
    bus.on('turnStarted', () => this.refreshUnits());
    bus.on('carryChanged', () => this.refreshUnits());

    this.drawTerrain();
    this.checkRoofReveals();
    this.drawRoofs();
    this.drawFog();
    this.drawIntel();
    this.refreshUnits();
    this.centerOn(state.dropPoint.x, state.dropPoint.y);
  }

  centerOn(tx: number, ty: number, keepScale = false): void {
    if (!keepScale) this.world.scale.set(1.4);
    const s = this.world.scale.x;
    this.world.position.set(
      this.app.screen.width / 2 - tx * TILE * s,
      this.app.screen.height / 2 - ty * TILE * s,
    );
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    const p = this.world.toLocal({ x: sx, y: sy });
    const gx = Math.floor(p.x / TILE);
    const gy = Math.floor(p.y / TILE);
    // cells are warped: test the candidate cell and its neighbors
    let best = { x: gx, y: gy };
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (pointInPoly(p, this.cellPoly(x, y))) return { x, y };
        const c = this.cellCenter(x, y);
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** Begin a walk tween along the path a unit just took (instead of teleporting). */
  private startAnim(unitId: number, path: Pt[]): void {
    const node = this.unitNodes.get(unitId);
    if (!node || path.length === 0) return;
    const W = this.state.grid.width;
    const pathVisible =
      this.debugReveal || path.some((p) => this.state.visible.has(p.y * W + p.x));
    const points: Pt[] = [
      { x: node.position.x, y: node.position.y },
      ...path.map((p) => ({ x: p.x * TILE + TILE / 2, y: p.y * TILE + TILE / 2 })),
    ];
    this.anims.set(unitId, { points, seg: 0, t: 0, pathVisible });
  }

  /** Projectiles and combat numbers, driven off resolved attacks. */
  private onAttackResolved(e: { attackerId: number; targetId: number; hit: boolean; damage: number }): void {
    const attacker = this.state.unitById(e.attackerId);
    const target = this.state.unitById(e.targetId);
    if (!attacker || !target) return;
    const dist = Math.hypot(target.x - attacker.x, target.y - attacker.y);
    let delay = 0;
    if (dist > 1.7) {
      // a bolt or ember streaks over; the number lands with the impact
      const life = 70 + dist * 16;
      delay = life;
      this.projectiles.push({
        fx: attacker.x * TILE + TILE / 2,
        fy: attacker.y * TILE + TILE / 2,
        tx: target.x * TILE + TILE / 2,
        ty: target.y * TILE + TILE / 2,
        t: 0,
        life,
        color: attacker.faction === 'guard' ? 0x54432e : 0xd96f32,
      });
    }
    const isSquadTarget = target.faction === 'squad';
    const node = new Text({
      text: e.hit ? `-${e.damage}` : 'miss',
      style: {
        fontSize: e.hit ? 11 : 9,
        fill: e.hit ? (isSquadTarget ? 0xb03a2e : 0x2b2620) : 0x6d6752,
        fontFamily: 'Georgia',
        fontWeight: 'bold',
        fontStyle: e.hit ? 'normal' : 'italic',
        stroke: { color: 0xf2ede0, width: 3 },
      },
      resolution: 8,
    });
    node.anchor.set(0.5, 1);
    node.visible = false;
    this.floatsLayer.addChild(node);
    this.floats.push({
      node,
      x: target.x * TILE + TILE / 2 + (Math.random() - 0.5) * 4,
      y: target.y * TILE - 2,
      t: 0,
      life: 800,
      delay,
    });
  }

  private tickProjectiles(deltaMS: number): void {
    if (this.projectiles.length === 0) return;
    const g = this.projG;
    g.clear();
    this.projectiles = this.projectiles.filter((p) => {
      p.t += deltaMS;
      const k = Math.min(1, p.t / p.life);
      if (k >= 1) {
        // impact sparks
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = (0.015 + Math.random() * 0.04) * TILE;
          this.particles.push({
            x: p.tx, y: p.ty,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            size: 1 + Math.random() * 1.3,
            color: p.color === 0xd96f32 ? (Math.random() < 0.5 ? 0xd96f32 : 0xe8b23a) : 0x54432e,
            t: 0,
            life: 200 + Math.random() * 180,
          });
        }
        return false;
      }
      const x = p.fx + (p.tx - p.fx) * k;
      const y = p.fy + (p.ty - p.fy) * k;
      const tk = Math.max(0, k - 0.12);
      g.moveTo(p.fx + (p.tx - p.fx) * tk, p.fy + (p.ty - p.fy) * tk)
        .lineTo(x, y)
        .stroke({ width: 1.6, color: p.color, alpha: 0.55, cap: 'round' });
      g.circle(x, y, 1.9).fill(p.color);
      return true;
    });
    if (this.projectiles.length === 0) g.clear();
  }

  private tickFloats(deltaMS: number): void {
    if (this.floats.length === 0) return;
    this.floats = this.floats.filter((f) => {
      f.t += deltaMS;
      if (f.t < f.delay) return true; // waiting for the projectile to land
      const k = (f.t - f.delay) / f.life;
      if (k >= 1) {
        f.node.destroy();
        return false;
      }
      f.node.visible = true;
      f.node.position.set(f.x, f.y - k * TILE * 1.1);
      f.node.alpha = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
      return true;
    });
  }

  private tickRings(deltaMS: number): void {
    if (this.rings.length === 0) return;
    const g = this.ringsG;
    g.clear();
    this.rings = this.rings.filter((r) => {
      r.t += deltaMS;
      if (r.t >= r.life) return false;
      const k = r.t / r.life;
      const radius = r.maxR * (1 - (1 - k) ** 2); // rushes out, settles at true reach
      const alpha = (1 - k) * Math.min(0.6, 0.28 + r.points * 0.08);
      g.circle(r.x, r.y, radius).stroke({ width: 1.4 + r.points * 0.3, color: 0xd08a2e, alpha });
      return true;
    });
    if (this.rings.length === 0) g.clear();
  }

  private tickAnims(deltaMS: number): void {
    this.tickDoorAnims(deltaMS);
    this.tickProjectiles(deltaMS);
    this.tickParticles(deltaMS);
    this.tickFloats(deltaMS);
    this.tickRings(deltaMS);
    if (this.anims.size === 0) return;
    for (const [id, a] of [...this.anims]) {
      const node = this.unitNodes.get(id);
      if (!node) {
        this.anims.delete(id);
        continue;
      }
      a.t += deltaMS / Renderer.MS_PER_TILE;
      while (a.t >= 1 && a.seg < a.points.length - 2) {
        a.t -= 1;
        a.seg++;
      }
      if (a.seg >= a.points.length - 2 && a.t >= 1) {
        const end = a.points[a.points.length - 1];
        node.position.set(end.x, end.y);
        this.anims.delete(id);
        this.refreshUnits(); // settle visibility at the destination
        continue;
      }
      const from = a.points[a.seg];
      const to = a.points[a.seg + 1];
      const k = Math.min(1, a.t);
      node.position.set(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    }
  }

  /** Glass explodes off the pane, perpendicular to the wall — into both rooms. */
  private spawnGlassBurst(x: number, y: number): void {
    const a = this.portalAngle(x, y);
    const nx = -Math.sin(a); // wall normal
    const ny = Math.cos(a);
    const cx = x * TILE + TILE / 2;
    const cy = y * TILE + TILE / 2;
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      // mostly along the normal, with sideways scatter along the pane
      const speed = (0.02 + Math.random() * 0.05) * TILE;
      const scatter = (Math.random() - 0.5) * 0.9;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * TILE * 0.5,
        y: cy + (Math.random() - 0.5) * TILE * 0.5,
        vx: (nx * side + Math.cos(a) * scatter) * speed,
        vy: (ny * side + Math.sin(a) * scatter) * speed,
        size: 1 + Math.random() * 1.6,
        color: Math.random() < 0.5 ? 0xaebfc7 : 0xe8f0f2,
        t: 0,
        life: 320 + Math.random() * 260,
      });
    }
  }

  private tickParticles(deltaMS: number): void {
    if (this.particles.length === 0) return;
    const g = this.effectsG;
    g.clear();
    this.particles = this.particles.filter((p) => {
      p.t += deltaMS;
      if (p.t >= p.life) return false;
      p.x += p.vx * deltaMS * 0.06;
      p.y += p.vy * deltaMS * 0.06;
      p.vx *= 0.94; // shards skitter to a stop
      p.vy *= 0.94;
      const k = 1 - p.t / p.life;
      g.rect(p.x, p.y, p.size, p.size).fill({ color: p.color, alpha: 0.35 + 0.65 * k });
      return true;
    });
    if (this.particles.length === 0) g.clear();
  }

  private tickDoorAnims(deltaMS: number): void {
    if (this.doorAnims.size === 0) return;
    const g = this.doorAnimG;
    g.clear();
    for (const [idx, d] of [...this.doorAnims]) {
      d.t += deltaMS / Renderer.DOOR_SWING_MS;
      if (d.t >= 1) {
        this.doorAnims.delete(idx);
        this.drawDoorLeaf(g, d.x, d.y, 1); // hold the final pose this frame
        continue;
      }
      const frac = 1 - (1 - d.t) ** 2; // ease-out: kicked hard, settles soft
      this.drawDoorLeaf(g, d.x, d.y, frac);
    }
    if (this.doorAnims.size === 0) {
      g.clear();
      this.drawTerrain(); // bake the settled leaves back into the static layer
    }
  }

  /** Update the hovered cell (from mouse move); refreshes previews. */
  setHover(t: Pt | null): void {
    const same =
      (t === null && this.hoverTile === null) ||
      (t !== null && this.hoverTile !== null && t.x === this.hoverTile.x && t.y === this.hoverTile.y);
    if (same) return;
    this.hoverTile = t;
    this.drawRange();
  }

  // --- Cityshaper-style warped mesh: every tile corner gets a deterministic
  // --- organic offset, so cells share edges but nothing reads as a square grid.
  private warpCorner(cx: number, cy: number): Pt {
    const h = ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0);
    const jx = ((h & 255) / 255 - 0.5) * 3.4;
    const jy = (((h >> 8) & 255) / 255 - 0.5) * 3.4;
    return {
      x: cx * TILE + Math.sin(cx * 0.9 + cy * 0.57) * 1.5 + jx,
      y: cy * TILE + Math.cos(cx * 0.52 - cy * 0.83) * 1.5 + jy,
    };
  }

  private cellPoly(x: number, y: number): Pt[] {
    return [
      this.warpCorner(x, y),
      this.warpCorner(x + 1, y),
      this.warpCorner(x + 1, y + 1),
      this.warpCorner(x, y + 1),
    ];
  }

  private cellCenter(x: number, y: number): Pt {
    const p = this.cellPoly(x, y);
    return {
      x: (p[0].x + p[1].x + p[2].x + p[3].x) / 4,
      y: (p[0].y + p[1].y + p[2].y + p[3].y) / 4,
    };
  }

  private tracePoly(g: Graphics, pts: Pt[]): void {
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  }

  /** Portals on the building shell render above roofs (you can see them from the street). */
  private isShellPortal(x: number, y: number): boolean {
    const grid = this.state.grid;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const t = grid.get(x + dx, y + dy);
      if (t === Terrain.Street || t === Terrain.Grass) return true;
    }
    return false;
  }

  drawTerrain(): void {
    const g = this.terrainG;
    const { grid, model } = { grid: this.state.grid, model: this.state.raster.model };
    const W = grid.width;
    g.clear();
    this.portalsG.clear();

    // 1. paper
    g.rect(-TILE * 4, -TILE * 4, (grid.width + 8) * TILE, (grid.height + 8) * TILE).fill(PAPER);

    // 2. greens / parks, then paved plazas
    for (const poly of model.greens) {
      this.poly(g, poly);
      g.fill({ color: GREEN, alpha: 0.65 });
    }
    for (const poly of model.plazas) {
      this.poly(g, poly);
      g.fill(ROAD);
    }

    // 3. water, with a darker shoreline
    for (const poly of model.water) {
      this.poly(g, poly);
      g.fill(WATER).stroke({ width: 1.5, color: 0x7d9096 });
    }

    // 4. roads as soft ribbons (drawn after water: crossings read as bridges)
    for (const line of model.roads) {
      if (line.length < 2) continue;
      g.moveTo(line[0].x * TILE, line[0].y * TILE);
      for (let i = 1; i < line.length; i++) g.lineTo(line[i].x * TILE, line[i].y * TILE);
      g.stroke({ width: TILE * 1.6, color: ROAD, cap: 'round', join: 'round' });
    }

    // 5. buildings: organic outlined shapes from the model polygons.
    for (const poly of model.buildings) {
      // skip polygons the rasterizer rejected (e.g. drowned in water):
      // sample the centroid tile — if it isn't building terrain, don't draw it.
      let cx = 0, cy = 0;
      for (const p of poly.points) { cx += p.x; cy += p.y; }
      cx = Math.floor(cx / poly.points.length);
      cy = Math.floor(cy / poly.points.length);
      const t = grid.get(cx, cy);
      if (t !== Terrain.Wall && t !== Terrain.Floor && t !== Terrain.Door) continue;
      this.poly(g, poly.points);
      g.fill(BUILDING_FILL).stroke({ width: 2, color: INK, join: 'round' });
    }

    // 6. interior detail from the grid: room floors, partition walls, doors.
    //    (Rectilinear is fine here — watabou's own dungeons are rectilinear;
    //    it's the streets and blocks that need to stay organic.)
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const terr = grid.terrain[idx];
        if (terr === Terrain.Floor) {
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(FLOOR_FILL);
        } else if (terr === Terrain.Wall && grid.buildingId[idx] >= 0 && this.isInteriorWall(x, y)) {
          // partitions as strokes toward every wall-like neighbor (8-way), so
          // diagonal, building-aligned walls read as continuous lines
          const cx = x * TILE + TILE / 2;
          const cy = y * TILE + TILE / 2;
          g.circle(cx, cy, TILE * 0.21).fill(INK);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (!this.isWallLike(nx, ny)) continue;
            if (grid.buildingId[ny * W + nx] !== grid.buildingId[idx]) continue;
            g.moveTo(cx, cy)
              .lineTo(cx + (dx * TILE) / 2, cy + (dy * TILE) / 2)
              .stroke({ width: TILE * 0.42, color: INK, cap: 'round' });
          }
        } else if (terr === Terrain.Door) {
          // a gap in the wall; the leaf hangs from a hinge and lies along the wall
          const dg = this.isShellPortal(x, y) ? this.portalsG : g;
          dg.rect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2).fill(FLOOR_FILL);
          if (!this.doorAnims.has(y * W + x)) {
            this.drawDoorLeaf(dg, x, y, grid.isDoorOpen(x, y) ? 1 : 0);
          }
        } else if (terr === Terrain.Container) {
          // chest / cupboard: backed up against its wall, long side parallel to it
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(FLOOR_FILL);
          let bx = 0;
          let by = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            if (!this.isWallLike(x + dx, y + dy)) continue;
            const w = dx !== 0 && dy !== 0 ? 1 : 2;
            bx += dx * w;
            by += dy * w;
          }
          const bl = Math.hypot(bx, by);
          const nx = bl > 0 ? bx / bl : 0;
          const ny = bl > 0 ? by / bl : 0;
          let angle = bl > 0 ? Math.atan2(ny, nx) + Math.PI / 2 : 0;
          // snap to the building's own axes so furniture agrees with the walls
          const crec = this.polyByBuilding.get(grid.buildingId[idx]);
          if (crec) {
            angle = lineAngleDist(crec.orientation, angle) <= lineAngleDist(crec.orientation + Math.PI / 2, angle)
              ? crec.orientation
              : crec.orientation + Math.PI / 2;
          }
          const ccx = x * TILE + TILE / 2 + nx * TILE * 0.12;
          const ccy = y * TILE + TILE / 2 + ny * TILE * 0.12;
          this.slab(g, ccx, ccy, angle, TILE * 0.84, TILE * 0.58);
          g.fill(0x7a5a33).stroke({ width: 1, color: INK });
          // lid seam along the long side, toward the room
          const lx = -nx * TILE * 0.1;
          const ly = -ny * TILE * 0.1;
          g.moveTo(ccx + Math.cos(angle) * TILE * 0.4 + lx, ccy + Math.sin(angle) * TILE * 0.4 + ly)
            .lineTo(ccx - Math.cos(angle) * TILE * 0.4 + lx, ccy - Math.sin(angle) * TILE * 0.4 + ly)
            .stroke({ width: 0.8, color: INK, alpha: 0.8 });
        } else if (terr === Terrain.Window) {
          // a pane set parallel to the wall; intact = glass, opened = empty frame
          const wg = this.isShellPortal(x, y) ? this.portalsG : g;
          const cx = x * TILE + TILE / 2;
          const cy = y * TILE + TILE / 2;
          const a = this.portalAngle(x, y);
          wg.rect(x * TILE + 1.5, y * TILE + 1.5, TILE - 3, TILE - 3).fill(BUILDING_FILL);
          this.slab(wg, cx, cy, a, TILE * 0.95, TILE * 0.34);
          if (grid.opened(x, y)) {
            wg.fill(FLOOR_FILL).stroke({ width: 1, color: INK, alpha: 0.8 });
          } else {
            wg.fill(0xaebfc7).stroke({ width: 1, color: INK, alpha: 0.8 });
            // glint along the pane
            wg.moveTo(cx - Math.cos(a) * TILE * 0.28, cy - Math.sin(a) * TILE * 0.28)
              .lineTo(cx + Math.cos(a) * TILE * 0.12, cy + Math.sin(a) * TILE * 0.12)
              .stroke({ width: 1, color: 0xe8f0f2, alpha: 0.9 });
          }
        }
      }
    }

    // 7. trees & carts: organic circles with a size wobble per tile
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < W; x++) {
        if (grid.terrain[y * W + x] !== Terrain.Cover) continue;
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const r = TILE * (0.34 + ((h % 100) / 100) * 0.16);
        const ox = (((h >> 8) % 40) - 20) / 40 * TILE * 0.25;
        const oy = (((h >> 16) % 40) - 20) / 40 * TILE * 0.25;
        g.circle(x * TILE + TILE / 2 + ox, y * TILE + TILE / 2 + oy, r)
          .fill(TREE)
          .stroke({ width: 1, color: INK, alpha: 0.6 });
      }
    }
  }

  private poly(g: Graphics, pts: { x: number; y: number }[]): void {
    if (pts.length < 3) return;
    g.moveTo(pts[0].x * TILE, pts[0].y * TILE);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x * TILE, pts[i].y * TILE);
    g.closePath();
  }

  private isWallLike(x: number, y: number): boolean {
    const t = this.state.grid.get(x, y);
    return t === Terrain.Wall || t === Terrain.Door || t === Terrain.Window;
  }

  /** Neighbor-voted line direction (angle-doubled average of wall-like neighbors). */
  private votedAngle(x: number, y: number): number | null {
    let sx = 0;
    let sy = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      if (!this.isWallLike(x + dx, y + dy)) continue;
      const w = dx !== 0 && dy !== 0 ? 1 : 2;
      const a = Math.atan2(dy, dx);
      sx += Math.cos(2 * a) * w;
      sy += Math.sin(2 * a) * w;
    }
    if (sx === 0 && sy === 0) return null;
    return Math.atan2(sy, sx) / 2;
  }

  /** Angle of the building's polygon edge nearest to this tile (exact facade direction). */
  private nearestEdgeAngle(bid: number, px: number, py: number): number | null {
    const rec = this.polyByBuilding.get(bid);
    if (!rec) return null;
    let best: number | null = null;
    let bestD = Infinity;
    const pts = rec.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = distToSegment(px, py, a, b);
      if (d < bestD) {
        bestD = d;
        best = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
    return best;
  }

  /**
   * Direction of the wall a door/window sits in. Shell portals take the exact
   * angle of the nearest footprint edge; interior portals snap to the
   * building's own axes (whichever agrees better with the neighboring walls);
   * neighbor voting is the fallback for buildings without a polygon.
   */
  private portalAngle(x: number, y: number): number {
    const grid = this.state.grid;
    const bid = grid.buildingId[y * grid.width + x];
    const rec = bid >= 0 ? this.polyByBuilding.get(bid) : undefined;
    if (rec) {
      if (this.isShellPortal(x, y)) {
        const a = this.nearestEdgeAngle(bid, x + 0.5, y + 0.5);
        if (a !== null) return a;
      } else {
        const v = this.votedAngle(x, y);
        const c1 = rec.orientation;
        const c2 = rec.orientation + Math.PI / 2;
        if (v === null) return c1;
        return lineAngleDist(c1, v) <= lineAngleDist(c2, v) ? c1 : c2;
      }
    }
    return this.votedAngle(x, y) ?? 0;
  }

  /**
   * The door leaf, hinged at one jamb. openFrac 0 = shut across the doorway,
   * 1 = swung ~110° back into the room; in between, it's mid-swing.
   */
  private drawDoorLeaf(g: Graphics, x: number, y: number, openFrac: number): void {
    const a = this.portalAngle(x, y);
    const hx = x * TILE + TILE / 2 + Math.cos(a) * TILE * 0.46;
    const hy = y * TILE + TILE / 2 + Math.sin(a) * TILE * 0.46;
    const dir = a + Math.PI + openFrac * 1.9;
    const len = TILE * 0.92;
    this.slab(g, hx + (Math.cos(dir) * len) / 2, hy + (Math.sin(dir) * len) / 2, dir, len, TILE * 0.28);
    g.fill(DOOR).stroke({ width: 0.9, color: INK });
    g.circle(hx, hy, 1.2).fill(INK); // the hinge
  }

  /** Trace a rotated rectangle (a door leaf / window pane) centered on (cx,cy). */
  private slab(g: Graphics, cx: number, cy: number, angle: number, len: number, thick: number): void {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const vx = -uy;
    const vy = ux;
    const hl = len / 2;
    const ht = thick / 2;
    g.moveTo(cx + ux * hl + vx * ht, cy + uy * hl + vy * ht);
    g.lineTo(cx - ux * hl + vx * ht, cy - uy * hl + vy * ht);
    g.lineTo(cx - ux * hl - vx * ht, cy - uy * hl - vy * ht);
    g.lineTo(cx + ux * hl - vx * ht, cy + uy * hl - vy * ht);
    g.closePath();
  }

  /**
   * Wall tile fully surrounded by this building AND touching real floor —
   * a BSP partition. (Solid pruned buildings have no floor: no ink marks.)
   */
  private isInteriorWall(x: number, y: number): boolean {
    const grid = this.state.grid;
    const W = grid.width;
    const id = grid.buildingId[y * W + x];
    let touchesFloor = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (!grid.inBounds(nx, ny)) return false;
      const ni = ny * W + nx;
      if (grid.buildingId[ni] !== id) return false;
      if (grid.terrain[ni] === Terrain.Floor || grid.terrain[ni] === Terrain.Door) touchesFloor = true;
    }
    return touchesFloor;
  }

  /**
   * Fog as a 1-pixel-per-tile canvas texture, scaled up with bilinear
   * sampling: boundaries become smooth gradients at any zoom level.
   */
  drawFog(): void {
    this.roofsG.visible = !this.debugReveal;
    if (this.debugReveal) {
      this.fogSprite.visible = false;
      return;
    }
    this.fogSprite.visible = true;
    const grid = this.state.grid;
    const { explored, visible } = this.state;
    const W = grid.width;
    const B = 4;
    const cw = this.fogCanvas.width;
    const img = this.fogCtx.createImageData(cw, this.fogCanvas.height);
    const data = img.data;
    // ink color 0x161420, border and unexplored nearly opaque
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 22; data[i + 1] = 20; data[i + 2] = 32; data[i + 3] = 247;
    }
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (!explored[idx]) continue;
        const px = ((y + B) * cw + (x + B)) * 4 + 3;
        data[px] = visible.has(idx) ? 0 : 107;
      }
    }
    this.fogCtx.putImageData(img, 0, 0);
    this.fogTexture.source.update();
  }

  /** Roofed silhouettes for buildings nobody has seen inside yet. */
  drawRoofs(): void {
    const g = this.roofsG;
    g.clear();
    for (const roof of this.roofPolys) {
      if (roof.buildingId >= 0 && this.liftedRoofs.has(roof.buildingId)) continue;
      this.poly(g, roof.points);
      g.fill(0xbfae8c).stroke({ width: 2, color: INK, join: 'round' });
      // ridge line along the building's orientation
      if (roof.orientation !== null) {
        let cx = 0;
        let cy = 0;
        let maxD = 0;
        for (const p of roof.points) { cx += p.x; cy += p.y; }
        cx /= roof.points.length;
        cy /= roof.points.length;
        for (const p of roof.points) {
          maxD = Math.max(maxD, Math.hypot(p.x - cx, p.y - cy));
        }
        const ux = Math.cos(roof.orientation);
        const uy = Math.sin(roof.orientation);
        const d = maxD * 0.45;
        g.moveTo((cx - ux * d) * TILE, (cy - uy * d) * TILE)
          .lineTo((cx + ux * d) * TILE, (cy + uy * d) * TILE)
          .stroke({ width: 1, color: INK, alpha: 0.35 });
      }
    }
  }

  /** Once any interior tile has been seen, the roof comes off for good. */
  private checkRoofReveals(): void {
    const { explored } = this.state;
    let changed = false;
    for (const b of this.state.raster.buildings) {
      if (this.liftedRoofs.has(b.id)) continue;
      if (b.floorTiles.some((t) => explored[t] === 1)) {
        this.liftedRoofs.add(b.id);
        changed = true;
      }
    }
    if (changed) this.drawRoofs();
  }

  /** Player-belief overlay: candidate buildings, extraction anchor. Drawn above fog. */
  drawIntel(): void {
    const g = this.intelG;
    g.clear();
    const { knowledge, raster, dropPoint, extractionRadius } = this.state;
    const W = raster.grid.width;
    const single = knowledge.candidates.size === 1;
    // with no intel yet the whole city is suspect — wax circles would just be
    // noise, so they only appear once the set is small enough to reason about
    const showCircles = knowledge.candidates.size <= 24;
    for (const id of showCircles ? knowledge.candidates : []) {
      const b = raster.buildings.find((bb) => bb.id === id);
      if (!b) continue;
      // circle the suspicion on the map, like a wax-pencil mark
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const t of b.floorTiles) {
        const x = t % W, y = Math.floor(t / W);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const cx = ((minX + maxX) / 2 + 0.5) * TILE;
      const cy = ((minY + maxY) / 2 + 0.5) * TILE;
      const r = (Math.max(maxX - minX, maxY - minY) / 2 + 2.2) * TILE;
      g.circle(cx, cy, r).stroke({
        width: single ? 3 : 1.8,
        color: single ? 0xe0a92f : 0xc79a2a,
        alpha: single ? 1 : 0.6,
      });
    }
    // extraction anchor
    const r = (extractionRadius + 0.5) * TILE;
    const ax = dropPoint.x * TILE + TILE / 2;
    const ay = dropPoint.y * TILE + TILE / 2;
    g.circle(ax, ay, r).stroke({ width: 2.5, color: 0x2f6fae, alpha: 0.9 });
    g.circle(ax, ay, TILE * 0.3).fill({ color: 0x2f6fae, alpha: 0.9 });
  }

  /** Move-range mesh / spell-range ring / hover previews for the selected unit. */
  drawRange(): void {
    const g = this.rangeG;
    g.clear();
    this.hoverLabel.visible = false;
    const u = this.ui.selectedUnitId !== null ? this.state.unitById(this.ui.selectedUnitId) : null;
    if (!u || !u.alive || this.state.phase !== 'player') return;

    if (this.ui.armedSpell) {
      this.drawArmedPreview(g, u, this.ui.armedSpell);
    } else if (u.ap > 0) {
      this.drawMoveMesh(g, u);
    }
    // who is that? hovering any visible figure names them and their state
    if (!this.ui.armedSpell && this.hoverTile) {
      const hu = this.state.unitAt(this.hoverTile.x, this.hoverTile.y);
      const idx = this.hoverTile.y * this.state.grid.width + this.hoverTile.x;
      if (hu && (hu.faction === 'squad' || this.debugReveal || this.state.visible.has(idx))) {
        this.hoverLabel.text = describeUnit(hu);
        this.hoverLabel.position.set(hu.x * TILE + TILE / 2, hu.y * TILE - TILE * 0.5);
        this.hoverLabel.visible = true;
      }
    }
    // selection ring
    g.circle(u.x * TILE + TILE / 2, u.y * TILE + TILE / 2, TILE * 0.68)
      .stroke({ width: 2, color: 0xb8860b });
  }

  /** Reachable cells as an organic warped mesh + hover path preview. */
  private drawMoveMesh(g: Graphics, u: Unit): void {
    const opts = this.state.moveOptions(u);
    const perAp = this.state.effectiveMove(u) * 2;
    const W = this.state.grid.width;
    for (const [idx, cost] of opts) {
      const x = idx % W;
      const y = Math.floor(idx / W);
      const twoAp = cost > perAp;
      if (twoAp && u.ap < 2) continue;
      this.tracePoly(g, this.cellPoly(x, y));
      g.fill({ color: twoAp ? 0x8a6d1f : 0x2f6fae, alpha: twoAp ? 0.13 : 0.16 })
        .stroke({ width: 0.6, color: INK, alpha: 0.13 });
    }

    // hover: highlight the destination cell, sketch the path, price it in AP
    const h = this.hoverTile;
    if (!h) return;
    const hIdx = h.y * W + h.x;
    const cost = opts.get(hIdx);
    if (cost === undefined) return;
    const apCost = cost > perAp ? 2 : 1;
    if (apCost > u.ap) return;
    const path = findPath(this.state.grid, u, h, {
      blocked: this.state.occupied(u),
      maxCost: u.ap * this.state.effectiveMove(u),
    });
    if (path && path.length > 0) {
      const start = this.cellCenter(u.x, u.y);
      g.moveTo(start.x, start.y);
      for (const p of path) {
        const c = this.cellCenter(p.x, p.y);
        g.lineTo(c.x, c.y);
      }
      g.stroke({ width: 1.6, color: 0x2f6fae, alpha: 0.55, cap: 'round', join: 'round' });
    }
    this.tracePoly(g, this.cellPoly(h.x, h.y));
    g.fill({ color: 0x2f6fae, alpha: 0.18 }).stroke({ width: 1.6, color: INK, alpha: 0.65 });
    // destination cover shields
    this.drawCoverPips(g, h.x, h.y);
    const c = this.cellCenter(h.x, h.y);
    this.hoverLabel.text = `${apCost} AP`;
    this.hoverLabel.position.set(c.x, c.y - TILE * 0.8);
    this.hoverLabel.visible = true;
  }

  /** Armed spell: range ring; hovering a target shows the shot preview. */
  private drawArmedPreview(g: Graphics, u: Unit, spellId: SpellId): void {
    const s = SPELLS[spellId];
    if (s.range > 0) {
      g.circle(u.x * TILE + TILE / 2, u.y * TILE + TILE / 2, s.range * TILE)
        .fill({ color: 0xb03a2e, alpha: 0.07 })
        .stroke({ width: 1.5, color: 0xb03a2e, alpha: 0.45 });
    }
    const h = this.hoverTile;
    if (!h) return;
    if (spellId === 'sunder') {
      const terr = this.state.grid.get(h.x, h.y);
      const breachable = terr === Terrain.Wall || terr === Terrain.Window || terr === Terrain.Door;
      const near = Math.hypot(h.x - u.x, h.y - u.y) <= 1.5;
      this.hoverLabel.text = breachable ? (near ? '💥 breach here' : 'get adjacent') : 'needs a wall';
      this.hoverLabel.position.set(h.x * TILE + TILE / 2, h.y * TILE - TILE * 0.3);
      this.hoverLabel.visible = true;
      return;
    }
    const targetUnit = this.state.unitAt(h.x, h.y);
    if (!targetUnit || targetUnit.faction === 'squad' || !this.state.isVisibleToSquad(targetUnit)) return;
    const dist = Math.hypot(h.x - u.x, h.y - u.y);
    const inRange = s.range <= 0 || dist <= s.range;
    const hc = this.state.hitChance(u, targetUnit);
    const cx = h.x * TILE + TILE / 2;
    const cy = h.y * TILE + TILE / 2;
    if (!inRange) {
      this.hoverLabel.text = 'out of range';
    } else if (!hc) {
      this.hoverLabel.text = 'no sight line';
    } else if (s.minDmg !== undefined) {
      // sketch the actual firing line (peek origin included)
      const o = hc.origin;
      g.moveTo(o.x * TILE + TILE / 2, o.y * TILE + TILE / 2);
      g.lineTo(cx, cy);
      g.stroke({ width: 1.2, color: 0xb03a2e, alpha: 0.5 });
      const coverWord = hc.cover === 2 ? ' · full cover' : hc.cover === 1 ? ' · half cover' : ' · flanked!';
      this.hoverLabel.text = `${hc.chance}%${hc.chance === 100 ? '' : coverWord}`;
    } else {
      this.hoverLabel.text = SPELLS[spellId].name.toLowerCase();
    }
    this.hoverLabel.position.set(cx, cy - TILE * 0.9);
    this.hoverLabel.visible = true;
  }

  /** Shield pips on each side of a cell that has a cover element. */
  private drawCoverPips(g: Graphics, x: number, y: number): void {
    const grid = this.state.grid;
    const cx = x * TILE + TILE / 2;
    const cy = y * TILE + TILE / 2;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const lvl = grid.coverAt(x, y, dx, dy);
      if (lvl === 0) continue;
      drawShield(g, cx + dx * (TILE * 0.62), cy + dy * (TILE * 0.62), lvl);
    }
  }

  refreshUnits(): void {
    const seen = new Set<number>();
    for (const u of this.state.units) {
      seen.add(u.id);
      let node = this.unitNodes.get(u.id);
      if (!node) {
        node = this.makeUnitNode(u);
        this.unitNodes.set(u.id, node);
        this.unitLayer.addChild(node);
      }
      const anim = this.anims.get(u.id);
      if (!anim) node.position.set(u.x * TILE + TILE / 2, u.y * TILE + TILE / 2);
      const idx = u.y * this.state.grid.width + u.x;
      // corpses stay on the map (evidence to hide) unless stashed or carried
      const visible = u.stashed || u.carriedBy !== null
        ? false
        : u.faction === 'squad'
          ? true
          : this.debugReveal || this.state.visible.has(idx) || (anim?.pathVisible ?? false);
      node.visible = visible;
      node.alpha = u.subdued || u.sleepTurns > 0 ? 0.45 : 1;
      this.updateUnitNode(node, u);
    }
    for (const [id, node] of this.unitNodes) {
      if (!seen.has(id)) {
        node.destroy();
        this.unitNodes.delete(id);
      }
    }
    this.drawRange();
  }

  private makeUnitNode(u: Unit): Container {
    const c = new Container();
    const body = new Graphics();
    body.label = 'body';
    c.addChild(body);
    const letter = new Text({
      text: u.faction === 'squad' ? u.name[0] : u.isTarget || u.isDecoy ? '?' : '',
      style: { fontSize: 9, fill: 0xf2ede0, fontFamily: 'Georgia', fontWeight: 'bold' },
      resolution: 8,
    });
    letter.anchor.set(0.5);
    letter.label = 'letter';
    c.addChild(letter);
    const bar = new Graphics();
    bar.label = 'bar';
    c.addChild(bar);
    return c;
  }

  private updateUnitNode(node: Container, u: Unit): void {
    const body = node.getChildByLabel('body') as Graphics;
    const bar = node.getChildByLabel('bar') as Graphics;
    const letter = node.getChildByLabel('letter') as Text;
    body.clear();
    const color = FACTION_COLORS[u.faction] ?? 0xffffff;
    const r = u.faction === 'squad' ? TILE * 0.42 : TILE * 0.36;
    if (!u.alive) {
      body.circle(0, 0, r * 0.7).fill({ color: 0x4a443a, alpha: 0.8 });
      bar.clear();
      letter.text = '✕';
      return;
    }
    // silhouettes differ by faction: circles = wizards & folk, squares = uniforms, diamonds = blades
    if (u.faction === 'guard') {
      body.roundRect(-r * 0.92, -r * 0.92, r * 1.84, r * 1.84, 2).fill(color).stroke({ width: 1.5, color: INK });
    } else if (u.faction === 'hostile') {
      body.poly([0, -r * 1.15, r * 1.15, 0, 0, r * 1.15, -r * 1.15, 0]).fill(color).stroke({ width: 1.5, color: INK });
    } else if (u.faction === 'civilian') {
      body.circle(0, 0, r * (u.isTarget || u.isDecoy ? 1 : 0.8)).fill(color).stroke({ width: 1.2, color: INK });
    } else {
      body.circle(0, 0, r).fill(color).stroke({ width: 1.5, color: INK });
    }
    // stealth-game state pips: red ! = hostile and hunting, amber ? = investigating
    if (u.faction !== 'squad' && u.aiState === 'combat') {
      body.rect(-1, -r - 9.5, 2, 4.5).fill(0xb03a2e);
      body.circle(0, -r - 3.6, 1.1).fill(0xb03a2e);
    } else if (u.faction !== 'squad' && u.aiState === 'suspicious') {
      body.rect(-1, -r - 9, 2, 3).fill(0xc79a2a);
      body.circle(0, -r - 3.6, 1.1).fill(0xc79a2a);
    }
    // cover badges: wizards always show their covered sides…
    if (u.faction === 'squad') {
      const grid = this.state.grid;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const lvl = grid.coverAt(u.x, u.y, dx, dy);
        if (lvl > 0) drawShield(body, dx * (r + 3.5), dy * (r + 3.5), lvl);
      }
    } else if (this.ui.armedSpell && SPELLS[this.ui.armedSpell].minDmg !== undefined) {
      // …enemies show their cover against the aiming wizard (red dot = flanked)
      const sel = this.ui.selectedUnitId !== null ? this.state.unitById(this.ui.selectedUnitId) : null;
      if (sel && sel.faction === 'squad' && sel.alive) {
        const lvl = this.state.grid.coverFrom(u.x, u.y, sel.x, sel.y);
        if (lvl > 0) drawShield(body, 0, -(r + 5), lvl);
        else body.circle(0, -(r + 5), 2.2).fill(0xb03a2e);
      }
    }
    if (u.overwatch) body.circle(0, 0, r + 2.5).stroke({ width: 1.5, color: 0xb8a500 });
    if (u.wardHp > 0) body.circle(0, 0, r + 1.5).stroke({ width: 1.5, color: 0x7a5fb5 });
    if (u.suppressedTurns > 0) {
      // pinned: sparks raining down
      for (const ox of [-3, 0, 3]) {
        body.moveTo(ox, -r - 7).lineTo(ox - 1.2, -r - 3.8).stroke({ width: 1.2, color: 0xb03a2e });
      }
    }
    if (u.carrying !== null) body.circle(r * 0.7, -r * 0.7, r * 0.4).fill(0x6d6752);
    if (u.isTarget && this.state.knowledge.identityKnown) {
      body.circle(0, 0, r + 3.5).stroke({ width: 2, color: 0xb03a2e });
    }
    bar.clear();
    if (u.hp < u.maxHp) {
      const w = TILE * 0.9;
      bar.rect(-w / 2, -r - 4, w, 2.5).fill({ color: 0x39332a, alpha: 0.7 });
      bar.rect(-w / 2, -r - 4, (w * u.hp) / u.maxHp, 2.5).fill(0x4d7c3f);
    }
  }
}
