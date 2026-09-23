export type GameSpeed = 0 | 1 | 2 | 4 | 8;

export interface GameClockSnapshot {
  gameSeconds: number;
  speed: GameSpeed;
}

export class GameClock {
  gameSeconds = 0;
  speed: GameSpeed = 1;
  private fraction = 0;

  advance(realSeconds: number): void {
    this.fraction += realSeconds * this.speed * 10;
    const wholeSeconds = Math.floor(this.fraction);
    this.fraction -= wholeSeconds;
    this.gameSeconds += wholeSeconds;
  }

  snapshot(): GameClockSnapshot {
    return { gameSeconds: this.gameSeconds, speed: this.speed };
  }

  restore(snapshot: GameClockSnapshot): void {
    this.gameSeconds = Math.max(0, Math.floor(snapshot.gameSeconds));
    this.speed = snapshot.speed;
    this.fraction = 0;
  }
}
