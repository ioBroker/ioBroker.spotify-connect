import { execFile, type ExecFileOptions } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    /** Signal that killed the process, e.g. "SIGILL" */
    signal?: string;
    /** Spawn error, e.g. "EACCES" (noexec mount) or "ENOENT" (missing ELF interpreter) */
    spawnError?: string;
}

/** Runs a command and resolves with exit code and output, never rejects. */
export function run(cmd: string, args: string[], options: ExecFileOptions = {}): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: 600_000, maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
            const e = err as (Error & { code?: number | string; signal?: string | null }) | null;
            resolve({
                code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                signal: e?.signal || undefined,
                spawnError: typeof e?.code === 'string' ? e.code : undefined,
            });
        });
    });
}

/** Returns true if the binary is found in PATH. */
export async function hasBinary(name: string): Promise<boolean> {
    const res = await run('sh', ['-c', `command -v ${name}`]);
    return res.code === 0 && !!res.stdout.trim();
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
