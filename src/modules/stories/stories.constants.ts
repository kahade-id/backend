import {
  STORY_MEDIA_MAX_BYTES as APP_STORY_MEDIA_MAX_BYTES,
  STORY_VIDEO_MAX_BYTES as APP_STORY_VIDEO_MAX_BYTES,
  STORY_VIDEO_MAX_DURATION_SEC as APP_STORY_VIDEO_MAX_DURATION_SEC,
  STORY_VIDEO_MIN_DURATION_SEC as APP_STORY_VIDEO_MIN_DURATION_SEC,
  STORY_VIDEO_THUMBNAIL_WIDTH as APP_STORY_VIDEO_THUMBNAIL_WIDTH,
} from '../../common/constants/app.constants';

/** Foto story: maks 10 MB (dikecilkan ulang ke 1600 px oleh server). */
export const STORY_MEDIA_MAX_BYTES = APP_STORY_MEDIA_MAX_BYTES;
/** Video story: maks 50 MB / 60 detik (lihat app.constants). */
export const STORY_VIDEO_MAX_BYTES = APP_STORY_VIDEO_MAX_BYTES;
export const STORY_VIDEO_MAX_DURATION_SEC = APP_STORY_VIDEO_MAX_DURATION_SEC;
export const STORY_VIDEO_MIN_DURATION_SEC = APP_STORY_VIDEO_MIN_DURATION_SEC;
export const STORY_VIDEO_THUMBNAIL_WIDTH = APP_STORY_VIDEO_THUMBNAIL_WIDTH;
/**
 * Batas multer untuk POST /stories/media: cukup untuk video + overhead
 * multipart. Batas per-jenis (foto 10 MB / video 50 MB) ditegakkan di
 * StoriesService.uploadStoryMedia sebelum file menyentuh storage.
 */
export const STORY_MEDIA_MULTER_MAX_BYTES = STORY_VIDEO_MAX_BYTES + 64 * 1024;

export const STORY_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const STORY_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

export function isStoryVideoContentType(contentType: string): boolean {
  return (STORY_VIDEO_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

export function isStoryImageContentType(contentType: string): boolean {
  return (STORY_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());
}
