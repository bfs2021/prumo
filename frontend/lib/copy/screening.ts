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

  // Header summary
  summaryEnrolled: '{{n}} enrolled',
  summaryNotEnrolled: '{{n}} not enrolled',
  summaryReviewerOne: '1 reviewer per record',
  summaryReviewers: '{{n}} reviewers per record',
  viewerNotice: 'You can follow screening here. Only reviewers screen records.',

  // Errors (`lib/screening/errors.ts`): no `{{…}}` placeholders — the mapper fills nothing.
  errorConfigFrozen: 'Reviewers per record cannot change after the first decision.',
  errorTooFewReviewers: 'The project has fewer reviewers than that.',
  errorValidation: 'That was not accepted. Check what you entered and try again.',
  errorForbidden: 'You do not have permission to do this.',
  errorNotFound: 'This record no longer exists.',
  errorGeneric: 'Something went wrong. Please try again.',
} as const;
