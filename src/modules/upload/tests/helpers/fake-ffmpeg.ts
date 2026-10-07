/**
 * Harness test Bug #2: biner ffprobe/ffmpeg PALSU (shell script) supaya
 * perilaku proses anak nyata — timeout, SIGKILL, PID benar-benar mati, slot
 * semaphore dilepas — terverifikasi tanpa ffmpeg sungguhan di mesin test.
 *
 * Biner ditunjuk lewat `FFPROBE_PATH`/`FFMPEG_PATH` (VideoProcessingService),
 * bukan lewat PATH: resolusi PATH libuv memakai environ proses induk sehingga
 * `process.env.PATH` yang diubah di dalam worker Jest tidak berpengaruh.
 *
 * Mode dikendalikan berkas `<dir>/mode`:
 *  - `ok`        : ffprobe → JSON valid (12.5s, 1280x720); ffmpeg → menulis dest.
 *  - `hang`      : mengabaikan SIGTERM (`trap '' TERM; exec sleep 600`).
 *  - `garbage`   : ffprobe → keluaran bukan JSON.
 *  - `too-long`  : ffprobe → durasi 300s (di atas batas 180s).
 *  - `huge`      : ffprobe → 8000x4320 (di atas batas 3840px).
 *  - `fail`      : ffmpeg keluar dengan status 1.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type FakeFfmpegMode = 'ok' | 'hang' | 'garbage' | 'too-long' | 'huge' | 'fail';

const FFPROBE_SCRIPT = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "-version" ]; then echo "ffprobe version 6.0-fake"; exit 0; fi
echo $$ > "$DIR/ffprobe.pid"
MODE="$(cat "$DIR/mode" 2>/dev/null || echo ok)"
case "$MODE" in
  hang) trap '' TERM; exec sleep 600 ;;
  garbage) printf 'not-json' ;;
  too-long) printf '{"format":{"duration":"300"},"streams":[{"width":1280,"height":720}]}' ;;
  huge) printf '{"format":{"duration":"12.5"},"streams":[{"width":8000,"height":4320}]}' ;;
  *) printf '{"format":{"duration":"12.5"},"streams":[{"width":1280,"height":720}]}' ;;
esac
`;

const FFMPEG_SCRIPT = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "-version" ]; then echo "ffmpeg version 6.0-fake"; exit 0; fi
echo $$ > "$DIR/ffmpeg.pid"
MODE="$(cat "$DIR/mode" 2>/dev/null || echo ok)"
case "$MODE" in
  hang) trap '' TERM; exec sleep 600 ;;
  fail) exit 1 ;;
  *) for a in "$@"; do DEST="$a"; done; printf 'JPEG-FAKE-THUMBNAIL' > "$DEST" ;;
esac
`;

export interface FakeFfmpegHarness {
  dir: string;
  ffprobeBin: string;
  ffmpegBin: string;
  setMode(mode: FakeFfmpegMode): void;
  /** Pasang FFPROBE_PATH/FFMPEG_PATH (dipanggil sebelum service dibuat). */
  installEnv(): void;
  /** Kembalikan env + bunuh proses `sleep` yatim + hapus direktori. */
  cleanup(): void;
  readPid(bin: 'ffprobe' | 'ffmpeg'): number | null;
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Tunggu sampai proses mati; kembalikan PID bila masih hidup. */
export async function waitUntilDead(pidFile: string, timeoutMs = 2000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let pid = readPid(pidFile);
  while (pid !== null && isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    pid = readPid(pidFile);
  }
  return pid !== null && isAlive(pid) ? pid : null;
}

export function createFakeFfmpegHarness(): FakeFfmpegHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kahade-ffmpeg-'));
  const ffprobeBin = path.join(dir, 'ffprobe');
  const ffmpegBin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(ffprobeBin, FFPROBE_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(ffmpegBin, FFMPEG_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mode'), 'ok', 'utf8');
  const origProbePath = process.env.FFPROBE_PATH;
  const origFfmpegPath = process.env.FFMPEG_PATH;

  return {
    dir,
    ffprobeBin,
    ffmpegBin,
    setMode: (mode) => fs.writeFileSync(path.join(dir, 'mode'), mode, 'utf8'),
    installEnv: () => {
      process.env.FFPROBE_PATH = ffprobeBin;
      process.env.FFMPEG_PATH = ffmpegBin;
    },
    readPid: (bin) => readPid(path.join(dir, `${bin}.pid`)),
    cleanup: () => {
      for (const bin of ['ffprobe', 'ffmpeg'] as const) {
        const pid = readPid(path.join(dir, `${bin}.pid`));
        if (pid !== null && isAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* sudah mati */
          }
        }
        fs.rmSync(path.join(dir, `${bin}.pid`), { force: true });
      }
      if (origProbePath === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = origProbePath;
      if (origFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = origFfmpegPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
