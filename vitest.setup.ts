import '@testing-library/jest-dom/vitest';

// Tests must never depend on a developer's local .env.
process.env.DEMO_MODE = '1';
process.env.NODE_ENV = 'test';

/**
 * jsdom has no layout, so it implements neither of these and logs a stack trace
 * every time one is called. Both are ordinary in a form that moves focus
 * between steps; the noise made real failures harder to find in the output.
 */
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
}
