import { CareerCaptchaService, CAPTCHA_TTL_MS } from '../captcha.service';

describe('CareerCaptchaService', () => {
  let service: CareerCaptchaService;

  beforeEach(() => {
    service = new CareerCaptchaService();
  });

  it('menerbitkan challenge { challengeId, question } tanpa jawaban ke client', () => {
    const c = service.issueChallenge();
    expect(typeof c.challengeId).toBe('string');
    expect(c.challengeId.length).toBeGreaterThan(16);
    expect(c.question).toMatch(/= \?$/);
    expect((c as unknown as Record<string, unknown>).answer).toBeUndefined();
    expect(c.expiresIn).toBe(Math.floor(CAPTCHA_TTL_MS / 1000));
  });

  it('challengeId unik per penerbitan', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => service.issueChallenge().challengeId),
    );
    expect(ids.size).toBe(50);
  });

  it('verifikasi benar → true (perlu jawaban yang benar dari internal)', () => {
    // Akses internal Map untuk mengambil jawaban yang benar (test-only).
    const c = service.issueChallenge();
    const stored = (service as unknown as { challenges: Map<string, { answer: number }> })
      .challenges.get(c.challengeId)!;
    expect(service.verifyChallenge(c.challengeId, stored.answer)).toBe(true);
  });

  it('jawaban salah → false', () => {
    const c = service.issueChallenge();
    const stored = (service as unknown as { challenges: Map<string, { answer: number }> })
      .challenges.get(c.challengeId)!;
    expect(service.verifyChallenge(c.challengeId, stored.answer + 9999)).toBe(false);
  });

  it('single-use: challenge yang sama tidak bisa diverifikasi dua kali', () => {
    const c = service.issueChallenge();
    const stored = (service as unknown as { challenges: Map<string, { answer: number }> })
      .challenges.get(c.challengeId)!;
    expect(service.verifyChallenge(c.challengeId, stored.answer)).toBe(true);
    // Percobaan kedua dengan jawaban BENAR pun ditolak (sudah dihapus).
    expect(service.verifyChallenge(c.challengeId, stored.answer)).toBe(false);
  });

  it('single-use: percobaan salah menghanguskan challenge', () => {
    const c = service.issueChallenge();
    const stored = (service as unknown as { challenges: Map<string, { answer: number }> })
      .challenges.get(c.challengeId)!;
    expect(service.verifyChallenge(c.challengeId, stored.answer + 1)).toBe(false);
    expect(service.verifyChallenge(c.challengeId, stored.answer)).toBe(false);
  });

  it('challenge kedaluwarsa (TTL 5 menit) → false', () => {
    const c = service.issueChallenge();
    const map = (service as unknown as { challenges: Map<string, { answer: number; expiresAt: number }> })
      .challenges;
    const stored = map.get(c.challengeId)!;
    stored.expiresAt = Date.now() - 1; // paksa kedaluwarsa
    expect(service.verifyChallenge(c.challengeId, stored.answer)).toBe(false);
  });

  it('challengeId tidak dikenal → false', () => {
    expect(service.verifyChallenge('tidak-ada', 42)).toBe(false);
  });
});
