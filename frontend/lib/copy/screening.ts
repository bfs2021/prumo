/** Copy for title/abstract screening (screening v1). */
export const screening = {
  // Tab states
  loading: 'Loading screening…',
  loadErrorTitle: 'Could not load screening',

  // Reviewers-per-record setup
  configureTitle: 'Reviewers per record',
  configureDescription: 'Reviewers screen blind. When they disagree, an arbitrator decides.',
  reviewerCountOne: '1 reviewer',
  reviewerCountMany: '{{n}} reviewers',
  reviewerCountNeedsMembers: 'Needs {{n}} reviewers in the project',
  configureSave: 'Save',
  configSavedToast: 'Screening is set up',
  notConfiguredTitle: 'Screening is not set up yet',
  notConfiguredMember: 'A project manager chooses how many reviewers screen each record.',

  // Enrollment
  nothingEnrolledTitle: 'No records to screen',
  nothingEnrolledManager: "Enroll the project's articles to start title and abstract screening.",
  nothingEnrolledMember: 'A project manager enrolls articles for screening.',
  enrollAll: 'Enroll all articles',
  nothingToEnroll: 'Add or import articles first',
  enrolledToast: '{{n}} articles enrolled',
  enrollNew: 'Enroll {{n}} new',

  // PubMed import dialog
  importOpen: 'Import from PubMed',
  importTitle: 'Import from PubMed',
  importDescription:
    'Upload the CSV PubMed exports, or paste PMIDs. Records are fetched from PubMed with their abstracts.',
  importTabCsv: 'Upload CSV',
  importTabPaste: 'Paste PMIDs',
  importDropHint: 'Drop the PubMed CSV here, or choose a file',
  importPastePlaceholder: 'One PMID per line, or separated by commas',
  importCheck: 'Check',
  importChecking: 'Checking…',
  errEmpty: 'No PMIDs found.',
  errNoPmidColumn: 'This CSV has no PMID column.',
  errInvalidPmids: 'These are not PMIDs: {{list}}',
  errTooMany: 'Up to 10,000 PMIDs per import.',
  errFileTooLarge: 'Files up to 25 MB.',
  errPmidsRejected: 'PubMed import refused this list. Check that every entry is a PMID and try again.',
  dryRunReceived: '{{n}} PMIDs',
  dryRunAlready: '{{n}} already in this project',
  dryRunNew: '{{n}} new',
  dryRunRepeated: '{{n}} repeated in the list',
  dryRunNothingNew: 'All of these PMIDs are already in this project. Importing again only fills missing fields.',
  importConfirm: 'Import {{n}} PMIDs',
  importRunning: 'Importing… {{done}} of {{total}}',
  importDone: 'Imported: {{inserted}} new, {{updated}} updated',
  importNotFound: '{{n}} PMIDs were not found in PubMed or could not be fetched.',
  importNextStepManager: 'Enroll the new articles to screen them.',
  importNextStepMember: 'A project manager enrolls them for screening.',
  importClose: 'Close',
  importFailed: 'The import stopped. Articles imported so far are kept; you can import the same list again.',
  importRunNotFound: 'This import is no longer available.',

  // Header summary
  summaryEnrolled: '{{n}} enrolled',
  summaryNotEnrolled: '{{n}} not enrolled',
  summaryReviewerOne: '1 reviewer per record',
  summaryReviewers: '{{n}} reviewers per record',
  viewerNotice: 'You can follow screening here. Only reviewers screen records.',

  // Errors (`lib/screening/errors.ts`): no `{{…}}` placeholders — the mapper fills nothing.
  errorConfigFrozen: 'Reviewers per record cannot change after the first decision.',
  errorTooFewReviewers: 'The project has fewer reviewers than that.',
  errNcbiEmailMissing: 'PubMed import is not configured on this server. Ask an administrator.',
  errQueueUnavailable: 'The import queue is unavailable. The import may not have started. Try again later.',
  errorValidation: 'That was not accepted. Check what you entered and try again.',
  errorForbidden: 'You do not have permission to do this.',
  errorNotFound: 'This record no longer exists.',
  errorGeneric: 'Something went wrong. Please try again.',
} as const;
