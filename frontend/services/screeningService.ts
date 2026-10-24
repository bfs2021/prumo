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
