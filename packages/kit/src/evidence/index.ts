// The evidence pipeline (plan §8): scrub, scan and quarantine, the redacting stream for child stdio, the reports,
// post-run, and the Playwright 1.65 `trace.secrets` detection. The CLI (Task 4) imports `postRun`, `scrubDir`,
// `scanDir`, `Redactor` and the report functions from here.
export {
  collectCookieValues,
  DEFAULT_COOKIE_NAMES,
  DEFAULT_HEADER_NAMES,
  findInText,
  formsOf,
  isRedacted,
  MIN_SECRET_LENGTH,
  REDACTED,
  type SecretLike,
  SecretShapes,
  type ShapeOptions,
  scrubText,
  shapesForRun,
  stripAnsi,
} from './patterns.ts';
export { main as postRunMain, type PostRunOptions, postRun, readScrubValuesFile } from './post-run.ts';
export { Redactor, type RedactorOptions, redactString } from './redactor.ts';
export {
  type CompareOptions,
  type ContactSheetOptions,
  compare,
  contactSheets,
  coverage,
  hashCheck,
  hostsIn,
  type JsonReport,
  type Mark,
  markOf,
  outcomeOf,
  playwrightCliPath,
  projectsOf,
  readResults,
  type SummaryOptions,
  summary,
  type TestRow,
  testsOf,
} from './report.ts';
export {
  type QuarantineOptions,
  type QuarantineOutcome,
  quarantineDir,
  type ScanFile,
  type ScanOptions,
  type ScanOutcome,
  scanDir,
  scanExitCode,
} from './scan.ts';
export { type ScrubOptions, type ScrubOutcome, scrubDir } from './scrub.ts';
export {
  installedPlaywrightVersion,
  TRACE_SECRETS_SINCE,
  type TraceSecret,
  type TraceUseOption,
  traceOption,
  traceSecretsSupported,
} from './secrets-option.ts';
export {
  BINARY_EXT,
  fileOf,
  type TextVisitor,
  topFile,
  type VisitOptions,
  type VisitOutcome,
  visitTexts,
  walkFiles,
} from './walk.ts';
