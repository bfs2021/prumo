/**
 * The project's Screening tab. One config read drives a state machine,
 * checked in order: loading → load error → not configured → nothing enrolled
 * → running. Managers act in each state; members get a notice saying who
 * acts. Reviewer and arbitrator bodies of the running state land later.
 */
import {useId} from 'react';

import {ErrorState} from '@/components/patterns/ErrorState';
import {Skeleton} from '@/components/ui/skeleton';
import {useScreeningConfig} from '@/hooks/screening/useScreeningConfig';
import {t} from '@/lib/copy';
import {screeningErrorMessage} from '@/lib/screening/errors';

import {ScreeningConfigForm} from './ScreeningConfigForm';
import {EnrollAllButton, ScreeningHeader} from './ScreeningHeader';

function Notice({title, body}: {title: string; body: string}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-12 text-center">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="max-w-sm text-[13px] text-muted-foreground">{body}</p>
    </div>
  );
}

function LoadingState() {
  const labelId = useId();
  return (
    <section aria-busy="true" aria-labelledby={labelId} className="flex flex-col gap-2 p-2">
      <span id={labelId} className="sr-only">
        {t('screening', 'loading')}
      </span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
    </section>
  );
}

export function ScreeningTab({projectId}: {projectId: string}) {
  const query = useScreeningConfig(projectId);

  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title={t('screening', 'loadErrorTitle')}
        message={screeningErrorMessage(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const config = query.data;

  if (config.reviewer_count === null) {
    return config.can_manage ? (
      <div className="p-2">
        <ScreeningConfigForm projectId={projectId} config={config} />
      </div>
    ) : (
      <Notice title={t('screening', 'notConfiguredTitle')} body={t('screening', 'notConfiguredMember')} />
    );
  }

  if (config.enrolled === 0) {
    if (!config.can_manage) {
      return (
        <Notice title={t('screening', 'nothingEnrolledTitle')} body={t('screening', 'nothingEnrolledMember')} />
      );
    }
    const nothingToEnroll = config.not_enrolled === 0;
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">{t('screening', 'nothingEnrolledTitle')}</h2>
          <p className="max-w-sm text-[13px] text-muted-foreground">{t('screening', 'nothingEnrolledManager')}</p>
        </div>
        <EnrollAllButton
          projectId={projectId}
          size="default"
          label={t('screening', 'enrollAll')}
          disabled={nothingToEnroll}
        />
        {nothingToEnroll && <p className="text-xs text-muted-foreground">{t('screening', 'nothingToEnroll')}</p>}
      </div>
    );
  }

  const isViewer = !config.can_review && !config.can_arbitrate;
  return (
    <div className="flex flex-col">
      <ScreeningHeader projectId={projectId} config={config} />
      {isViewer && (
        <p className="px-4 py-12 text-center text-[13px] text-muted-foreground">{t('screening', 'viewerNotice')}</p>
      )}
    </div>
  );
}
