import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const libraryPath = path.join(dataDir, 'test-library.json');

const defaultLibrary = {
  tests: [],
  suites: [],
};

export async function readLibrary() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const library = JSON.parse(await fs.readFile(libraryPath, 'utf8'));
    return {
      tests: Array.isArray(library.tests) ? library.tests : [],
      suites: Array.isArray(library.suites) ? library.suites : [],
    };
  } catch {
    await writeLibrary(defaultLibrary);
    return structuredClone(defaultLibrary);
  }
}

export async function writeLibrary(library) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

export async function saveTest(input) {
  const library = await readLibrary();
  const now = new Date().toISOString();
  const id = input.id || slugify(input.name || path.basename(input.flowFile || 'test'));
  const existing = library.tests.find((test) => test.id === id);
  const test = {
    id,
    name: input.name || existing?.name || id,
    flowFile: normalizeFlowFile(input.flowFile || existing?.flowFile || ''),
    platform: input.platform || existing?.platform || 'android',
    tags: Array.isArray(input.tags) ? input.tags : existing?.tags || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastStatus: existing?.lastStatus || null,
    lastRunId: existing?.lastRunId || null,
  };

  if (!test.flowFile) throw new Error('flowFile is required.');

  if (existing) Object.assign(existing, test);
  else library.tests.push(test);

  await writeLibrary(library);
  return test;
}

export async function saveSuite(input) {
  const library = await readLibrary();
  const now = new Date().toISOString();
  const id = input.id || slugify(input.name || 'suite');
  const testIds = [...new Set(input.testIds || [])].filter((testId) => library.tests.some((test) => test.id === testId));
  if (!testIds.length) throw new Error('A suite needs at least one saved test.');

  const existing = library.suites.find((suite) => suite.id === id);
  const suite = {
    id,
    name: input.name || existing?.name || id,
    testIds,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastStatus: existing?.lastStatus || null,
    lastRunId: existing?.lastRunId || null,
  };

  if (existing) Object.assign(existing, suite);
  else library.suites.push(suite);

  await writeLibrary(library);
  return suite;
}

export async function deleteTest(testId) {
  const library = await readLibrary();
  const existingIndex = library.tests.findIndex((test) => test.id === testId);
  if (existingIndex === -1) throw new Error(`Test not found: ${testId}`);

  library.tests.splice(existingIndex, 1);
  library.suites = library.suites
    .map((suite) => ({ ...suite, testIds: suite.testIds.filter((id) => id !== testId) }))
    .filter((suite) => suite.testIds.length > 0);

  await writeLibrary(library);
}

export async function deleteSuite(suiteId) {
  const library = await readLibrary();
  const nextSuites = library.suites.filter((suite) => suite.id !== suiteId);
  if (nextSuites.length === library.suites.length) throw new Error(`Suite not found: ${suiteId}`);

  await writeLibrary({ ...library, suites: nextSuites });
}

export async function getTestsByIds(testIds) {
  const library = await readLibrary();
  const selected = testIds
    .map((testId) => library.tests.find((test) => test.id === testId))
    .filter(Boolean);

  if (!selected.length) throw new Error('No saved tests found for the selected ids.');
  return selected;
}

export async function getSuiteById(suiteId) {
  const library = await readLibrary();
  const suite = library.suites.find((item) => item.id === suiteId);
  if (!suite) throw new Error(`Suite not found: ${suiteId}`);
  const tests = await getTestsByIds(suite.testIds);
  return { suite, tests };
}

export async function updateRunResult({ testIds = [], suiteId, status, runId }) {
  const library = await readLibrary();
  const now = new Date().toISOString();

  for (const test of library.tests) {
    if (testIds.includes(test.id)) {
      test.lastStatus = status;
      test.lastRunId = runId;
      test.updatedAt = now;
    }
  }

  for (const suite of library.suites) {
    if (suite.id === suiteId) {
      suite.lastStatus = status;
      suite.lastRunId = runId;
      suite.updatedAt = now;
    }
  }

  await writeLibrary(library);
}

export function testsToFlowFiles(tests) {
  return tests.map((test) => normalizeFlowFile(test.flowFile));
}

function normalizeFlowFile(flowFile) {
  if (!flowFile) return '';
  const absolute = path.isAbsolute(flowFile) ? flowFile : path.resolve(rootDir, flowFile);
  return path.relative(rootDir, absolute);
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `item-${Date.now()}`;
}
