/**
 * easytg studio, from code: `startStudio({ file })` runs a bot against a
 * simulated Telegram and serves the studio page.
 */
export { startStudio, type Studio, type StudioOptions } from './server';
export { generateTest, screenOf, type RecordedStep, type Screen } from './testgen';
