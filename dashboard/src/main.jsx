import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Copy,
  Cpu,
  FileText,
  Filter,
  FolderOpen,
  Languages,
  Layers3,
  ListChecks,
  Package,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  Smartphone,
  Square,
  Sun,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import './styles.css';

function Root() {
  const reportMatch = window.location.pathname.match(/^\/report\/([^/]+)$/);
  const [language, setLanguage] = useLanguage();
  if (reportMatch) {
    return <ReportPage runId={decodeURIComponent(reportMatch[1])} language={language} setLanguage={setLanguage} />;
  }

  return <App language={language} setLanguage={setLanguage} />;
}

function App({ language, setLanguage }) {
  const t = useMemo(() => createTranslator(language), [language]);
  const [reports, setReports] = useState([]);
  const [status, setStatus] = useState({ latestStatus: { phase: 'idle', message: 'No run active' } });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedRuns, setExpandedRuns] = useState([]);
  const [dark, setDark] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [setupPlatform, setSetupPlatform] = useState('mac');
  const [library, setLibrary] = useState({ tests: [], suites: [] });
  const [devices, setDevices] = useState({ android: [], ios: [], errors: [] });
  const [schedule, setSchedule] = useState({ cronExpression: '0 2 * * *', environment: 'nightly', command: '', installed: false });
  const [selectedTestIds, setSelectedTestIds] = useState(['android-login-smoke']);
  const [suiteName, setSuiteName] = useState('Custom Smoke Suite');
  const [editingSuiteId, setEditingSuiteId] = useState('');
  const [newTest, setNewTest] = useState({ name: '', flowFile: 'flows/login.yaml', platform: 'android', tags: 'smoke' });
  const [runConfig, setRunConfig] = useState({
    platform: 'android',
    environment: 'local',
    deviceName: '',
    appApkPath: '',
    appIosPath: '',
    appId: '',
    testEmail: '',
    testPassword: '',
    flowPath: 'flows',
    slackWebhook: '',
    dashboardBaseUrl: '',
    maestroTimeoutMs: '',
    reinstallApp: true,
    resetAppData: true,
    notifySlack: false,
  });

  async function loadReports() {
    const params = new URLSearchParams({ search, status: filter });
    const response = await fetch(`/api/reports?${params}`);
    const data = await response.json();
    setReports(data.reports || []);
  }

  async function loadLibrary() {
    const response = await fetch('/api/library');
    const data = await response.json();
    setLibrary(data);
    if (!selectedTestIds.length && data.tests?.length) {
      setSelectedTestIds([data.tests[0].id]);
    }
  }

  async function loadConfig() {
    const response = await fetch('/api/config');
    const config = await response.json();
    setRunConfig((current) => ({
      ...current,
      environment: config.environment || current.environment,
      deviceName: config.deviceName || current.deviceName,
      appApkPath: config.appApkPath || current.appApkPath,
      appIosPath: config.appIosPath || current.appIosPath,
      platform: config.platform || current.platform,
      appId: config.appId || current.appId,
      testEmail: config.testEmail || current.testEmail,
      testPassword: config.testPassword || current.testPassword,
      flowPath: config.flowPath || current.flowPath,
      slackWebhook: config.slackWebhook || current.slackWebhook,
      dashboardBaseUrl: config.dashboardBaseUrl || current.dashboardBaseUrl,
      maestroTimeoutMs: config.maestroTimeoutMs || current.maestroTimeoutMs,
      reinstallApp: Boolean(config.reinstallApp),
      resetAppData: Boolean(config.resetAppData),
      notifySlack: Boolean(config.notifySlack),
    }));
  }

  async function loadDevices() {
    const response = await fetch('/api/devices');
    const data = await response.json();
    setDevices(data);
  }

  async function loadSchedule() {
    const response = await fetch('/api/schedule');
    const data = await response.json();
    setSchedule(data);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    loadConfig().catch(console.error);
    loadDevices().catch(console.error);
    loadSchedule().catch(console.error);
    loadLibrary().catch(console.error);
    loadReports().catch(console.error);
    const timer = setInterval(() => loadReports().catch(console.error), 30_000);
    return () => clearInterval(timer);
  }, [search, filter]);

  useEffect(() => {
    const source = new EventSource('/api/status/stream');
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      setStatus(payload);
      if (payload.latestStatus?.phase === 'finished') {
        loadReports().catch(console.error);
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, []);

  const latest = reports[0];
  const historyPageSize = 8;
  const totalHistoryPages = Math.max(1, Math.ceil(reports.length / historyPageSize));
  const pagedReports = useMemo(() => (
    reports.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize)
  ), [historyPage, reports]);
  const trend = useMemo(() => reports.slice(0, 12).reverse().map((report) => ({
    name: shortRunId(report.runId),
    passed: report.passed,
    failed: report.failed,
  })), [reports]);
  const flakyTests = useMemo(() => [...new Set(reports.flatMap((report) => report.flakyTests || []))], [reports]);
  const selectedTests = useMemo(() => (
    library.tests.filter((test) => selectedTestIds.includes(test.id))
  ), [library.tests, selectedTestIds]);
  const activePlatformLabel = runConfig.platform === 'ios' ? 'iOS Simulator' : 'Android Emulator';
  const platformDevices = runConfig.platform === 'ios' ? devices.ios : devices.android;
  const appPathLabel = runConfig.platform === 'ios' ? t('iosAppPath') : t('androidApkPath');
  const appPathPlaceholder = runConfig.platform === 'ios' ? '/Users/.../Runner.app' : '/Users/.../app.apk';
  const appPathValue = runConfig.platform === 'ios' ? runConfig.appIosPath : runConfig.appApkPath;
  const setupGuide = getSetupGuide(language, setupPlatform);
  const statusMessage = status.activeRun
    ? status.latestStatus?.message || t('runPreparing')
    : latest?.status === 'passed'
      ? t('lastRunPassed')
      : latest?.status === 'failed'
        ? t('lastRunFailed')
        : latest?.status === 'cancelled'
          ? t('lastRunCancelled')
          : t('readyToRun');
  const statusTone = status.activeRun ? status.latestStatus?.phase || 'running' : latest?.status || 'idle';
  const statusTime = status.activeRun ? status.latestStatus?.timestamp : latest?.endedAt || latest?.startedAt;

  useEffect(() => {
    setHistoryPage(1);
    setExpandedRuns([]);
  }, [search, filter]);

  useEffect(() => {
    if (historyPage > totalHistoryPages) setHistoryPage(totalHistoryPages);
  }, [historyPage, totalHistoryPages]);

  async function triggerRun() {
    setIsTriggering(true);
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runConfig),
      });
      if (!response.ok) {
        const data = await response.json();
        alert(data.error || t('unableToTriggerRun'));
      }
    } finally {
      setIsTriggering(false);
    }
  }

  async function triggerSavedTests(testIds) {
    if (!testIds.length) return;
    setIsTriggering(true);
    try {
      const response = await fetch('/api/run-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...runConfig, testIds }),
      });
      if (!response.ok) alert((await response.json()).error || t('unableToRunSavedTests'));
    } finally {
      setIsTriggering(false);
    }
  }

  async function triggerSuite(suiteId) {
    setIsTriggering(true);
    try {
      const response = await fetch(`/api/run-suite/${suiteId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runConfig),
      });
      if (!response.ok) alert((await response.json()).error || t('unableToRunSuite'));
    } finally {
      setIsTriggering(false);
    }
  }

  async function cancelRun() {
    try {
      const response = await fetch('/api/run/cancel', { method: 'POST' });
      if (!response.ok) alert((await response.json()).error || t('unableToCancelRun'));
    } catch (error) {
      alert(error?.message || t('unableToCancelRun'));
    }
  }

  async function saveConfig() {
    setIsSavingConfig(true);
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runConfig),
      });
      if (!response.ok) {
        alert((await response.json()).error || t('unableToSaveConfig'));
        return;
      }
      await loadConfig();
    } finally {
      setIsSavingConfig(false);
    }
  }

  async function saveSchedule() {
    await updateSchedule('/api/schedule');
  }

  async function installSchedule() {
    await updateSchedule('/api/schedule/install');
  }

  async function removeSchedule() {
    await updateSchedule('/api/schedule/remove');
  }

  async function updateSchedule(url) {
    setIsScheduling(true);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(schedule),
      });
      if (!response.ok) {
        alert((await response.json()).error || t('unableToSaveSchedule'));
        return;
      }
      setSchedule(await response.json());
    } finally {
      setIsScheduling(false);
    }
  }

  async function saveSelectedSuite() {
    const response = await fetch(editingSuiteId ? `/api/suites/${editingSuiteId}` : '/api/suites', {
      method: editingSuiteId ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: suiteName, testIds: selectedTestIds }),
    });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToSaveSuite'));
      return;
    }
    setEditingSuiteId('');
    await loadLibrary();
  }

  async function saveNewTest() {
    const tags = newTest.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    const response = await fetch('/api/tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newTest.name, flowFile: newTest.flowFile, platform: newTest.platform, tags }),
    });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToSaveTest'));
      return;
    }
    setNewTest({ name: '', flowFile: 'flows/login.yaml', platform: 'android', tags: 'smoke' });
    await loadLibrary();
  }

  async function deleteSavedTest(testId) {
    if (!confirm(t('confirmDeleteTest'))) return;
    const response = await fetch(`/api/tests/${testId}`, { method: 'DELETE' });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToDeleteTest'));
      return;
    }
    setSelectedTestIds((current) => current.filter((id) => id !== testId));
    await loadLibrary();
  }

  function editSuite(suite) {
    setEditingSuiteId(suite.id);
    setSuiteName(suite.name);
    setSelectedTestIds(suite.testIds || []);
  }

  async function deleteSavedSuite(suiteId) {
    if (!confirm(t('confirmDeleteSuite'))) return;
    const response = await fetch(`/api/suites/${suiteId}`, { method: 'DELETE' });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToDeleteSuite'));
      return;
    }
    if (editingSuiteId === suiteId) {
      setEditingSuiteId('');
      setSuiteName('Custom Smoke Suite');
    }
    await loadLibrary();
  }

  async function archiveReport(runId) {
    if (!confirm(t('confirmArchiveReport'))) return;
    const response = await fetch(`/api/reports/${encodeURIComponent(runId)}/archive`, { method: 'POST' });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToArchiveReport'));
      return;
    }
    await loadReports();
  }

  async function deleteReport(runId) {
    if (!confirm(t('confirmDeleteReport'))) return;
    const response = await fetch(`/api/reports/${encodeURIComponent(runId)}`, { method: 'DELETE' });
    if (!response.ok) {
      alert((await response.json()).error || t('unableToDeleteReport'));
      return;
    }
    await loadReports();
  }

  function toggleTest(testId) {
    setSelectedTestIds((current) => (
      current.includes(testId)
        ? current.filter((id) => id !== testId)
        : [...current, testId]
    ));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{t('brandEyebrow')}</p>
          <BrandTitle />
          <p className="subtitle">{activePlatformLabel} {t('dashboardSubtitle')}</p>
        </div>
        <div className="actions">
          <label className="languageSelect" title={t('language')}>
            <Languages size={16} />
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="tr">TR</option>
              <option value="en">EN</option>
            </select>
          </label>
          <button className="iconButton" title={t('refreshReports')} onClick={() => loadReports().catch(console.error)}>
            <RefreshCcw size={18} />
          </button>
          <button className="iconButton" title={dark ? t('lightTheme') : t('darkTheme')} onClick={() => setDark(!dark)}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="primaryButton" onClick={triggerRun} disabled={isTriggering || Boolean(status.activeRun)}>
            <Play size={18} />
            {status.activeRun ? t('running') : t('runAll')}
          </button>
          {status.activeRun && (
            <button className="dangerButton" onClick={cancelRun}>
              <Square size={15} />
              {t('stop')}
            </button>
          )}
        </div>
      </header>

      <section className="controlDeck">
        <div className="statusCard">
          <div className={`statusPill ${statusTone}`}>
            <Activity size={18} />
            <span>{statusMessage}</span>
          </div>
          <strong>{status.activeRun ? t('activeRun') : latest ? latest.runId : t('ready')}</strong>
          <p>{statusTime ? formatDate(statusTime) : t('noReportsYet')}</p>
        </div>

        <section className="runConfig" aria-label={t('runSettings')}>
          <label className="selectField">
            <span><Smartphone size={16} /> {t('platform')}</span>
            <select
              value={runConfig.platform}
              onChange={(event) => setRunConfig((current) => ({ ...current, platform: event.target.value }))}
            >
              <option value="android">Android</option>
              <option value="ios">iOS</option>
            </select>
          </label>
          <label className="selectField">
            <span><Cpu size={16} /> {t('device')}</span>
            <select
              value={runConfig.deviceName}
              onChange={(event) => setRunConfig((current) => ({ ...current, deviceName: event.target.value }))}
            >
              <option value="">{t('autoDevice')}</option>
              {platformDevices.map((device) => (
                <option value={device.name || device.id} key={`${device.platform}-${device.id}`}>
                  {device.name || device.id}{device.booted ? ` · ${t('booted')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="pathField">
            <span><Package size={16} /> {appPathLabel}</span>
            <input
              value={appPathValue}
              onChange={(event) => setRunConfig((current) => (
                current.platform === 'ios'
                  ? { ...current, appIosPath: event.target.value }
                  : { ...current, appApkPath: event.target.value }
              ))}
              placeholder={appPathPlaceholder}
            />
          </label>
          <label className="pathField">
            <span><Settings2 size={16} /> {t('environment')}</span>
            <input
              value={runConfig.environment}
              onChange={(event) => setRunConfig((current) => ({ ...current, environment: event.target.value }))}
              placeholder="local"
            />
          </label>
          <div className="toggleGroup">
            <label className="toggleField">
              <input
                type="checkbox"
                checked={runConfig.reinstallApp}
                onChange={(event) => setRunConfig((current) => ({ ...current, reinstallApp: event.target.checked }))}
              />
              <span>{t('reinstallApp')}</span>
            </label>
            <label className="toggleField">
              <input
                type="checkbox"
                checked={runConfig.resetAppData}
                onChange={(event) => setRunConfig((current) => ({ ...current, resetAppData: event.target.checked }))}
              />
              <span>{t('resetAppData')}</span>
            </label>
            <label className="toggleField">
              <input
                type="checkbox"
                checked={runConfig.notifySlack}
                onChange={(event) => setRunConfig((current) => ({ ...current, notifySlack: event.target.checked }))}
              />
              <span>{t('slackNotify')}</span>
            </label>
            <button className="smallButton" onClick={() => loadDevices().catch(console.error)}>
              <RefreshCcw size={15} />
              {t('refreshDevices')}
            </button>
          </div>
        </section>
      </section>

      <section className="settingsGrid">
        <div className="panel configPanel">
          <div className="panelHeader">
            <div>
              <h2><Settings2 size={17} /> {t('localSettings')}</h2>
              <p>{t('localSettingsSubtitle')}</p>
            </div>
            <button className="smallButton" onClick={saveConfig} disabled={isSavingConfig}>
              <Save size={15} />
              {isSavingConfig ? t('saving') : t('saveEnv')}
            </button>
          </div>
          <div className="settingsForm">
            <label>
              <span>{t('appId')}</span>
              <input value={runConfig.appId} onChange={(event) => setRunConfig((current) => ({ ...current, appId: event.target.value }))} placeholder="com.example.app" />
            </label>
            <label>
              <span>{t('flowPath')}</span>
              <input value={runConfig.flowPath} onChange={(event) => setRunConfig((current) => ({ ...current, flowPath: event.target.value }))} placeholder="flows" />
            </label>
            <label>
              <span>{t('testEmail')}</span>
              <input value={runConfig.testEmail} onChange={(event) => setRunConfig((current) => ({ ...current, testEmail: event.target.value }))} placeholder="qa@example.com" />
            </label>
            <label>
              <span>{t('testPassword')}</span>
              <input type="password" value={runConfig.testPassword} onChange={(event) => setRunConfig((current) => ({ ...current, testPassword: event.target.value }))} placeholder="••••••••" />
            </label>
            <label className="wideField">
              <span><Bell size={15} /> {t('slackWebhook')}</span>
              <input value={runConfig.slackWebhook} onChange={(event) => setRunConfig((current) => ({ ...current, slackWebhook: event.target.value }))} placeholder="https://hooks.slack.com/services/..." />
            </label>
            <label>
              <span>{t('dashboardBaseUrl')}</span>
              <input value={runConfig.dashboardBaseUrl} onChange={(event) => setRunConfig((current) => ({ ...current, dashboardBaseUrl: event.target.value }))} placeholder="http://127.0.0.1:5173" />
            </label>
            <label>
              <span>{t('timeoutMs')}</span>
              <input value={runConfig.maestroTimeoutMs} onChange={(event) => setRunConfig((current) => ({ ...current, maestroTimeoutMs: event.target.value }))} placeholder="1800000" />
            </label>
          </div>
        </div>

        <div className="panel schedulePanel">
          <div className="panelHeader">
            <div>
              <h2><CalendarClock size={17} /> {t('cronManagement')}</h2>
              <p>{schedule.installed ? t('cronInstalled') : t('cronNotInstalled')}</p>
            </div>
            <span className={`scheduleBadge ${schedule.installed ? 'installed' : ''}`}>{schedule.installed ? t('active') : t('inactive')}</span>
          </div>
          <div className="settingsForm singleColumn">
            <label>
              <span>{t('cronExpression')}</span>
              <input value={schedule.cronExpression} onChange={(event) => setSchedule((current) => ({ ...current, cronExpression: event.target.value }))} placeholder="0 2 * * *" />
            </label>
            <label>
              <span>{t('scheduleEnvironment')}</span>
              <input value={schedule.environment} onChange={(event) => setSchedule((current) => ({ ...current, environment: event.target.value }))} placeholder="nightly" />
            </label>
          </div>
          <div className="commandPreview">
            <span>{t('cronCommand')}</span>
            <code>{schedule.command || 'npm run test:nightly'}</code>
          </div>
          <div className="scheduleActions">
            <button className="smallButton" onClick={saveSchedule} disabled={isScheduling}>
              <Save size={15} />
              {t('save')}
            </button>
            <button className="smallButton" onClick={installSchedule} disabled={isScheduling}>
              <CalendarClock size={15} />
              {t('installCron')}
            </button>
            <button className="smallButton dangerTextButton" onClick={removeSchedule} disabled={isScheduling || !schedule.installed}>
              <Trash2 size={15} />
              {t('removeCron')}
            </button>
          </div>
        </div>
      </section>

      {status.activeRun && (
        <section className="activeRunPanel">
          <div>
            <p className="eyebrow">{t('currentlyRunning')}</p>
            <h2>{displayRunName(status.activeRun, t)}</h2>
            <p>
              {status.activeRun.runId || t('runPreparing')} · {localizedPhase(status.latestStatus?.phase || 'queued', language)} · {status.activeRun.platform || runConfig.platform}
            </p>
          </div>
          <div className="activeRunMeta">
            {(status.activeRun.testNames || []).slice(0, 6).map((name) => <span key={name}>{name}</span>)}
            {(status.activeRun.testNames || []).length > 6 && <span>+{status.activeRun.testNames.length - 6} {t('tests')}</span>}
            {!(status.activeRun.testNames || []).length && <span>{status.latestStatus?.message || t('flowsRunning')}</span>}
          </div>
        </section>
      )}

      <section className="metrics">
        <Metric icon={<CheckCircle2 />} label={t('latestPassed')} value={latest?.passed ?? 0} tone="pass" />
        <Metric icon={<XCircle />} label={t('latestFailed')} value={latest?.failed ?? 0} tone="fail" />
        <Metric icon={<Clock3 />} label={t('latestDuration')} value={latest?.duration || '0s'} />
        <Metric icon={<Smartphone />} label={t('device')} value={latest?.deviceName || activePlatformLabel} />
      </section>

      <section className="flowGuide">
        <div>
          <p className="eyebrow">{t('flowDirectory')}</p>
          <h2>{t('putYamlHere')}</h2>
          <p>
            {t('flowGuideBefore')} <code>/flows</code> {t('flowGuideMiddle')} <code>/flows/happy-path</code> {t('flowGuideAfter')}
          </p>
        </div>
        <div className="flowPathCard">
          <FolderOpen size={18} />
          <code>./flows</code>
        </div>
      </section>

      <section className="panel setupGuide">
        <div className="panelHeader setupHeader">
          <div>
            <h2><Terminal size={17} /> {t('setupGuide')}</h2>
            <p>{t('setupGuideSubtitle')}</p>
          </div>
          <div className="segmentedControl" aria-label={t('operatingSystem')}>
            <button className={setupPlatform === 'mac' ? 'active' : ''} onClick={() => setSetupPlatform('mac')}>macOS</button>
            <button className={setupPlatform === 'windows' ? 'active' : ''} onClick={() => setSetupPlatform('windows')}>Windows</button>
          </div>
        </div>

        <div className="setupGrid">
          <div className="setupColumn">
            <h3>{t('prerequisites')}</h3>
            <ul className="setupChecklist">
              {setupGuide.prerequisites.map((item) => (
                <li key={item.title}>
                  <CheckCircle2 size={16} />
                  <span><strong>{item.title}</strong>{item.body}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="setupColumn">
            <h3>{t('firstRun')}</h3>
            <ol className="setupSteps">
              {setupGuide.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
        </div>

        <div className="setupCommandGrid">
          {setupGuide.commands.map((command) => (
            <div className="commandPreview" key={command.label}>
              <span>{command.label}</span>
              <code>{command.value}</code>
            </div>
          ))}
        </div>

        <p className="setupNote">{setupGuide.note}</p>
      </section>

      <section className="libraryGrid">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <h2><ListChecks size={17} /> {t('savedTests')}</h2>
              <p>{selectedTests.length} {t('testsSelected')}</p>
            </div>
            <button className="smallButton" onClick={() => triggerSavedTests(selectedTestIds)} disabled={isTriggering || Boolean(status.activeRun) || !selectedTestIds.length}>
              <Play size={15} />
              {t('runSelected')}
            </button>
          </div>
          <div className="savedList">
            {library.tests.map((test) => (
              <div className="savedItem" key={test.id}>
                <label>
                  <input type="checkbox" checked={selectedTestIds.includes(test.id)} onChange={() => toggleTest(test.id)} />
                  <span>
                    <strong>{test.name}</strong>
                    <small>{test.flowFile} · {test.platform === 'shared' ? t('shared') : test.platform} · {test.lastStatus ? statusLabel(test.lastStatus, language) : t('notRun')}</small>
                  </span>
                </label>
                <div className="itemActions twoActions">
                  <button className="iconButton mini" title={t('runThisTest')} onClick={() => triggerSavedTests([test.id])} disabled={isTriggering || Boolean(status.activeRun)}>
                    <Play size={15} />
                  </button>
                  <button className="iconButton mini" title={t('delete')} onClick={() => deleteSavedTest(test.id)} disabled={Boolean(status.activeRun)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="testWizard">
            <p className="eyebrow"><Plus size={13} /> {t('testWizard')}</p>
            <ol>
              <li>{t('wizardStep1')}</li>
              <li>{t('wizardStep2')}</li>
              <li>{t('wizardStep3')}</li>
            </ol>
          </div>
          <div className="inlineForm">
            <input value={newTest.name} onChange={(event) => setNewTest((current) => ({ ...current, name: event.target.value }))} placeholder={t('testName')} />
            <input value={newTest.flowFile} onChange={(event) => setNewTest((current) => ({ ...current, flowFile: event.target.value }))} placeholder="flows/example.yaml" />
            <select value={newTest.platform} onChange={(event) => setNewTest((current) => ({ ...current, platform: event.target.value }))}>
              <option value="shared">Shared</option>
              <option value="android">Android</option>
              <option value="ios">iOS</option>
            </select>
            <input value={newTest.tags} onChange={(event) => setNewTest((current) => ({ ...current, tags: event.target.value }))} placeholder={t('tagsPlaceholder')} />
            <button className="smallButton" onClick={saveNewTest} disabled={!newTest.name || !newTest.flowFile}>
              <Save size={15} />
              {t('save')}
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <div>
              <h2><Layers3 size={17} /> {t('suites')}</h2>
              <p>{t('suiteSubtitle')}</p>
            </div>
            <span>{library.suites.length}</span>
          </div>
          <div className="savedList">
            {library.suites.map((suite) => (
              <div className="savedItem" key={suite.id}>
                <span>
                  <strong>{suite.name}</strong>
                  <small>{suite.testIds.length} {t('tests')} · {suite.lastStatus ? statusLabel(suite.lastStatus, language) : t('notRun')}</small>
                </span>
                <div className="itemActions">
                  <button className="iconButton mini" title={t('runSuite')} onClick={() => triggerSuite(suite.id)} disabled={isTriggering || Boolean(status.activeRun)}>
                    <Play size={15} />
                  </button>
                  <button className="iconButton mini" title={t('edit')} onClick={() => editSuite(suite)} disabled={Boolean(status.activeRun)}>
                    <Pencil size={15} />
                  </button>
                  <button className="iconButton mini" title={t('delete')} onClick={() => deleteSavedSuite(suite.id)} disabled={Boolean(status.activeRun)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="inlineForm suiteForm">
            <input value={suiteName} onChange={(event) => setSuiteName(event.target.value)} placeholder={t('suiteName')} />
            <button className="smallButton" onClick={saveSelectedSuite} disabled={!suiteName || !selectedTestIds.length}>
              <Save size={15} />
              {editingSuiteId ? t('updateSuite') : t('saveSuite')}
            </button>
            {editingSuiteId && (
              <button className="smallButton" onClick={() => { setEditingSuiteId(''); setSuiteName('Custom Smoke Suite'); }}>
                {t('cancel')}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="mainGrid">
        <div className="panel">
          <div className="panelHeader">
            <h2>{t('passFailTrend')}</h2>
            <span>{reports.length} {t('runs')}</span>
          </div>
          <div className="chartWrap">
            <TrendChart data={trend} t={t} />
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>{t('flakyTests')}</h2>
            <span>{flakyTests.length}</span>
          </div>
          {flakyTests.length ? (
            <ul className="simpleList">
              {flakyTests.map((test) => <li key={test}><AlertTriangle size={16} />{test}</li>)}
            </ul>
          ) : (
            <p className="empty">{t('noFlaky')}</p>
          )}
        </div>
      </section>

      <section className="history">
        <div className="historyHeader">
          <h2>{t('runHistory')}</h2>
          <div className="filters">
            <label className="searchBox">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchRuns')} />
            </label>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">{t('all')}</option>
              <option value="passed">{t('passed')}</option>
              <option value="failed">{t('failed')}</option>
              <option value="cancelled">{t('cancelled')}</option>
            </select>
          </div>
        </div>

        <div className="runList">
          {pagedReports.map((report) => (
            <RunRow
              key={report.runId}
              report={report}
              t={t}
              language={language}
              expanded={expandedRuns.includes(report.runId)}
              onArchive={() => archiveReport(report.runId)}
              onDelete={() => deleteReport(report.runId)}
              onToggle={() => setExpandedRuns((current) => (
                current.includes(report.runId)
                  ? current.filter((runId) => runId !== report.runId)
                  : [...current, report.runId]
              ))}
            />
          ))}
          {!reports.length && <p className="empty">{t('historyEmpty')}</p>}
        </div>

        {reports.length > 0 && (
          <div className="pagination">
            <button className="smallButton" onClick={() => setHistoryPage((page) => Math.max(1, page - 1))} disabled={historyPage === 1}>
              {t('previous')}
            </button>
            <span>{historyPage} / {totalHistoryPages} · {reports.length} {t('runs')}</span>
            <button className="smallButton" onClick={() => setHistoryPage((page) => Math.min(totalHistoryPages, page + 1))} disabled={historyPage === totalHistoryPages}>
              {t('next')}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function ReportPage({ runId, language, setLanguage }) {
  const t = useMemo(() => createTranslator(language), [language]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  useEffect(() => {
    fetch(`/api/reports/${encodeURIComponent(runId)}`)
      .then((response) => {
        if (!response.ok) throw new Error(t('reportNotFound'));
        return response.json();
      })
      .then(setReport)
      .catch((err) => setError(err.message || t('reportCouldNotLoad')));
  }, [runId, t]);

  if (error) {
    return (
      <main className="shell reportShell">
        <ReportTopbar dark={dark} setDark={setDark} language={language} setLanguage={setLanguage} t={t} />
        <section className="detailPanel">
          <h1>{t('reportOpenFailed')}</h1>
          <p className="empty">{error}</p>
        </section>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="shell reportShell">
        <ReportTopbar dark={dark} setDark={setDark} language={language} setLanguage={setLanguage} t={t} />
        <section className="detailPanel">
          <p className="empty">{t('reportLoading')}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell reportShell">
      <ReportTopbar dark={dark} setDark={setDark} language={language} setLanguage={setLanguage} t={t} />
      <ReportDetail report={report} standalone t={t} language={language} />
    </main>
  );
}

function ReportTopbar({ dark, setDark, language, setLanguage, t }) {
  return (
    <header className="topbar reportTopbar">
      <div>
        <p className="eyebrow">maestRoRun · RoR</p>
        <h1>{t('detailedRunReport')}</h1>
        <p className="subtitle">{t('detailedRunSubtitle')}</p>
      </div>
      <div className="actions">
        <label className="languageSelect" title={t('language')}>
          <Languages size={16} />
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="tr">TR</option>
            <option value="en">EN</option>
          </select>
        </label>
        <button className="iconButton" title={t('backToDashboard')} onClick={() => { window.location.href = '/'; }}>
          <ArrowLeft size={18} />
        </button>
        <button className="iconButton" title={dark ? t('lightTheme') : t('darkTheme')} onClick={() => setDark(!dark)}>
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}

function Metric({ icon, label, value, tone = '' }) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metricIcon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function BrandTitle() {
  return (
    <h1 className="brandTitle" aria-label="maestRoRun">
      <span>maest</span><span className="brandRoR">RoR</span><span>un</span>
    </h1>
  );
}

function ReportDetail({ report, standalone = false, t, language }) {
  const [testFilter, setTestFilter] = useState('all');
  const [testSearch, setTestSearch] = useState('');
  const testResults = report.testResults || [];
  const failedTests = report.failedTests || [];
  const screenshots = report.screenshots || [];
  const selectedFlows = report.selectedFlows || [];
  const passRate = report.total ? Math.round((report.passed / report.total) * 100) : 0;
  const reportFileEntries = Object.entries(report.reportFiles || {}).filter(([, value]) => value);
  const visibleTestResults = (testResults.length ? testResults : fallbackResults(report)).filter((test) => {
    const matchesStatus = testFilter === 'all' || test.status === testFilter;
    const matchesSearch = !testSearch || [test.name, test.suite, test.message].filter(Boolean).join(' ').toLowerCase().includes(testSearch.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  return (
    <section className={`reportDetail ${standalone ? 'standalone' : ''}`}>
      <div className="reportHero">
        <div>
          <p className="eyebrow">{t('detailedReport')}</p>
          <h2>{report.runId}</h2>
          <p>{formatDate(report.startedAt)} · {report.environment} · {report.platform} · {report.deviceName}</p>
        </div>
        <div className="reportHeroActions">
          <button className="smallButton" onClick={() => navigator.clipboard?.writeText(report.runId)}>
            <Copy size={15} />
            {t('copyRunId')}
          </button>
        </div>
        <div className={`scoreRing ${report.status}`}>
          <strong>{passRate}%</strong>
          <span>{statusLabel(report.status, language)}</span>
        </div>
      </div>

      <div className="reportStats">
        <MiniStat label={t('total')} value={report.total} />
        <MiniStat label={t('passed')} value={report.passed} tone="pass" />
        <MiniStat label={t('failed')} value={report.failed} tone="fail" />
        <MiniStat label={t('duration')} value={report.duration} />
        <MiniStat label="Slack" value={report.slackNotified ? t('sent') : t('off')} />
      </div>

      <div className="detailGrid reportLayout">
        <section className="detailPanel testsPanel">
          <div className="panelHeader">
            <h2><ListChecks size={17} /> {t('testResults')}</h2>
            <span>{visibleTestResults.length} / {testResults.length || report.total} {t('tests')}</span>
          </div>
          <div className="testFilterBar">
            <label className="searchBox compact">
              <Search size={15} />
              <input value={testSearch} onChange={(event) => setTestSearch(event.target.value)} placeholder={t('searchTests')} />
            </label>
            <label className="selectField compact">
              <span><Filter size={15} /> {t('status')}</span>
              <select value={testFilter} onChange={(event) => setTestFilter(event.target.value)}>
                <option value="all">{t('all')}</option>
                <option value="passed">{t('passed')}</option>
                <option value="failed">{t('failed')}</option>
                <option value="skipped">{t('skipped')}</option>
                <option value="cancelled">{t('cancelled')}</option>
              </select>
            </label>
          </div>
          <div className="testTimeline">
            {visibleTestResults.map((test) => (
              <TestResultCard key={`${report.runId}-${test.name}`} test={test} t={t} language={language} />
            ))}
            {!visibleTestResults.length && <p className="empty">{t('noMatchingTestResults')}</p>}
          </div>
        </section>

        <section className="detailPanel reportSide">
          <div className="panelHeader">
            <h2><FileText size={17} /> {t('runInformation')}</h2>
          </div>
          <dl className="infoList">
            <div><dt>{t('status')}</dt><dd>{statusLabel(report.status, language)}</dd></div>
            <div><dt>{t('startedAt')}</dt><dd>{formatDate(report.startedAt)}</dd></div>
            <div><dt>{t('endedAt')}</dt><dd>{formatDate(report.endedAt)}</dd></div>
            <div><dt>Flow path</dt><dd>{report.flowPath || '-'}</dd></div>
            <div><dt>Suite</dt><dd>{report.suiteId || '-'}</dd></div>
            <div><dt>Platform</dt><dd>{report.platform || '-'}</dd></div>
            <div><dt>{t('environment')}</dt><dd>{report.environment || '-'}</dd></div>
            <div><dt>Device ID</dt><dd>{report.deviceId || '-'}</dd></div>
            <div><dt>App path</dt><dd>{report.appPath || report.appIosPath || report.appApkPath || '-'}</dd></div>
            <div><dt>Exit code</dt><dd>{report.exitCode ?? '-'}</dd></div>
          </dl>
        </section>

        <section className="detailPanel reportSide">
          <div className="panelHeader">
            <h2>{t('reportFiles')}</h2>
            <span>{reportFileEntries.length}</span>
          </div>
          <ul className="flowList">
            {reportFileEntries.map(([key, value]) => (
              <li key={key}><strong>{key}</strong><span>{value}</span></li>
            ))}
          </ul>
        </section>

        {failedTests.length > 0 && (
          <section className="detailPanel reportWide">
            <div className="panelHeader">
              <h2><AlertTriangle size={17} /> {t('errorDetails')}</h2>
              <span>{failedTests.length}</span>
            </div>
            <div className="errorStack">
              {failedTests.map((test) => (
                <article key={`${report.runId}-${test.name}-error`}>
                  <strong>{test.name}</strong>
                  <pre>{test.message || t('noErrorMessage')}</pre>
                </article>
              ))}
            </div>
          </section>
        )}

        {screenshots.length > 0 && (
          <section className="detailPanel reportWide">
            <div className="panelHeader">
              <h2>{t('failureScreenshots')}</h2>
              <span>{screenshots.length}</span>
            </div>
            <div className="screenshotGrid large">
              {screenshots.map((shot) => (
                <a href={shot.url} target="_blank" rel="noreferrer" key={`${report.runId}-${shot.path}`}>
                  <img src={shot.url} alt={shot.name} />
                </a>
              ))}
            </div>
          </section>
        )}

        {selectedFlows.length > 0 && (
          <section className="detailPanel reportSide">
            <div className="panelHeader">
              <h2><FolderOpen size={17} /> {t('executedFlows')}</h2>
              <span>{selectedFlows.length}</span>
            </div>
            <ul className="flowList">
              {selectedFlows.map((flow) => <li key={flow}>{flow}</li>)}
            </ul>
          </section>
        )}

        <section className="detailPanel reportWide">
          <div className="panelHeader">
            <h2><Terminal size={17} /> {t('maestroOutput')}</h2>
          </div>
          <div className="logGrid">
            <div>
              <span>stdout</span>
              <pre>{report.stdoutTail || t('noStdout')}</pre>
            </div>
            <div>
              <span>stderr</span>
              <pre>{report.stderrTail || t('noStderr')}</pre>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function TestResultCard({ test, t, language }) {
  return (
    <article className={`testResultCard ${test.status}`}>
      <div className="testResultHeader">
        <span className={`resultBadge ${test.status}`}>{statusLabel(test.status, language)}</span>
        <div>
          <strong>{test.name}</strong>
          <small>{test.suite || t('testSuite')} · {test.duration || t('noDuration')}</small>
        </div>
      </div>
      <dl className="testResultMeta">
        <div><dt>{t('status')}</dt><dd>{statusLabel(test.status, language)}</dd></div>
        <div><dt>{t('duration')}</dt><dd>{test.duration || '-'}</dd></div>
        <div><dt>Suite</dt><dd>{test.suite || '-'}</dd></div>
      </dl>
      {test.message && (
        <div className="testMessage">
          <span>{t('errorMessage')}</span>
          <pre>{test.message}</pre>
        </div>
      )}
    </article>
  );
}

function MiniStat({ label, value, tone = '' }) {
  return (
    <div className={`miniStat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RunRow({ report, expanded, onToggle, onArchive, onDelete, t, language }) {
  const failedTests = report.failedTests || [];
  const screenshots = report.screenshots || [];
  const testResults = report.testResults || [];
  const reportUrl = `/report/${encodeURIComponent(report.runId)}`;

  return (
    <article className={`runRow ${report.status} ${expanded ? 'expanded' : ''}`}>
      <button className="runSummary runToggle" onClick={onToggle} aria-expanded={expanded}>
        <div>
          <div className="runTitle">
            <span className="statusDot" />
            <strong>{report.runId}</strong>
          </div>
          <p>{formatDate(report.startedAt)} · {report.environment} · {report.deviceName} · {report.duration}</p>
        </div>
        <div className="counts">
          <span>{report.total} {t('total')}</span>
          <span className="pass">{report.passed} {t('passed')}</span>
          <span className="fail">{report.failed} {t('failed')}</span>
          {report.status === 'cancelled' && <span className="cancelled">{t('cancelled')}</span>}
          <a className="smallButton" href={reportUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{t('details')}</a>
          <span className="expandHint">{expanded ? t('close') : t('open')}</span>
        </div>
      </button>

      {expanded && (
        <div className="runExpanded">
          <div className="runExpandedGrid">
            <div>
              <h3>{t('runSummary')}</h3>
              <dl className="compactInfo">
                <div><dt>Platform</dt><dd>{report.platform || '-'}</dd></div>
                <div><dt>{t('environment')}</dt><dd>{report.environment || '-'}</dd></div>
                <div><dt>Suite</dt><dd>{report.suiteId || '-'}</dd></div>
                <div><dt>Slack</dt><dd>{report.slackNotified ? t('sent') : t('off')}</dd></div>
              </dl>
            </div>

            <div>
              <h3>{t('tests')}</h3>
              <div className="miniResults">
                {(testResults.length ? testResults : fallbackResults(report)).slice(0, 8).map((test) => (
                  <span className={test.status} key={`${report.runId}-${test.name}-mini`}>
                    {test.status === 'passed' ? '✓' : test.status === 'skipped' ? '-' : test.status === 'cancelled' ? '◦' : '×'} {test.name}
                  </span>
                ))}
                {(testResults.length || report.total) > 8 && <small>+{(testResults.length || report.total) - 8} {t('moreTests')}</small>}
              </div>
            </div>
          </div>

          {failedTests.length > 0 && (
            <ul className="failureList">
              {failedTests.map((test) => (
                <li key={`${report.runId}-${test.name}`}>
                  <XCircle size={16} />
                  <span>{test.name}</span>
                </li>
              ))}
            </ul>
          )}

          {screenshots.length > 0 && (
            <div className="screenshotGrid">
              {screenshots.slice(0, 6).map((shot) => (
                <a href={shot.url} target="_blank" rel="noreferrer" key={`${report.runId}-${shot.path}`}>
                  <img src={shot.url} alt={shot.name} />
                </a>
              ))}
            </div>
          )}

          <div className="reportActions">
            <button className="smallButton" onClick={onArchive}>
              <Archive size={15} />
              {t('archive')}
            </button>
            <button className="smallButton dangerTextButton" onClick={onDelete}>
              <Trash2 size={15} />
              {t('delete')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function fallbackResults(report) {
  if (report.failedTests?.length) {
    return report.failedTests.map((test) => ({ ...test, status: 'failed' }));
  }
  return report.total ? [{ name: `${report.total} flow`, status: report.status, duration: report.duration }] : [];
}

function TrendChart({ data, t }) {
  const max = Math.max(1, ...data.map((item) => item.passed + item.failed));

  if (!data.length) {
    return <p className="empty">{t('noTrendData')}</p>;
  }

  return (
    <div className="trendChart" aria-label="Pass fail trend chart">
      {data.map((item) => {
        const passedHeight = `${Math.max(4, (item.passed / max) * 100)}%`;
        const failedHeight = `${Math.max(item.failed ? 4 : 0, (item.failed / max) * 100)}%`;
        return (
          <div className="trendItem" key={item.name} title={`${item.passed} ${t('passed')}, ${item.failed} ${t('failed')}`}>
            <div className="trendBars">
              <span className="trendBar pass" style={{ height: passedHeight }} />
              <span className="trendBar fail" style={{ height: failedHeight }} />
            </div>
            <small>{item.name}</small>
          </div>
        );
      })}
    </div>
  );
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function shortRunId(runId = '') {
  return runId.replace('run-', '').slice(11, 16);
}

function statusLabel(status, language = 'tr') {
  const labels = {
    tr: { passed: 'Geçti', failed: 'Kaldı', skipped: 'Atlandı', cancelled: 'İptal' },
    en: { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' },
  };
  return labels[language]?.[status] || labels.tr[status] || status || '-';
}

function localizedPhase(phase, language = 'tr') {
  const labels = {
    tr: {
      idle: 'hazır',
      queued: 'sırada',
      starting: 'başlıyor',
      device: 'cihaz',
      running: 'koşuyor',
      collecting: 'raporlanıyor',
      finished: 'bitti',
      cancelled: 'iptal',
      error: 'hata',
    },
    en: {
      idle: 'idle',
      queued: 'queued',
      starting: 'starting',
      device: 'device',
      running: 'running',
      collecting: 'collecting',
      finished: 'finished',
      cancelled: 'cancelled',
      error: 'error',
    },
  };
  return labels[language]?.[phase] || phase || '-';
}

function displayRunName(activeRun, t) {
  if (!activeRun) return t('maestroRun');
  if (activeRun.displayName === 'Tüm Maestro flowları') return t('allMaestroFlows');
  const selectedMatch = String(activeRun.displayName || '').match(/^(\d+) seçili test$/);
  if (selectedMatch) return `${selectedMatch[1]} ${t('selectedTests')}`;
  return activeRun.displayName || activeRun.suiteName || activeRun.runId || t('maestroRun');
}

function getSetupGuide(language, platform) {
  const guides = {
    tr: {
      mac: {
        prerequisites: [
          { title: 'Node.js 20+', body: ' Dashboard ve orchestrator scriptleri için gerekli.' },
          { title: 'Java 17+ ve JAVA_HOME', body: ' Maestro CLI Java 17 veya üzerini ister.' },
          { title: 'Maestro CLI', body: ' curl veya Homebrew ile kurulabilir.' },
          { title: 'Android Studio + AVD', body: ' Android Emulator, adb ve emulator binary için gerekli.' },
          { title: 'Xcode + Command Line Tools', body: ' iOS Simulator koşumları sadece macOS üzerinde desteklenir.' },
        ],
        steps: [
          'Repoyu klonla ve npm install çalıştır.',
          '.env dosyasını oluştur veya Local Settings panelinden doldur.',
          'APK ya da .app path alanını gir.',
          'Cihazı seç, flow YAML dosyalarını /flows altına koy.',
          'Run All, Run Selected veya bir suite ile koşumu başlat.',
        ],
        commands: [
          { label: 'Kurulum', value: 'npm install\ncp .env.example .env\nnpm run dashboard' },
          { label: 'Maestro', value: 'curl -fsSL "https://get.maestro.mobile.dev" | bash\n# veya\nbrew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro' },
          { label: 'Doğrulama', value: 'java -version\nmaestro --help\nadb devices\nxcrun simctl list devices' },
        ],
        note: 'macOS üzerinde hem Android Emulator hem iOS Simulator koşabilirsin. iOS gerçek cihaz değil, Simulator hedeflenir.',
      },
      windows: {
        prerequisites: [
          { title: 'Node.js 20+', body: ' Dashboard ve backend için gerekli.' },
          { title: 'Java 17+ ve JAVA_HOME', body: ' Maestro CLI için gerekli.' },
          { title: 'Maestro CLI', body: ' Installer script veya GitHub zip paketi ile kurulabilir.' },
          { title: 'Android Studio + AVD', body: ' Android Emulator ve adb için gerekli.' },
          { title: 'PowerShell PATH ayarı', body: ' maestro, adb ve emulator komutları terminalden görünmeli.' },
        ],
        steps: [
          'Repoyu klonla ve npm install çalıştır.',
          '.env dosyasını oluştur veya Local Settings panelinden doldur.',
          'APK path alanını gir ve Android cihazı seç.',
          'Flow YAML dosyalarını /flows altına koy.',
          'Run All, Run Selected veya bir suite ile koşumu başlat.',
        ],
        commands: [
          { label: 'Kurulum', value: 'npm install\ncopy .env.example .env\nnpm run dashboard' },
          { label: 'Maestro', value: 'curl -fsSL "https://get.maestro.mobile.dev" | bash\n# veya maestro.zip indir, C:\\maestro içine çıkar ve C:\\maestro\\bin PATH içine ekle' },
          { label: 'Doğrulama', value: 'java -version\nmaestro --help\nadb devices' },
        ],
        note: 'Windows tarafında bu setup Android için tasarlanır. iOS Simulator Windows üzerinde çalışmaz; iOS koşumları için macOS gerekir.',
      },
    },
    en: {
      mac: {
        prerequisites: [
          { title: 'Node.js 20+', body: ' Required for the dashboard and orchestration scripts.' },
          { title: 'Java 17+ and JAVA_HOME', body: ' Required by the Maestro CLI.' },
          { title: 'Maestro CLI', body: ' Install with curl or Homebrew.' },
          { title: 'Android Studio + AVD', body: ' Required for Android Emulator, adb, and emulator binaries.' },
          { title: 'Xcode + Command Line Tools', body: ' Required for iOS Simulator runs on macOS.' },
        ],
        steps: [
          'Clone the repo and run npm install.',
          'Create .env or fill it from the Local Settings panel.',
          'Enter the APK or .app path.',
          'Pick a device and put flow YAML files under /flows.',
          'Start with Run All, Run Selected, or a saved suite.',
        ],
        commands: [
          { label: 'Project setup', value: 'npm install\ncp .env.example .env\nnpm run dashboard' },
          { label: 'Maestro', value: 'curl -fsSL "https://get.maestro.mobile.dev" | bash\n# or\nbrew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro' },
          { label: 'Verify', value: 'java -version\nmaestro --help\nadb devices\nxcrun simctl list devices' },
        ],
        note: 'On macOS you can run both Android Emulator and iOS Simulator. iOS here means Simulator, not a physical iOS device.',
      },
      windows: {
        prerequisites: [
          { title: 'Node.js 20+', body: ' Required for the dashboard and backend.' },
          { title: 'Java 17+ and JAVA_HOME', body: ' Required by the Maestro CLI.' },
          { title: 'Maestro CLI', body: ' Install using the script or the GitHub zip package.' },
          { title: 'Android Studio + AVD', body: ' Required for Android Emulator and adb.' },
          { title: 'PowerShell PATH setup', body: ' maestro, adb, and emulator commands must be visible from the terminal.' },
        ],
        steps: [
          'Clone the repo and run npm install.',
          'Create .env or fill it from the Local Settings panel.',
          'Enter the APK path and select an Android device.',
          'Put flow YAML files under /flows.',
          'Start with Run All, Run Selected, or a saved suite.',
        ],
        commands: [
          { label: 'Project setup', value: 'npm install\ncopy .env.example .env\nnpm run dashboard' },
          { label: 'Maestro', value: 'curl -fsSL "https://get.maestro.mobile.dev" | bash\n# or download maestro.zip, extract to C:\\maestro, and add C:\\maestro\\bin to PATH' },
          { label: 'Verify', value: 'java -version\nmaestro --help\nadb devices' },
        ],
        note: 'This Windows setup targets Android. iOS Simulator does not run on Windows; use macOS for iOS runs.',
      },
    },
  };

  return guides[language]?.[platform] || guides.tr.mac;
}

function useLanguage() {
  const [language, setLanguageState] = useState(() => localStorage.getItem('language') || 'tr');
  const setLanguage = (nextLanguage) => {
    localStorage.setItem('language', nextLanguage);
    setLanguageState(nextLanguage);
  };
  return [language, setLanguage];
}

function createTranslator(language) {
  return (key) => translations[language]?.[key] || translations.tr[key] || key;
}

const translations = {
  tr: {
    language: 'Dil',
    brandEyebrow: 'Local Maestro otomasyon aracı · kısa ad RoR',
    dashboardSubtitle: 'üzerinde kayıtlı flow ve suite koşumları',
    refreshReports: 'Raporları yenile',
    lightTheme: 'Açık tema',
    darkTheme: 'Koyu tema',
    runPreparing: 'Koşum hazırlanıyor',
    lastRunPassed: 'Son koşum başarılı',
    lastRunFailed: 'Son koşum başarısız',
    lastRunCancelled: 'Son koşum iptal edildi',
    readyToRun: 'Koşuma hazır',
    activeRun: 'Aktif koşum var',
    ready: 'Hazır',
    noReportsYet: 'Henüz rapor yok',
    running: 'Koşuyor',
    runAll: 'Tümünü Koş',
    stop: 'Durdur',
    platform: 'Platform',
    runSettings: 'Koşum ayarları',
    device: 'Cihaz',
    autoDevice: 'Otomatik seç',
    booted: 'açık',
    androidApkPath: 'APK yolu',
    iosAppPath: '.app yolu',
    environment: 'Ortam',
    reinstallApp: "App'i yeniden kur",
    resetAppData: 'Datayı sıfırla',
    slackNotify: 'Slack bildirimi',
    refreshDevices: 'Cihazları yenile',
    localSettings: 'Yerel Ayarlar',
    localSettingsSubtitle: '.env değerlerini arayüzden yönet',
    saveEnv: '.env Kaydet',
    saving: 'Kaydediliyor',
    appId: 'App ID',
    flowPath: 'Flow path',
    testEmail: 'Test e-posta',
    testPassword: 'Test şifre',
    slackWebhook: 'Slack webhook',
    dashboardBaseUrl: 'Dashboard base URL',
    timeoutMs: 'Maestro timeout ms',
    cronManagement: 'Cron Yönetimi',
    cronInstalled: 'Nightly cron kurulu',
    cronNotInstalled: 'Nightly cron kurulu değil',
    active: 'Aktif',
    inactive: 'Pasif',
    cronExpression: 'Cron ifadesi',
    scheduleEnvironment: 'Schedule ortamı',
    cronCommand: 'Çalışacak komut',
    installCron: 'Cron Kur',
    removeCron: 'Cron Kaldır',
    currentlyRunning: 'Şu an koşuyor',
    maestroRun: 'Maestro koşumu',
    allMaestroFlows: 'Tüm Maestro flowları',
    selectedTests: 'seçili test',
    flowsRunning: 'Flowlar çalışıyor',
    tests: 'test',
    latestPassed: 'Son Passed',
    latestFailed: 'Son Failed',
    latestDuration: 'Son Süre',
    flowDirectory: 'Maestro flow dizini',
    putYamlHere: 'Yeni YAML testlerini buraya koy',
    flowGuideBefore: 'Kendi ürettiğin Maestro dosyalarını',
    flowGuideMiddle: 'altına veya kategori için',
    flowGuideAfter: 'gibi bir alt klasöre ekle. Sonra Kayıtlı Testler bölümünden flow path ile kaydedip tek tek ya da suite olarak koşturabilirsin.',
    setupGuide: 'Kurulum Rehberi',
    setupGuideSubtitle: 'GitHub’dan çeken biri önce ne kurmalı, sonra ne çalıştırmalı?',
    operatingSystem: 'İşletim sistemi',
    prerequisites: 'Ön koşullar',
    firstRun: 'İlk çalıştırma',
    savedTests: 'Kayıtlı Testler',
    testsSelected: 'test seçili',
    runSelected: 'Seçilileri Koş',
    shared: 'ortak',
    notRun: 'koşmadı',
    runThisTest: 'Bu testi koş',
    testWizard: 'Test oluşturma',
    wizardStep1: 'YAML dosyanı /flows altında oluştur veya kopyala.',
    wizardStep2: 'Flow path alanına örn. flows/happy-path/login.yaml yaz.',
    wizardStep3: 'Kaydet, sonra tek test veya suite olarak çalıştır.',
    testName: 'Test adı',
    tagsPlaceholder: 'smoke, regression',
    suites: "Suite'ler",
    suiteSubtitle: 'Seçili testlerden paket oluştur',
    runSuite: 'Suite koş',
    suiteName: 'Suite adı',
    save: 'Kaydet',
    saveSuite: 'Suite Kaydet',
    updateSuite: 'Suite Güncelle',
    cancel: 'Vazgeç',
    edit: 'Düzenle',
    delete: 'Sil',
    passFailTrend: 'Pass/Fail Trendi',
    runs: 'koşum',
    flakyTests: 'Flaky Testler',
    noFlaky: 'Son raporlarda flaky pattern görünmüyor.',
    runHistory: 'Geçmiş Koşumlar',
    searchRuns: 'Run/test ara',
    all: 'Tümü',
    passed: 'Başarılı',
    failed: 'Başarısız',
    skipped: 'Atlandı',
    cancelled: 'İptal',
    historyEmpty: 'Henüz rapor yok. Bir koşum başlat veya npm run test:mobile çalıştır.',
    previous: 'Önceki',
    next: 'Sonraki',
    total: 'toplam',
    details: 'Detay',
    open: 'Aç',
    close: 'Kapat',
    runSummary: 'Koşum Özeti',
    sent: 'Gönderildi',
    off: 'Kapalı',
    moreTests: 'test daha',
    archive: 'Arşivle',
    duration: 'Süre',
    detailedRunReport: 'Detaylı Koşum Raporu',
    detailedRunSubtitle: 'Her test, flow, log ve hata çıktısı tek sayfada',
    backToDashboard: "Dashboard'a dön",
    reportNotFound: 'Rapor bulunamadı',
    reportCouldNotLoad: 'Rapor yüklenemedi',
    reportOpenFailed: 'Rapor açılamadı',
    reportLoading: 'Rapor yükleniyor...',
    detailedReport: 'Detaylı rapor',
    copyRunId: 'Run ID kopyala',
    testResults: 'Test Sonuçları',
    searchTests: 'Test ara',
    status: 'Durum',
    noMatchingTestResults: 'Bu filtreye uygun test sonucu yok.',
    runInformation: 'Koşum Bilgisi',
    startedAt: 'Başlangıç',
    endedAt: 'Bitiş',
    reportFiles: 'Rapor Dosyaları',
    errorDetails: 'Hata Detayları',
    noErrorMessage: 'Hata mesajı yok.',
    failureScreenshots: 'Hata Ekran Görüntüleri',
    executedFlows: 'Çalışan Flowlar',
    maestroOutput: 'Maestro Çıktısı',
    noStdout: 'stdout yok.',
    noStderr: 'stderr yok.',
    testSuite: 'Test Suite',
    noDuration: 'süre yok',
    errorMessage: 'Hata mesajı',
    noTrendData: 'Henüz trend verisi yok.',
    unableToSaveConfig: 'Ayarlar kaydedilemedi',
    unableToSaveSchedule: 'Schedule kaydedilemedi',
    unableToTriggerRun: 'Koşum başlatılamadı',
    unableToRunSavedTests: 'Kayıtlı testler çalıştırılamadı',
    unableToRunSuite: 'Suite çalıştırılamadı',
    unableToCancelRun: 'Koşum durdurulamadı',
    unableToSaveSuite: 'Suite kaydedilemedi',
    unableToSaveTest: 'Test kaydedilemedi',
    unableToDeleteTest: 'Test silinemedi',
    unableToDeleteSuite: 'Suite silinemedi',
    unableToArchiveReport: 'Rapor arşivlenemedi',
    unableToDeleteReport: 'Rapor silinemedi',
    confirmDeleteTest: 'Bu kayıtlı test silinsin mi? Flow YAML dosyasına dokunulmaz.',
    confirmDeleteSuite: 'Bu suite silinsin mi? Test kayıtları kalır.',
    confirmArchiveReport: 'Bu rapor arşive taşınsın mı?',
    confirmDeleteReport: 'Bu rapor kalıcı olarak silinsin mi?',
  },
  en: {
    language: 'Language',
    brandEyebrow: 'Local Maestro automation tool · short name RoR',
    dashboardSubtitle: 'saved flow and suite runs',
    refreshReports: 'Refresh reports',
    lightTheme: 'Light theme',
    darkTheme: 'Dark theme',
    runPreparing: 'Preparing run',
    lastRunPassed: 'Latest run passed',
    lastRunFailed: 'Latest run failed',
    lastRunCancelled: 'Latest run cancelled',
    readyToRun: 'Ready to run',
    activeRun: 'Run in progress',
    ready: 'Ready',
    noReportsYet: 'No reports yet',
    running: 'Running',
    runAll: 'Run All',
    stop: 'Stop',
    platform: 'Platform',
    runSettings: 'Run settings',
    device: 'Device',
    autoDevice: 'Auto select',
    booted: 'booted',
    androidApkPath: 'APK path',
    iosAppPath: '.app path',
    environment: 'Environment',
    reinstallApp: 'Reinstall app',
    resetAppData: 'Reset app data',
    slackNotify: 'Slack notification',
    refreshDevices: 'Refresh devices',
    localSettings: 'Local Settings',
    localSettingsSubtitle: 'Manage .env values from the UI',
    saveEnv: 'Save .env',
    saving: 'Saving',
    appId: 'App ID',
    flowPath: 'Flow path',
    testEmail: 'Test email',
    testPassword: 'Test password',
    slackWebhook: 'Slack webhook',
    dashboardBaseUrl: 'Dashboard base URL',
    timeoutMs: 'Maestro timeout ms',
    cronManagement: 'Cron Management',
    cronInstalled: 'Nightly cron is installed',
    cronNotInstalled: 'Nightly cron is not installed',
    active: 'Active',
    inactive: 'Inactive',
    cronExpression: 'Cron expression',
    scheduleEnvironment: 'Schedule environment',
    cronCommand: 'Command to run',
    installCron: 'Install Cron',
    removeCron: 'Remove Cron',
    currentlyRunning: 'Currently running',
    maestroRun: 'Maestro run',
    allMaestroFlows: 'All Maestro flows',
    selectedTests: 'selected tests',
    flowsRunning: 'Flows are running',
    tests: 'tests',
    latestPassed: 'Latest Passed',
    latestFailed: 'Latest Failed',
    latestDuration: 'Latest Duration',
    flowDirectory: 'Maestro flow directory',
    putYamlHere: 'Put new YAML tests here',
    flowGuideBefore: 'Add your Maestro files under',
    flowGuideMiddle: 'or a category folder such as',
    flowGuideAfter: 'Then save them from Saved Tests using the flow path and run them individually or as a suite.',
    setupGuide: 'Setup Guide',
    setupGuideSubtitle: 'What should someone install first after cloning from GitHub?',
    operatingSystem: 'Operating system',
    prerequisites: 'Prerequisites',
    firstRun: 'First run',
    savedTests: 'Saved Tests',
    testsSelected: 'tests selected',
    runSelected: 'Run Selected',
    shared: 'shared',
    notRun: 'not run',
    runThisTest: 'Run this test',
    testWizard: 'Create a test',
    wizardStep1: 'Create or copy your YAML file under /flows.',
    wizardStep2: 'Enter a flow path like flows/happy-path/login.yaml.',
    wizardStep3: 'Save it, then run it alone or inside a suite.',
    testName: 'Test name',
    tagsPlaceholder: 'smoke, regression',
    suites: 'Suites',
    suiteSubtitle: 'Create a package from selected tests',
    runSuite: 'Run suite',
    suiteName: 'Suite name',
    save: 'Save',
    saveSuite: 'Save Suite',
    updateSuite: 'Update Suite',
    cancel: 'Cancel',
    edit: 'Edit',
    delete: 'Delete',
    passFailTrend: 'Pass/Fail Trend',
    runs: 'runs',
    flakyTests: 'Flaky Tests',
    noFlaky: 'No flaky pattern in recent reports.',
    runHistory: 'Run History',
    searchRuns: 'Search run/test',
    all: 'All',
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
    historyEmpty: 'No reports yet. Trigger a run or run npm run test:mobile.',
    previous: 'Previous',
    next: 'Next',
    total: 'total',
    details: 'Details',
    open: 'Open',
    close: 'Close',
    runSummary: 'Run Summary',
    sent: 'Sent',
    off: 'Off',
    moreTests: 'more tests',
    archive: 'Archive',
    duration: 'Duration',
    detailedRunReport: 'Detailed Run Report',
    detailedRunSubtitle: 'Every test, flow, log, and error output in one page',
    backToDashboard: 'Back to dashboard',
    reportNotFound: 'Report not found',
    reportCouldNotLoad: 'Report could not be loaded',
    reportOpenFailed: 'Could not open report',
    reportLoading: 'Loading report...',
    detailedReport: 'Detailed report',
    copyRunId: 'Copy Run ID',
    testResults: 'Test Results',
    searchTests: 'Search tests',
    status: 'Status',
    noMatchingTestResults: 'No test result matches this filter.',
    runInformation: 'Run Information',
    startedAt: 'Started',
    endedAt: 'Ended',
    reportFiles: 'Report Files',
    errorDetails: 'Error Details',
    noErrorMessage: 'No error message.',
    failureScreenshots: 'Failure Screenshots',
    executedFlows: 'Executed Flows',
    maestroOutput: 'Maestro Output',
    noStdout: 'No stdout.',
    noStderr: 'No stderr.',
    testSuite: 'Test Suite',
    noDuration: 'no duration',
    errorMessage: 'Error message',
    noTrendData: 'No trend data yet.',
    unableToSaveConfig: 'Unable to save config',
    unableToSaveSchedule: 'Unable to save schedule',
    unableToTriggerRun: 'Unable to trigger run',
    unableToRunSavedTests: 'Unable to run saved tests',
    unableToRunSuite: 'Unable to run suite',
    unableToCancelRun: 'Unable to cancel run',
    unableToSaveSuite: 'Unable to save suite',
    unableToSaveTest: 'Unable to save test',
    unableToDeleteTest: 'Unable to delete test',
    unableToDeleteSuite: 'Unable to delete suite',
    unableToArchiveReport: 'Unable to archive report',
    unableToDeleteReport: 'Unable to delete report',
    confirmDeleteTest: 'Delete this saved test? The YAML flow file will stay untouched.',
    confirmDeleteSuite: 'Delete this suite? Saved tests will stay.',
    confirmArchiveReport: 'Archive this report?',
    confirmDeleteReport: 'Permanently delete this report?',
  },
};

createRoot(document.getElementById('root')).render(<Root />);
