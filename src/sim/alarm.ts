import type { EventBus } from '../core/events';

/**
 * City-wide alarm 0–5 — the mission timer pressure. Raised by witnessed
 * violence and loud magic; thresholds spawn reinforcements (handled by the
 * mission via onLevelUp).
 */
export class Alarm {
  points = 0;
  level = 0;
  onLevelUp: ((level: number) => void) | null = null;

  constructor(private bus: EventBus) {}

  add(points: number, reason: string): void {
    if (points <= 0) return;
    this.points += points;
    const newLevel = Math.min(5, Math.floor(this.points / 5));
    if (newLevel > this.level) {
      for (let l = this.level + 1; l <= newLevel; l++) {
        this.level = l;
        this.bus.emit('alarmChanged', { level: l, reason });
        this.onLevelUp?.(l);
      }
    } else {
      this.bus.emit('alarmChanged', { level: this.level, reason });
    }
  }
}

export const ALARM_LABELS = [
  'Quiet streets',
  'Uneasy whispers',
  'Guards alerted',
  'Manhunt',
  'District lockdown',
  'The city hunts you',
];
