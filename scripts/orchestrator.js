import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const reportsDir = path.join(rootDir, 'reports');
const flowsDir = path.join(rootDir, 'flows');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
});

export async function runMobileTests(options = {}) {
  const startedAt = new Date();
  const runId = makeRunId(startedAt);
  const runDir = path.join(reportsDir, runId);
  const artifactDir = path.join(runDir, 'artifacts');
  const screenshotsDir = path.join(runDir, 'screenshots');
  const requestedFlowPath = path.resolve(rootDir, options.flowPath || process.env.FLOW_PATH || 'flows');
  const requestedFlowFiles = Array.isArray(options.flowFiles) ? options.flowFiles : [];
  const environment = options.environment || process.env.ENVIRONMENT || 'local';
  const deviceName = options.deviceName || process.env.DEVICE_NAME || '';
  const appApkPath = options.appApkPath || process.env.APP_APK_PATH || '';
  const appIosPath = options.appIosPath || process.env.APP_IOS_PATH || '';
  const platform = detectPlatform(options.platform || process.env.MOBILE_PLATFORM, deviceName);
  const notifySlack = toBoolean(options.notifySlack ?? process.env.SLACK_NOTIFY ?? true);

  const notify = createStatusNotifier(options.onStatus, runId);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  const flowTarget = await prepareFlowTarget({
    requestedFlowPath,
    flowFiles: requestedFlowFiles,
    runDir,
  });

  notify('starting', { message: `Starting ${platform} Maestro run`, runId, environment, deviceName });

  let device = { id: undefined, name: deviceName || platform, platform };
  let maestroResult = { exitCode: 1, stdout: '', stderr: '' };

  try {
    await assertCommand('maestro', 'Maestro CLI is required. Install it with: curl -Ls "https://get.maestro.mobile.dev" | bash');

    if (platform === 'android') {
      device = await ensureAndroidDevice(deviceName, notify);
      await ensureAndroidAppInstalled({
        deviceId: device.id,
        appId: process.env.APP_ID,
        appApkPath,
        reinstall: toBoolean(options.reinstallApp ?? process.env.APP_REINSTALL ?? true),
        resetData: toBoolean(options.resetAppData ?? process.env.APP_RESET_DATA ?? true),
        notify,
      });
      await prewarmMaestroAndroidDriver(device.id, notify);
    } else if (platform === 'ios') {
      device = await ensureIosSimulator(deviceName, notify);
      await ensureIosAppInstalled({
        simulatorId: device.id,
        appId: process.env.APP_ID,
        appIosPath,
        reinstall: toBoolean(options.reinstallApp ?? process.env.APP_REINSTALL ?? true),
        resetData: toBoolean(options.resetAppData ?? process.env.APP_RESET_DATA ?? true),
        notify,
      });
    }

    notify('running', { message: 'Running Maestro flows', device });
    maestroResult = await runMaestro({
      flowPath: flowTarget.path,
      platform,
      deviceId: device.id,
      artifactDir,
      runDir,
      environment,
      deviceName: device.name,
      signal: options.signal,
    });
  } catch (error) {
    maestroResult.stderr += `\n${error?.stack || error}`;
  }

  notify('collecting', { message: 'Collecting reports and screenshots' });
  const endedAt = new Date();
  const junitPath = path.join(runDir, 'junit.xml');
  const parsed = await parseJUnitReport(junitPath, maestroResult.exitCode, startedAt, endedAt);
  const wasCancelled = options.signal?.aborted || maestroResult.exitCode === 130;
  const hasFailures = parsed.failed > 0 || maestroResult.exitCode !== 0;
  const runStatus = wasCancelled ? 'cancelled' : hasFailures ? 'failed' : 'passed';
  const screenshots = await collectScreenshots(artifactDir, screenshotsDir, hasFailures);

  const summary = {
    runId,
    status: runStatus,
    emoji: runStatus === 'passed' ? '✅' : runStatus === 'cancelled' ? '⏹️' : '❌',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    duration: formatDuration(endedAt.getTime() - startedAt.getTime()),
    environment,
    platform,
    appApkPath: appApkPath || null,
    appIosPath: appIosPath || null,
    appPath: platform === 'ios' ? appIosPath || null : appApkPath || null,
    deviceName: device.name || deviceName || platform,
    deviceId: device.id || null,
    flowPath: flowTarget.displayPath,
    selectedFlows: flowTarget.selectedFlows,
    selectedTestIds: options.testIds || [],
    suiteId: options.suiteId || null,
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    testResults: parsed.testResults,
    failedTests: parsed.failedTests,
    flakyTests: [],
    slackNotified: notifySlack,
    screenshots,
    reportFiles: {
      summary: path.relative(rootDir, path.join(runDir, 'summary.json')),
      latest: 'reports/latest.json',
      junit: await exists(junitPath) ? path.relative(rootDir, junitPath) : null,
      html: await exists(path.join(runDir, 'report.html')) ? path.relative(rootDir, path.join(runDir, 'report.html')) : null,
      artifacts: path.relative(rootDir, artifactDir),
    },
    exitCode: maestroResult.exitCode,
    stdoutTail: tail(maestroResult.stdout),
    stderrTail: tail(maestroResult.stderr),
  };

  if (summary.status !== 'cancelled') await computeFlakyTests(summary);
  await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(reportsDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, 'stdout.log'), maestroResult.stdout);
  await fs.writeFile(path.join(runDir, 'stderr.log'), maestroResult.stderr);

  if (notifySlack) {
    await sendSlackNotification(summary);
  }
  notify('finished', { message: `Run ${summary.status}`, summary });

  return summary;
}

async function prepareFlowTarget({ requestedFlowPath, flowFiles, runDir }) {
  if (!flowFiles.length) {
    return {
      path: requestedFlowPath,
      displayPath: path.relative(rootDir, requestedFlowPath),
      selectedFlows: [],
    };
  }

  const selectedFlows = flowFiles.map((flowFile) => path.resolve(rootDir, flowFile));
  if (selectedFlows.length === 1) {
    return {
      path: selectedFlows[0],
      displayPath: path.relative(rootDir, selectedFlows[0]),
      selectedFlows: selectedFlows.map((flowFile) => path.relative(rootDir, flowFile)),
    };
  }

  const selectedDir = path.join(runDir, 'selected-flows');
  await fs.mkdir(selectedDir, { recursive: true });

  for (const [index, source] of selectedFlows.entries()) {
    const safeName = `${String(index + 1).padStart(3, '0')}-${path.basename(source)}`;
    await fs.copyFile(source, path.join(selectedDir, safeName));
  }

  return {
    path: selectedDir,
    displayPath: path.relative(rootDir, selectedDir),
    selectedFlows: selectedFlows.map((flowFile) => path.relative(rootDir, flowFile)),
  };
}

async function runMaestro({ flowPath, platform, deviceId, artifactDir, runDir, environment, deviceName, signal }) {
  const args = [
    `--platform=${platform}`,
    'test',
    flowPath,
    '--format=junit',
    `--output=${path.join(runDir, 'junit.xml')}`,
    `--test-output-dir=${artifactDir}`,
    `--debug-output=${artifactDir}`,
  ];

  if (deviceId) {
    args.unshift(`--device=${deviceId}`);
  }

  const envPairs = {
    ENVIRONMENT: environment,
    DEVICE_NAME: deviceName,
    APP_ID: process.env.APP_ID,
    TEST_EMAIL: process.env.TEST_EMAIL,
    TEST_PASSWORD: process.env.TEST_PASSWORD,
    QA_EMAIL: process.env.QA_EMAIL || process.env.TEST_EMAIL,
    QA_PASSWORD: process.env.QA_PASSWORD || process.env.TEST_PASSWORD,
  };

  for (const [key, value] of Object.entries(envPairs)) {
    if (value) args.push(`--env=${key}=${value}`);
  }

  return runCommand('maestro', args, {
    cwd: rootDir,
    env: {
      JAVA_TOOL_OPTIONS: [
        process.env.JAVA_TOOL_OPTIONS || '',
        '-Djava.net.preferIPv4Stack=true',
        '-Djava.net.preferIPv4Addresses=true',
      ].filter(Boolean).join(' '),
    },
    timeoutMs: Number(process.env.MAESTRO_TIMEOUT_MS || 30 * 60 * 1000),
    signal,
  });
}

async function ensureAndroidDevice(deviceName, notify) {
  await assertCommand('adb', 'Android platform-tools are required. Make sure adb is on your PATH.');
  const emulatorPath = await resolveEmulatorBinary();
  const booted = await getBootedAndroidDevice(deviceName);
  if (booted) {
    notify('device', { message: `Using booted Android device ${booted.name} (${booted.id})` });
    return booted;
  }

  const avdName = deviceName || await firstAndroidAvd(emulatorPath);
  if (!avdName) {
    throw new Error('No Android emulator is running and no AVD was found. Set DEVICE_NAME to an AVD name or create one in Android Studio.');
  }

  notify('device', { message: `Starting Android Emulator: ${avdName}` });
  const child = spawn(emulatorPath, ['-avd', avdName, '-no-snapshot-load'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const device = await waitForAndroidBoot(notify, avdName);
  return { ...device, name: avdName, platform: 'android' };
}

async function ensureIosSimulator(deviceName, notify) {
  await assertCommand('xcrun', 'Xcode command line tools are required for iOS Simulator support.');
  const devices = await listIosSimulators();
  const booted = devices.find((device) => device.state === 'Booted' && (!deviceName || device.name === deviceName));
  if (booted) {
    notify('device', { message: `Using booted iOS Simulator ${booted.name}` });
    return { id: booted.udid, name: booted.name, platform: 'ios' };
  }

  const target = deviceName
    ? devices.find((device) => device.name === deviceName)
    : devices.find((device) => /iPhone/i.test(device.name)) || devices[0];

  if (!target) {
    throw new Error('No available iOS Simulator was found. Open Xcode once or create a simulator.');
  }

  notify('device', { message: `Booting iOS Simulator: ${target.name}` });
  await runCommand('xcrun', ['simctl', 'boot', target.udid], { allowFailure: true });
  await runCommand('xcrun', ['simctl', 'bootstatus', target.udid, '-b'], { timeoutMs: 180_000 });
  return { id: target.udid, name: target.name, platform: 'ios' };
}

async function ensureIosAppInstalled({ simulatorId, appId, appIosPath, reinstall, resetData, notify }) {
  if (!appIosPath) {
    notify('device', { message: 'No iOS .app path was provided. Set APP_IOS_PATH or use the dashboard .app path field.' });
    return;
  }

  const resolvedAppPath = path.resolve(rootDir, appIosPath);
  const stat = await fs.stat(resolvedAppPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`iOS .app path was not found or is not a directory: ${resolvedAppPath}`);
  }

  if ((resetData || reinstall) && appId) {
    notify('device', { message: `Uninstalling iOS app ${appId} for a clean install` });
    await runCommand('xcrun', ['simctl', 'uninstall', simulatorId, appId], { allowFailure: true });
  }

  notify('device', { message: `Installing iOS app ${resolvedAppPath}` });
  const result = await runCommand('xcrun', ['simctl', 'install', simulatorId, resolvedAppPath], { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to install iOS .app from ${resolvedAppPath}\n${result.stderr || result.stdout}`);
  }
}

async function getBootedAndroidDevice(preferredName = '') {
  const devices = await adbDevices();
  const bootedDevices = [];

  for (const device of devices) {
    const booted = await runCommand('adb', ['-s', device.id, 'shell', 'getprop', 'sys.boot_completed'], { allowFailure: true });
    if (booted.stdout.trim() === '1') {
      bootedDevices.push(await enrichAndroidDevice(device));
    }
  }

  if (preferredName) {
    return bootedDevices.find((device) => [
      device.id,
      device.name,
      device.avdName,
      device.model,
    ].filter(Boolean).some((value) => value === preferredName)) || null;
  }

  return bootedDevices.find((device) => device.id.startsWith('emulator-')) || bootedDevices[0] || null;
}

async function enrichAndroidDevice(device) {
  const [avdName, model] = await Promise.all([
    runCommand('adb', ['-s', device.id, 'emu', 'avd', 'name'], { allowFailure: true }),
    runCommand('adb', ['-s', device.id, 'shell', 'getprop', 'ro.product.model'], { allowFailure: true }),
  ]);

  const normalizedAvdName = avdName.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && line !== 'OK') || '';

  return {
    ...device,
    avdName: normalizedAvdName,
    model: model.stdout.trim(),
    name: normalizedAvdName || model.stdout.trim() || device.id,
  };
}

async function waitForAndroidBoot(notify, preferredName = '') {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const device = await getBootedAndroidDevice(preferredName);
    if (device) {
      await runCommand('adb', ['-s', device.id, 'shell', 'input', 'keyevent', '82'], { allowFailure: true });
      notify('device', { message: `Android Emulator is booted: ${device.name} (${device.id})` });
      return device;
    }
    await delay(5000);
    notify('device', { message: 'Waiting for Android Emulator boot...' });
  }
  throw new Error('Timed out waiting for Android Emulator to boot.');
}

async function adbDevices() {
  const result = await runCommand('adb', ['devices'], { allowFailure: true });
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([id, state]) => id && state === 'device')
    .map(([id]) => ({ id, name: id, platform: 'android' }));
}

async function ensureAndroidAppInstalled({ deviceId, appId, appApkPath, reinstall, resetData, notify }) {
  if (!appId) return;

  const installed = await runCommand('adb', ['-s', deviceId, 'shell', 'pm', 'path', appId], { allowFailure: true });
  const resolvedApkPath = await resolveAndroidApkPath(appId, appApkPath);

  if (!resolvedApkPath && installed.stdout.trim()) {
    if (resetData) await clearAndroidAppData(deviceId, appId, notify);
    return;
  }

  if (!resolvedApkPath) {
    notify('device', { message: `App ${appId} is not installed and no APK was found. Set APP_APK_PATH or use the dashboard APK path field.` });
    return;
  }

  if (!installed.stdout.trim() || reinstall) {
    notify('device', { message: `Installing app APK for ${appId}` });
    const result = await runCommand('adb', ['-s', deviceId, 'install', '-r', '-d', resolvedApkPath], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to install app APK: ${result.stderr || result.stdout}`);
    }
  }

  if (resetData) await clearAndroidAppData(deviceId, appId, notify);
}

async function resolveAndroidApkPath(appId, appApkPath) {
  const candidates = [
    appApkPath,
    path.join(process.env.HOME || '', '.maestro', 'apps', 'android', `${appId}.apk`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (await exists(resolved)) return resolved;
  }

  return '';
}

async function clearAndroidAppData(deviceId, appId, notify) {
  notify('device', { message: `Clearing app data for ${appId}` });
  const result = await runCommand('adb', ['-s', deviceId, 'shell', 'pm', 'clear', appId], { timeoutMs: 60_000, allowFailure: true });
  if (result.exitCode !== 0) {
    notify('device', { message: `Could not clear app data for ${appId}` });
  }
}

async function prewarmMaestroAndroidDriver(deviceId, notify) {
  const clientJar = path.join(process.env.HOME || '', '.maestro', 'lib', 'maestro-client.jar');
  if (!await exists(clientJar)) return;

  const driverDir = path.join(process.env.HOME || '', '.maestro', 'tmp', 'android-driver');
  const appApk = path.join(driverDir, 'maestro-app.apk');
  const serverApk = path.join(driverDir, 'maestro-server.apk');

  await fs.mkdir(driverDir, { recursive: true });
  if (!await exists(appApk) || !await exists(serverApk)) {
    const extract = await runCommand('jar', ['xf', clientJar, 'maestro-app.apk', 'maestro-server.apk'], { cwd: driverDir, allowFailure: true });
    if (extract.exitCode !== 0) return;
  }

  notify('device', { message: 'Preparing Maestro Android driver' });
  await runCommand('adb', ['-s', deviceId, 'forward', 'tcp:7001', 'tcp:7001'], { allowFailure: true });
  const alreadyReachable = await waitForPort(7001, 1000);
  if (alreadyReachable) return;

  await runCommand('adb', ['-s', deviceId, 'install', '-r', appApk], { timeoutMs: 120_000, allowFailure: true });
  await runCommand('adb', ['-s', deviceId, 'install', '-r', serverApk], { timeoutMs: 120_000, allowFailure: true });
  await runCommand('adb', ['-s', deviceId, 'forward', 'tcp:7001', 'tcp:7001'], { allowFailure: true });

  const child = spawn('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'instrument',
    '-w',
    'dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const ready = await waitForPort(7001, 10_000);
  if (!ready) {
    notify('device', { message: 'Maestro Android driver did not open port 7001 before timeout; continuing with Maestro CLI startup' });
  } else {
    await delay(3000);
  }
}

async function resolveEmulatorBinary() {
  const fromPath = await commandPath('emulator');
  if (fromPath) return fromPath;

  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'emulator', 'emulator'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'emulator', 'emulator'),
    path.join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'emulator', 'emulator'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error('Android Emulator binary was not found. Add Android SDK emulator tools to PATH or set ANDROID_HOME.');
}

async function firstAndroidAvd(emulatorPath) {
  const result = await runCommand(emulatorPath, ['-list-avds'], { allowFailure: true });
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
}

async function listIosSimulators() {
  const result = await runCommand('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const parsed = JSON.parse(result.stdout);
  return Object.values(parsed.devices || {}).flat();
}

async function parseJUnitReport(junitPath, exitCode, startedAt, endedAt) {
  if (!await exists(junitPath)) {
    return {
      total: exitCode === 0 ? 0 : 1,
      passed: exitCode === 0 ? 0 : 0,
      failed: exitCode === 0 ? 0 : 1,
      skipped: 0,
      testResults: exitCode === 0 ? [] : [{ name: 'Maestro execution', status: 'failed', message: 'Maestro exited before a JUnit report was written.' }],
      failedTests: exitCode === 0 ? [] : [{ name: 'Maestro execution', message: 'Maestro exited before a JUnit report was written.' }],
    };
  }

  const xml = await fs.readFile(junitPath, 'utf8');
  const parsed = parser.parse(xml);
  const suites = arrayify(parsed.testsuites?.testsuite || parsed.testsuite);
  const cases = suites.flatMap((suite) => arrayify(suite.testcase).map((testcase) => ({ suite, testcase })));
  const total = numberAttr(parsed.testsuites?.tests) || sumAttr(suites, 'tests') || cases.length;
  const failed = numberAttr(parsed.testsuites?.failures) + numberAttr(parsed.testsuites?.errors) || sumAttr(suites, 'failures') + sumAttr(suites, 'errors');
  const skipped = numberAttr(parsed.testsuites?.skipped) || sumAttr(suites, 'skipped');
  const failedTests = cases
    .filter(({ testcase }) => testcase.failure || testcase.error)
    .map(({ suite, testcase }) => ({
      name: testcase.name || testcase.classname || suite.name || 'Unnamed flow',
      suite: suite.name || testcase.classname || '',
      duration: testcase.time ? `${testcase.time}s` : null,
      message: testcase.failure?.message || testcase.error?.message || stringifyFailure(testcase.failure || testcase.error),
    }));
  const testResults = cases.map(({ suite, testcase }) => {
    const failure = testcase.failure || testcase.error;
    const skippedCase = testcase.skipped;
    return {
      name: testcase.name || testcase.classname || suite.name || 'Unnamed flow',
      suite: suite.name || testcase.classname || '',
      duration: testcase.time ? `${testcase.time}s` : null,
      status: failure ? 'failed' : skippedCase ? 'skipped' : 'passed',
      message: failure ? (testcase.failure?.message || testcase.error?.message || stringifyFailure(failure)) : '',
    };
  });

  const normalizedFailed = failed || failedTests.length;
  return {
    total,
    passed: Math.max(total - normalizedFailed - skipped, 0),
    failed: normalizedFailed,
    skipped,
    testResults,
    failedTests,
    measuredDurationMs: endedAt.getTime() - startedAt.getTime(),
  };
}

async function collectScreenshots(artifactDir, screenshotsDir, includeAll) {
  const files = await walkFiles(artifactDir);
  const imageFiles = files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
  const selected = includeAll ? imageFiles : [];
  const collected = [];

  for (const source of selected) {
    const destination = path.join(screenshotsDir, path.basename(source));
    await fs.copyFile(source, destination).catch(async () => {
      const fallback = path.join(screenshotsDir, `${Date.now()}-${path.basename(source)}`);
      await fs.copyFile(source, fallback);
      collected.push(toScreenshotRecord(fallback));
    });
    if (await exists(destination)) collected.push(toScreenshotRecord(destination));
  }

  return dedupeBy(collected, 'path');
}

function toScreenshotRecord(file) {
  const relative = path.relative(reportsDir, file);
  return {
    name: path.basename(file),
    path: path.relative(rootDir, file),
    url: `/api/screenshots/${relative.split(path.sep).map(encodeURIComponent).join('/')}`,
  };
}

async function sendSlackNotification(summary) {
  const webhook = process.env.SLACK_WEBHOOK;
  if (!webhook) return;

  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL;
  const passed = summary.status === 'passed';
  const cancelled = summary.status === 'cancelled';
  const statusText = passed ? 'Başarılı' : cancelled ? 'İptal Edildi' : 'Başarısız';
  const statusSentence = passed
    ? '_Tüm Maestro akışları başarıyla tamamlandı._'
    : cancelled
      ? '_Maestro koşumu kullanıcı isteğiyle durduruldu; tamamlanan test çıktıları rapora yazıldı._'
      : '_Bazı Maestro akışları başarısız oldu; aşağıdaki hata listesi ve ekran görüntülerini kontrol edebilirsin._';
  const selectedText = summary.suiteId
    ? `📦 *Test paketi:* \`${summary.suiteId}\``
    : summary.selectedTestIds?.length
      ? `🎯 *Seçili testler:* ${summary.selectedTestIds.join(', ')}`
      : `▶️ *Çalıştırılan akış:* \`${summary.flowPath}\``;
  const platformEmoji = String(summary.platform || '').toLowerCase() === 'ios' ? '🍎' : '🤖';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${summary.emoji} Mobil Test Sonucu - Maestro: ${statusText}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *Koşum Özeti*\n${statusSentence}\n${selectedText}\n🆔 *Koşum ID:* \`${summary.runId}\``,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `📊 *Toplam*\n${summary.total}` },
        { type: 'mrkdwn', text: `✅ *Başarılı*\n${summary.passed}` },
        { type: 'mrkdwn', text: `❌ *Başarısız*\n${summary.failed}` },
        { type: 'mrkdwn', text: `⏱️ *Süre*\n${summary.duration}` },
        { type: 'mrkdwn', text: `🌐 *Ortam*\n\`${summary.environment}\`` },
        { type: 'mrkdwn', text: `📱 *Cihaz*\n${summary.deviceName}` },
        { type: 'mrkdwn', text: `${platformEmoji} *Platform*\n${summary.platform}` },
      ],
    },
  ];

  if (summary.failedTests.length) {
    const failedText = summary.failedTests
      .map((test) => `• *${test.name}*${test.message ? `\n  _${truncate(test.message, 180)}_` : ''}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🚨 *Başarısız Testler*\n${failedText}` },
    });
  }

  const testResults = Array.isArray(summary.testResults) ? summary.testResults : [];
  if (testResults.length) {
    const resultText = testResults
      .slice(0, 30)
      .map((test) => `${test.status === 'passed' ? '✅' : test.status === 'skipped' ? '⏭️' : test.status === 'cancelled' ? '⏹️' : '❌'} ${shortTestName(test.name)} - ${test.status === 'passed' ? 'Geçti' : test.status === 'skipped' ? 'Atlandı' : test.status === 'cancelled' ? 'İptal' : 'Kaldı'}`)
      .join('\n');
    const remainder = testResults.length > 30 ? `\n_+${testResults.length - 30} test daha var._` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🧪 *Test Bazlı Sonuçlar*\n${resultText}${remainder}` },
    });
  }

  if (summary.screenshots.length) {
    const screenshotText = summary.screenshots
      .slice(0, 8)
      .map((shot) => (dashboardBaseUrl
        ? `🖼️ <${dashboardBaseUrl}${shot.url}|${shot.name}>`
        : `🖼️ \`${shot.path}\``))
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📸 *Hata Ekran Görüntüleri*\n${screenshotText}` },
    });
  }

  const payload = {
    text: `${summary.emoji} Maestro mobil test koşumu ${statusText.toLowerCase()}: ${summary.passed}/${summary.total} test geçti`,
    blocks,
  };

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.warn(`Slack notification failed: ${response.status} ${await response.text()}`);
  }
}

async function computeFlakyTests(summary) {
  const summaries = await readReportSummaries();
  const recent = summaries.slice(0, 20);
  const currentFailures = new Set(summary.failedTests.map((test) => test.name));
  const flaky = [];

  for (const name of currentFailures) {
    const failedBefore = recent.some((run) => run.failedTests?.some((test) => test.name === name));
    const passedBefore = recent.some((run) => run.status === 'passed' || !run.failedTests?.some((test) => test.name === name));
    if (failedBefore && passedBefore) flaky.push(name);
  }

  summary.flakyTests = flaky;
}

export async function readReportSummaries() {
  await fs.mkdir(reportsDir, { recursive: true });
  const entries = await fs.readdir(reportsDir, { withFileTypes: true });
  const summaries = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(reportsDir, entry.name, 'summary.json');
    if (!await exists(file)) continue;
    try {
      summaries.push(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      // Ignore partial or hand-edited report files.
    }
  }

  return summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`Command cancelled before start: ${command} ${args.join(' ')}`));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
      }, options.timeoutMs)
      : null;
    const onAbort = () => {
      child.kill('SIGTERM');
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.allowFailure) resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}` });
      else reject(error);
    });
    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        resolve({
          exitCode: 130,
          stdout,
          stderr: `${stderr}\nCommand cancelled: ${command} ${args.join(' ')}`,
        });
        return;
      }
      const result = { exitCode: exitCode ?? 0, stdout, stderr };
      if (result.exitCode !== 0 && !options.allowFailure) {
        resolve(result);
      } else {
        resolve(result);
      }
    });
  });
}

async function assertCommand(command, message) {
  if (!await commandPath(command)) throw new Error(message);
}

async function commandPath(command) {
  const result = await runCommand('zsh', ['-lc', `command -v ${shellEscape(command)}`], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function exists(file) {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir) {
  if (!await exists(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else files.push(full);
  }
  return files;
}

function detectPlatform(explicit, deviceName) {
  if (explicit) return explicit.toLowerCase() === 'ios' ? 'ios' : 'android';
  return /ios|iphone|ipad|simulator/i.test(deviceName || '') ? 'ios' : 'android';
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function createStatusNotifier(onStatus, runId) {
  return (phase, payload = {}) => {
    const event = { runId, phase, timestamp: new Date().toISOString(), ...payload };
    if (onStatus) onStatus(event);
    if (process.env.QUIET !== 'true') console.log(`[${phase}] ${payload.message || ''}`.trim());
  };
}

function makeRunId(date) {
  return `run-${date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`;
}

function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function numberAttr(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function sumAttr(items, attr) {
  return items.reduce((sum, item) => sum + numberAttr(item?.[attr]), 0);
}

function stringifyFailure(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value['#text']) return value['#text'];
  return JSON.stringify(value);
}

function tail(value, max = 5000) {
  return value.length > max ? value.slice(-max) : value;
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function shortTestName(value = '') {
  return truncate(String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(), 56);
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });

    if (connected) return true;
    await delay(500);
  }

  return false;
}

function dedupeBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item[key])) return false;
    seen.add(item[key]);
    return true;
  });
}
