import { Module } from '@nestjs/common';
import { AdminShowcaseCommentsController } from './admin-showcase-comments.controller';
import { ShowcaseModule } from '../../showcase/showcase.module';

/**
 * Audit 2026-10-03 (FAL-010): modul admin untuk moderasi komentar showcase.
 * Mengimpor ShowcaseModule (ShowcaseService di-export) — tidak ada siklus:
 * ShowcaseModule tidak mengimpor modul ini.
 */
@Module({
  imports: [ShowcaseModule],
  controllers: [AdminShowcaseCommentsController],
})
export class AdminShowcaseCommentsModule {}
