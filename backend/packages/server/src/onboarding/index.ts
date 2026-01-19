/**
 * Onboarding Module
 *
 * Handles fetching and seeding initial content for new spaces.
 * Content is managed in Sanity Studio and fetched at signup time.
 */

export { fetchOnboardingContent } from './sanity-client';
export type { OnboardingContent } from './sanity-client';
export { transformOnboardingContent } from './transform';
export type { TransformedContent } from './transform';
export { seedSpaceFromSanity } from './seed';
export { resetRootChannel } from './reset';
