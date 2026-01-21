/**
 * Slug utilities for artifact identifiers.
 *
 * Slugs must match: /^[a-z0-9-]+(\.[a-z0-9]+)*$/
 * - Lowercase letters, numbers, hyphens
 * - Optional file extension (dot followed by lowercase alphanumeric)
 */

/**
 * Valid slug pattern - used for validation.
 */
export const SLUG_PATTERN = /^[a-z0-9-]+(\.[a-z0-9]+)*$/;

/**
 * Convert a string (typically a filename) into a valid slug.
 *
 * Transformations:
 * - Lowercase
 * - Replace spaces and underscores with hyphens
 * - Remove characters that aren't alphanumeric, hyphens, or dots
 * - Collapse multiple hyphens into one
 * - Remove leading/trailing hyphens (but preserve extension)
 *
 * @example
 * slugify("My File Name.png") // "my-file-name.png"
 * slugify("splatter_teal_20260103.PNG") // "splatter-teal-20260103.png"
 * slugify("weird!!!name...test.jpg") // "weird-name-test.jpg"
 */
export function slugify(input: string): string {
  if (!input) return '';

  // Split extension from base name
  const lastDotIndex = input.lastIndexOf('.');
  let baseName: string;
  let extension: string | null = null;

  if (lastDotIndex > 0) {
    baseName = input.slice(0, lastDotIndex);
    extension = input.slice(lastDotIndex + 1).toLowerCase();
    // Clean extension - only alphanumeric
    extension = extension.replace(/[^a-z0-9]/g, '');
    if (!extension) extension = null;
  } else {
    baseName = input;
  }

  // Process base name
  let slug = baseName
    .toLowerCase()
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove anything that's not alphanumeric or hyphen
    .replace(/[^a-z0-9-]/g, '')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');

  // Handle edge case: empty slug
  if (!slug) {
    slug = 'file';
  }

  // Reattach extension
  if (extension) {
    return `${slug}.${extension}`;
  }

  return slug;
}

/**
 * Check if a string is a valid slug.
 */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}
