/**
 * Vitest setup file - runs before all tests
 *
 * Sets required environment variables for test environment.
 */

// Miriad Cloud requires MIRIAD_RUNTIME_MODE to be set
// Use 'docker' for tests since it doesn't require external services
process.env.MIRIAD_RUNTIME_MODE = 'docker';

// Docker mode requires MIRIAD_CLOUD_IMAGE
process.env.MIRIAD_CLOUD_IMAGE = 'miriad-cloud:test';

// =============================================================================
// Error Handling for Test Worker Stability
// =============================================================================

// Catch unhandled promise rejections to prevent worker crashes
// These can cause "Worker exited unexpectedly" errors in vitest
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Test Setup] Unhandled Promise Rejection:', reason);
  // Don't exit - let the test framework handle reporting
});

// Catch uncaught exceptions similarly
process.on('uncaughtException', (error) => {
  console.error('[Test Setup] Uncaught Exception:', error);
  // Don't exit - let the test framework handle reporting
});
