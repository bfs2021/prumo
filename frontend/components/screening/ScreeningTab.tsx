/**
 * The project's Screening tab. One config read drives a state machine,
 * checked in order: loading → load error → not configured → nothing enrolled
 * → running. Managers act in each state; members get a notice saying who
 * acts. Every member can import from PubMed where nothing is enrolled and in
 * the running header. While running, `?assignment=<id>` opens that record for
 * any member; otherwise a reviewer gets the queue.
 */
import {useSearchParams} from 'react-router';

import {ErrorState} from '@/components/patterns/ErrorState';
import {useScreeningConfig} from '@/hooks/screening/useScreeningConfig';
import {t} from '@/lib/copy';
import {screeningErrorMessage} from '@/lib/screening/errors';

import {AssignmentView} from './AssignmentView';
import {ScreeningConfigForm} from './ScreeningConfigForm';
import {LoadingState, Notice} from './ScreeningParts';
import {EnrollAllButton, PubMedImportButton, ScreeningHeader} from './ScreeningHeader';
import {ScreeningQueue} from './ScreeningQueue';

export function ScreeningTab({projectId, onImportComplete}: {projectId: string; onImportComplete?: () => void}) {
  const query = useScreeningConfig(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const assignmentId = searchParams.get('assignment');
  const closeAssignment = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('assignment');
      return next;
    });

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
        <Notice title={t('screening', 'nothingEnrolledTitle')} body={t('screening', 'nothingEnrolledMember')}>
          <PubMedImportButton projectId={projectId} canManage={false} onImportComplete={onImportComplete} />
        </Notice>
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
        <PubMedImportButton projectId={projectId} canManage onImportComplete={onImportComplete} />
      </div>
    );
  }

  const isViewer = !config.can_review && !config.can_arbitrate;
  return (
    <div className="flex flex-col">
      <ScreeningHeader projectId={projectId} config={config} onImportComplete={onImportComplete} />
      {assignmentId ? (
        <AssignmentView assignmentId={assignmentId} canReview={config.can_review} onBack={closeAssignment} />
      ) : config.can_review ? (
        <ScreeningQueue projectId={projectId} />
      ) : (
        isViewer && (
          <p className="px-4 py-12 text-center text-[13px] text-muted-foreground">{t('screening', 'viewerNotice')}</p>
        )
      )}
    </div>
  );
}
