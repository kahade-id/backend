import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobApplicationStatus } from '@prisma/client';
import { CareersRetentionService } from '../careers-retention.service';
import { CV_PENDING_TTL_MS } from '../careers.service';

const prismaMock = {
  jobApplication: { findMany: jest.fn(), delete: jest.fn() },
};
const uploadServiceMock = {
  deleteStoredFile: jest.fn().mockResolvedValue(true),
};
const configServiceMock = { get: jest.fn() };

function makeService() {
  return new CareersRetentionService(
    prismaMock as never,
    uploadServiceMock as never,
    configServiceMock as never,
  );
}

describe('CareersRetentionService.purgeRejectedApplications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hanya query DITOLAK dengan updatedAt < 90 hari; hapus file + baris DB', async () => {
    prismaMock.jobApplication.findMany.mockResolvedValue([
      { id: 'app-old', cvFileKey: 'uploads/career-cvs/u/old.pdf' },
    ]);
    prismaMock.jobApplication.delete.mockResolvedValue({});
    const service = makeService();

    const res = await service.purgeRejectedApplications();

    expect(res.deleted).toBe(1);
    const where = prismaMock.jobApplication.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(JobApplicationStatus.DITOLAK);
    const cutoff: Date = where.updatedAt.lt;
    const ageDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThanOrEqual(90);
    expect(ageDays).toBeLessThan(91);
    expect(uploadServiceMock.deleteStoredFile).toHaveBeenCalledWith('uploads/career-cvs/u/old.pdf');
    expect(prismaMock.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-old' } });
  });

  it('tidak ada yang basi → deleted 0, tidak ada penghapusan', async () => {
    prismaMock.jobApplication.findMany.mockResolvedValue([]);
    const service = makeService();
    const res = await service.purgeRejectedApplications();
    expect(res.deleted).toBe(0);
    expect(prismaMock.jobApplication.delete).not.toHaveBeenCalled();
  });
});

describe('CareersRetentionService.cleanupPendingCvs', () => {
  let tmp: string;
  let service: CareersRetentionService;

  beforeEach(() => {
    jest.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-cv-test-'));
    configServiceMock.get.mockReturnValue(tmp);
    service = makeService();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function putFile(uuid: string, name: string, mtimeMs: number) {
    const dir = path.join(tmp, 'career-cvs', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, '%PDF-1.4 fake');
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return `uploads/career-cvs/${uuid}/${name}`;
  }

  it('hapus file >1 jam yang tidak dirujuk DB; pertahankan yang baru & yang dirujuk', async () => {
    const oldUnref = putFile('u-old', 'a.pdf', Date.now() - CV_PENDING_TTL_MS - 60_000);
    const freshUnref = putFile('u-fresh', 'b.pdf', Date.now() - 1000);
    const oldRef = putFile('u-ref', 'c.pdf', Date.now() - CV_PENDING_TTL_MS - 60_000);

    prismaMock.jobApplication.findMany.mockResolvedValue([{ cvFileKey: oldRef }]);

    const res = await service.cleanupPendingCvs();

    expect(res.deleted).toBe(1);
    expect(uploadServiceMock.deleteStoredFile).toHaveBeenCalledTimes(1);
    expect(uploadServiceMock.deleteStoredFile).toHaveBeenCalledWith(oldUnref);
    expect(uploadServiceMock.deleteStoredFile).not.toHaveBeenCalledWith(freshUnref);
    expect(uploadServiceMock.deleteStoredFile).not.toHaveBeenCalledWith(oldRef);
  });
});
