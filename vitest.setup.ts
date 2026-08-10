import '@testing-library/jest-dom/vitest';

// Tests must never depend on a developer's local .env.
process.env.DEMO_MODE = '1';
process.env.NODE_ENV = 'test';
