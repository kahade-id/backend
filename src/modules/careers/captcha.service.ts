import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';

export interface CaptchaChallenge {
  challengeId: string;
  /** Soal matematika sederhana, mis. "7 + 4 = ?". Jawaban TIDAK PERNAH ke client. */
  question: string;
  /** Detik hingga challenge kedaluwarsa. */
  expiresIn: number;
}

interface StoredChallenge {
  answer: number;
  expiresAt: number;
}

/** TTL challenge 5 menit (keputusan user). */
export const CAPTCHA_TTL_MS = 5 * 60 * 1000;

/**
 * CAPTCHA self-hosted (tanpa layanan eksternal) untuk form lamaran karir.
 *
 * - `issueChallenge()` → `{ challengeId, question }`; jawaban hanya di server.
 * - `verifyChallenge()` → single-use: challenge DIHAPUS pada percobaan
 *   pertama (benar maupun salah) + ditolak bila kedaluwarsa.
 *
 * Penyimpanan in-memory (Map + TTL). Tradeoff eksplisit: bila deployment
 * diskalakan ke >1 instance, challenge hanya valid di instance penerbit.
 * PM2 saat ini `instances: 1` (deploy/ecosystem.config.js) sehingga ini aman;
 * bila instances ditambah, pindahkan ke Redis.
 */
@Injectable()
export class CareerCaptchaService {
  private readonly logger = new Logger(CareerCaptchaService.name);
  private readonly challenges = new Map<string, StoredChallenge>();

  issueChallenge(): CaptchaChallenge {
    this.sweepExpired();

    const op = randomInt(0, 3); // 0: tambah, 1: kurang, 2: kali
    let question: string;
    let answer: number;
    if (op === 0) {
      const a = randomInt(1, 21);
      const b = randomInt(1, 21);
      question = `${a} + ${b} = ?`;
      answer = a + b;
    } else if (op === 1) {
      const a = randomInt(1, 21);
      const b = randomInt(1, 21);
      const [x, y] = a >= b ? [a, b] : [b, a]; // hindari hasil negatif
      question = `${x} − ${y} = ?`;
      answer = x - y;
    } else {
      const a = randomInt(1, 10);
      const b = randomInt(1, 10);
      question = `${a} × ${b} = ?`;
      answer = a * b;
    }

    const challengeId = randomBytes(16).toString('hex');
    this.challenges.set(challengeId, {
      answer,
      expiresAt: Date.now() + CAPTCHA_TTL_MS,
    });
    return { challengeId, question, expiresIn: Math.floor(CAPTCHA_TTL_MS / 1000) };
  }

  /**
   * Verifikasi jawaban. Single-use: entri dihapus apa pun hasilnya.
   * @returns true hanya bila challenge ada, belum kedaluwarsa, dan jawaban cocok.
   */
  verifyChallenge(challengeId: string, answer: number): boolean {
    const stored = this.challenges.get(challengeId);
    // Single-use: hapus pada percobaan pertama (mencegah brute-force ulang).
    this.challenges.delete(challengeId);
    if (!stored) return false;
    if (Date.now() > stored.expiresAt) return false;
    // Perbandingan integer timing-safe sederhana (tanpa early-exit string compare).
    return stored.answer === answer;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, c] of this.challenges) {
      if (now > c.expiresAt) this.challenges.delete(id);
    }
  }
}
