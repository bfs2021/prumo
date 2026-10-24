/**
 * Title/abstract screening service. Every call routes through the typed
 * client and returns `ErrorResult<T>` — never throws across the boundary,
 * never toasts. The `ApiError` (`code`, `status`) comes back intact as
 * `error`; `screeningErrorMessage` (`lib/screening/errors.ts`) words it.
 */

import {apiClient} from '@/integrations/api/client';
import {toResult, type ErrorResult} from '@/lib/error-utils';
import type {components} from '@/types/api/schema';

export type ScreeningConfigRead = components['schemas']['ScreeningConfigRead'];
export type ScreeningConfigUpdate = components['schemas']['ScreeningConfigUpdate'];
export type ScreeningEnrollRequest = components['schemas']['ScreeningEnrollRequest'];
export type ScreeningEnrollResult = components['schemas']['ScreeningEnrollResult'];
export type PubmedDryRunRead = components['schemas']['PubmedDryRunRead'];
export type PubmedImportStarted = components['schemas']['PubmedImportStarted'];
export type ImportRunRead = components['schemas']['ImportRunRead'];

export function fetchScreeningConfig(projectId: string): Promise<ErrorResult<ScreeningConfigRead>> {
  return toResult(
    () => apiClient<ScreeningConfigRead>(`/api/v1/projects/${projectId}/screening/config`),
    'screeningService.fetchScreeningConfig',
  );
}

/** 409 SCREENING_CONFIG_FROZEN after the first decision; 409 SCREENING_TOO_FEW_REVIEWERS above `reviewer_capable`. */
export function setScreeningConfig(
  projectId: string,
  body: ScreeningConfigUpdate,
): Promise<ErrorResult<ScreeningConfigRead>> {
  return toResult(
    () =>
      apiClient<ScreeningConfigRead>(`/api/v1/projects/${projectId}/screening/config`, {
        method: 'PUT',
        body,
      }),
    'screeningService.setScreeningConfig',
  );
}

/** No `article_ids` enrolls every project article not yet enrolled. */
export function enrollArticles(
  projectId: string,
  body: ScreeningEnrollRequest,
): Promise<ErrorResult<ScreeningEnrollResult>> {
  return toResult(
    () =>
      apiClient<ScreeningEnrollResult>(`/api/v1/projects/${projectId}/screening/enroll`, {
        method: 'POST',
        body,
      }),
    'screeningService.enrollArticles',
  );
}

/** Counts only, nothing written. 422 VALIDATION_ERROR when the server refuses the list. */
export function dryRunPubmedImport(
  projectId: string,
  pmids: string[],
): Promise<ErrorResult<PubmedDryRunRead>> {
  return toResult(
    () =>
      apiClient<PubmedDryRunRead>(`/api/v1/projects/${projectId}/imports/pubmed`, {
        method: 'POST',
        body: {pmids, dry_run: true},
      }),
    'screeningService.dryRunPubmedImport',
  );
}

/** 202 with the run to poll; 503 NCBI_EMAIL_NOT_CONFIGURED / SERVICE_UNAVAILABLE when it cannot start. */
export function startPubmedImport(
  projectId: string,
  pmids: string[],
): Promise<ErrorResult<PubmedImportStarted>> {
  return toResult(
    () =>
      apiClient<PubmedImportStarted>(`/api/v1/projects/${projectId}/imports/pubmed`, {
        method: 'POST',
        body: {pmids, dry_run: false},
      }),
    'screeningService.startPubmedImport',
  );
}

/** 404 when the run is missing, in another project, or another requester's. */
export function fetchImportRun(projectId: string, syncRunId: string): Promise<ErrorResult<ImportRunRead>> {
  return toResult(
    () => apiClient<ImportRunRead>(`/api/v1/projects/${projectId}/imports/${syncRunId}`),
    'screeningService.fetchImportRun',
  );
}
