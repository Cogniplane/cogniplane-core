export const MAX_SKILL_BUNDLE_FILES = 50;
export const MAX_SKILL_BUNDLE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Most entries (files and folders) that a GitHub repository archive can have.
 * The bundle limits above apply only to the selected skill folder. Outside it,
 * the import reads entry names but no content. This limits the number of
 * central directory records for which JSZip can allocate objects.
 */
export const MAX_GITHUB_ARCHIVE_ENTRIES = 20_000;
