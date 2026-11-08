/** Soloist reports the position only on events like pause or seek. This clock keeps it running in between. */
export class PlaybackClock {
    private positionMs = 0;
    private durationMs = 0;
    /** Time from which the position runs, null if the playback is stopped */
    private runningSince: number | null = null;

    public constructor(private readonly now: () => number = Date.now) {}

    public setPosition(ms: number): void {
        this.positionMs = ms;
        if (this.runningSince !== null) {
            this.runningSince = this.now();
        }
    }

    /** The position does not run past the duration. 0 means that the duration is unknown. */
    public setDuration(ms: number): void {
        this.durationMs = ms;
    }

    public setRunning(running: boolean): void {
        if (running === (this.runningSince !== null)) {
            return;
        }
        this.positionMs = this.currentMs();
        this.runningSince = running ? this.now() : null;
    }

    public get seconds(): number {
        return Math.round(this.currentMs() / 1000);
    }

    private currentMs(): number {
        const ms = this.positionMs + (this.runningSince === null ? 0 : this.now() - this.runningSince);
        return this.durationMs > 0 ? Math.min(ms, this.durationMs) : ms;
    }
}
