import { execFile, type ExecFileOptions } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs a command and resolves with exit code and output, never rejects. */
export function run(cmd: string, args: string[], options: ExecFileOptions = {}): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: 600_000, maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
            const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as any).code : 1) : 0;
            resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
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
