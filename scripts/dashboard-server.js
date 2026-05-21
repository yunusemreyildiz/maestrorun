#!/usr/bin/env node
import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readReportSummaries, runMobileTests } from './orchestrator.js';
import {
  deleteSuite,
  deleteTest,
  getSuiteById,
  getTestsByIds,
  readLibrary,
  saveSuite,
  saveTest,
  testsToFlowFiles,
  updateRunResult,
} from './test-library.js';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const dataDir = path.join(rootDir, 'data');
const scheduleConfigPath = path.join(dataDir, 'schedule.json');
const reportsDir = path.join(rootDir, 'reports');
const dashboardDist = path.join(rootDir, 'dashboard', 'dist');
const port = Number(process.env.API_PORT || process.env.PORT || 3001);
const execFileAsync = promisify(execFile);

const editableConfigKeys = [
  'SLACK_WEBHOOK',
  'ENVIRONMENT',
  'DEVICE_NAME',
  'MOBILE_PLATFORM',
  'APP_APK_PATH',
  'APP_IOS_PATH',
  'APP_REINSTALL',
  'APP_RESET_DATA',
  'SLACK_NOTIFY',
  'APP_ID',
  'TEST_EMAIL',
  'TEST_PASSWORD',
  'QA_EMAIL',
  'QA_PASSWORD',
  'FLOW_PATH',
  'MAESTRO_TIMEOUT_MS',
  'DASHBOARD_BASE_URL',
];

const cronMarkerStart = '# maestRoRun nightly schedule start';
const cronMarkerEnd = '# maestRoRun nightly schedule end';

const app = express();
const clients = new Set();

let activeRun = null;
let activeAbortController = null;
let latestStatus = {
  phase: 'idle',
  message: 'No run active',
  timestamp: new Date().toISOString(),
};

app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, activeRun: Boolean(activeRun), latestStatus });
});

app.get('/api/config', (_req, res) => {
  res.json({
    environment: process.env.ENVIRONMENT || 'local',
    deviceName: process.env.DEVICE_NAME || '',
    platform: process.env.MOBILE_PLATFORM || 'android',
    appApkPath: process.env.APP_APK_PATH || '',
    appIosPath: process.env.APP_IOS_PATH || '',
    appId: process.env.APP_ID || '',
    testEmail: process.env.TEST_EMAIL || process.env.QA_EMAIL || '',
    testPassword: process.env.TEST_PASSWORD || process.env.QA_PASSWORD || '',
    flowPath: process.env.FLOW_PATH || 'flows',
    slackWebhook: process.env.SLACK_WEBHOOK || '',
    dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || '',
    maestroTimeoutMs: process.env.MAESTRO_TIMEOUT_MS || '',
    reinstallApp: parseBoolean(process.env.APP_REINSTALL ?? true),
    resetAppData: parseBoolean(process.env.APP_RESET_DATA ?? true),
    notifySlack: parseBoolean(process.env.SLACK_NOTIFY ?? false),
  });
});

app.post('/api/config', async (req, res, next) => {
  try {
    const updates = configPayloadToEnv(req.body || {});
    await updateEnvFile(updates);
    Object.assign(process.env, updates);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/devices', async (_req, res) => {
  const [android, ios] = await Promise.all([
    listAndroidDevices(),
    listIosDevices(),
  ]);
  res.json({ android: android.devices, ios: ios.devices, errors: [...android.errors, ...ios.errors] });
});

app.get('/api/schedule', async (_req, res, next) => {
  try {
    const config = await readScheduleConfig();
    res.json({
      ...config,
      command: buildCronCommand(config),
      installed: await cronIsInstalled(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/schedule', async (req, res, next) => {
  try {
    const config = normalizeScheduleConfig(req.body || {});
    await writeScheduleConfig(config);
    res.json({
      ...config,
      command: buildCronCommand(config),
      installed: await cronIsInstalled(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/schedule/install', async (req, res, next) => {
  try {
    const config = normalizeScheduleConfig(req.body || await readScheduleConfig());
    await writeScheduleConfig(config);
    await installCron(config);
    res.json({
      ...config,
      command: buildCronCommand(config),
      installed: true,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/schedule/remove', async (_req, res, next) => {
  try {
    await removeCron();
    const config = await readScheduleConfig();
    res.json({
      ...config,
      command: buildCronCommand(config),
      installed: false,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').toLowerCase();
    const status = String(req.query.status || 'all');
    let reports = await readReportSummaries();

    if (status !== 'all') {
      reports = reports.filter((report) => report.status === status);
    }

    if (search) {
      reports = reports.filter((report) => [
        report.runId,
        report.environment,
        report.deviceName,
        report.platform,
        ...(report.failedTests || []).map((test) => test.name),
      ].filter(Boolean).join(' ').toLowerCase().includes(search));
    }

    res.json({ reports });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports/:runId', async (req, res, next) => {
  try {
    const file = path.join(reportsDir, safeRunId(req.params.runId), 'summary.json');
    const summary = JSON.parse(await fs.readFile(file, 'utf8'));
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.post('/api/reports/:runId/archive', async (req, res, next) => {
  try {
    const runId = safeRunId(req.params.runId);
    const runDir = path.join(reportsDir, runId);
    const archiveDir = path.join(reportsDir, 'archive');
    const targetDir = path.join(archiveDir, runId);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.rename(runDir, targetDir);
    res.json({ ok: true, archivedPath: path.relative(rootDir, targetDir) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/reports/:runId', async (req, res, next) => {
  try {
    await fs.rm(path.join(reportsDir, safeRunId(req.params.runId)), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run', async (req, res) => {
  startRun(req, res, {
    requestLabel: 'Dashboard requested a Maestro run',
    displayName: 'Tüm Maestro flowları',
    runOptions: {
      environment: req.body?.environment,
      deviceName: req.body?.deviceName,
      platform: req.body?.platform,
      flowPath: req.body?.flowPath,
      appApkPath: req.body?.appApkPath,
      appIosPath: req.body?.appIosPath,
      reinstallApp: req.body?.reinstallApp,
      resetAppData: req.body?.resetAppData,
      notifySlack: req.body?.notifySlack,
    },
  });
});

app.get('/api/library', async (_req, res, next) => {
  try {
    res.json(await readLibrary());
  } catch (error) {
    next(error);
  }
});

app.post('/api/tests', async (req, res, next) => {
  try {
    const test = await saveTest(req.body || {});
    res.status(201).json({ test, library: await readLibrary() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/tests/:testId', async (req, res, next) => {
  try {
    await deleteTest(req.params.testId);
    res.json({ ok: true, library: await readLibrary() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/suites', async (req, res, next) => {
  try {
    const suite = await saveSuite(req.body || {});
    res.status(201).json({ suite, library: await readLibrary() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/suites/:suiteId', async (req, res, next) => {
  try {
    const suite = await saveSuite({ ...(req.body || {}), id: req.params.suiteId });
    res.json({ suite, library: await readLibrary() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/suites/:suiteId', async (req, res, next) => {
  try {
    await deleteSuite(req.params.suiteId);
    res.json({ ok: true, library: await readLibrary() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run-tests', async (req, res, next) => {
  try {
    const tests = await getTestsByIds(req.body?.testIds || []);
    startRun(req, res, {
      requestLabel: `Dashboard requested ${tests.length} saved test(s)`,
      displayName: tests.length === 1 ? tests[0].name : `${tests.length} seçili test`,
      testIds: tests.map((test) => test.id),
      testNames: tests.map((test) => test.name),
      flowFiles: testsToFlowFiles(tests),
      runOptions: {
        ...runOptionsFromBody(req.body),
        platform: inferPlatform(tests, req.body?.platform),
        flowFiles: testsToFlowFiles(tests),
        testIds: tests.map((test) => test.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run-test/:testId', async (req, res, next) => {
  try {
    const tests = await getTestsByIds([req.params.testId]);
    startRun(req, res, {
      requestLabel: `Dashboard requested saved test: ${tests[0].name}`,
      displayName: tests[0].name,
      testIds: [tests[0].id],
      testNames: [tests[0].name],
      flowFiles: testsToFlowFiles(tests),
      runOptions: {
        ...runOptionsFromBody(req.body),
        platform: inferPlatform(tests, req.body?.platform),
        flowFiles: testsToFlowFiles(tests),
        testIds: [tests[0].id],
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run-suite/:suiteId', async (req, res, next) => {
  try {
    const { suite, tests } = await getSuiteById(req.params.suiteId);
    startRun(req, res, {
      requestLabel: `Dashboard requested suite: ${suite.name}`,
      displayName: suite.name,
      testIds: tests.map((test) => test.id),
      testNames: tests.map((test) => test.name),
      flowFiles: testsToFlowFiles(tests),
      suiteId: suite.id,
      suiteName: suite.name,
      runOptions: {
        ...runOptionsFromBody(req.body),
        platform: inferPlatform(tests, req.body?.platform),
        flowFiles: testsToFlowFiles(tests),
        testIds: tests.map((test) => test.id),
        suiteId: suite.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run/cancel', (_req, res) => {
  if (!activeRun || !activeAbortController) {
    res.status(409).json({ error: 'No active Maestro run to cancel.' });
    return;
  }

  activeAbortController.abort();
  publish({
    phase: 'cancelled',
    message: `Cancelling ${activeRun.displayName || 'active Maestro run'}`,
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true, activeRun });
});

function startRun(req, res, {
  requestLabel,
  displayName,
  runOptions,
  testIds = [],
  testNames = [],
  flowFiles = [],
  suiteId = null,
  suiteName = null,
}) {
  if (activeRun) {
    res.status(409).json({ error: 'A Maestro run is already active.', activeRun });
    return;
  }

  activeAbortController = new AbortController();
  activeRun = {
    requestedAt: new Date().toISOString(),
    requestedBy: 'dashboard',
    displayName,
    testIds,
    testNames,
    flowFiles,
    suiteId,
    suiteName,
    platform: runOptions.platform,
  };
  publish({ phase: 'queued', message: requestLabel, timestamp: new Date().toISOString() });
  res.status(202).json({ ok: true, activeRun });

  runMobileTests({
    ...runOptions,
    signal: activeAbortController.signal,
    onStatus: (event) => {
      activeRun = { ...activeRun, runId: event.runId, phase: event.phase };
      publish(event);
    },
  }).then((summary) => updateRunResult({
    testIds,
    suiteId,
    status: summary.status,
    runId: summary.runId,
  })).catch((error) => {
    publish({
      phase: 'error',
      message: error?.message || 'Maestro run failed unexpectedly',
      timestamp: new Date().toISOString(),
    });
  }).finally(() => {
    activeRun = null;
    activeAbortController = null;
  });
}

app.get('/api/status', (_req, res) => {
  res.json({ activeRun, latestStatus });
});

app.get('/api/status/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ activeRun, latestStatus })}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.use('/api/screenshots', express.static(reportsDir, {
  fallthrough: false,
  index: false,
}));

if (process.argv.includes('--serve-static')) {
  app.use(express.static(dashboardDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Unexpected server error' });
});

app.listen(port, () => {
  console.log(`Dashboard API listening on http://localhost:${port}`);
});

function publish(event) {
  latestStatus = { ...latestStatus, ...event };
  const payload = `data: ${JSON.stringify({ activeRun, latestStatus })}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function configPayloadToEnv(body) {
  const keyMap = {
    slackWebhook: 'SLACK_WEBHOOK',
    environment: 'ENVIRONMENT',
    deviceName: 'DEVICE_NAME',
    platform: 'MOBILE_PLATFORM',
    appApkPath: 'APP_APK_PATH',
    appIosPath: 'APP_IOS_PATH',
    reinstallApp: 'APP_REINSTALL',
    resetAppData: 'APP_RESET_DATA',
    notifySlack: 'SLACK_NOTIFY',
    appId: 'APP_ID',
    testEmail: 'TEST_EMAIL',
    testPassword: 'TEST_PASSWORD',
    qaEmail: 'QA_EMAIL',
    qaPassword: 'QA_PASSWORD',
    flowPath: 'FLOW_PATH',
    maestroTimeoutMs: 'MAESTRO_TIMEOUT_MS',
    dashboardBaseUrl: 'DASHBOARD_BASE_URL',
  };

  const updates = {};
  for (const [bodyKey, envKey] of Object.entries(keyMap)) {
    if (!(bodyKey in body)) continue;
    const value = body[bodyKey];
    updates[envKey] = typeof value === 'boolean' ? String(value) : String(value ?? '').replace(/\r?\n/g, '');
  }

  if (updates.TEST_EMAIL && !updates.QA_EMAIL) updates.QA_EMAIL = updates.TEST_EMAIL;
  if (updates.TEST_PASSWORD && !updates.QA_PASSWORD) updates.QA_PASSWORD = updates.TEST_PASSWORD;

  return Object.fromEntries(Object.entries(updates).filter(([key]) => editableConfigKeys.includes(key)));
}

async function updateEnvFile(updates) {
  const existing = await fs.readFile(envPath, 'utf8').catch(() => '');
  const seen = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(updates[match[1]])}`;
  }).filter((line, index, array) => index < array.length - 1 || line);

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${formatEnvValue(value)}`);
  }

  await fs.writeFile(envPath, `${lines.join('\n')}\n`);
}

function formatEnvValue(value) {
  const stringValue = String(value ?? '');
  if (!stringValue || /^[A-Za-z0-9_./:@%+=,-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function runOptionsFromBody(body = {}) {
  return {
    environment: body.environment,
    deviceName: body.deviceName,
    platform: body.platform,
    flowPath: body.flowPath,
    appApkPath: body.appApkPath,
    appIosPath: body.appIosPath,
    reinstallApp: body.reinstallApp,
    resetAppData: body.resetAppData,
    notifySlack: body.notifySlack,
  };
}

function inferPlatform(tests, requestedPlatform) {
  if (requestedPlatform) return requestedPlatform;
  const platforms = [...new Set(tests
    .map((test) => test.platform)
    .filter((platform) => platform && platform !== 'shared'))];
  return platforms.length === 1 ? platforms[0] : undefined;
}

function safeRunId(value) {
  const runId = String(value || '');
  if (!/^run-[A-Za-z0-9_.-]+$/.test(runId)) {
    const error = new Error('Invalid run id.');
    error.status = 400;
    throw error;
  }
  return runId;
}

async function listAndroidDevices() {
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const devices = stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([id]) => id)
      .map(([id, state]) => ({
        id,
        name: id,
        platform: 'android',
        state: state || 'unknown',
        booted: state === 'device',
      }));

    return { devices, errors: [] };
  } catch (error) {
    return { devices: [], errors: [`Android devices could not be listed: ${error.message}`] };
  }
}

async function listIosDevices() {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    const parsed = JSON.parse(stdout);
    const devices = Object.values(parsed.devices || {})
      .flat()
      .map((device) => ({
        id: device.udid,
        name: device.name,
        platform: 'ios',
        state: device.state,
        booted: device.state === 'Booted',
      }));

    return { devices, errors: [] };
  } catch (error) {
    return { devices: [], errors: [`iOS devices could not be listed: ${error.message}`] };
  }
}

async function readScheduleConfig() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    return normalizeScheduleConfig(JSON.parse(await fs.readFile(scheduleConfigPath, 'utf8')));
  } catch {
    const config = normalizeScheduleConfig({});
    await writeScheduleConfig(config);
    return config;
  }
}

async function writeScheduleConfig(config) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(scheduleConfigPath, `${JSON.stringify(normalizeScheduleConfig(config), null, 2)}\n`);
}

function normalizeScheduleConfig(input) {
  const cronExpression = String(input.cronExpression || '0 2 * * *').trim();
  if (!/^(\S+\s+){4}\S+$/.test(cronExpression)) {
    const error = new Error('Cron expression must have five fields.');
    error.status = 400;
    throw error;
  }

  return {
    cronExpression,
    environment: String(input.environment || process.env.ENVIRONMENT || 'nightly').trim() || 'nightly',
    enabled: input.enabled !== false,
  };
}

function buildCronCommand(config) {
  const logPath = path.join(rootDir, 'reports', 'nightly-cron.log');
  return `cd ${shellQuote(rootDir)} && ENVIRONMENT=${shellQuote(config.environment)} npm run test:nightly >> ${shellQuote(logPath)} 2>&1`;
}

async function currentCrontab() {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout;
  } catch {
    return '';
  }
}

async function cronIsInstalled() {
  return (await currentCrontab()).includes(cronMarkerStart);
}

async function installCron(config) {
  const existing = removeCronBlock(await currentCrontab()).trimEnd();
  const block = [
    cronMarkerStart,
    `${config.cronExpression} ${buildCronCommand(config)}`,
    cronMarkerEnd,
  ].join('\n');
  const next = `${existing ? `${existing}\n\n` : ''}${block}\n`;
  await writeCrontab(next);
}

async function removeCron() {
  const next = `${removeCronBlock(await currentCrontab()).trimEnd()}\n`;
  await writeCrontab(next.trim() ? next : '');
}

function removeCronBlock(value) {
  const escapedStart = escapeRegExp(cronMarkerStart);
  const escapedEnd = escapeRegExp(cronMarkerEnd);
  return value.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), '\n');
}

async function writeCrontab(content) {
  const tempFile = path.join(dataDir, `crontab-${Date.now()}.txt`);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tempFile, content);
  try {
    await execFileAsync('crontab', [tempFile]);
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
