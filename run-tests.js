#!/usr/bin/env node
import { runMobileTests } from './scripts/orchestrator.js';

try {
  const summary = await runMobileTests();
  process.exitCode = summary.failed > 0 || summary.exitCode !== 0 ? 1 : 0;
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
