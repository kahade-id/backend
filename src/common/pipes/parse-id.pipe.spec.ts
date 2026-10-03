import { BadRequestException } from '@nestjs/common';
import { ParseIdPipe } from './parse-id.pipe';

describe('ParseIdPipe', () => {
  const pipe = new ParseIdPipe();

  describe('CUID v1 (backward compatible)', () => {
    it('accepts a valid CUID v1', () => {
      const cuid1 = 'ckz9q1x2y0000a1b2c3d4e5f6';
      expect(pipe.transform(cuid1)).toBe(cuid1);
    });

    it('accepts another valid CUID v1', () => {
      const cuid1 = 'cm3x8k2p10000abcdefghijkl';
      expect(pipe.transform(cuid1)).toBe(cuid1);
    });
  });

  describe('CUID v2 (chat message IDs)', () => {
    it('accepts a valid CUID2 (example from production chat)', () => {
      const cuid2 = 'lz86en0s6kbxtgoevh7k7az7';
      expect(pipe.transform(cuid2)).toBe(cuid2);
    });

    it('accepts a CUID2 starting with a digit', () => {
      const cuid2 = '9x7en0s6kbxtgoevh7k7az7q';
      expect(pipe.transform(cuid2)).toBe(cuid2);
    });

    it('accepts a CUID2 starting with "c" (24 chars, not 25)', () => {
      const cuid2 = 'ckz9q1x2y0000a1b2c3d4e5f';
      expect(cuid2.length).toBe(24);
      expect(pipe.transform(cuid2)).toBe(cuid2);
    });
  });

  describe('prefixed IDs', () => {
    it('accepts USR- prefixed IDs', () => {
      expect(pipe.transform('USR-AB12CD34')).toBe('USR-AB12CD34');
    });

    it('accepts ORD- prefixed IDs', () => {
      expect(pipe.transform('ORD-xyz789ABC')).toBe('ORD-xyz789ABC');
    });
  });

  describe('invalid IDs (still rejected)', () => {
    it('rejects empty string', () => {
      expect(() => pipe.transform('')).toThrow(BadRequestException);
    });

    it('rejects non-string values', () => {
      expect(() => pipe.transform(undefined as unknown as string)).toThrow(BadRequestException);
      expect(() => pipe.transform(null as unknown as string)).toThrow(BadRequestException);
    });

    it('rejects too-short IDs', () => {
      expect(() => pipe.transform('abc123')).toThrow(BadRequestException);
    });

    it('rejects 23-char lowercase alphanumeric (not CUID2 length)', () => {
      expect(() => pipe.transform('lz86en0s6kbxtgoevh7k7az')).toThrow(BadRequestException);
    });

    it('rejects 24-char with uppercase (CUID2 is lowercase only)', () => {
      expect(() => pipe.transform('LZ86EN0S6KBXTGOEVH7K7AZ7')).toThrow(BadRequestException);
    });

    it('rejects 24-char with special characters', () => {
      expect(() => pipe.transform('lz86en0s6kbxtgoevh7k7az!')).toThrow(BadRequestException);
    });

    it('rejects SQL injection attempts', () => {
      expect(() => pipe.transform("' OR '1'='1")).toThrow(BadRequestException);
    });

    it('rejects IDs over max length', () => {
      expect(() => pipe.transform('a'.repeat(101))).toThrow(BadRequestException);
    });

    it('rejects malformed prefixed IDs', () => {
      expect(() => pipe.transform('USR-')).toThrow(BadRequestException);
    });
  });
});
