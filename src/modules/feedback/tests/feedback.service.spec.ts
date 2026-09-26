import { Test, TestingModule } from '@nestjs/testing';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FeedbackService } from '../feedback.service';
import { CreateFeedbackDto } from '../dto/create-feedback.dto';
import { PrismaService } from '../../../prisma/prisma.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  const mockPrisma = {
    feedback: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedbackService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<FeedbackService>(FeedbackService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('menyimpan feedback user login dengan field lengkap', async () => {
      const createdAt = new Date();
      mockPrisma.feedback.create.mockResolvedValue({ id: 'fb123', createdAt });

      const result = await service.create('user-1', {
        category: 'Saran fitur',
        message: 'Tambahkan dark mode',
        contact: 'user@example.com',
        rating: 5,
        platform: 'app',
      });

      expect(mockPrisma.feedback.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          category: 'Saran fitur',
          message: 'Tambahkan dark mode',
          contact: 'user@example.com',
          rating: 5,
          platform: 'app',
        },
        select: { id: true, createdAt: true },
      });
      expect(result).toEqual({ success: true, data: { id: 'fb123', createdAt } });
    });

    it('menyimpan feedback guest (userId null) tanpa userId', async () => {
      mockPrisma.feedback.create.mockResolvedValue({ id: 'fb456', createdAt: new Date() });

      await service.create(null, {
        category: 'Lainnya',
        message: 'Halo',
      });

      expect(mockPrisma.feedback.create).toHaveBeenCalledWith({
        data: {
          userId: undefined,
          category: 'Lainnya',
          message: 'Halo',
          contact: undefined,
          rating: undefined,
          platform: 'app',
        },
        select: { id: true, createdAt: true },
      });
    });
  });

  describe('CreateFeedbackDto validation', () => {
    const toDto = (obj: object) => plainToInstance(CreateFeedbackDto, obj);

    it('menolak category/message kosong dan rating di luar 1-5', async () => {
      const dto = toDto({ category: '   ', message: '', rating: 9 });
      const errors = await validate(dto);
      const props = errors.map((e) => e.property);
      expect(props).toContain('category');
      expect(props).toContain('message');
      expect(props).toContain('rating');
    });

    it('menerima payload valid frontend (termasuk rating string dari form)', async () => {
      const dto = toDto({
        category: 'Pujian',
        message: 'Bagus!',
        rating: '5',
        platform: 'app',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.rating).toBe(5);
    });
  });
});
