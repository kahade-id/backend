import { PartialType } from '@nestjs/swagger';
import { CreateJobPostingDto } from './create-job-posting.dto';

/**
 * Semua field opsional — termasuk `isActive` (toggle tutup/buka lowongan).
 */
export class UpdateJobPostingDto extends PartialType(CreateJobPostingDto) {}
