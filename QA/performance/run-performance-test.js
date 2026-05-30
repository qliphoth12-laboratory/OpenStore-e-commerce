#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_CONFIG = {
  targetUrl: '',
  pagePath: '',
  queryParams: {},
  mode: 'smoke',
  concurrentUsers: 5,
  durationSeconds: 30,
  rampUpSeconds: 10,
  requestTimeoutMs: 15000,
  outputFile: '',
  thresholds: {
    maxErrorRatePercent: 5,
    maxP95Ms: 3000
  },
  stepTest: {
    startUsers: 5,
    stepUsers: 10,
    maxUsers: 100,
    durationSeconds: 30,
    rampUpSeconds: 10,
    cooldownSeconds: 5
  }
};

const PRESETS = {
  smoke: {
    mode: 'smoke',
    concurrentUsers: 5,
    durationSeconds: 30,
    rampUpSeconds: 10
  },
  light: {
    mode: 'light',
    concurrentUsers: 25,
    durationSeconds: 60,
    rampUpSeconds: 20
  },
  medium: {
    mode: 'medium',
    concurrentUsers: 50,
    durationSeconds: 90,
    rampUpSeconds: 30
  },
  heavy: {
    mode: 'heavy',
    concurrentUsers: 100,
    durationSeconds: 120,
    rampUpSeconds: 45
  },
  step: {
    mode: 'step'
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    config: 'config.json',
    preset: '',
    targetUrl: '',
    users: null,
    duration: null,
    rampUp: null,
    output: '',
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--config') {
      args.config = next;
      i += 1;
    } else if (arg === '--preset') {
      args.preset = next;
      i += 1;
    } else if (arg === '--target-url') {
      args.targetUrl = next;
      i += 1;
    } else if (arg === '--users') {
      args.users = Number(next);
      i += 1;
    } else if (arg === '--duration') {
      args.duration = Number(next);
      i += 1;
    } else if (arg === '--ramp-up') {
      args.rampUp = Number(next);
      i += 1;
    } else if (arg === '--output') {
      args.output = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Storefront Performance Test

Usage:
  node run-performance-test.js --config config.json
  node run-performance-test.js --config config.json --preset smoke
  node run-performance-test.js --config config.json --preset step

Options:
  --config <file>      Config JSON file. Default: config.json
  --preset <name>      smoke | light | medium | heavy | step
  --target-url <url>   Override targetUrl from config
  --users <number>     Override concurrentUsers
  --duration <sec>     Override durationSeconds
  --ramp-up <sec>      Override rampUpSeconds
  --output <file>      Override outputFile
  --help               Show this help

Safety:
  This runner sends GET requests only. It does not submit checkout/order data.
`);
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}\nCopy config.example.json to config.json and edit targetUrl first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

function mergeDeep(base, override) {
  const output = { ...base };

  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
      output[key] = mergeDeep(base[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function applyOverrides(config, args) {
  let next = { ...config };
  const modeName = args.preset || config.mode;

  if (modeName && !PRESETS[modeName]) {
    throw new Error(`Unknown mode/preset: ${modeName}. Use smoke, light, medium, heavy, or step.`);
  }

  if (args.preset) {
    const presetName = args.preset;
    next = mergeDeep(next, PRESETS[presetName]);
  }

  next.mode = modeName || next.mode;

  if (args.targetUrl) next.targetUrl = args.targetUrl;
  if (Number.isFinite(args.users)) next.concurrentUsers = args.users;
  if (Number.isFinite(args.duration)) next.durationSeconds = args.duration;
  if (Number.isFinite(args.rampUp)) next.rampUpSeconds = args.rampUp;
  if (args.output) next.outputFile = args.output;

  return next;
}

function validateConfig(config) {
  if (!config.targetUrl || config.targetUrl.includes('YOUR_DEPLOYMENT_ID')) {
    throw new Error('Please set targetUrl to your deployed Google Apps Script Web App URL.');
  }

  let url;
  try {
    url = new URL(config.targetUrl);
  } catch (error) {
    throw new Error(`targetUrl is not a valid URL: ${config.targetUrl}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('targetUrl must start with http:// or https://');
  }

  const numericFields = [
    ['concurrentUsers', config.concurrentUsers],
    ['durationSeconds', config.durationSeconds],
    ['rampUpSeconds', config.rampUpSeconds],
    ['requestTimeoutMs', config.requestTimeoutMs]
  ];

  for (const [field, value] of numericFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a number >= 0`);
    }
  }

  if (config.concurrentUsers < 1) {
    throw new Error('concurrentUsers must be at least 1');
  }

  if (config.durationSeconds < 1) {
    throw new Error('durationSeconds must be at least 1');
  }

  if (config.mode === 'step') {
    const stepFields = [
      ['stepTest.startUsers', config.stepTest.startUsers],
      ['stepTest.stepUsers', config.stepTest.stepUsers],
      ['stepTest.maxUsers', config.stepTest.maxUsers],
      ['stepTest.durationSeconds', config.stepTest.durationSeconds],
      ['stepTest.rampUpSeconds', config.stepTest.rampUpSeconds],
      ['stepTest.cooldownSeconds', config.stepTest.cooldownSeconds]
    ];

    for (const [field, value] of stepFields) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a number >= 0`);
      }
    }

    if (config.stepTest.startUsers < 1 || config.stepTest.stepUsers < 1 || config.stepTest.maxUsers < config.stepTest.startUsers) {
      throw new Error('stepTest must have startUsers >= 1, stepUsers >= 1, and maxUsers >= startUsers');
    }
  }
}

function buildTargetUrl(config) {
  const url = new URL(config.targetUrl);

  if (config.pagePath) {
    const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    const extraPath = String(config.pagePath).startsWith('/') ? config.pagePath : `/${config.pagePath}`;
    url.pathname = `${basePath}${extraPath}`;
  }

  for (const [key, value] of Object.entries(config.queryParams || {})) {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function requestOnce(targetUrl, timeoutMs, redirectCount = 0) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'StorefrontPerformanceTest/1.0 GET-only',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache'
        }
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirectCount < 5) {
          res.resume();
          res.on('end', async () => {
            const firstHopMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const redirectedUrl = new URL(location, url).toString();
            const redirectedResult = await requestOnce(redirectedUrl, timeoutMs, redirectCount + 1);
            redirectedResult.durationMs += firstHopMs;
            resolve(redirectedResult);
          });
          return;
        }

        res.resume();
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          resolve({
            ok: statusCode >= 200 && statusCode < 400,
            statusCode,
            durationMs: elapsedMs,
            error: ''
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    req.on('error', (error) => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({
        ok: false,
        statusCode: 0,
        durationMs: elapsedMs,
        error: error.message || 'request error'
      });
    });

    req.end();
  });
}

async function runVirtualUser(userId, testState, config, targetUrl) {
  const rampDelayMs = config.concurrentUsers > 1
    ? (config.rampUpSeconds * 1000 * (userId - 1)) / config.concurrentUsers
    : 0;

  await sleep(rampDelayMs);

  while (Date.now() < testState.endsAt) {
    const result = await requestOnce(targetUrl, config.requestTimeoutMs);
    testState.results.push(result);
  }
}

async function runScenario(config, targetUrl, label) {
  const startedAt = new Date();
  const testState = {
    results: [],
    endsAt: Date.now() + (config.durationSeconds * 1000)
  };

  console.log(`\n[${label}] GET ${targetUrl}`);
  console.log(`[${label}] users=${config.concurrentUsers}, duration=${config.durationSeconds}s, rampUp=${config.rampUpSeconds}s`);

  const users = [];
  for (let userId = 1; userId <= config.concurrentUsers; userId += 1) {
    users.push(runVirtualUser(userId, testState, config, targetUrl));
  }

  await Promise.all(users);

  const endedAt = new Date();
  const summary = summarizeResults(testState.results, {
    concurrentUsers: config.concurrentUsers,
    durationSeconds: config.durationSeconds,
    startedAt,
    endedAt,
    label,
    thresholds: config.thresholds
  });

  console.log(`[${label}] requests=${summary.totalRequests}, success=${summary.successfulRequests}, failed=${summary.failedRequests}, p95=${formatMs(summary.p95Ms)}, error=${formatPercent(summary.errorRatePercent)}`);

  return summary;
}

async function runStepTest(config, targetUrl) {
  const stepConfig = config.stepTest || DEFAULT_CONFIG.stepTest;
  const summaries = [];

  for (let users = stepConfig.startUsers; users <= stepConfig.maxUsers; users += stepConfig.stepUsers) {
    const scenarioConfig = {
      ...config,
      concurrentUsers: users,
      durationSeconds: stepConfig.durationSeconds,
      rampUpSeconds: stepConfig.rampUpSeconds
    };

    const summary = await runScenario(scenarioConfig, targetUrl, `step-${users}-users`);
    summaries.push(summary);

    if (summary.isProblem) {
      console.log(`[step] stopping because threshold was exceeded at about ${users} users.`);
      break;
    }

    if (stepConfig.cooldownSeconds > 0 && users + stepConfig.stepUsers <= stepConfig.maxUsers) {
      console.log(`[step] cooldown ${stepConfig.cooldownSeconds}s`);
      await sleep(stepConfig.cooldownSeconds * 1000);
    }
  }

  return summaries;
}

function summarizeResults(results, context) {
  const durations = results.map((item) => item.durationMs).sort((a, b) => a - b);
  const totalRequests = results.length;
  const successfulRequests = results.filter((item) => item.ok).length;
  const failedRequests = totalRequests - successfulRequests;
  const statusCodes = {};
  const errors = {};

  for (const result of results) {
    const statusKey = result.statusCode ? String(result.statusCode) : 'NETWORK_ERROR';
    statusCodes[statusKey] = (statusCodes[statusKey] || 0) + 1;

    if (result.error) {
      errors[result.error] = (errors[result.error] || 0) + 1;
    }
  }

  const actualDurationSeconds = Math.max(
    0.001,
    (context.endedAt.getTime() - context.startedAt.getTime()) / 1000
  );

  const errorRatePercent = totalRequests === 0 ? 100 : (failedRequests / totalRequests) * 100;
  const thresholds = context.thresholds || DEFAULT_CONFIG.thresholds;
  const p95Ms = percentile(durations, 95);
  const isProblem = errorRatePercent > thresholds.maxErrorRatePercent || p95Ms > thresholds.maxP95Ms;

  return {
    label: context.label,
    concurrentUsers: context.concurrentUsers,
    durationSeconds: context.durationSeconds,
    actualDurationSeconds,
    startedAt: context.startedAt.toISOString(),
    endedAt: context.endedAt.toISOString(),
    totalRequests,
    successfulRequests,
    failedRequests,
    averageMs: average(durations),
    p50Ms: percentile(durations, 50),
    p95Ms,
    p99Ms: percentile(durations, 99),
    minMs: durations.length ? durations[0] : 0,
    maxMs: durations.length ? durations[durations.length - 1] : 0,
    requestsPerSecond: totalRequests / actualDurationSeconds,
    errorRatePercent,
    statusCodes,
    errors,
    thresholds,
    isProblem
  };
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (upper >= sortedValues.length) return sortedValues[sortedValues.length - 1];
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function formatPercent(value) {
  return `${formatNumber(value, 2)}%`;
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join('');
}

function getOutputPath(config, baseDir) {
  if (config.outputFile) {
    return path.resolve(baseDir, config.outputFile);
  }

  return path.resolve(baseDir, 'results', `report-${timestampForFile()}.md`);
}

function getJsonOutputPath(markdownPath) {
  return markdownPath.replace(/\.md$/i, '.json');
}

function inferCapacity(summaries) {
  const passing = summaries.filter((summary) => !summary.isProblem);
  const firstProblem = summaries.find((summary) => summary.isProblem);
  const highestPassing = passing.length ? passing[passing.length - 1] : null;

  if (firstProblem && highestPassing) {
    return {
      supportedUsersText: `ประมาณ ${highestPassing.concurrentUsers} users พร้อมกัน`,
      problemAtText: `เริ่มมีสัญญาณปัญหาประมาณ ${firstProblem.concurrentUsers} users`,
      recommendationText: `ควรถือว่าใช้งานได้ราว ${highestPassing.concurrentUsers} users พร้อมกันภายใต้เงื่อนไขการทดสอบนี้ และควรเผื่อ buffer ก่อนถึง ${firstProblem.concurrentUsers} users`
    };
  }

  if (firstProblem && !highestPassing) {
    return {
      supportedUsersText: `ต่ำกว่า ${firstProblem.concurrentUsers} users พร้อมกัน`,
      problemAtText: `พบปัญหาตั้งแต่ ${firstProblem.concurrentUsers} users`,
      recommendationText: 'ควรลดโหลดลงและตรวจ quota, latency, หรือ error จาก Google Apps Script ก่อนทดสอบซ้ำ'
    };
  }

  const last = summaries[summaries.length - 1];
  return {
    supportedUsersText: `อย่างน้อย ${last.concurrentUsers} users พร้อมกัน`,
    problemAtText: 'ยังไม่พบจุดเริ่มมีปัญหาในช่วงที่ทดสอบ',
    recommendationText: `ถ้าต้องการหาขีดจำกัดจริง ให้รัน step test ต่อด้วย maxUsers ที่สูงขึ้นอย่างระมัดระวัง`
  };
}

function renderStatusCodeTable(statusCodes) {
  const rows = Object.entries(statusCodes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `| ${status} | ${count} |`);

  return rows.length ? rows.join('\n') : '| - | 0 |';
}

function renderErrorTable(errors) {
  const rows = Object.entries(errors)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([message, count]) => `| ${escapeMarkdown(message)} | ${count} |`);

  return rows.length ? rows.join('\n') : '| - | 0 |';
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderSingleMetrics(summary) {
  return `| Metric | Value |
| --- | ---: |
| Concurrent users | ${summary.concurrentUsers} |
| Total requests | ${summary.totalRequests} |
| Successful requests | ${summary.successfulRequests} |
| Failed requests | ${summary.failedRequests} |
| Requests/sec | ${formatNumber(summary.requestsPerSecond)} |
| Average response time | ${formatMs(summary.averageMs)} |
| p50 response time | ${formatMs(summary.p50Ms)} |
| p95 response time | ${formatMs(summary.p95Ms)} |
| p99 response time | ${formatMs(summary.p99Ms)} |
| Min response time | ${formatMs(summary.minMs)} |
| Max response time | ${formatMs(summary.maxMs)} |
| Error rate | ${formatPercent(summary.errorRatePercent)} |`;
}

function renderStepSummaryTable(summaries) {
  return `| Users | Requests | RPS | Avg | p50 | p95 | p99 | Error rate | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${summaries.map((summary) => `| ${summary.concurrentUsers} | ${summary.totalRequests} | ${formatNumber(summary.requestsPerSecond)} | ${formatMs(summary.averageMs)} | ${formatMs(summary.p50Ms)} | ${formatMs(summary.p95Ms)} | ${formatMs(summary.p99Ms)} | ${formatPercent(summary.errorRatePercent)} | ${summary.isProblem ? 'เริ่มมีปัญหา' : 'ผ่าน'} |`).join('\n')}`;
}

function renderReport(config, targetUrl, summaries) {
  const generatedAt = new Date();
  const capacity = inferCapacity(summaries);
  const mode = config.mode === 'step' ? 'Step test' : `${config.mode} test`;
  const lastSummary = summaries[summaries.length - 1];

  return `# รายงาน Performance Test หน้า Storefront

สร้างเมื่อ: ${generatedAt.toLocaleString('th-TH')}

## สรุปผล

- URL ที่ทดสอบ: ${targetUrl}
- รูปแบบทดสอบ: ${mode}
- จำนวน user ที่ทดสอบ: ${config.mode === 'step' ? `${summaries[0].concurrentUsers}-${lastSummary.concurrentUsers} users` : `${lastSummary.concurrentUsers} users`}
- ระยะเวลาทดสอบต่อรอบ: ${lastSummary.durationSeconds} วินาที
- เกณฑ์เตือน: error rate > ${formatPercent(lastSummary.thresholds.maxErrorRatePercent)} หรือ p95 > ${formatMs(lastSummary.thresholds.maxP95Ms)}
- ข้อสรุปโดยประมาณ: ${capacity.supportedUsersText}
- จุดที่เริ่มมีปัญหา: ${capacity.problemAtText}

${capacity.recommendationText}

## Metrics

${config.mode === 'step' ? renderStepSummaryTable(summaries) : renderSingleMetrics(lastSummary)}

## HTTP Status Code Breakdown

${summaries.map((summary) => `### ${summary.label}

| Status | Count |
| --- | ---: |
${renderStatusCodeTable(summary.statusCodes)}`).join('\n\n')}

## Error Breakdown

${summaries.map((summary) => `### ${summary.label}

| Error | Count |
| --- | ---: |
${renderErrorTable(summary.errors)}`).join('\n\n')}

## วิธีอ่านผล

- ถ้า p95 สูงมาก แปลว่า 95% ของ request ใช้เวลาไม่เกินค่านั้น แต่มีผู้ใช้กลุ่มหนึ่งเริ่มรอนาน
- ถ้า error rate เกินเกณฑ์ แปลว่ามี request ล้มเหลวมากพอที่ผู้ใช้จริงอาจเจอปัญหา
- ถ้า step test ผ่านทุกระดับ แปลว่าหน้านี้รองรับได้อย่างน้อยถึงจำนวน user สูงสุดที่ทดสอบ แต่ยังไม่ได้แปลว่าขีดจำกัดจริงอยู่ตรงนั้น
- ถ้า step test หยุดที่ระดับใด ให้ใช้ระดับก่อนหน้าเป็นค่าประมาณที่ปลอดภัยกว่า

## ข้อจำกัดของการทดสอบ

- สคริปต์นี้ยิงเฉพาะ HTTP GET ไปที่หน้า index/storefront ไม่ได้จำลองการ render ใน browser จริง
- ไม่ได้ทดสอบ checkout, RPC, การสร้าง order, หรือ flow ที่แก้ข้อมูล
- ผลลัพธ์ขึ้นกับเครือข่าย, cache, quota, rate limit, และสภาพแวดล้อมของ Google Apps Script ในช่วงเวลาที่ทดสอบ
- Google Apps Script ไม่เหมาะกับ load test หนักมากแบบ production server และอาจติด quota ได้ก่อนถึงขีดจำกัดเชิงระบบจริง
- ตัวเลข "รองรับได้กี่ user" เป็นค่าประมาณ ไม่ใช่ absolute capacity 100%

## คำแนะนำในการปรับปรุง

- เริ่มจาก smoke/light test ทุกครั้งก่อนเพิ่มโหลด
- ถ้า p95 เกิน 3 วินาทีหรือ error rate เกิน 5% ให้ตรวจ Google Apps Script execution log, quota, และ endpoint ที่ช้า
- ลดงานที่เกิดใน doGet ของหน้า storefront เช่น อ่าน Sheet จำนวนมาก, loop ใหญ่, หรือเรียก service ภายนอก
- ใช้ caching สำหรับข้อมูล storefront ที่ไม่เปลี่ยนบ่อย
- แยกการทดสอบ flow ที่สร้างข้อมูลไว้เป็น optional script พร้อม sandbox/test environment เท่านั้น
`;
}

function writeReport(config, targetUrl, summaries, baseDir) {
  const outputPath = getOutputPath(config, baseDir);
  const outputDir = path.dirname(outputPath);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, renderReport(config, targetUrl, summaries), 'utf8');

  const jsonPath = getJsonOutputPath(outputPath);
  fs.writeFileSync(jsonPath, JSON.stringify({ config, targetUrl, summaries }, null, 2), 'utf8');

  return { outputPath, jsonPath };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = path.resolve(process.cwd(), args.config);
  const baseDir = path.dirname(configPath);
  const userConfig = readConfig(configPath);
  const configMode = userConfig.mode || DEFAULT_CONFIG.mode;

  if (!PRESETS[configMode]) {
    throw new Error(`Unknown mode in config: ${configMode}. Use smoke, light, medium, heavy, or step.`);
  }

  const configWithDefaults = mergeDeep(
    mergeDeep(DEFAULT_CONFIG, PRESETS[configMode]),
    userConfig
  );
  const config = applyOverrides(configWithDefaults, args);
  validateConfig(config);

  const targetUrl = buildTargetUrl(config);
  const summaries = config.mode === 'step'
    ? await runStepTest(config, targetUrl)
    : [await runScenario(config, targetUrl, config.mode)];

  const { outputPath, jsonPath } = writeReport(config, targetUrl, summaries, baseDir);
  const capacity = inferCapacity(summaries);

  console.log('\nDone.');
  console.log(`Report: ${outputPath}`);
  console.log(`Raw JSON: ${jsonPath}`);
  console.log(`Estimated capacity: ${capacity.supportedUsersText}`);
  console.log(`Problem point: ${capacity.problemAtText}`);
}

main().catch((error) => {
  console.error(`\nPerformance test failed: ${error.message}`);
  process.exitCode = 1;
});
